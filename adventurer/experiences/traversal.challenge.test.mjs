// adventurer/experiences/traversal.challenge.test.mjs
// Adversarial Traversal & Boundary Challenge Suite (Milestone 1 Iteration 2)
// Run with: node --test adventurer/experiences/traversal.challenge.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    readFileSync,
    existsSync,
    mkdirSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Mock loader so native.ts can resolve the type-only 'electron' import in Node.js
register("data:text/javascript," + encodeURIComponent(`
export function resolve(specifier, context, next) {
    if (specifier === "electron") {
        return {
            url: "data:text/javascript,export class IpcMainInvokeEvent {}; export class WebContents {}; export class WebFrameMain {};",
            shortCircuit: true
        };
    }
    return next(specifier, context);
}
`));

import * as storage from "./storage.ts";
import * as recipeModule from "./recipe.ts";
const native = await import("../native.ts");

// ----------------------------------------------------------------------------
// SUITE 1: isSafePath Boundary & Invariant Stress Testing
// ----------------------------------------------------------------------------

test("CHALLENGE_T01: isSafePath rejects standard parent traversals (../, ../../)", () => {
    const base = resolve("C:/safe/base/dir");
    assert.equal(storage.isSafePath(base, resolve("C:/safe/base/dir/../evil.advrecipe")), false);
    assert.equal(storage.isSafePath(base, resolve("C:/safe/base/dir/../../evil.advrecipe")), false);
    assert.equal(storage.isSafePath(base, resolve("C:/safe/evil.advrecipe")), false);
    assert.equal(storage.isSafePath(base, "../evil.advrecipe"), false);
    assert.equal(storage.isSafePath(base, "../../evil.advrecipe"), false);
});

test("CHALLENGE_T02: isSafePath rejects Windows backslash traversal (..\\, ..\\..\\)", () => {
    const base = resolve("C:/safe/base/dir");
    assert.equal(storage.isSafePath(base, "..\\evil.advrecipe"), false);
    assert.equal(storage.isSafePath(base, "..\\..\\evil.advrecipe"), false);
    assert.equal(storage.isSafePath(base, "sub\\..\\..\\evil.advrecipe"), false);
});

test("CHALLENGE_T03: isSafePath rejects mixed forward/backslash traversal (../..\\../)", () => {
    const base = resolve("C:/safe/base/dir");
    assert.equal(storage.isSafePath(base, "../..\\../Windows/System32/cmd.exe"), false);
    assert.equal(storage.isSafePath(base, "..\\../..\\evil.advrecipe"), false);
});

test("CHALLENGE_T04: isSafePath rejects cross-drive root paths on Windows (D:\\, Z:\\)", () => {
    const base = resolve("C:/safe/base/dir");
    assert.equal(storage.isSafePath(base, "D:\\other_drive\\recipe.advrecipe"), false);
    assert.equal(storage.isSafePath(base, "Z:/network_drive/recipe.advrecipe"), false);
    assert.equal(storage.isSafePath(base, "D:recipe.advrecipe"), false);
});

test("CHALLENGE_T05: isSafePath rejects UNC network paths (\\\\server\\share)", () => {
    const base = resolve("C:/safe/base/dir");
    assert.equal(storage.isSafePath(base, "\\\\unc\\share\\recipe.advrecipe"), false);
    assert.equal(storage.isSafePath(base, "//unc/share/recipe.advrecipe"), false);
});

test("CHALLENGE_T06: isSafePath rejects directory root itself and trailing slashes", () => {
    const base = resolve("C:/safe/base/dir");
    assert.equal(storage.isSafePath(base, base), false);
    assert.equal(storage.isSafePath(base, base + "/"), false);
    assert.equal(storage.isSafePath(base, base + "\\"), false);
    assert.equal(storage.isSafePath(base, base + "/."), false);
    assert.equal(storage.isSafePath(base, "."), false);
    assert.equal(storage.isSafePath(base, "./"), false);
    assert.equal(storage.isSafePath(base, ".."), false);
    assert.equal(storage.isSafePath(base, "../"), false);
});

test("CHALLENGE_T07: isSafePath permits legitimate subpaths and dot-prefixed filenames inside base", () => {
    const base = resolve("C:/safe/base/dir");
    assert.equal(storage.isSafePath(base, resolve("C:/safe/base/dir/recipe.advrecipe")), true);
    assert.equal(storage.isSafePath(base, resolve("C:/safe/base/dir/nested/deep/recipe.advrecipe")), true);
    assert.equal(storage.isSafePath(base, resolve("C:/safe/base/dir/..safe.advrecipe")), true);
    assert.equal(storage.isSafePath(base, resolve("C:/safe/base/dir/...tripledot.advrecipe")), true);
    assert.equal(storage.isSafePath(base, resolve("C:/safe/base/dir/.hidden.advrecipe")), true);
});

