import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAbsolutePath } from "../lib.ts";

let sandbox: string;
let realSandbox: string;
let realEtc: string;

before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "path-gate-test-"));
    realSandbox = realpathSync(sandbox);
    // Pretend "workspace/esc" is a symlink escaping to /etc.
    mkdirSync(join(sandbox, "workspace"));
    symlinkSync("/etc", join(sandbox, "workspace", "esc"));
    realEtc = realpathSync("/etc");
});

after(() => {
    rmSync(sandbox, { recursive: true, force: true });
});

test("symlink with non-existent direct leaf resolves through the link", () => {
    // workspace/esc -> /etc; "newfile" doesn't exist under /etc
    const cwd = join(realSandbox, "workspace");
    const result = toAbsolutePath("esc/newfile", cwd);
    assert.equal(result, `${realEtc}/newfile`);
});

test("symlink with deep non-existent path still resolves through the link", () => {
    // The bypass: parent doesn't exist either, so single-level fallback fails.
    // Expected: walk up until we find a real ancestor, realpath it, append rest.
    const cwd = join(realSandbox, "workspace");
    const result = toAbsolutePath("esc/no_such_dir/passwd", cwd);
    assert.equal(
        result,
        `${realEtc}/no_such_dir/passwd`,
        "ancestor walk should resolve symlink even when intermediate dirs don't exist",
    );
});

test("fully non-existent path under a real cwd still returns sane absolute", () => {
    const cwd = join(realSandbox, "workspace");
    const result = toAbsolutePath("totally/made/up/path", cwd);
    assert.equal(result, `${realSandbox}/workspace/totally/made/up/path`);
});

test("existing path is realpath'd as before", () => {
    const cwd = join(realSandbox, "workspace");
    const result = toAbsolutePath("esc", cwd);
    assert.equal(result, realEtc);
});
