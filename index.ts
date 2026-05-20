import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolve, isAbsolute, dirname } from "node:path";
import {
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    realpathSync,
} from "node:fs";
import { load, dump } from "js-yaml";

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

const EXT_DIR = __dirname;
const CONFIG_PATH = resolve(EXT_DIR, "whitelist.yml");

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
        return { paths: [...new Set(parsed.paths)] };
    } catch {
        return { paths: [] };
    }
}

function saveConfig(config: WhitelistConfig): void {
    mkdirSync(EXT_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, dump(config, { lineWidth: -1 }));
}

// ---------------------------------------------------------------------------
// Path analysis
// ---------------------------------------------------------------------------

/**
 * Remote URL scheme prefix — strings matching these are remote URLs, not file paths.
 * NOTE: `file://` is intentionally excluded — it points to local files and must be gated.
 */
const REMOTE_URL_RE = /^(https?|ftp|ftps|ssh|git|mailto):\/\//i;

/**
 * file:// scheme prefix — local file URLs that need path gating.
 */
const FILE_URL_RE = /^file:\/\//i;

/**
 * Check if a string looks like a remote URL (not a file path).
 */
function isUrl(candidate: string): boolean {
    return REMOTE_URL_RE.test(candidate.trim());
}

/**
 * Strip a file:// scheme to get the underlying path, or return the string unchanged.
 */
function stripFileUrl(candidate: string): string {
    const trimmed = candidate.trim();
    if (FILE_URL_RE.test(trimmed)) {
        return trimmed.replace(FILE_URL_RE, "");
    }
    return trimmed;
}

/**
 * Check if a resolved absolute path is inside the allowed zone.
 * Allowed = cwd (workspace) or any whitelisted path (exact match or directory prefix).
 */
function isPathAllowed(
    absolutePath: string,
    cwd: string,
    whitelistEntries: string[],
): boolean {
    const normCwd = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;

    if (absolutePath === normCwd || absolutePath.startsWith(normCwd + "/")) {
        return true;
    }

    for (const entry of whitelistEntries) {
        const norm = entry.endsWith("/") ? entry.slice(0, -1) : entry;
        // Exact match OR directory prefix (whitelisted dir covers everything inside it)
        if (absolutePath === norm || absolutePath.startsWith(norm + "/")) {
            return true;
        }
    }

    return false;
}

/**
 * Resolve a path string to an absolute path, following symlinks.
 * Returns null if the string looks like a URL or is not a path.
 * Uses realpath to defeat symlink attacks (e.g., /tmp/evil -> /etc/shadow).
 */
function toAbsolutePath(raw: string, cwd: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed || isUrl(trimmed)) {
        return null;
    }
    const resolved = resolve(cwd, trimmed);
    // Follow symlinks so /tmp/backdoor -> /etc/shadow is caught as /etc/shadow
    try {
        return realpathSync(resolved);
    } catch {
        // File doesn't exist yet (e.g., write to new path) — use resolved path
        // but still check parent dir for symlinks
        let parent = dirname(resolved);
        let realParent: string;
        try {
            realParent = realpathSync(parent);
        } catch {
            return resolved;
        }
        // Reconstruct: real parent + relative portion
        const rel = resolved.slice(parent.length);
        return rel ? realParent + rel : realParent;
    }
}

// ---------------------------------------------------------------------------
// Generic path extraction — works with ANY tool
// ---------------------------------------------------------------------------

/**
 * Maximum string length we'll inspect for embedded paths.
 * Longer strings are likely code, HTML, markdown, etc. — skip them.
 */
const MAX_STRING_LENGTH = 2048;

/**
 * Parameter name patterns that strongly hint at a file path.
 * When a key matches, we treat even non-obvious strings as candidates.
 */
const PATH_HINT_RE = /\b(path|file|filename|filepath|dir|directory|folder|output|dest|target|source|root|base|prefix|tmp|temp|cache|log|config)\b/i;

