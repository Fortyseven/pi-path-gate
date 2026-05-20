import { resolve, isAbsolute, dirname } from "node:path";
import { realpathSync } from "node:fs";

// ---------------------------------------------------------------------------
// Path analysis
// ---------------------------------------------------------------------------

const REMOTE_URL_RE = /^(https?|ftp|ftps|ssh|git|mailto):\/\//i;
// file:///path (empty authority) and file://localhost/path are the only
// authority forms we treat as local files. Any other authority means a
// remote/foreign host — we refuse to silently rewrite those to a path.
const FILE_URL_LOCAL_RE = /^file:\/\/(localhost)?\//i;
// file:/path is RFC 8089's no-authority short form.
const FILE_URL_NOAUTH_RE = /^file:\/(?!\/)/i;
// Any other file:// URL — has a non-empty, non-localhost authority. Treated
// as a remote URL so the walker skips it instead of trusting the path tail.
const FILE_URL_REMOTE_RE = /^file:\/\//i;

export function isUrl(candidate: string): boolean {
    const trimmed = candidate.trim();
    if (REMOTE_URL_RE.test(trimmed)) return true;
    // file://attacker/... — has authority, not localhost. Treat as URL so
    // walkers skip it rather than misinterpreting the authority as a path.
    if (FILE_URL_REMOTE_RE.test(trimmed) && !FILE_URL_LOCAL_RE.test(trimmed)) {
        return true;
    }
    return false;
}

export function stripFileUrl(candidate: string): string {
    const trimmed = candidate.trim();
    if (FILE_URL_LOCAL_RE.test(trimmed)) {
        return trimmed.replace(FILE_URL_LOCAL_RE, "/");
    }
    if (FILE_URL_NOAUTH_RE.test(trimmed)) {
        return trimmed.replace(FILE_URL_NOAUTH_RE, "/");
    }
    return trimmed;
}

/**
 * Realpath `p` when it exists; return `p` unchanged otherwise. Used to
 * canonicalise paths (cwd, whitelist entries) so they compare consistently
 * against candidates that have already gone through realpath.
 */
export function realpathOrSelf(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        return p;
    }
}

export function isPathAllowed(
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
        if (absolutePath === norm || absolutePath.startsWith(norm + "/")) {
            return true;
        }
    }

    return false;
}

