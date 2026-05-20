import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPathsFromBash, toAbsolutePath } from "../lib.ts";

const CWD = "/home/user/proj";
const HOME = "/home/user";

test("toAbsolutePath expands leading ~/ using HOME", () => {
    const prev = process.env.HOME;
    process.env.HOME = HOME;
    try {
        const abs = toAbsolutePath("~/.ssh/id_rsa", CWD);
        assert.equal(abs, "/home/user/.ssh/id_rsa");
    } finally {
        process.env.HOME = prev;
    }
});

test("bash 'cat ~/.ssh/id_rsa' yields a path candidate", () => {
    const prev = process.env.HOME;
    process.env.HOME = HOME;
    try {
        const paths = extractPathsFromBash("cat ~/.ssh/id_rsa", CWD).map(
            (c) => c.resolved,
        );
        assert.ok(
            paths.includes("/home/user/.ssh/id_rsa"),
            `expected /home/user/.ssh/id_rsa in ${JSON.stringify(paths)}`,
        );
    } finally {
        process.env.HOME = prev;
    }
});

test("bare ~ alone resolves to HOME", () => {
    const prev = process.env.HOME;
    process.env.HOME = HOME;
    try {
        const abs = toAbsolutePath("~", CWD);
        assert.equal(abs, HOME);
    } finally {
        process.env.HOME = prev;
    }
});

test("path containing ~ in the middle is NOT tilde-expanded", () => {
    // Only a leading ~/ (or bare ~) should expand. /tmp/~file is literal.
    const abs = toAbsolutePath("/tmp/~weirdname", CWD);
    assert.equal(abs, "/tmp/~weirdname");
});
