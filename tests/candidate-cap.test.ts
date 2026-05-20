import { test } from "node:test";
import assert from "node:assert/strict";
import { collectCandidatesCapped, CANDIDATE_CAP } from "../lib.ts";

const CWD = "/home/user/proj";

test("collectCandidatesCapped exports a sensible cap", () => {
    assert.ok(CANDIDATE_CAP >= 64 && CANDIDATE_CAP <= 4096);
});

test("small input: returns paths with truncated=false", () => {
    const input = { file: "/etc/passwd", dir: "/etc/foo" };
    const result = collectCandidatesCapped(
        { toolName: "edit", input },
        CWD,
    );
    assert.equal(result.truncated, false);
    assert.ok(result.paths.length >= 1);
});

test("over-cap input: stops collecting and reports truncated=true", () => {
    const flood = Array.from({ length: CANDIDATE_CAP * 2 }, (_, i) => `/etc/file_${i}`);
    const result = collectCandidatesCapped(
        { toolName: "edit", input: { paths: flood } },
        CWD,
    );
    assert.equal(result.truncated, true, "must signal overflow");
    assert.equal(
        result.paths.length,
        CANDIDATE_CAP,
        `should stop exactly at cap (got ${result.paths.length})`,
    );
});

test("bash tool with many path tokens is also capped", () => {
    const tokens = Array.from({ length: CANDIDATE_CAP * 2 }, (_, i) => `/etc/f${i}`).join(" ");
    const result = collectCandidatesCapped(
        { toolName: "bash", input: { command: `cat ${tokens}` } },
        CWD,
    );
    assert.equal(result.truncated, true);
    assert.ok(result.paths.length <= CANDIDATE_CAP);
});

test("dedup applied within the cap", () => {
    // 10 unique paths repeated 100 times should yield 10, not the cap.
    const repeats = Array.from({ length: 100 }, () =>
        Array.from({ length: 10 }, (_, i) => `/etc/d${i}`),
    ).flat();
    const result = collectCandidatesCapped(
        { toolName: "edit", input: { paths: repeats } },
        CWD,
    );
    assert.equal(result.truncated, false);
    assert.equal(result.paths.length, 10);
});