export function toAbsolutePath(raw: string, cwd: string): string | null {
    // Reject NUL bytes up front. Otherwise node's path/fs APIs throw an
    // opaque ERR_INVALID_ARG_VALUE that propagates out of the hook; a
    // null return gives the caller a well-defined "not a usable path".
    if (raw.includes("\0")) {
        return null;
    }
    const trimmed = raw.trim();
    if (!trimmed || isUrl(trimmed)) {
        return null;
    }
    // Leading `~` / `~/...` — the shell would expand to $HOME before the tool
    // ever sees the path. Mirror that here so the gate isn't blind to it.
    // We don't handle `~user/...` (would need /etc/passwd lookup); leave those
    // literal — they'll fail isAbsolute and surface as a non-path token.
    const expanded =
        trimmed === "~" || trimmed.startsWith("~/")
            ? (process.env.HOME ?? "") + trimmed.slice(1)
            : trimmed;
    const resolved = resolve(cwd, expanded);
    try {
        return realpathSync(resolved);
    } catch {
        // Path doesn't exist yet. Walk up ancestors until we find one that does,
        // realpath that, and append the remaining tail. This defeats the
        // workspace/symlink/nonexistent_dir/leaf escape where a single-level
        // parent realpath would also fail and leave the symlink unresolved.
        let ancestor = dirname(resolved);
        const tail: string[] = [resolved.slice(ancestor.length)];
        while (true) {
            try {
                const realAncestor = realpathSync(ancestor);
                return realAncestor + tail.join("");
            } catch {
                const next = dirname(ancestor);
                if (next === ancestor) {
                    // Hit the filesystem root with nothing existing — give up,
                    // return the normalised but un-canonicalised path.
                    return resolved;
                }
                tail.unshift(ancestor.slice(next.length));
                ancestor = next;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Generic path extraction
// ---------------------------------------------------------------------------

const MAX_STRING_LENGTH = 2048;
const PATH_HINT_RE = /\b(path|file|filename|filepath|dir|directory|folder|output|dest|target|source|root|base|prefix|tmp|temp|cache|log|config)\b/i;

// Tool names that execute a shell command. Matched case-insensitively against
// event.toolName so a host that exposes the tool as "Bash", "shell", "exec",
// etc. still gets shell-aware path extraction and shell-expansion detection.
// Anything not in this set falls back to the generic input walker only.
const SHELL_TOOL_NAMES = new Set([
    "bash", "shell", "sh", "zsh",
    "exec", "execute", "execute_command", "executecommand", "executeshell",
    "run", "run_command", "runcommand",
    "terminal", "cmd", "command",
]);

export function isShellTool(toolName: string): boolean {
    return SHELL_TOOL_NAMES.has(toolName.toLowerCase());
}

/**
 * Pull the shell command string out of a shell-tool input. Different
 * integrations use different field names; we accept the common ones so a
 * tool renamed from "bash" to "shell" with a "script" field still gets
 * tokenised.
 */
export function extractShellCommand(input: any): string | undefined {
    if (!input || typeof input !== "object") return undefined;
    for (const key of ["command", "cmd", "script", "code"]) {
        const v = input[key];
        if (typeof v === "string") return v;
    }
    return undefined;
}

function looksLikePath(str: string): boolean {
    if (isAbsolute(str)) return true;
    if (str.startsWith("./") || str.startsWith("../")) return true;
    if (str === "~" || str.startsWith("~/")) return true;
    return false;
}

function isPathHintKey(key: string): boolean {
    return PATH_HINT_RE.test(key);
}

/**
 * One detected path candidate. `raw` is the string as it appeared in the
 * tool input (trimmed, file:// stripped); `resolved` is the canonicalised
 * absolute path used for gate decisions. They differ when a symlink was
 * resolved or when the input was relative.
 */
export interface PathCandidate {
    raw: string;
    resolved: string;
}

export function walkInputForPaths(
    value: any,
    cwd: string,
    key: string = "",
    depth: number = 0,
): PathCandidate[] {
    const paths: PathCandidate[] = [];

    if (depth > 20) return paths;

    if (typeof value === "string") {
        if (isUrl(value)) return paths;

        const trimmed = value.trim();
        const stripped = stripFileUrl(value);
        if (stripped !== trimmed) {
            const abs = toAbsolutePath(stripped, cwd);
            if (abs) paths.push({ raw: stripped, resolved: abs });
            return paths;
        }

        const hinted = isPathHintKey(key) && trimmed.length > 0;
        const pathy = looksLikePath(value);

        // The length cap is meant to skip free-form prose blobs — but it must
        // not skip path-shaped strings. Otherwise an attacker can pad an
        // absolute path past the cap with redundant `/./` segments; node's
        // resolve() collapses them back to the real target, but a blanket
        // length skip would have already returned without checking.
        if (!hinted && !pathy && value.length > MAX_STRING_LENGTH) return paths;

        if (hinted) {
            if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("<")) {
                const abs = toAbsolutePath(trimmed, cwd);
                if (abs) paths.push({ raw: trimmed, resolved: abs });
            }
        } else if (pathy) {
            const abs = toAbsolutePath(value, cwd);
            if (abs) paths.push({ raw: trimmed, resolved: abs });
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
 * Maximum number of candidate paths to collect from a single tool call.
 * Beyond this we stop walking and tell the caller the result is truncated
 * — they must fail closed because we cannot vouch for the un-inspected tail.
 */
export const CANDIDATE_CAP = 256;

export interface CandidateResult {
    paths: PathCandidate[];
    /** True if collection stopped early due to the cap. Caller MUST fail closed. */
    truncated: boolean;
}

/**
 * Collect candidate paths from a tool-call event, deduplicated by resolved,
 * capped at CANDIDATE_CAP. The first `raw` seen for a given resolved target
 * wins so the user sees the form they originally wrote.
 */
export function collectCandidatesCapped(
    event: { toolName: string; input: any },
    cwd: string,
): CandidateResult {
    const seen = new Set<string>();
    const paths: PathCandidate[] = [];
    let truncated = false;

    const push = (p: PathCandidate): boolean => {
        if (seen.has(p.resolved)) return true;
        if (paths.length >= CANDIDATE_CAP) {
            truncated = true;
            return false;
        }
        seen.add(p.resolved);
        paths.push(p);
        return true;
    };

    if (isShellTool(event.toolName)) {
        const shellCmd = extractShellCommand(event.input);
        if (typeof shellCmd === "string") {
            for (const p of extractPathsFromBash(shellCmd, cwd)) {
                if (!push(p)) return { paths, truncated };
            }
        }
    }
    for (const p of walkInputForPaths(event.input, cwd)) {
        if (!push(p)) return { paths, truncated };
    }
    return { paths, truncated };
}

// Shell binaries whose `-c <STRING>` argument is itself a shell command.
// Without recursing, `bash -c "cat /etc/passwd"` produces a single token
// `cat /etc/passwd` that is not absolute, so the path scanner misses it.
const SHELL_BINARIES = new Set([
    "sh", "bash", "dash", "ash", "zsh", "ksh",
    "/bin/sh", "/bin/bash", "/usr/bin/bash", "/usr/bin/sh",
    "/bin/dash", "/bin/zsh", "/bin/ksh",
]);

// Commands whose first non-flag argument is itself shell code.
const EVAL_LIKE = new Set(["eval"]);

// Interpreters that take inline code via a flag. We can't fully parse their
// scripts, but we can substring-scan for absolute-path literals AND signal
// upward that the call evaluates arbitrary code (so the gate prompts the
// user even when no path is statically visible — paths built from variables
// or string concatenation are invisible to us, just like shell expansion).
const INTERPRETERS: Map<string, Set<string>> = new Map([
    ["python", new Set(["-c"])],
    ["python2", new Set(["-c"])],
    ["python3", new Set(["-c"])],
    ["perl", new Set(["-e", "-E"])],
    ["ruby", new Set(["-e"])],
    ["node", new Set(["-e", "--eval", "-p", "--print"])],
    ["deno", new Set(["eval"])],
    ["php", new Set(["-r"])],
]);

function interpreterFlags(token: string): Set<string> | undefined {
    const base = token.includes("/")
        ? token.slice(token.lastIndexOf("/") + 1)
        : token;
    return INTERPRETERS.get(base);
}

// Match absolute-path-looking literals inside a code blob. The negative
// lookbehind excludes the path portion of URLs like http://x/y, which would
// otherwise produce a spurious "//x/y" candidate.
const PATH_LITERAL_RE =
    /(?<![:/])\/[A-Za-z0-9_.\-~]+(?:\/[A-Za-z0-9_.\-~]+)*/g;

function scanCodeForPaths(code: string, cwd: string): PathCandidate[] {
    const out: PathCandidate[] = [];
    const seen = new Set<string>();
    for (const match of code.matchAll(PATH_LITERAL_RE)) {
        const raw = match[0];
        if (seen.has(raw)) continue;
        seen.add(raw);
        const abs = toAbsolutePath(raw, cwd);
        if (abs) out.push({ raw, resolved: abs });
    }
    return out;
}

/**
 * True if `command` invokes a known interpreter with a code-eval flag
 * (e.g. `python -c '...'`). The caller should treat this exactly like
 * shell expansion: prompt the user even if no concrete path was extracted,
 * because the code blob may construct paths dynamically.
 */
export function hasInterpreterEval(command: string): boolean {
    const tokens = tokeniseShell(command);
    for (let i = 0; i < tokens.length; i++) {
        const flags = interpreterFlags(tokens[i]);
        if (!flags) continue;
        for (let j = i + 1; j < tokens.length; j++) {
            if (flags.has(tokens[j])) return true;
            if (!tokens[j].startsWith("-")) break;
        }
    }
    return false;
}

function extractFromNestedCommands(
    tokens: string[],
    cwd: string,
    depth: number,
): PathCandidate[] {
    if (depth > 4) return [];
    const out: PathCandidate[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (SHELL_BINARIES.has(tok)) {
            // Look for -c <STRING> after this token.
            for (let j = i + 1; j < tokens.length; j++) {
                if (tokens[j] === "-c" && j + 1 < tokens.length) {
                    out.push(
                        ...extractPathsFromBashInternal(
                            tokens[j + 1],
                            cwd,
                            depth + 1,
                        ),
                    );
                    break;
                }
                if (!tokens[j].startsWith("-")) break;
            }
        } else if (EVAL_LIKE.has(tok) && i + 1 < tokens.length) {
            out.push(
                ...extractPathsFromBashInternal(
                    tokens[i + 1],
                    cwd,
                    depth + 1,
                ),
            );
        } else {
            const flags = interpreterFlags(tok);
            if (flags) {
                // Walk forward over remaining flags to find the eval flag,
                // then scan its argument for path literals.
                for (let j = i + 1; j < tokens.length; j++) {
                    if (flags.has(tokens[j]) && j + 1 < tokens.length) {
                        out.push(...scanCodeForPaths(tokens[j + 1], cwd));
                        break;
                    }
                    if (!tokens[j].startsWith("-")) break;
                }
            }
        }
    }
    return out;
}

function extractPathsFromBashInternal(
    command: string,
    cwd: string,
    depth: number,
): PathCandidate[] {
    const paths: PathCandidate[] = [];
    const tokens = tokeniseShell(command);
    paths.push(...extractFromNestedCommands(tokens, cwd, depth));
    paths.push(...extractFromTokens(tokens, cwd));
    return paths;
}

export function extractPathsFromBash(
    command: string,
    cwd: string,
): PathCandidate[] {
    return extractPathsFromBashInternal(command, cwd, 0);
}

function extractFromTokens(tokens: string[], cwd: string): PathCandidate[] {
    const paths: PathCandidate[] = [];
    for (const token of tokens) {
        if (isUrl(token)) continue;
        const stripped = stripFileUrl(token);
        if (stripped !== token) {
            const abs = toAbsolutePath(stripped, cwd);
            if (abs) paths.push({ raw: stripped, resolved: abs });
            continue;
        }
        if (token.startsWith("-")) continue;
        if (/^[;&|(){}$`!'"\\[\]<>]/.test(token)) continue;
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
            token.startsWith("../") ||
            token === "~" ||
            token.startsWith("~/")
        ) {
            const abs = toAbsolutePath(token, cwd);
            if (abs) {
                paths.push({ raw: token, resolved: abs });
            }
        }
    }

    return paths;
}

// Named built-ins that never resolve to filesystem paths. All values are
// [A-Z_]+ — safe to interpolate into a regex template without escaping.
// ($PWD/$OLDPWD are intentionally excluded — they ARE paths.)
const SAFE_NAMED_VARS = [
    "RANDOM", "SECONDS", "LINENO", "BASH_LINENO", "SHLVL",
    "UID", "EUID", "PPID", "BASH_SUBSHELL",
    "IFS", "HOSTNAME", "HOSTTYPE", "MACHTYPE", "OSTYPE",
    "SHELLOPTS", "BASHOPTS", "BASH_VERSION",
    "FUNCNAME", "BASH_SOURCE", "BASH_COMMAND",
    "GROUPS", "PIPESTATUS", "EPOCHREALTIME", "EPOCHSECONDS",
    "REPLY", "COMP_CWORD", "COMP_WORDS",
];

function stripSafeExpansions(cmd: string): string {
    let result = cmd;

    // $'...' (ANSI-C quoting) and $"..." (locale translation) are literal
    // strings, not variable expansions. Strip them first so the residual-$
    // check below doesn't flag them. Backslash escapes inside the quotes
    // are respected so $'it\'s' closes on the *second* unescaped quote.
    result = result.replace(/\$'(?:\\.|[^'\\])*'/g, "");
    result = result.replace(/\$"(?:\\.|[^"\\])*"/g, "");

    // Named vars: ${VAR} / ${VAR[idx]} / $VAR.
    for (const v of SAFE_NAMED_VARS) {
        result = result.replace(
            new RegExp(`\\$\\{${v}(?:\\[[^}]*\\])?}`, "g"),
            "",
        );
        result = result.replace(new RegExp(`\\$${v}(?=\\W|\\s|$)`, "g"), "");
    }

    // $$ (shell PID), then single-char special params $? $# $- $* $@ $_ $!,
    // their ${X} forms, and positional params $1-$9 / ${1}-${9}.
    result = result.replace(/\$\$/g, "");
    result = result.replace(/\$[?#\-*@_!]/g, "");
    result = result.replace(/\$\{[?#\-*@_!]\}/g, "");
    result = result.replace(/\$\{?[0-9]\}?/g, "");
    return result;
}

export function hasShellExpansion(command: string): boolean {
    if (/[`]/.test(command)) return true;
    if (/[<>]\(/.test(command)) return true;

    const stripped = stripSafeExpansions(command);
    return /\$/.test(stripped);
}

export function tokeniseShell(cmd: string): string[] {
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
            if (ch === "\\" && i + 1 < cmd.length) {
                // Unquoted backslash escapes the next char. Mirror the shell:
                // `cat \/etc\/passwd` is really `cat /etc/passwd`, and without
                // this the path scanner sees a non-absolute token and misses
                // the escape attempt entirely.
                current += cmd[i + 1];
                i += 2;
                continue;
            }
            if (ch === "'") {
                inSingle = true;
            } else if (ch === '"') {
                inDouble = true;
            } else if (/\s/.test(ch)) {
                if (current) {
                    tokens.push(current);
                    current = "";
                }
            } else if (
                ch === "<" || ch === ">" || ch === "|" ||
                ch === ";" || ch === "&" || ch === "(" || ch === ")"
            ) {
                // Shell metacharacters act as token boundaries: emit the
                // preceding word, then the operator itself, so a path glued
                // to a redirect/pipe (e.g. cat</etc/passwd) gets separated.
                if (current) {
                    tokens.push(current);
                    current = "";
                }
                let op = ch;
                while (i + 1 < cmd.length && cmd[i + 1] === ch) {
                    op += cmd[i + 1];
                    i++;
                }
                tokens.push(op);
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
