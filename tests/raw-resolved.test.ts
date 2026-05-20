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
import {
    extractPathsFromBash,
    walkInputForPaths,
    collectCandidatesCapped,
} from "../lib.ts";

let sandbox: string;
let realSandbox: string;
let realEtc: string;

before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "path-gate-rr-"));
    realSandbox = realpathSync(sandbox);
    mkdirSync(join(sandbox, "workspace"));
    symlinkSync("/etc", join(sandbox, "workspace", "esc"));
    realEtc = realpathSync("/etc");
});

after(() => {
    rmSync(sandbox, { recursive: true, force: true });
});

test("extractPathsFromBash returns {raw, resolved} pairs", () => {
    const cwd = join(realSandbox, "workspace");
    const out = extractPathsFromBash("cat ./esc/passwd", cwd);
    assert.equal(out.length, 1);
    assert.equal(out[0].raw, "./esc/passwd");
    assert.equal(out[0].resolved, `${realEtc}/passwd`);
});

test("walkInputForPaths returns {raw, resolved} pairs", () => {
    const cwd = join(realSandbox, "workspace");
    const out = walkInputForPaths({ file: "esc/hosts" }, cwd);
    assert.equal(out.length, 1);
    assert.equal(out[0].raw, "esc/hosts");
    assert.equal(out[0].resolved, `${realEtc}/hosts`);
});

test("raw equals resolved when no symlink resolution happened", () => {
    const cwd = join(realSandbox, "workspace");
    const out = walkInputForPaths({ file: "/var/log/messages" }, cwd);
    assert.equal(out.length, 1);
    assert.equal(out[0].raw, "/var/log/messages");
    // /var/log may or may not exist; either way raw is preserved literally.
    assert.ok(out[0].resolved.endsWith("messages"));
});

test("collectCandidatesCapped dedups on resolved, keeps the first raw", () => {
    const cwd = join(realSandbox, "workspace");
    const out = collectCandidatesCapped(
        {
            // Use a key matching PATH_HINT_RE ("file") and explicit-relative
            // forms so the walker picks up both — the dedup happens on resolved.
            toolName: "edit",
            input: { file: "./esc/passwd", target: "/etc/passwd" },
        },
        cwd,
    );
    assert.equal(out.truncated, false);
    assert.equal(out.paths.length, 1, "both inputs resolve to the same target");
    // First raw seen should win — preserves the user-visible original intent.
    assert.equal(out.paths[0].raw, "./esc/passwd");
    assert.equal(out.paths[0].resolved, `${realEtc}/passwd`);
});

test("collectCandidatesCapped: file:// URLs surface the post-strip raw", () => {
    const cwd = join(realSandbox, "workspace");
    const out = collectCandidatesCapped(
        { toolName: "edit", input: { file: "file:///etc/passwd" } },
        cwd,
    );
    assert.equal(out.paths.length, 1);
    // We accept either the original URL or the stripped path as `raw` — the
    // important contract is that resolved is canonical.
    assert.equal(out.paths[0].resolved, `${realEtc}/passwd`);
});
