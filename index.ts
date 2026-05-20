import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { load, dump } from "js-yaml";
import {
    isPathAllowed,
    hasShellExpansion,
    hasInterpreterEval,
    isShellTool,
    extractShellCommand,
    realpathOrSelf,
    collectCandidatesCapped,
} from "./lib.ts";
import {
    sanitizeWhitelistEntries,
    validateAddPath,
    resolveConfigPath,
    atomicWriteFile,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WhitelistConfig {
    /** Absolute directory paths that are always allowed */
    paths: string[];
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

const CONFIG_PATH = resolveConfigPath(process.env);
const CONFIG_DIR = dirname(CONFIG_PATH);

function loadConfig(): WhitelistConfig {
    if (!existsSync(CONFIG_PATH)) {
        return { paths: [] };
    }
    try {
        const raw = readFileSync(CONFIG_PATH, "utf-8");
        const parsed = load(raw) as WhitelistConfig | null;
        if (!parsed || !Array.isArray(parsed.paths)) {
            return { paths: [] };
        }
        return { paths: sanitizeWhitelistEntries(parsed.paths) };
    } catch {
        return { paths: [] };
    }
}

function saveConfig(config: WhitelistConfig): void {
    mkdirSync(CONFIG_DIR, { recursive: true });
    atomicWriteFile(CONFIG_PATH, dump(config, { lineWidth: -1 }));
}


// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    // In-memory session whitelist — paths the user approved "for this session"
    const sessionWhitelist = new Set<string>();
    // Cache realpath(ctx.cwd) so we pay the syscall once per unique cwd
    // rather than on every tool_call.
    const cwdCache = new Map<string, string>();
    const realCwd = (literal: string): string => {
        let real = cwdCache.get(literal);
        if (real === undefined) {
            real = realpathOrSelf(literal);
            cwdCache.set(literal, real);
        }
        return real;
    };

    pi.on("session_start", async (_event, ctx) => {
        // Warm the cwd cache so any later tool_call hits a precomputed value.
        realCwd(ctx.cwd);
        ctx.ui.notify("path-gate: workspace path guard active", "info");
    });

    pi.on("session_shutdown", async (_event, _ctx) => {
        sessionWhitelist.clear();
        cwdCache.clear();
    });

    pi.on("tool_call", async (event, ctx) => {
        // Inspect ALL tool calls — no whitelist needed.
        // The generic walker extracts paths from any input shape.
        // Realpath cwd so symlinked workspace roots compare correctly against
        // candidates (which are already canonicalised by toAbsolutePath).
        const cwd = realCwd(ctx.cwd);
        const config = loadConfig();
        const whitelistDirs = config.paths;

        // Collect all file-path candidates from this tool call.
        // `truncated` means we hit the cap and stopped looking — we cannot
        // vouch for the uninspected tail, so the gate must fire even if the
        // paths we DID see are all in-workspace.
        const { paths: candidatePaths, truncated } = collectCandidatesCapped(
            event,
            cwd,
        );

        // Shell tools: always gate when the command uses shell expansion
        // ($VAR, $(cmd), <(cmd), `cmd`) OR invokes an interpreter with an
        // inline-code flag (python -c, perl -e, node -e, ...). In both
        // cases paths can be constructed dynamically and aren't statically
        // visible — the user has to see the raw command and decide.
        const bashCmd = isShellTool(event.toolName)
            ? extractShellCommand(event.input)
            : undefined;
        const shellExpansion =
            typeof bashCmd === "string" &&
            (hasShellExpansion(bashCmd) || hasInterpreterEval(bashCmd));

        if (candidatePaths.length === 0 && !shellExpansion && !truncated) {
            return;
        }

        // Filter: find paths that are outside workspace AND not whitelisted.
        // Gate decisions use `resolved`; we keep the candidate around so we
        // can show the user the form they actually wrote.
        const blockedPaths: typeof candidatePaths = [];
        for (const p of candidatePaths) {
            if (isPathAllowed(p.resolved, cwd, whitelistDirs)) continue;
            if (
                isPathAllowed(p.resolved, cwd, [
                    ...whitelistDirs,
                    ...sessionWhitelist,
                ])
            )
                continue;
            blockedPaths.push(p);
        }

        if (blockedPaths.length === 0 && !shellExpansion && !truncated) {
            return;
        }

        // Hard fail when the candidate cap was hit — we have no idea what we
        // didn't look at, so refuse the call rather than risk approving an
        // unseen escape attempt buried after the cap.
        if (truncated) {
            return {
                block: true,
                reason: `Blocked by path-gate: too many path arguments in a single tool call to evaluate safely`,
            };
        }

        // --- Gate triggered: ask the user ---
        // Render "raw → resolved" when the two differ (symlink resolution or
        // a relative input); otherwise just the path. Prefer cwd-relative for
        // readability when the resolved path is inside the workspace.
        const displayPaths = blockedPaths.map((p) => {
            const display = (s: string) =>
                s.startsWith(cwd + "/") ? s.slice(cwd.length + 1) : s;
            const shown = display(p.resolved);
            if (p.raw && p.raw !== p.resolved && p.raw !== shown) {
                return `${p.raw} → ${shown}`;
            }
            return shown;
        });

        let title: string;
        if (shellExpansion && blockedPaths.length === 0) {
            // Shell expansion with no statically detectable paths — the warning
            // IS the headline since there's no concrete path to lead with.
            const cmdPreview =
                bashCmd!.length > 120 ? bashCmd!.slice(0, 120) + "…" : bashCmd!;
            title = [
                `⚠ Dynamic command detected`,
                `This ${event.toolName} command uses shell expansion or an inline interpreter — paths can't be verified statically:`,
                `  ${cmdPreview}`,
            ].join("\n");
        } else if (shellExpansion && blockedPaths.length > 0) {
            // Lead with the concrete paths (the actionable, user-readable fact)
            // and demote the expansion warning to a trailing note.
            title = [
                `⚠ Path outside workspace`,
                `The ${event.toolName} tool is trying to access:`,
                ...displayPaths.map((p) => `  ${p}`),
                ``,
                `Note: this command also uses shell expansion ($VAR, $(cmd)) or`,
                `an inline interpreter (python -c, node -e, ...), so additional`,
                `paths may be touched that we couldn't analyse statically.`,
            ].join("\n");
        } else {
            title = [
                `⚠ Path outside workspace`,
                `The ${event.toolName} tool is trying to access:`,
                ...displayPaths.map((p) => `  ${p}`),
            ].join("\n");
        }

        const choice = await ctx.ui.select(title, [
            "[✕] Deny",
            "[✓] Allow (once)",
            "[·] Allow for Session",
            "[●] Always Allow",
        ]);

        const action =
            choice === "[✕] Deny"
                ? "deny"
                : choice === "[✓] Allow (once)"
                  ? "allow"
                  : choice === "[·] Allow for Session"
                    ? "session"
                    : choice === "[●] Always Allow"
                      ? "always"
                      : "deny";

        if (action === "deny") {
            return {
                block: true,
                reason: "Blocked by path-gate: user denied access to paths outside workspace",
            };
        }

        if (action === "allow") {
            // Allow this one call, don't remember
            return;
        }

        if (action === "session") {
            // Add the resolved targets to session whitelist — gate decisions
            // compare against resolved paths.
            for (const p of blockedPaths) {
                sessionWhitelist.add(p.resolved);
            }
            ctx.ui.notify(
                `path-gate: whitelisted for this session: ${displayPaths.join(", ")}`,
                "info",
            );
            return;
        }

        if (action === "always") {
            for (const p of blockedPaths) {
                if (!config.paths.includes(p.resolved)) {
                    config.paths.push(p.resolved);
                }
            }
            saveConfig(config);
            ctx.ui.notify(
                `path-gate: always-allow updated: ${displayPaths.join(", ")}`,
                "info",
            );
            for (const p of blockedPaths) {
                sessionWhitelist.add(p.resolved);
            }
            return;
        }

        // Default: deny if somehow no choice matched
        return { block: true, reason: "Blocked by path-gate" };
    });

    // -----------------------------------------------------------------------
    // /path-gate command — inspect and manage the whitelist
    // -----------------------------------------------------------------------

    pi.registerCommand("path-gate", {
        description: "Inspect and manage the path-gate whitelist",
        getArgumentCompletions: (
            prefix,
        ): import("@earendil-works/pi-tui").AutocompleteItem[] | null => {
            const cmds = ["list", "add", "remove", "reset"];
            const filtered = cmds.filter((c) => c.startsWith(prefix));
            return filtered.length > 0
                ? filtered.map((v) => ({ value: v, label: v }))
                : null;
        },
        handler: async (args, ctx) => {
            const config = loadConfig();

            if (!args || args === "list") {
                const sessionEntries = [...sessionWhitelist];
                const lines: string[] = [];

                if (config.paths.length > 0) {
                    lines.push("Persistent whitelist:");
                    lines.push(...config.paths.map((p) => `  💾 ${p}`));
                } else {
                    lines.push("Persistent whitelist: (empty)");
                }

                if (sessionEntries.length > 0) {
                    lines.push("");
                    lines.push("Session whitelist:");
                    lines.push(...sessionEntries.map((p) => `  🔓 ${p}`));
                } else {
                    lines.push("");
                    lines.push("Session whitelist: (empty)");
                }

                lines.push(`\nConfig: ${CONFIG_PATH}`);
                lines.push("\nCommands:");
                lines.push(
                    "  /path-gate list            — show whitelist (default)",
                );
                lines.push("  /path-gate add /some/path  — add a path");
                lines.push(
                    "  /path-gate remove /some/p  — remove a path (prefix match)",
                );
                lines.push("  /path-gate reset           — reset to empty");

                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            if (args.startsWith("add ")) {
                const pathToAdd = args.slice(4).trim();
                if (!pathToAdd) {
                    ctx.ui.notify(
                        "Usage: /path-gate add /absolute/path",
                        "warning",
                    );
                    return;
                }
                const validation = validateAddPath(pathToAdd);
                if (!validation.ok) {
                    ctx.ui.notify(validation.reason!, "warning");
                    return;
                }
                const absPath = validation.normalized!;
                if (config.paths.includes(absPath)) {
                    ctx.ui.notify(`${absPath} is already whitelisted`, "info");
                    return;
                }
                config.paths.push(absPath);
                saveConfig(config);
                ctx.ui.notify(`Added ${absPath} to whitelist`, "info");
                return;
            }

            if (args.startsWith("remove ")) {
                const prefix = args.slice(7).trim();
                if (!prefix) {
                    ctx.ui.notify(
                        "Usage: /path-gate remove /absolute/path",
                        "warning",
                    );
                    return;
                }
                const before = config.paths.length;
                config.paths = config.paths.filter(
                    (p) => !p.startsWith(prefix),
                );
                const removed = before - config.paths.length;
                if (removed === 0) {
                    ctx.ui.notify(
                        `No whitelist entry matches prefix "${prefix}"`,
                        "warning",
                    );
                    return;
                }
                saveConfig(config);
                ctx.ui.notify(
                    `Removed ${removed} path(s) matching "${prefix}"`,
                    "info",
                );
                return;
            }

            if (args === "reset") {
                const ok = await ctx.ui.confirm(
                    "Reset whitelist?",
                    "This removes all paths from the whitelist.",
                );
                if (!ok) return;
                config.paths = [];
                saveConfig(config);
                ctx.ui.notify("Whitelist cleared", "info");
                return;
            }

            ctx.ui.notify(
                `Unknown subcommand: ${args}. Use list, add, remove, or reset.`,
                "warning",
            );
        },
    });
}
