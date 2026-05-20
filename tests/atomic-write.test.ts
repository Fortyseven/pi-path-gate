import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
    mkdtempSync,
    readFileSync,
    writeFileSync,
    existsSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../config.ts";

let sandbox: string;

before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "path-gate-atomic-"));
});

after(() => {
    rmSync(sandbox, { recursive: true, force: true });
});

test("writes content to target path", () => {
    const target = join(sandbox, "out.txt");
    atomicWriteFile(target, "hello\n");
    assert.equal(readFileSync(target, "utf-8"), "hello\n");
});

test("leaves no .tmp file after success", () => {
    const target = join(sandbox, "clean.txt");
    atomicWriteFile(target, "x");
    assert.equal(existsSync(target + ".tmp"), false);
});

test("overwriting an existing file leaves it intact on disk (no truncation window)", () => {
    // We can't simulate a crash mid-write, but we CAN verify the contract that
    // a pre-existing stale .tmp file from a prior crash does not block the
    // next write, and the target ends up with the new content.
    const target = join(sandbox, "stale.txt");
    writeFileSync(target, "original");
    writeFileSync(target + ".tmp", "garbage from crash");

    atomicWriteFile(target, "fresh");

    assert.equal(readFileSync(target, "utf-8"), "fresh");
    assert.equal(existsSync(target + ".tmp"), false);
});

test("two consecutive writes both succeed", () => {
    const target = join(sandbox, "twice.txt");
    atomicWriteFile(target, "first");
    atomicWriteFile(target, "second");
    assert.equal(readFileSync(target, "utf-8"), "second");
});
