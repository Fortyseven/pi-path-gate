import { test } from "node:test";
import assert from "node:assert/strict";
import {
    isShellTool,
    extractShellCommand,
    collectCandidatesCapped,
} from "../lib.ts";

const CWD = "/home/user/proj";

test("isShellTool matches case-insensitively", () => {
    assert.equal(isShellTool("bash"), true);
    assert.equal(isShellTool("Bash"), true);
    assert.equal(isShellTool("BASH"), true);
});

test("isShellTool accepts common aliases", () => {
    for (const name of [
        "shell", "sh", "zsh", "exec", "execute", "run",
        "run_command", "terminal", "command", "cmd",
    ]) {
        assert.equal(isShellTool(name), true, `expected ${name} to be a shell tool`);
    }
});

test("isShellTool rejects unrelated tool names", () => {
    assert.equal(isShellTool("file_read"), false);
    assert.equal(isShellTool("edit"), false);
    assert.equal(isShellTool(""), false);
});

test("extractShellCommand pulls from command/cmd/script/code", () => {
    assert.equal(extractShellCommand({ command: "ls" }), "ls");
    assert.equal(extractShellCommand({ cmd: "ls" }), "ls");
    assert.equal(extractShellCommand({ script: "ls" }), "ls");
    assert.equal(extractShellCommand({ code: "ls" }), "ls");
    assert.equal(extractShellCommand({}), undefined);
    assert.equal(extractShellCommand(null), undefined);
});

test("collectCandidatesCapped tokenises capital-B 'Bash' tool too", () => {
    const { paths } = collectCandidatesCapped(
        { toolName: "Bash", input: { command: "cat /etc/passwd" } },
        CWD,
    );
    assert.ok(
        paths.some((p) => p.resolved === "/etc/passwd"),
        `expected /etc/passwd from Bash tool, got ${JSON.stringify(paths)}`,
    );
});

test("collectCandidatesCapped tokenises a 'shell' tool with a 'script' field", () => {
    const { paths } = collectCandidatesCapped(
        { toolName: "shell", input: { script: "cat /etc/passwd" } },
        CWD,
    );
    assert.ok(paths.some((p) => p.resolved === "/etc/passwd"));
});

test("unknown tool name with a 'command' field falls back to generic walker only", () => {
    // The string "cat /etc/passwd" is not path-hint-keyed and not absolute,
    // so a non-shell tool should NOT shell-parse it. This documents the
    // intentional boundary — if a host adds a new shell tool name, it must
    // be added to SHELL_TOOL_NAMES.
    const { paths } = collectCandidatesCapped(
        { toolName: "totally_new_tool", input: { command: "cat /etc/passwd" } },
        CWD,
    );
    assert.ok(!paths.some((p) => p.resolved === "/etc/passwd"));
});