/**
 * Check if a string looks like a file path.
 * Matches absolute paths, relative paths with ./ or ../, and bare names with extensions.
 */
function looksLikePath(str: string): boolean {
    if (isAbsolute(str)) return true;
    if (str.startsWith("./") || str.startsWith("../")) return true;
    return false;
}

/**
 * Check if a parameter name hints that its value is a file path.
 */
function isPathHintKey(key: string): boolean {
    return PATH_HINT_RE.test(key);
}

/**
 * Recursively walk a tool's input object, collecting path-like strings.
 * Works with any tool — no tool-specific knowledge required.
 */
function walkInputForPaths(
    value: any,
    cwd: string,
    key: string = "",
    depth: number = 0,): string[] {
    const paths: string[] = [];

    // Prevent infinite recursion on circular references
    if (depth > 20) return paths;

    if (typeof value === "string") {
        // Skip remote URLs
        if (isUrl(value)) return paths;

        // file:// URLs are local — strip the scheme and treat as a path
        const stripped = stripFileUrl(value);
        if (stripped !== value.trim()) {
            const abs = toAbsolutePath(stripped, cwd);
            if (abs) paths.push(abs);
            return paths;
        }

        // Skip very long strings (code, HTML, markdown content)
        if (value.length > MAX_STRING_LENGTH) return paths;

        // If the key hints at a path, treat any non-empty string as a candidate
        if (isPathHintKey(key) && value.trim().length > 0) {
            const candidate = value.trim();
            // Still skip things that are clearly not paths
            if (!candidate.startsWith("{") && !candidate.startsWith("[") && !candidate.startsWith("<")) {
                const abs = toAbsolutePath(candidate, cwd);
                if (abs) paths.push(abs);
            }
        }
        // If the string itself looks like a path, check it
        else if (looksLikePath(value)) {
            const abs = toAbsolutePath(value, cwd);
            if (abs) paths.push(abs);
        }
    } else if (Array.isArray(value)) {
        for (const item of value) {
            paths.push(...walkInputForPaths(item, cwd, key, depth + 1));
        }
    } else if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
            paths.push(...walkInputForPaths(v, cwd, k, depth + 1));
        }
    }

    return paths;
}

/**
 * Extract file-path strings from a bash command.
 * Skips URLs, flags, and inline code that isn't a path.
 */
