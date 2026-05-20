import { test } from "node:test";
import assert from "node:assert/strict";
import { hasShellExpansion } from "../lib.ts";

test("$'...' ANSI-C quoting alone does NOT trigger expansion gate", () => {
    assert.equal(
        hasShellExpansion("echo $'hello\\nworld'"),
        false,
        "$'...' is just a literal string with C-escapes, not an expansion",
    );
});

test("$\"...\" locale-translated string alone does NOT trigger expansion gate", () => {
    assert.equal(
        hasShellExpansion('echo $"hello"'),
        false,
        '$"..." is locale-translated literal, not a variable expansion',
    );
});

test("a real $VAR inside the rest of the command still triggers", () => {
    assert.equal(
        hasShellExpansion("echo $'safe' $HOME/file"),
        true,
        "an unsafe $VAR adjacent to safe $'...' must still trigger",
    );
});

test("escaped quotes inside $'...' do not prematurely close the span", () => {
    // $'it\\'s' contains an escaped single quote; the closing ' is the second one.
    assert.equal(hasShellExpansion("echo $'it\\'s fine'"), false);
});

test("regression: backtick command substitution still triggers", () => {
    assert.equal(hasShellExpansion("echo `whoami`"), true);
});

test("regression: $(...) command substitution still triggers", () => {
    assert.equal(hasShellExpansion("echo $(whoami)"), true);
});

test("regression: plain command stays clean", () => {
    assert.equal(hasShellExpansion("ls -la /tmp"), false);
});
