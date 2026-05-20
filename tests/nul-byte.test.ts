import { test } from "node:test";
import assert from "node:assert/strict";
import { toAbsolutePath, extractPathsFromBash, walkInputForPaths } from "../lib.ts";

const CWD = "/home/user/proj";

test("toAbsolutePath returns null for input with embedded NUL", () => {
    assert.equal(toAbsolutePath("/etc/passwd\0.txt", CWD), null);
});

test("toAbsolutePath returns null for NUL at the start", () => {
    assert.equal(toAbsolutePath("\0/etc/passwd", CWD), null);
});

test("toAbsolutePath returns null for NUL inside a relative path", () => {
    assert.equal(toAbsolutePath("foo\0/bar", CWD), null);
});

test("toAbsolutePath does NOT throw on NUL input", () => {
    // Before the fix, resolve()/realpathSync() throws ERR_INVALID_ARG_VALUE.
    assert.doesNotThrow(() => toAbsolutePath("/x\0y", CWD));
});

test("extractPathsFromBash skips NUL-bearing tokens silently", () => {
    const paths = extractPathsFromBash("cat /etc/passwd\0evil", CWD);
    // Token "/etc/passwd\0evil" should be dropped, not returned.
    assert.deepEqual(paths, []);
});

test("walkInputForPaths drops NUL-bearing string values", () => {
    const paths = walkInputForPaths({ file: "/etc/passwd\0.bak" }, CWD);
    assert.deepEqual(paths, []);
});

// Note: both assertions above compare against [] which works for both string[]
// and PathCandidate[] return shapes — empty array equality holds either way.

test("regression: clean paths still produce an absolute result", () => {
    const r = toAbsolutePath("/tmp/clean", CWD);
    assert.ok(r && r.endsWith("/clean"), `expected absolute clean path, got ${r}`);
});
