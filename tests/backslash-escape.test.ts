import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPathsFromBash, tokeniseShell } from "../lib.ts";

const CWD = "/home/user/proj";

test("tokeniser unescapes backslash-escaped slashes outside quotes", () => {
    // bash: `cat \/etc\/passwd` runs `cat /etc/passwd`. The tokeniser must
    // produce the same token the shell would execute, otherwise the gate is
    // blind to escaped paths.
    const tokens = tokeniseShell("cat \\/etc\\/passwd");
    assert.deepEqual(tokens, ["cat", "/etc/passwd"]);
});

test("backslash-escaped path is detected by extractPathsFromBash", () => {
    const paths = extractPathsFromBash("cat \\/etc\\/passwd", CWD).map(
        (c) => c.resolved,
    );
    assert.ok(
        paths.includes("/etc/passwd"),
        `expected /etc/passwd in ${JSON.stringify(paths)}`,
    );
});

test("backslash before a non-special char is also unescaped", () => {
    const tokens = tokeniseShell("echo a\\bc");
    assert.deepEqual(tokens, ["echo", "abc"]);
});
