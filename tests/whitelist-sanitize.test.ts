import { test } from "node:test";
import assert from "node:assert/strict";
import {
    sanitizeWhitelistEntries,
    validateAddPath,
} from "../config.ts";

test("drops empty strings", () => {
    assert.deepEqual(sanitizeWhitelistEntries(["", "/home/u/proj"]), [
        "/home/u/proj",
    ]);
});

test("drops whitespace-only entries", () => {
    assert.deepEqual(sanitizeWhitelistEntries(["   ", "\t", "/etc/foo"]), [
        "/etc/foo",
    ]);
});

test("drops root '/' (would whitelist everything)", () => {
    assert.deepEqual(sanitizeWhitelistEntries(["/", "/home/u/proj"]), [
        "/home/u/proj",
    ]);
});

test("drops non-absolute entries", () => {
    assert.deepEqual(
        sanitizeWhitelistEntries(["relative/path", "./also", "/abs"]),
        ["/abs"],
    );
});

test("drops non-string values defensively", () => {
    assert.deepEqual(
        sanitizeWhitelistEntries([null as any, 42 as any, "/abs"]),
        ["/abs"],
    );
});

test("deduplicates", () => {
    assert.deepEqual(
        sanitizeWhitelistEntries(["/a", "/a", "/b", "/a"]),
        ["/a", "/b"],
    );
});

test("normalises trailing slashes", () => {
    // Trailing slashes are stripped so prefix matching works consistently and
    // dedup catches /a and /a/ as the same entry.
    assert.deepEqual(sanitizeWhitelistEntries(["/a/", "/a"]), ["/a"]);
});

test("validateAddPath rejects relative", () => {
    const r = validateAddPath("relative/path");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /absolute/i);
});

test("validateAddPath rejects empty", () => {
    const r = validateAddPath("   ");
    assert.equal(r.ok, false);
});

test("validateAddPath rejects '/'", () => {
    const r = validateAddPath("/");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /root|whole filesystem|too broad/i);
});

test("validateAddPath flags shallow system paths", () => {
    // /etc, /usr, /var, /home, /opt, /bin, /sbin, /lib, /tmp at depth 1 are
    // suspicious — caller should confirm with the user.
    for (const p of ["/etc", "/usr", "/var", "/home", "/opt", "/bin", "/sbin", "/lib", "/tmp"]) {
        const r = validateAddPath(p);
        assert.equal(r.ok, false, `${p} should require confirmation`);
        assert.match(r.reason!, /broad|confirm|system/i, `${p}: ${r.reason}`);
    }
});

test("validateAddPath accepts deep absolute paths", () => {
    const r = validateAddPath("/home/user/projects/foo");
    assert.equal(r.ok, true);
    assert.equal(r.normalized, "/home/user/projects/foo");
});

test("validateAddPath normalises trailing slash", () => {
    const r = validateAddPath("/home/user/proj/");
    assert.equal(r.ok, true);
    assert.equal(r.normalized, "/home/user/proj");
});

test("validateAddPath normalises '..' segments", () => {
    const r = validateAddPath("/home/user/proj/../proj");
    assert.equal(r.ok, true);
    assert.equal(r.normalized, "/home/user/proj");
});
