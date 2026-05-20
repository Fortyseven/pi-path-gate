import { test } from "node:test";
import assert from "node:assert/strict";
import { stripFileUrl, isUrl } from "../lib.ts";

test("file:///path (empty authority) strips to /path", () => {
    assert.equal(stripFileUrl("file:///etc/passwd"), "/etc/passwd");
});

test("file://localhost/path strips to /path", () => {
    assert.equal(stripFileUrl("file://localhost/etc/passwd"), "/etc/passwd");
});

test("file:/path (no authority) strips to /path", () => {
    assert.equal(stripFileUrl("file:/etc/passwd"), "/etc/passwd");
});

test("file://attacker.example/etc/passwd is NOT silently rewritten", () => {
    // Previously stripFileUrl turned this into "attacker.example/etc/passwd"
    // — a relative-looking string that escaped path detection entirely.
    // Either return it unchanged, or treat it as a URL — never strip the
    // scheme without also dropping the authority.
    const stripped = stripFileUrl("file://attacker.example/etc/passwd");
    assert.notEqual(
        stripped,
        "attacker.example/etc/passwd",
        "must not drop scheme while leaving authority behind",
    );
});

test("file://host/path is treated as a URL (so the walker skips it)", () => {
    assert.equal(isUrl("file://attacker.example/etc/passwd"), true);
});
