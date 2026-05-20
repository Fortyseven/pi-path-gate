import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
    mkdtempSync,
    mkdirSync,
    symlinkSync,
    rmSync,
    realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeWhitelistEntries } from "../config.ts";

let sandbox: string;
let realSandbox: string;

before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "path-gate-wlrp-"));
    realSandbox = realpathSync(sandbox);
    mkdirSync(join(sandbox, "target"));
    symlinkSync(join(realSandbox, "target"), join(sandbox, "link"));
});

after(() => {
    rmSync(sandbox, { recursive: true, force: true });
});

test("an existing symlink entry is replaced with its realpath", () => {
    const linkPath = join(realSandbox, "link");
    const out = sanitizeWhitelistEntries([linkPath]);
    assert.deepEqual(out, [join(realSandbox, "target")]);
});

test("a non-existent entry is kept literally (cannot realpath what doesn't exist)", () => {
    const ghost = join(realSandbox, "does-not-exist");
    const out = sanitizeWhitelistEntries([ghost]);
    assert.deepEqual(out, [ghost]);
});

test("dedup catches symlink + realpath of same target", () => {
    const linkPath = join(realSandbox, "link");
    const target = join(realSandbox, "target");
    const out = sanitizeWhitelistEntries([linkPath, target]);
    assert.deepEqual(out, [target]);
});

test("regression: a plain absolute path is kept (and trailing slash normalised)", () => {
    const out = sanitizeWhitelistEntries(["/usr/local/share/", "/usr/local/share"]);
    assert.deepEqual(out, ["/usr/local/share"]);
});

test("regression: '/' and '' still dropped", () => {
    const out = sanitizeWhitelistEntries(["/", "", "/usr/local"]);
    assert.deepEqual(out, ["/usr/local"]);
});
