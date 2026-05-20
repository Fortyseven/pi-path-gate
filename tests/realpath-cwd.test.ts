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
import { realpathOrSelf, isPathAllowed, toAbsolutePath } from "../lib.ts";

let sandbox: string;
let realSandbox: string;

before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "path-gate-cwd-"));
    realSandbox = realpathSync(sandbox);
    mkdirSync(join(sandbox, "real-proj"));
    symlinkSync(join(realSandbox, "real-proj"), join(sandbox, "link-proj"));
});

after(() => {
    rmSync(sandbox, { recursive: true, force: true });
});

test("realpathOrSelf resolves an existing symlink", () => {
    const linkCwd = join(realSandbox, "link-proj");
    const result = realpathOrSelf(linkCwd);
    assert.equal(result, join(realSandbox, "real-proj"));
});

test("realpathOrSelf returns the input unchanged for a non-existent path", () => {
    const ghost = join(realSandbox, "does-not-exist");
    assert.equal(realpathOrSelf(ghost), ghost);
});

test("realpathOrSelf is a no-op for a real path with no symlinks", () => {
    const real = join(realSandbox, "real-proj");
    assert.equal(realpathOrSelf(real), real);
});

test("regression: with realpath'd cwd, in-workspace files are allowed even when cwd is a symlink", () => {
    // cwd is the SYMLINK path. Candidate is realpath'd (toAbsolutePath does that).
    // Without realpath'ing cwd: candidate (real) does not startsWith(symlink-cwd) → BLOCKED (false positive).
    // With realpath'd cwd: both sides are the same prefix → ALLOWED.
    const linkCwd = join(realSandbox, "link-proj");
    const candidate = toAbsolutePath("file-inside.txt", linkCwd)!;

    // Sanity: candidate has been realpath'd through the symlink.
    assert.ok(
        candidate.startsWith(join(realSandbox, "real-proj")),
        `candidate should be under real path, got ${candidate}`,
    );

    // The OLD bug: comparing against the symlink-cwd directly fails.
    assert.equal(
        isPathAllowed(candidate, linkCwd, []),
        false,
        "literal cwd comparison should fail (this proves the bug exists)",
    );

    // The fix: caller realpath's cwd before passing it to isPathAllowed.
    const realCwd = realpathOrSelf(linkCwd);
    assert.equal(
        isPathAllowed(candidate, realCwd, []),
        true,
        "after realpath'ing cwd, in-workspace candidate must be allowed",
    );
});
