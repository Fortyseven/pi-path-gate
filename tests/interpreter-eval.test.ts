import { test } from "node:test";
import assert from "node:assert/strict";
import {
    extractPathsFromBash,
    hasInterpreterEval,
    collectCandidatesCapped,
} from "../lib.ts";

const CWD = "/home/user/proj";

const resolved = (cmd: string) =>
    extractPathsFromBash(cmd, CWD).map((c) => c.resolved);

test("python -c 'open(/etc/passwd)' extracts /etc/passwd", () => {
    const paths = resolved(`python -c "open('/etc/passwd').read()"`);
    assert.ok(
        paths.includes("/etc/passwd"),
        `expected /etc/passwd in ${JSON.stringify(paths)}`,
    );
});

test("perl -e 'open F,/etc/shadow' extracts /etc/shadow", () => {
    const paths = resolved(`perl -e 'open(F,"/etc/shadow")'`);
    assert.ok(
        paths.includes("/etc/shadow"),
        `expected /etc/shadow in ${JSON.stringify(paths)}`,
    );
});

test("node -e require('fs').readFileSync('/root/.ssh/id_rsa') extracts the key path", () => {
    const paths = resolved(
        `node -e "require('fs').readFileSync('/root/.ssh/id_rsa')"`,
    );
    assert.ok(
        paths.includes("/root/.ssh/id_rsa"),
        `expected /root/.ssh/id_rsa in ${JSON.stringify(paths)}`,
    );
});

test("ruby -e 'File.read /etc/passwd' extracts /etc/passwd", () => {
    const paths = resolved(`ruby -e 'File.read("/etc/passwd")'`);
    assert.ok(
        paths.includes("/etc/passwd"),
        `expected /etc/passwd in ${JSON.stringify(paths)}`,
    );
});

test("python3 -c is recognised as well as python -c", () => {
    const paths = resolved(`python3 -c "open('/etc/passwd')"`);
    assert.ok(paths.includes("/etc/passwd"));
});

test("absolute interpreter path /usr/bin/python3 -c is recognised", () => {
    const paths = resolved(`/usr/bin/python3 -c "open('/etc/passwd')"`);
    assert.ok(paths.includes("/etc/passwd"));
});

test("hasInterpreterEval flags python -c even when no path literal", () => {
    // The code blob builds the path dynamically; we can't see it statically,
    // but hasInterpreterEval still signals that the gate should prompt.
    assert.equal(
        hasInterpreterEval(`python -c "import os; open(os.environ['T'])"`),
        true,
    );
});

test("hasInterpreterEval does not flag plain python script.py", () => {
    assert.equal(hasInterpreterEval(`python script.py`), false);
});

test("hasInterpreterEval flags node --eval", () => {
    assert.equal(hasInterpreterEval(`node --eval "1+1"`), true);
});

test("URLs inside the code blob do not produce spurious //host/path candidates", () => {
    const paths = resolved(
        `python -c "import urllib; urllib.urlopen('http://x.com/y')"`,
    );
    // Should not contain anything resembling //x.com/y or /y as a target.
    assert.ok(
        !paths.some((p) => p.includes("x.com")),
        `unexpected URL-derived path in ${JSON.stringify(paths)}`,
    );
});

test("collectCandidatesCapped also surfaces interpreter-scanned paths", () => {
    const { paths } = collectCandidatesCapped(
        {
            toolName: "bash",
            input: { command: `python -c "open('/etc/passwd')"` },
        },
        CWD,
    );
    assert.ok(paths.some((p) => p.resolved === "/etc/passwd"));
});
