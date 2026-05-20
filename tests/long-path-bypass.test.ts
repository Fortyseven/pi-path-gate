import { test } from "node:test";
import assert from "node:assert/strict";
import { walkInputForPaths, collectCandidatesCapped } from "../lib.ts";

const CWD = "/home/user/proj";

test("padded absolute path past MAX_STRING_LENGTH is still inspected (path-hint key)", () => {
    // Pad /etc/passwd with redundant /./ segments to ~3000 chars; node's
    // resolve() collapses them back to /etc/passwd, but a blanket length
    // skip would have caused the walker to return without checking.
    const padding = "/.".repeat(1500); // 3000 chars
    const padded = padding + "/etc/passwd";
    assert.ok(padded.length > 2048, "test setup: must exceed length cap");

    const found = walkInputForPaths({ path: padded }, CWD);
    assert.ok(
        found.some((p) => p.resolved === "/etc/passwd"),
        `padded path bypassed gate: ${JSON.stringify(found)}`,
    );
});

test("padded absolute path past MAX_STRING_LENGTH still inspected (path-shaped, no hint)", () => {
    const padding = "/.".repeat(1500);
    const padded = padding + "/etc/passwd";

    const found = walkInputForPaths({ arbitrary_field: padded }, CWD);
    assert.ok(
        found.some((p) => p.resolved === "/etc/passwd"),
        `padded path bypassed gate: ${JSON.stringify(found)}`,
    );
});

test("genuinely long non-path prose is still skipped", () => {
    const prose = "lorem ipsum ".repeat(300); // ~3600 chars, no leading /
    const found = walkInputForPaths({ description: prose }, CWD);
    assert.equal(found.length, 0);
});

test("collectCandidatesCapped catches the padded escape on non-bash tools", () => {
    const padding = "/.".repeat(1500);
    const padded = padding + "/etc/passwd";
    const { paths } = collectCandidatesCapped(
        { toolName: "file_write", input: { path: padded, content: "x" } },
        CWD,
    );
    assert.ok(paths.some((p) => p.resolved === "/etc/passwd"));
});
