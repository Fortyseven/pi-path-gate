import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfigPath } from "../config.ts";

test("uses XDG_CONFIG_HOME when set", () => {
    const p = resolveConfigPath({
        XDG_CONFIG_HOME: "/custom/xdg",
        HOME: "/home/user",
    });
    assert.equal(p, "/custom/xdg/path-gate/whitelist.yml");
});

test("falls back to $HOME/.config when XDG_CONFIG_HOME unset", () => {
    const p = resolveConfigPath({ HOME: "/home/user" });
    assert.equal(p, "/home/user/.config/path-gate/whitelist.yml");
});

test("ignores empty XDG_CONFIG_HOME (per spec, treat as unset)", () => {
    const p = resolveConfigPath({
        XDG_CONFIG_HOME: "",
        HOME: "/home/user",
    });
    assert.equal(p, "/home/user/.config/path-gate/whitelist.yml");
});

test("ignores non-absolute XDG_CONFIG_HOME (per spec, treat as unset)", () => {
    const p = resolveConfigPath({
        XDG_CONFIG_HOME: "relative/dir",
        HOME: "/home/user",
    });
    assert.equal(p, "/home/user/.config/path-gate/whitelist.yml");
});

test("throws when neither XDG_CONFIG_HOME nor HOME is usable", () => {
    assert.throws(() => resolveConfigPath({}), /HOME/);
});