function extractPathsFromBash(command: string, cwd: string): string[] {
    const paths: string[] = [];
    const tokens = tokeniseShell(command);

    for (const token of tokens) {
        if (isUrl(token)) continue;
        // file:// URLs are local — strip the scheme and treat as a path
        const stripped = stripFileUrl(token);
        if (stripped !== token) {
            const abs = toAbsolutePath(stripped, cwd);
            if (abs) paths.push(abs);
            continue;
        }
        if (token.startsWith("-")) continue;
        if (/^[;&|(){}$`!'"\\[\]]/.test(token)) continue;
        if (/^\d+$/.test(token) || /^true$|^false$|^yes$|^no$/i.test(token))
            continue;
        if (
            /^(if|then|else|fi|for|while|do|done|case|esac|in|function|export|echo|cd|set|unset|source|eval|exec|exit|return|break|continue|export|declare|local|readonly|typeset|shift|trap|ulimit|umask|wait|bg|fg|jobs|kill|logout|let|read|printf|test)\s*$/.test(
                token,
            )
        )
            continue;

        if (
            isAbsolute(token) ||
            token.startsWith("./") ||
            token.startsWith("../")
        ) {
            const abs = toAbsolutePath(token, cwd);
            if (abs) {
                paths.push(abs);
            }
        }
    }

    return paths;
}

/**
 * Bash special variables / built-ins that never resolve to filesystem paths.
 * $PWD and $OLDPWD are intentionally excluded — they ARE paths.
 */
const SAFE_VARS = new Set([
    // Special characters
    "?", "#", "-", "*", "@", "!", "_",
    // Numeric-only built-ins
    "RANDOM", "SECONDS", "LINENO", "BASH_LINENO", "SHLVL",
    "UID", "EUID", "PPID", "BASH_SUBSHELL",
    // Non-path built-ins
    "IFS", "HOSTNAME", "HOSTTYPE", "MACHTYPE", "OSTYPE",
    "SHELLOPTS", "BASHOPTS", "BASH_VERSION",
    "FUNCNAME", "BASH_SOURCE", "BASH_COMMAND",
    "GROUPS", "PIPESTATUS", "EPOCHREALTIME", "EPOCHSECONDS",
    "REPLY", "COMP_CWORD", "COMP_WORDS",
]);

/**
 * Strip safe shell expansions from a command string.
 * Leaves behind unsafe ones ($HOME, $VAR, $(cmd), `cmd`, <(cmd)) for detection.
 */
function stripSafeExpansions(cmd: string): string {
    let result = cmd;
    // Remove ${SAFE_VAR} and ${SAFE_VAR[index]} forms
    for (const v of SAFE_VARS) {
        result = result.replace(
            new RegExp(`\\$\\{${v}(?:\\[[^}]*\\])?}`, "g"),
            "",
        );
    }
    // Remove $SAFE_VAR (word-boundary aware — $RANDOM but not $RANDOMFOO)
    for (const v of SAFE_VARS) {
        result = result.replace(new RegExp(`\\$${v}(?=\\W|\\s|$)`, "g"), "");
    }
    // Remove $$ (shell PID — must be after single-char ${} removal)
    result = result.replace(/\$\$/g, "");
    // Remove $X special chars: $? $# $- $* $@ $_ $!
    result = result.replace(/\$[?#\-*@_!]/g, "");
    // Remove ${X} special char forms
    result = result.replace(/\$\{[?#\-*@_!]\}/g, "");
    // Remove positional params: $1-$9, ${1}-${9}
    result = result.replace(/\$\{?[0-9]\}?/g, "");
    return result;
}

/**
 * Check if a bash command uses shell expansion that hides paths from static analysis.
 * Variables ($VAR, ${VAR}), command substitution ($(cmd), `cmd`), and process substitution <(cmd)
 * are evaluated at runtime — we can't see the real paths until execution.
 *
 * Known-safe expansions ($?, $$, $RANDOM, $SECONDS, etc.) are excluded.
 */
function hasShellExpansion(command: string): boolean {
    // Backticks and process substitution are always suspicious
    if (/[`]/.test(command)) return true;
    if (/<\(/.test(command)) return true;

    // Strip safe expansions, then check if any $ remains (unsafe variable)
    const stripped = stripSafeExpansions(command);
    return /\$/.test(stripped);
}

/**
 * Simple shell tokeniser that respects single and double quotes.
 */
function tokeniseShell(cmd: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    let i = 0;

    while (i < cmd.length) {
        const ch = cmd[i];

        if (inSingle) {
            if (ch === "'") {
                inSingle = false;
            } else {
                current += ch;
            }
        } else if (inDouble) {
            if (ch === '"' && (i === 0 || cmd[i - 1] !== "\\")) {
                inDouble = false;
            } else {
                current += ch;
            }
        } else {
            if (ch === "'") {
                inSingle = true;
            } else if (ch === '"') {
                inDouble = true;
            } else if (/\s/.test(ch)) {
                if (current) {
                    tokens.push(current);
                    current = "";
                }
            } else {
                current += ch;
            }
        }
        i++;
    }

    if (current) {
        tokens.push(current);
    }

    return tokens;
}

// ---------------------------------------------------------------------------
// Core: collect candidate paths from ANY tool call
// ---------------------------------------------------------------------------

function collectCandidatePaths(event: any, cwd: string): string[] {
    const seen = new Set<string>();
    const paths: string[] = [];

    // Special case: bash commands need shell tokenisation
    if (event.toolName === "bash" && typeof event.input.command === "string") {
        const bashPaths = extractPathsFromBash(event.input.command, cwd);
        for (const p of bashPaths) {
            if (!seen.has(p)) {
                seen.add(p);
                paths.push(p);
            }
        }
    }

    // Generic: walk ALL input parameters for any tool
    const walkedPaths = walkInputForPaths(event.input, cwd);
    for (const p of walkedPaths) {
        if (!seen.has(p)) {
            seen.add(p);
            paths.push(p);
        }
    }

    return paths;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    // In-memory session whitelist — paths the user approved "for this session"
    const sessionWhitelist = new Set<string>();

    pi.on("session_start", async (_event, ctx) => {
        ctx.ui.notify("path-gate: workspace path guard active", "info");
    });

    pi.on("session_shutdown", async (_event, _ctx) => {
        // Clear session-level whitelist on shutdown
        sessionWhitelist.clear();
    });

    pi.on("tool_call", async (event, ctx) => {
        // Inspect ALL tool calls — no whitelist needed.
        // The generic walker extracts paths from any input shape.
        const cwd = ctx.cwd;
        const config = loadConfig();
        const whitelistDirs = config.paths;

        // Collect all file-path candidates from this tool call
        const candidatePaths = collectCandidatePaths(event, cwd);

        // Bash with shell expansion: always gate — paths are hidden behind $VAR, $(cmd), <(cmd)
        const bashCmd = event.toolName === "bash" ? event.input.command : undefined;
        const shellExpansion =
            typeof bashCmd === "string" && hasShellExpansion(bashCmd);

        if (candidatePaths.length === 0 && !shellExpansion) {
            return;
        }

        // Filter: find paths that are outside workspace AND not whitelisted
        const blockedPaths: string[] = [];
        for (const p of candidatePaths) {
            // Check persistent whitelist
            if (isPathAllowed(p, cwd, whitelistDirs)) continue;
            // Check session whitelist
            if (isPathAllowed(p, cwd, [...whitelistDirs, ...sessionWhitelist]))
                continue;
            blockedPaths.push(p);
        }

        if (blockedPaths.length === 0 && !shellExpansion) {
            return;
        }

        // --- Gate triggered: ask the user ---
        const displayPaths = blockedPaths.map((p) => {
            // Show relative to cwd for readability if possible
            if (p.startsWith(cwd)) {
                return p.slice(cwd.length + 1);
            }
            return p;
        });

        let title: string;
        if (shellExpansion && blockedPaths.length === 0) {
            // Shell expansion with no statically detectable paths
            const cmdPreview = bashCmd!.length > 120 ? bashCmd!.slice(0, 120) + "…" : bashCmd!;
            title = [
                `⚠ Shell expansion detected`,
                `This bash command uses variables or substitution — paths can't be verified statically:`,
                `  ${cmdPreview}`,
            ].join("\n");
        } else if (shellExpansion && blockedPaths.length > 0) {
            title = [
                `⚠ Path outside workspace + shell expansion`,
                `The ${event.toolName} tool is trying to access:`,
                ...displayPaths.map((p) => `  ${p}`),
                `Additionally, shell expansion ($VAR, $(cmd)) hides paths from static analysis.`,
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
            // Add the exact blocked paths to session whitelist
            for (const p of blockedPaths) {
                sessionWhitelist.add(p);
            }
            ctx.ui.notify(
                `path-gate: whitelisted for this session: ${displayPaths.join(", ")}`,
                "info",
            );
            return;
        }

        if (action === "always") {
            // Add exact paths to persistent config
            for (const p of blockedPaths) {
                if (!config.paths.includes(p)) {
                    config.paths.push(p);
                }
            }
            saveConfig(config);
            ctx.ui.notify(
                `path-gate: always-allow updated: ${displayPaths.join(", ")}`,
                "info",
            );
            // Also add to session whitelist so it takes effect immediately
            for (const p of blockedPaths) {
                sessionWhitelist.add(p);
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
                const absPath = resolve(pathToAdd);
                if (!absPath.startsWith("/")) {
                    ctx.ui.notify("Path must be absolute", "warning");
                    return;
                }
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
