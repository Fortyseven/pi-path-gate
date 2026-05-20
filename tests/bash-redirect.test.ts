import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPathsFromBash } from "../lib.ts";

const CWD = "/home/user/proj";

const resolved = (cmd: string) =>
    extractPathsFromBash(cmd, CWD).map((c) => c.resolved);

test("redirect glued to path: cat</etc/passwd extracts /etc/passwd", () => {
    const paths = resolved("cat</etc/passwd");
    assert.ok(
        paths.includes("/etc/passwd"),
        `expected /etc/passwd in ${JSON.stringify(paths)}`,
    );
});

test("redirect glued to path: echo pwned>/etc/cron.d/x extracts /etc/cron.d/x", () => {
    const paths = resolved("echo pwned>/etc/cron.d/x");
    assert.ok(
        paths.includes("/etc/cron.d/x"),
        `expected /etc/cron.d/x in ${JSON.stringify(paths)}`,
    );
});

test("redirect with append: tee>>/etc/hosts extracts /etc/hosts", () => {
    const paths = resolved("tee>>/etc/hosts");
    assert.ok(
        paths.includes("/etc/hosts"),
        `expected /etc/hosts in ${JSON.stringify(paths)}`,
    );
});

test("pipe glued to path: cat /etc/passwd|grep root extracts /etc/passwd cleanly", () => {
    const paths = resolved("cat /etc/passwd|grep root");
    assert.ok(
        paths.includes("/etc/passwd"),
        `expected /etc/passwd (not /etc/passwd|grep) in ${JSON.stringify(paths)}`,
    );
});

test("semicolon glued to path: cd /tmp;cat /etc/shadow extracts both", () => {
    const paths = resolved("cd /tmp;cat /etc/shadow");
    assert.ok(paths.includes("/tmp"), `expected /tmp in ${JSON.stringify(paths)}`);
    assert.ok(
        paths.includes("/etc/shadow"),
        `expected /etc/shadow in ${JSON.stringify(paths)}`,
    );
});

test("quoted metacharacters do not split: cat '/tmp/has;semi' stays one token", () => {
    const paths = resolved("cat '/tmp/has;semi'");
    assert.ok(
        paths.includes("/tmp/has;semi"),
        `expected /tmp/has;semi preserved in ${JSON.stringify(paths)}`,
    );
});

test("normal command still works: ls /tmp", () => {
    const paths = resolved("ls /tmp");
    assert.deepEqual(paths, ["/tmp"]);
});
