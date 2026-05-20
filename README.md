# pi-path-gate

A Pi extension that gates file-system tool calls referencing paths **outside the current workspace**.

## What it does

Intercepts **every tool call** — no whitelist needed. It walks all input parameters recursively, detects file paths, and gates any that fall outside the workspace. When a path outside the workspace is detected, the user is prompted with four choices:

| Choice | Effect |
|--------|--------|
| **🚫 Deny** | Blocks the tool call |
| **✅ Allow (once)** | Allows this single call, no memory kept |
| **🔓 Allow for Session** | Allows and remembers for the rest of this session |
| **💾 Always Allow** | Writes the path to `whitelist.yml` so it persists across sessions |

## Whitelist

A `whitelist.yml` file lives in this extension directory. By default it includes `/tmp`.

Edit it directly, or use the built-in command:

```
/path-gate list              # show current whitelist
/path-gate add /some/path    # add a path
/path-gate remove /some/p    # remove by prefix
/path-gate reset             # reset to defaults (/tmp only)
```

## URL safety

URLs (`https://`, `ftp://`, etc.) are **not** treated as file paths and are never blocked.

## Config file

Located at `~/.pi/agent/extensions/path-gate/whitelist.yml`:

```yaml
paths:
  - /tmp
  - /var/log
  - /home/user/shared-data
```
