# pi-path-gate

A Pi extension that gates file-system tool calls referencing paths **outside the current workspace**.

## What it does

Intercepts **every tool call** — no whitelist needed. It walks all input parameters recursively, detects file paths, and gates any that fall outside the workspace. When a path outside the workspace is detected, the user is prompted with four choices:

| Choice | Effect |
|--------|--------|
| **[✕] Deny** | Blocks the tool call |
| **[✓] Allow (once)** | Allows this single call, nothing remembered |
| **[·] Allow for Session** | Allows and remembers for the rest of this session |
| **[●] Always Allow** | Writes the path to `whitelist.yml` so it persists across sessions |

## Path detection

The walker inspects every string value in a tool-call's input and extracts paths through several strategies:

- **Absolute paths** (`/etc/passwd`)
- **Relative paths** (`./data`, `../secret`)
- **Tilde expansion** (`~`, `~/projects`)
- **File URLs** (`file:///path`, `file://localhost/path`, `file:/path`) — stripped and treated as local paths. Remote authorities (`file://attacker/...`) are treated as URLs and skipped.
- **Hinted keys** — any value whose JSON key matches `path`, `file`, `filename`, `dir`, `directory`, `output`, `dest`, `target`, `source`, `root`, `base`, `tmp`, `temp`, `cache`, `log`, or `config` is treated as a path candidate (unless it looks like JSON/XML)

A candidate cap of **256 paths per tool call** prevents abuse. If exceeded, the call is blocked outright since uninspected arguments can't be vouched for.

## Shell command analysis

Tools whose name matches a shell tool (`bash`, `shell`, `sh`, `zsh`, `exec`, `execute`, `run`, `terminal`, `cmd`, `command`, etc.) get special treatment:

- The command string is **tokenised** (respecting quotes, backslash escapes, and shell metacharacters as token boundaries)
- Paths are extracted from tokens
- **Nested subshells** are recursed (`bash -c "bash -c 'cat /etc/passwd'"`)
- **Interpreter eval flags** are detected (`python -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, `deno eval`) — both for path scanning inside the code blob and for triggering a gate prompt even when no path is statically visible
- **Shell expansion** (`$VAR`, `$(cmd)`, `` `cmd` ``, `<(cmd)`) triggers a gate prompt because paths can be constructed dynamically. Safe expansions (`$$`, `$?`, `$#`, `$RANDOM`, `$SHLVL`, etc.) are stripped before checking so they don't cause false positives. ANSI-C quoting (`$'...'`) and locale translation (`$"..."`) are also stripped.

When shell expansion or interpreter eval is detected but no concrete paths are found, the user still sees a prompt with the raw command so they can make an informed decision.

## Symlink safety

All paths go through `realpath` resolution so symlinks can't be used to escape the workspace:

- **Existing paths** are resolved via `realpathSync`
- **Non-existent paths** walk up ancestors until one exists, realpath it, and append the remaining tail — defeating `workspace/symlink→/etc/nonexistent/leaf` escape attempts
- **The workspace `cwd`** is also realpath'd so a symlinked workspace root compares correctly against candidates
- **Whitelist entries** are realpath'd on load so a symlinked whitelist entry canonicalises to the same target candidates produce

## Security safeguards

- **NUL byte rejection** — strings containing `\0` are rejected up front (Node `path`/`fs` APIs throw opaque errors otherwise)
- **Broad system path blocking** — the `/path-gate add` command refuses to whitelist `/`, `/etc`, `/usr`, `/var`, `/home`, `/opt`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/tmp`, `/root`, `/boot`, `/dev`, `/proc`, `/sys`, `/srv`, `/mnt`, `/media`. Symlinks that resolve to these are also caught.
- **Atomic config writes** — the whitelist file is written to a `.tmp` file first, then renamed via POSIX `rename(2)` so a crash mid-write never produces a truncated half-file

## Whitelist

The persistent whitelist lives at `~/.config/path-gate/whitelist.yml` (or `$XDG_CONFIG_HOME/path-gate/whitelist.yml` when set, per the XDG Base Directory Spec).

Edit it directly, or use the built-in command:

```
/path-gate list              # show persistent + session whitelist
/path-gate add /some/path    # add a path (must be absolute, not too broad)
/path-gate remove /some/p    # remove by prefix match
/path-gate reset             # clear all persistent entries
```

The `list` command shows both the **persistent whitelist** (from `whitelist.yml`) and the **session whitelist** (paths approved "for this session" that won't survive a restart).

## URL safety

Remote URLs (`https://`, `ftp://`, `ftps://`, `ssh://`, `git://`, `mailto:`) are **not** treated as file paths and are never blocked. `file://` URLs with a non-localhost authority are also treated as remote and skipped.

## Config file

Located at `~/.config/path-gate/whitelist.yml`:

```yaml
paths:
  - /tmp
  - /var/log
  - /home/user/shared-data
```

## Testing

The extension includes a test suite covering edge cases:

```
npm test
```

Tests cover symlink escaping, shell expansion detection, interpreter eval, NUL bytes, file URL authority handling, tilde expansion, candidate cap enforcement, atomic writes, config path resolution (XDG), whitelist sanitization, broad system path blocking, long-path bypass prevention, ANSI-C quoting, backslash escapes, bash redirects, and nested subshell recursion.