test("CHALLENGE_T08: isSafePath handles null, undefined, empty, and non-string types safely", () => {
    const base = resolve("C:/safe/base/dir");
    assert.equal(storage.isSafePath(base, ""), false);
    assert.equal(storage.isSafePath("", resolve("C:/safe/base/dir/recipe.advrecipe")), false);
    assert.equal(storage.isSafePath(null, "foo"), false);
    assert.equal(storage.isSafePath(undefined, "foo"), false);
    assert.equal(storage.isSafePath(base, null), false);
    assert.equal(storage.isSafePath(base, undefined), false);
    assert.equal(storage.isSafePath(base, 12345), false);
    assert.equal(storage.isSafePath(base, {}), false);
});

// ----------------------------------------------------------------------------
// SUITE 2: Storage Persistence Boundary & File Deletion Exploit Attacks
// ----------------------------------------------------------------------------

test("CHALLENGE_T09: deleteRecipeDiskSync refuses to delete files outside baseDir via relative traversal", () => {
    const outside = mkdtempSync(join(tmpdir(), "adv-atk-out-"));
    const inside = mkdtempSync(join(tmpdir(), "adv-atk-in-"));
    try {
        const victim = join(outside, "victim.advrecipe");
        writeFileSync(victim, "CRITICAL DATA", "utf-8");

        const rel = join("..", outside.split(/[/\\]/).pop(), "victim.advrecipe");
        const res = storage.deleteRecipeDiskSync(rel, inside);
        assert.equal(res, false, "deleteRecipeDiskSync must return false on traversal attempt");
        assert.ok(existsSync(victim), "EXPLOIT SUCCEEDED: Victim file outside baseDir was deleted!");
    } finally {
        rmSync(outside, { recursive: true, force: true });
        rmSync(inside, { recursive: true, force: true });
    }
});

test("CHALLENGE_T10: deleteRecipeDiskSync refuses to delete files outside baseDir via absolute path", () => {
    const outside = mkdtempSync(join(tmpdir(), "adv-atk-out-"));
    const inside = mkdtempSync(join(tmpdir(), "adv-atk-in-"));
    try {
        const victim = join(outside, "victim.advrecipe");
        writeFileSync(victim, "CRITICAL DATA", "utf-8");

        const res = storage.deleteRecipeDiskSync(victim, inside);
        assert.equal(res, false, "deleteRecipeDiskSync must return false on absolute outside path");
        assert.ok(existsSync(victim), "EXPLOIT SUCCEEDED: Victim file outside baseDir was deleted!");
    } finally {
        rmSync(outside, { recursive: true, force: true });
        rmSync(inside, { recursive: true, force: true });
    }
});

test("CHALLENGE_T11: deleteRecipeDiskSync refuses to delete directories", () => {
    const inside = mkdtempSync(join(tmpdir(), "adv-atk-dir-"));
    try {
        const sub = join(inside, "fake_recipe.advrecipe");
        mkdirSync(sub);

        const res = storage.deleteRecipeDiskSync("fake_recipe", inside);
        assert.equal(res, false, "deleteRecipeDiskSync must return false when target is a directory");
        assert.ok(existsSync(sub), "Directory was deleted!");
    } finally {
        rmSync(inside, { recursive: true, force: true });
    }
});

test("CHALLENGE_T12: loadRecipeDiskSync refuses to read files outside baseDir (LFI / Traversal Read)", () => {
    const outside = mkdtempSync(join(tmpdir(), "adv-atk-out-"));
    const inside = mkdtempSync(join(tmpdir(), "adv-atk-in-"));
    try {
        const secret = join(outside, "secret.advrecipe");
        writeFileSync(secret, JSON.stringify({ token: "SUPER_SECRET" }), "utf-8");

        // Relative read attempt
        const rel = join("..", outside.split(/[/\\]/).pop(), "secret.advrecipe");
        assert.equal(storage.loadRecipeDiskSync(rel, inside), null, "loadRecipeDiskSync must return null on relative traversal");

        // Absolute read attempt
        assert.equal(storage.loadRecipeDiskSync(secret, inside), null, "loadRecipeDiskSync must return null on absolute outside read");

        // System file read attempt
        assert.equal(storage.loadRecipeDiskSync("C:/Windows/win.ini", inside), null);
    } finally {
        rmSync(outside, { recursive: true, force: true });
        rmSync(inside, { recursive: true, force: true });
    }
});

