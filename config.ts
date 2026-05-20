import { isAbsolute, resolve, join } from "node:path";
import { writeFileSync, renameSync, realpathSync } from "node:fs";

/**
 * Write `content` to `targetPath` atomically.
 *
 * Writes to `<targetPath>.tmp` first, then renames over the target. POSIX
 * rename(2) is atomic, so a crash mid-write either leaves the original file
 * intact or leaves the new file in place — never a truncated half-file.
 *
 * If a stale `.tmp` from a previous crashed write exists, it is overwritten.
 */
export function atomicWriteFile(targetPath: string, content: string): void {
    const tmpPath = targetPath + ".tmp";
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, targetPath);
}

/**
 * Resolve the path-gate config file location from environment variables.
 * Follows the XDG Base Directory Spec: prefer $XDG_CONFIG_HOME, fall back
 * to $HOME/.config. Empty or non-absolute XDG_CONFIG_HOME is treated as
 * unset, per the spec.
 *
 * Kept pure (takes env as a parameter) so it's deterministic in tests.
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv): string {
    const xdg = env.XDG_CONFIG_HOME;
    if (xdg && isAbsolute(xdg)) {
        return join(xdg, "path-gate", "whitelist.yml");
    }
    const home = env.HOME;
    if (!home || !isAbsolute(home)) {
        throw new Error(
            "path-gate: cannot determine config location — neither XDG_CONFIG_HOME nor HOME is set to an absolute path",
        );
    }
    return join(home, ".config", "path-gate", "whitelist.yml");
}

/**
 * Shallow system-level paths that should never be whitelisted without an
 * explicit, deliberate confirmation. Whitelisting any of these effectively
 * exposes the bulk of the filesystem.
 */
const BROAD_SYSTEM_PATHS = new Set([
    "/", "/etc", "/usr", "/var", "/home", "/opt",
    "/bin", "/sbin", "/lib", "/lib64", "/tmp", "/root",
    "/boot", "/dev", "/proc", "/sys", "/srv", "/mnt", "/media",
]);

function stripTrailingSlash(p: string): string {
    return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Filter a raw whitelist-entries list down to safe, normalised entries.
 * Drops: non-strings, empty/whitespace, non-absolute, '/', duplicates.
 * Normalises trailing slashes so prefix matching is consistent.
 */
export function sanitizeWhitelistEntries(entries: unknown[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of entries) {
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (!isAbsolute(trimmed)) continue;
        let normalised = stripTrailingSlash(resolve(trimmed));
        if (normalised === "/") continue;
        // Realpath when the entry exists, so a symlinked whitelist entry
        // canonicalises to the same target the candidate-side realpath
        // produces. Non-existent entries (e.g. paths the user expects to
        // appear later) are kept literally.
        try {
            normalised = stripTrailingSlash(realpathSync(normalised));
            if (normalised === "/") continue;
        } catch {
            /* not yet on disk — keep the literal */
        }
        if (seen.has(normalised)) continue;
        seen.add(normalised);
        out.push(normalised);
    }
    return out;
}

export interface AddPathResult {
    ok: boolean;
    /** Present on success — the path that should actually be stored. */
    normalized?: string;
    /** Present on failure — user-facing explanation. */
    reason?: string;
}

/**
 * Validate a path the user wants to add to the persistent whitelist.
 * Returns ok=false for empty, relative, root, or broad system-level paths.
 */
export function validateAddPath(raw: string): AddPathResult {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { ok: false, reason: "Path is empty" };
    }
    if (!isAbsolute(trimmed)) {
        return { ok: false, reason: "Path must be absolute (start with /)" };
    }
    let normalized = stripTrailingSlash(resolve(trimmed));
    if (normalized === "/") {
        return {
            ok: false,
            reason: "Refusing to whitelist root '/' — that covers the whole filesystem",
        };
    }
    if (BROAD_SYSTEM_PATHS.has(normalized)) {
        return {
            ok: false,
            reason: `Refusing to whitelist '${normalized}' — too broad (system directory). Whitelist a more specific subdirectory.`,
        };
    }
    // If the path exists and is a symlink, store the realpath so the user
    // sees what they actually whitelisted (a symlinked /tmp/safe -> /etc
    // gets stored as /etc, making the broad-path check above effective).
    try {
        const real = stripTrailingSlash(realpathSync(normalized));
        if (real === "/") {
            return {
                ok: false,
                reason: `Refusing to whitelist '${normalized}' — resolves to root '/' via symlink`,
            };
        }
        if (BROAD_SYSTEM_PATHS.has(real)) {
            return {
                ok: false,
                reason: `Refusing to whitelist '${normalized}' — resolves via symlink to system directory '${real}'`,
            };
        }
        normalized = real;
    } catch {
        /* path doesn't exist yet — keep the literal */
    }
    return { ok: true, normalized };
}
