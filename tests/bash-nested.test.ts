import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPathsFromBash } from "../lib.ts";

const CWD = "/home/user/proj";

const resolved = (cmd: string) =>
    extractPathsFromBash(cmd, CWD).map((c) => c.resolved);

test("bash -c \"cat /etc/passwd\" recurses into the quoted command", () => {
    const paths = resolved('bash -c "cat /etc/passwd"');
    assert.ok(
        paths.includes("/etc/passwd"),
        `expected /etc/passwd in ${JSON.stringify(paths)}`,
    );
});

test("sh -c 'rm /etc/shadow' recurses into the quoted command", () => {
    const paths = resolved("sh -c 'rm /etc/shadow'");
    assert.ok(
        paths.includes("/etc/shadow"),
        `expected /etc/shadow in ${JSON.stringify(paths)}`,
    );
});

test("/bin/bash -c recurses too", () => {
    const paths = resolved('/bin/bash -c "cat /etc/passwd"');
    assert.ok(
        paths.includes("/etc/passwd"),
        `expected /etc/passwd in ${JSON.stringify(paths)}`,
    );
});

test("eval 'cat /etc/passwd' recurses", () => {
    const paths = resolved("eval 'cat /etc/passwd'");
    assert.ok(
        paths.includes("/etc/passwd"),
        `expected /etc/passwd in ${JSON.stringify(paths)}`,
    );
});

test("nested bash -c chain is unwound", () => {
    const paths = resolved(`bash -c "sh -c 'cat /etc/passwd'"`);
    assert.ok(
        paths.includes("/etc/passwd"),
        `expected /etc/passwd in ${JSON.stringify(paths)}`,
    );
});
