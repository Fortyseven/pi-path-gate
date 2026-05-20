import { test } from "node:test";
import assert from "node:assert/strict";
import { stripFileUrl } from "../lib.ts";

test("file:// (double slash) is stripped", () => {
    assert.equal(stripFileUrl("file:///etc/passwd"), "/etc/passwd");
});

test("file:/ (single slash, RFC 8089) is stripped", () => {
    assert.equal(
        stripFileUrl("file:/etc/passwd"),
        "/etc/passwd",
        "single-slash file: URI form should also be recognised",
    );
});

test("FILE: uppercase scheme is stripped", () => {
    assert.equal(stripFileUrl("FILE:///etc/passwd"), "/etc/passwd");
});

test("non-file strings pass through unchanged", () => {
    assert.equal(stripFileUrl("/etc/passwd"), "/etc/passwd");
    assert.equal(stripFileUrl("https://example.com/x"), "https://example.com/x");
});

test("filename starting with 'file' is NOT stripped", () => {
    assert.equal(stripFileUrl("filer.txt"), "filer.txt");
    assert.equal(stripFileUrl("file.txt"), "file.txt");
});