test("CHALLENGE_T13: loadRecipeDiskSync refuses to read directories", () => {
    const inside = mkdtempSync(join(tmpdir(), "adv-atk-dir-"));
    try {
        const sub = join(inside, "test_dir.advrecipe");
        mkdirSync(sub);

        assert.equal(storage.loadRecipeDiskSync("test_dir", inside), null);
    } finally {
        rmSync(inside, { recursive: true, force: true });
    }
});

test("CHALLENGE_T14: Null-byte injection is safely neutralized across all storage operations", () => {
    const inside = mkdtempSync(join(tmpdir(), "adv-atk-null-"));
    try {
        assert.equal(storage.loadRecipeDiskSync("test\0.advrecipe", inside), null);
        assert.equal(storage.deleteRecipeDiskSync("test\0.advrecipe", inside), false);
    } finally {
        rmSync(inside, { recursive: true, force: true });
    }
});

test("CHALLENGE_T15: Whitespace, empty strings, and non-strings return safe fallbacks", () => {
    const inside = mkdtempSync(join(tmpdir(), "adv-atk-ws-"));
    try {
        assert.equal(storage.loadRecipeDiskSync("   ", inside), null);
        assert.equal(storage.loadRecipeDiskSync("", inside), null);
        assert.equal(storage.deleteRecipeDiskSync("   ", inside), false);
        assert.equal(storage.deleteRecipeDiskSync("", inside), false);
    } finally {
        rmSync(inside, { recursive: true, force: true });
    }
});

test("CHALLENGE_T16: slug() strips path separators and collapses dot traversal attempts", () => {
    assert.equal(storage.slug("../../Windows/System32/calc"), "Windows_System32_calc");
    assert.equal(storage.slug("..\\..\\Windows\\System32\\cmd.exe"), "Windows_System32_cmd.exe");
    assert.equal(storage.slug("..."), "unknown");
    assert.equal(storage.slug(".."), "unknown");
    assert.equal(storage.slug("."), "unknown");
    assert.equal(storage.slug(".hidden"), "hidden");
    assert.equal(storage.slug("__proto__"), "proto");
    assert.equal(storage.slug("valid-app_id.123"), "valid-app_id.123");
});

// ----------------------------------------------------------------------------
// SUITE 3: Electron Native IPC Bridge Boundary Challenges
// ----------------------------------------------------------------------------

test("CHALLENGE_T17: native.loadRecipe blocks path traversal and outside files", async () => {
    const mockEvent = {};
    const res1 = await native.loadRecipe(mockEvent, "../../Windows/win.ini");
    assert.equal(res1.ok, false);
    assert.match(res1.error, /(Access denied|not found)/i);

    const res2 = await native.loadRecipe(mockEvent, resolve("C:/Windows/win.ini"));
    assert.equal(res2.ok, false);
    assert.match(res2.error, /Access denied/i);

    const res3 = await native.loadRecipe(mockEvent, "D:/other_drive/recipe.advrecipe");
    assert.equal(res3.ok, false);
    assert.match(res3.error, /Access denied/i);
});

test("CHALLENGE_T18: native.deleteRecipe blocks path traversal and outside files", async () => {
    const mockEvent = {};
    const res1 = await native.deleteRecipe(mockEvent, "../../Windows/System32/cmd.exe");
    assert.equal(res1.ok, false);
    assert.match(res1.error, /Access denied/i);

    const res2 = await native.deleteRecipe(mockEvent, resolve("C:/Windows/System32/drivers/etc/hosts"));
    assert.equal(res2.ok, false);
    assert.match(res2.error, /Access denied/i);

    const res3 = await native.deleteRecipe(mockEvent, "   ");
    assert.equal(res3.ok, false);
});

// ----------------------------------------------------------------------------
// SUITE 4: Test Suite Wiring Verification
// ----------------------------------------------------------------------------

test("CHALLENGE_T19: recipe.test.mjs directly imports and executes production recipe.ts and storage.ts", () => {
    const testFile = readFileSync(resolve("adventurer/experiences/recipe.test.mjs"), "utf-8");
    assert.match(testFile, /import\s*\{[^}]*\}\s*from\s*["']\.\/recipe\.ts["']/);
    assert.match(testFile, /import\s*\{[^}]*\}\s*from\s*["']\.\/storage\.ts["']/);

    // Verify inlined duplicate definitions are removed from lines 19-321
    assert.doesNotMatch(testFile, /function\s+validateRecipe\s*\(/);
    assert.doesNotMatch(testFile, /function\s+sanitizeArgs\s*\(/);
    assert.doesNotMatch(testFile, /function\s+atomicSaveRecipe\s*\(/);
});
