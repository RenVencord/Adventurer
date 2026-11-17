/*
 * Empirical Challenge Suite: Milestone 1 Persistence Invariants, Concurrency, and Zero DataStore Compliance.
 *
 * Authored by: Empirical Challenger (critic / specialist)
 * Target Deliverables:
 *   - adventurer/experiences/recipe.ts
 *   - adventurer/experiences/storage.ts
 *   - adventurer/native.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    readFileSync,
    readdirSync,
    existsSync,
    openSync,
    closeSync,
    mkdirSync
} from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { register } from "node:module";

// Inline mock loader so native.ts can resolve the type-only 'electron' import in Node.js
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

function createMockValidRecipe(overrides = {}) {
    return {
        format: "advrecipe",
        version: 1,
        application_id: "1536318183873454090",
        scene: "GlobalAces_MASTER",
        name: "Test Recipe",
        created: new Date().toISOString(),
        verifiedCompletion: true,
        completion: {
            version: 1,
            goal: "arise:questComplete",
            triggers: ["select:play"],
            entries: [
                {
                    name: "run:complete",
                    scope: "app",
                    args: [{ total: 0 }],
                    source: "inferred"
                }
            ],
            suppress: ["leaderboard"],
            delay_ms: 0,
            source: "recorded"
        },
        ...overrides
    };
}

// ===========================================================================
// Section 1: Concurrency and Race Condition Stress Tests
// ===========================================================================

test("CHALLENGE_C01: 50 concurrent writes to identical recipe preserve atomic integrity", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-conc-"));
    try {
        const appId = "1536318183873454090";
        const scene = "GlobalAces_MASTER";
        const totalWriters = 50;

        // Launch 50 concurrent atomic writes to the same destination
        const writePromises = Array.from({ length: totalWriters }, (_, i) => {
            const recipe = createMockValidRecipe({
                name: `Concurrent Run ${i}`,
                notes: `Payload iteration ${i}`,
                created: new Date(Date.now() + i * 10).toISOString()
            });
            return Promise.resolve().then(() => storage.atomicSaveRecipe(recipe, tmp));
        });

        const results = await Promise.all(writePromises);

        // Every write attempt must complete without crashing
        for (const res of results) {
            assert.equal(res.ok, true, `Write failed: ${res.error}`);
        }

        // Verify filesystem invariants
        const dirFiles = readdirSync(tmp);

        // 1. Zero leftover .tmp files
        const tmpFiles = dirFiles.filter(f => f.endsWith(".tmp"));
        assert.equal(tmpFiles.length, 0, `Dangling .tmp files found: ${tmpFiles.join(", ")}`);

        // 2. Exactly one destination file exists
        const recipeFiles = dirFiles.filter(f => f.endsWith(".advrecipe"));
        assert.equal(recipeFiles.length, 1, `Expected 1 .advrecipe file, found ${recipeFiles.length}`);

        // 3. File content is fully valid, uncorrupted, parseable JSON
        const targetPath = join(tmp, recipeFiles[0]);
        const content = readFileSync(targetPath, "utf-8");
        const parsed = JSON.parse(content);

        assert.equal(parsed.format, "advrecipe");
        assert.equal(parsed.version, 1);
        assert.equal(parsed.application_id, appId);
        assert.equal(parsed.scene, scene);
        assert.match(parsed.name, /^Concurrent Run \d+$/);

        // 4. Schema validation passes on final file
        const validation = recipeModule.validateRecipe(parsed);
        assert.equal(validation.valid, true, `Validation failed: ${validation.errors.join(", ")}`);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_C02: 100 concurrent writers to distinct recipes create intact files", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-conc100-"));
    try {
        const totalRecipes = 100;
        const writePromises = Array.from({ length: totalRecipes }, (_, i) => {
            const recipe = createMockValidRecipe({
                application_id: `app_${i}`,
                scene: `scene_${i}`,
                name: `Distinct Recipe ${i}`,
                created: new Date(Date.now() + i * 100).toISOString()
            });
            return storage.saveRecipeDisk(recipe, tmp);
        });

        const results = await Promise.all(writePromises);
        for (const res of results) {
            assert.equal(res.ok, true);
        }

        // All 100 files exist and zero .tmp files
        const allFiles = readdirSync(tmp);
        const tmpFiles = allFiles.filter(f => f.endsWith(".tmp"));
        assert.equal(tmpFiles.length, 0);

        const recipeFiles = allFiles.filter(f => f.endsWith(".advrecipe"));
        assert.equal(recipeFiles.length, 100);

        // Discovery lists all 100 sorted newest first
        const discovered = storage.listLocalRecipesSync(tmp);
        assert.equal(discovered.length, 100);
        // Verify newest first sorting
        for (let i = 0; i < discovered.length - 1; i++) {
            assert.ok(
                discovered[i].created >= discovered[i + 1].created,
                `Sorting violated at index ${i}: ${discovered[i].created} < ${discovered[i + 1].created}`
            );
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_C03: High read/write contention never observes half-written state", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-contention-"));
    try {
        const appId = "1536318183873454090";
        const scene = "GlobalAces_MASTER";
        const durationMs = 300;
        const startTime = Date.now();
        let writeCount = 0;
        let readCount = 0;
        const readErrors = [];

        // Seed initial file
        storage.atomicSaveRecipe(createMockValidRecipe({ name: "Initial" }), tmp);

        // Concurrent loop of simultaneous writers and readers with cooperative yields
        const writerPromise = (async () => {
            while (Date.now() - startTime < durationMs) {
                writeCount++;
                const r = createMockValidRecipe({
                    name: `Writer Version ${writeCount}`,
                    created: new Date().toISOString()
                });
                storage.atomicSaveRecipe(r, tmp);
                await new Promise(r => setImmediate(r));
            }
        })();

        const readerPromise = (async () => {
            while (Date.now() - startTime < durationMs) {
                readCount++;
                try {
                    const loaded = storage.loadRecipeDiskSync(storage.recipeFileName(appId, scene), tmp);
                    if (loaded !== null) {
                        if (loaded.format !== "advrecipe" || (!loaded.name.startsWith("Writer Version") && loaded.name !== "Initial")) {
                            readErrors.push(`Corrupted recipe read: ${JSON.stringify(loaded)}`);
                        }
                    }
                    const list = storage.listLocalRecipesSync(tmp);
                    if (list.length > 0) {
                        if (list[0].format !== "advrecipe") {
                            readErrors.push(`Corrupted list item: ${JSON.stringify(list[0])}`);
                        }
                    }
                } catch (e) {
                    readErrors.push(`Reader threw error: ${e.message}`);
                }
                await new Promise(r => setImmediate(r));
            }
        })();

        await Promise.all([writerPromise, readerPromise]);

        assert.equal(readErrors.length, 0, `Contention read errors: ${readErrors.join("; ")}`);
        assert.ok(writeCount > 10, `Expected > 10 writes, got ${writeCount}`);
        assert.ok(readCount > 10, `Expected > 10 reads, got ${readCount}`);

        // Verify zero temp files left
        const leftovers = readdirSync(tmp).filter(f => f.endsWith(".tmp"));
        assert.equal(leftovers.length, 0);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_C04: Write failure cleans up temporary files without residue", () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-failclean-"));
    try {
        const recipe = createMockValidRecipe();
        const targetPath = join(tmp, storage.recipeFileName(recipe.application_id, recipe.scene));

        // Create target and lock it exclusively on Windows
        writeFileSync(targetPath, "initial content", "utf-8");
        let fd = null;
        try {
            // Open with 'r+' without shared write on Windows
            fd = openSync(targetPath, "r+");
        } catch {
            // if lock unsupported, skip
        }

        // Even if atomicSaveRecipe fails due to OS lock, .tmp files must be deleted
        const res = storage.atomicSaveRecipe(recipe, tmp);
        if (!res.ok) {
            // If it failed, verify no .tmp was left behind
            const tmpFiles = readdirSync(tmp).filter(f => f.endsWith(".tmp"));
            assert.equal(tmpFiles.length, 0, "Orphaned .tmp files after failed write");
        }

        if (fd !== null) {
            closeSync(fd);
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_C05: Multi-process concurrent writes to same file maintain JSON integrity", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-multiproc-"));
    try {
        const numProcesses = 4;
        const writesPerProc = 15;
        const targetAppId = "1536318183873454090";
        const targetScene = "GlobalAces_MASTER";

        // Seed initial valid file
        storage.atomicSaveRecipe(createMockValidRecipe({ name: "Seed Recipe" }), tmp);

        // Child process worker script that rapidly saves to the shared directory
        const workerScript = `
            import { atomicSaveRecipe, loadRecipeDiskSync } from './adventurer/experiences/storage.ts';
            const procId = process.argv[1];
            const tmpDir = process.argv[2];
            const writes = parseInt(process.argv[3], 10);

            for (let i = 0; i < writes; i++) {
                const recipe = {
                    format: "advrecipe",
                    version: 1,
                    application_id: "${targetAppId}",
                    scene: "${targetScene}",
                    name: "Process " + procId + " Iter " + i,
                    created: new Date().toISOString(),
                    verifiedCompletion: true,
                    completion: {
                        version: 1,
                        goal: "arise:questComplete",
                        triggers: ["select:play"],
                        entries: [{ name: "run:complete", scope: "app", args: [{ proc: Number(procId), iter: i }] }],
                        suppress: ["leaderboard"],
                        source: "recorded"
                    }
                };
                atomicSaveRecipe(recipe, tmpDir);
                // Interleaved read to stress concurrent access
                loadRecipeDiskSync("${storage.recipeFileName(targetAppId, targetScene)}", tmpDir);
            }
        `;

        const childPromises = Array.from({ length: numProcesses }, (_, procIndex) => {
            return new Promise((res, rej) => {
                const child = spawn(process.execPath, [
                    "--input-type=module",
                    "-e",
                    workerScript,
                    String(procIndex),
                    tmp,
                    String(writesPerProc)
                ], { stdio: "inherit" });

                child.on("exit", (code) => {
                    if (code === 0) res();
                    else rej(new Error(`Child process ${procIndex} exited with code ${code}`));
                });
                child.on("error", rej);
            });
        });

        await Promise.all(childPromises);

        // Filesystem checks after all child processes finish
        const dirFiles = readdirSync(tmp);

        // 1. Zero leftover .tmp files from any process
        const tmpFiles = dirFiles.filter(f => f.endsWith(".tmp"));
        assert.equal(tmpFiles.length, 0, `Dangling .tmp files left: ${tmpFiles.join(", ")}`);

        // 2. Exactly one recipe file exists
        const recipeFiles = dirFiles.filter(f => f.endsWith(".advrecipe"));
        assert.equal(recipeFiles.length, 1);

        // 3. Final file content is completely intact and valid
        const content = readFileSync(join(tmp, recipeFiles[0]), "utf-8");
        const parsed = JSON.parse(content);
        assert.equal(parsed.format, "advrecipe");
        assert.equal(parsed.version, 1);
        assert.match(parsed.name, /^Process \d+ Iter \d+$/);

        // 4. Recipe model validation succeeds
        const validation = recipeModule.validateRecipe(parsed);
        assert.equal(validation.valid, true);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

// ===========================================================================
// Section 2: Storage Discovery and Listing Resilience
// ===========================================================================

test("CHALLENGE_R01: Discovery skips corrupted JSON syntax without crashing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-corrupt-"));
    try {
        writeFileSync(join(tmp, "corrupt1__scene.advrecipe"), "{ this is not json @#$%^ }", "utf-8");
        writeFileSync(join(tmp, "corrupt2__scene.json"), "[unclosed array...", "utf-8");

        const valid = createMockValidRecipe({ scene: "good_scene" });
        storage.atomicSaveRecipe(valid, tmp);

        const list = storage.listLocalRecipesSync(tmp);
        assert.equal(list.length, 1);
        assert.equal(list[0].scene, "good_scene");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_R02: Discovery skips truncated EOF JSON files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-trunc-"));
    try {
        writeFileSync(join(tmp, "trunc__scene.advrecipe"), '{"format": "advrecipe", "version":', "utf-8");
        const valid = createMockValidRecipe();
        storage.atomicSaveRecipe(valid, tmp);

        const list = storage.listLocalRecipesSync(tmp);
        assert.equal(list.length, 1);
        assert.equal(list[0].name, "Test Recipe");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_R03: Discovery skips zero-byte files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-zero-"));
    try {
        writeFileSync(join(tmp, "empty__scene.advrecipe"), "", "utf-8");
        writeFileSync(join(tmp, "empty__scene.json"), "", "utf-8");
        const valid = createMockValidRecipe();
        storage.atomicSaveRecipe(valid, tmp);

        const list = storage.listLocalRecipesSync(tmp);
        assert.equal(list.length, 1);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_R04: Discovery ignores non-recipe extensions and directory noise", () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-noise-"));
    try {
        writeFileSync(join(tmp, "notes.txt"), "some notes", "utf-8");
        writeFileSync(join(tmp, "readme.md"), "# Readme", "utf-8");
        writeFileSync(join(tmp, "data.bin"), Buffer.from([0x00, 0x01, 0x02]));
        writeFileSync(join(tmp, "backup.advrecipe.bak"), "{}", "utf-8");
        writeFileSync(join(tmp, ".DS_Store"), "noise", "utf-8");
        writeFileSync(join(tmp, "pending.tmp"), "temp data", "utf-8");

        const valid = createMockValidRecipe();
        storage.atomicSaveRecipe(valid, tmp);

        const list = storage.listLocalRecipesSync(tmp);
        assert.equal(list.length, 1);
        assert.equal(list[0].application_id, "1536318183873454090");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_R05: Discovery safely handles subdirectory ending with .advrecipe", () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-dir-"));
    try {
        mkdirSync(join(tmp, "fake_dir__scene.advrecipe"));
        mkdirSync(join(tmp, "fake_dir__scene.json"));

        const valid = createMockValidRecipe();
        storage.atomicSaveRecipe(valid, tmp);

        // Must not throw EISDIR or EPERM
        const list = storage.listLocalRecipesSync(tmp);
        assert.equal(list.length, 1);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_R06: Discovery skips JSON primitive values", () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-prims-"));
    try {
        writeFileSync(join(tmp, "null__scene.advrecipe"), "null", "utf-8");
        writeFileSync(join(tmp, "number__scene.advrecipe"), "12345", "utf-8");
        writeFileSync(join(tmp, "string__scene.advrecipe"), '"just string"', "utf-8");
        writeFileSync(join(tmp, "bool__scene.advrecipe"), "true", "utf-8");

        const valid = createMockValidRecipe();
        storage.atomicSaveRecipe(valid, tmp);

        const list = storage.listLocalRecipesSync(tmp);
        assert.equal(list.length, 1);
        assert.equal(list[0].name, "Test Recipe");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_R07: Discovery de-duplication: .advrecipe takes precedence over legacy .json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-dedup-"));
    try {
        const recipeAdv = createMockValidRecipe({ name: "AdvRecipe Winner", created: "2026-11-08T00:00:00Z" });
        const recipeJson = createMockValidRecipe({ name: "Legacy Loser", created: "2026-11-07T00:00:00Z" });

        writeFileSync(join(tmp, "1536318183873454090__GlobalAces_MASTER.advrecipe"), JSON.stringify(recipeAdv), "utf-8");
        writeFileSync(join(tmp, "1536318183873454090__GlobalAces_MASTER.json"), JSON.stringify(recipeJson), "utf-8");

        const list = storage.listLocalRecipesSync(tmp);
        assert.equal(list.length, 1);
        assert.equal(list[0].name, "AdvRecipe Winner");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_R08: loadRecipeDisk returns null on missing, invalid, or traversal paths", async () => {
    assert.equal(await storage.loadRecipeDisk("non_existent_recipe_path"), null);
    assert.equal(await storage.loadRecipeDisk(""), null);

    const tmp = mkdtempSync(join(tmpdir(), "adv-loadfail-"));
    try {
        const corruptPath = join(tmp, "corrupt.advrecipe");
        writeFileSync(corruptPath, "{ bad json", "utf-8");
        assert.equal(await storage.loadRecipeDisk(corruptPath), null);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_R09: deleteRecipeDiskSync handles non-existent and safe paths gracefully", () => {
    assert.equal(storage.deleteRecipeDiskSync("does_not_exist"), false);
    assert.equal(storage.deleteRecipeDiskSync(""), false);

    const tmp = mkdtempSync(join(tmpdir(), "adv-delfail-"));
    try {
        const recipe = createMockValidRecipe();
        const saved = storage.atomicSaveRecipe(recipe, tmp);
        assert.equal(saved.ok, true);

        // Delete existing
        assert.equal(storage.deleteRecipeDiskSync(saved.path, tmp), true);
        // Delete again (idempotent false)
        assert.equal(storage.deleteRecipeDiskSync(saved.path, tmp), false);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_R10: isSafePath prevents directory traversal attacks across systems", () => {
    const base = resolve("C:\\mock\\base");
    assert.equal(storage.isSafePath(base, resolve("C:\\mock\\base\\recipe.advrecipe")), true);
    assert.equal(storage.isSafePath(base, resolve("C:\\mock\\base\\sub\\recipe.advrecipe")), true);
    assert.equal(storage.isSafePath(base, resolve("C:\\mock\\other\\recipe.advrecipe")), false);
    assert.equal(storage.isSafePath(base, resolve("C:\\mock\\base\\..\\evil.advrecipe")), false);
});

// ===========================================================================
// Section 3: Native Process Bridge (native.ts) Parity Tests
// ===========================================================================

test("CHALLENGE_N01: native.ts IPC handlers roundtrip in isolated profile directory", async () => {
    const mockEvent = {};
    const recipe = createMockValidRecipe({ name: "Native Test Recipe" });

    // Save recipe via native bridge
    const saveRes = await native.saveRecipe(mockEvent, recipe);
    assert.equal(saveRes.ok, true, `native.saveRecipe failed: ${saveRes.error}`);
    assert.ok(existsSync(saveRes.path));

    try {
        // Load recipe via identifier
        const loadRes = await native.loadRecipe(mockEvent, `${recipe.application_id}__${recipe.scene}`);
        assert.equal(loadRes.ok, true);
        assert.equal(loadRes.recipe.name, "Native Test Recipe");

        // Load recipe via absolute path
        const loadAbsRes = await native.loadRecipe(mockEvent, saveRes.path);
        assert.equal(loadAbsRes.ok, true);
        assert.equal(loadAbsRes.recipe.application_id, recipe.application_id);

        // List recipes via native bridge
        const listRes = await native.listRecipes(mockEvent, recipe.application_id);
        assert.ok(Array.isArray(listRes));
        assert.ok(listRes.some(r => r.name === "Native Test Recipe"));

        // Delete recipe via native bridge
        const delRes = await native.deleteRecipe(mockEvent, `${recipe.application_id}__${recipe.scene}`);
        assert.equal(delRes.ok, true);
        assert.equal(existsSync(saveRes.path), false);
    } finally {
        if (existsSync(saveRes.path)) {
            rmSync(saveRes.path, { force: true });
        }
    }
});

test("CHALLENGE_N02: native.ts rejects directory traversal attacks in load and delete", async () => {
    const mockEvent = {};

    // Traversal on load
    const loadTraversal = await native.loadRecipe(mockEvent, "../../../Windows/win.ini");
    assert.equal(loadTraversal.ok, false);
    assert.match(loadTraversal.error, /(Access denied|not found)/i);

    // Absolute outside allowed recipe dirs
    const loadOutside = await native.loadRecipe(mockEvent, resolve("C:/Windows/win.ini"));
    assert.equal(loadOutside.ok, false);
    assert.match(loadOutside.error, /Access denied/i);

    // Deletion outside allowed recipe dir
    const delOutside = await native.deleteRecipe(mockEvent, resolve("C:/Windows/System32/drivers/etc/hosts"));
    assert.equal(delOutside.ok, false);
    assert.match(delOutside.error, /Access denied/i);
});

// ===========================================================================
// Section 4: Zero DataStore Compliance Verification
// ===========================================================================

test("CHALLENGE_D01: Zero DataStore / Web Storage API calls during persistence lifecycle", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-datastore-"));
    let storageAccessCount = 0;

    // Install poison spies on all Discord/Vencord and Web Storage APIs
    const originalVencord = globalThis.Vencord;
    const originalWindow = globalThis.window;

    globalThis.Vencord = {
        Plugins: {
            plugins: {
                DataStore: new Proxy({}, {
                    get(_target, prop) {
                        storageAccessCount++;
                        throw new Error(`VIOLATION: DataStore.${String(prop)} called!`);
                    }
                })
            }
        }
    };

    const poisonStorage = new Proxy({}, {
        get(_target, prop) {
            storageAccessCount++;
            throw new Error(`VIOLATION: WebStorage.${String(prop)} called!`);
        }
    });

    globalThis.localStorage = poisonStorage;
    globalThis.sessionStorage = poisonStorage;
    globalThis.indexedDB = poisonStorage;

    try {
        const recipe = createMockValidRecipe({ name: "Zero DataStore Recipe" });

        // 1. Save
        const saveRes = await storage.saveRecipeDisk(recipe, tmp);
        assert.equal(saveRes.ok, true);

        // 2. Load
        const loaded = await storage.loadRecipeDisk(saveRes.path, tmp);
        assert.equal(loaded?.name, "Zero DataStore Recipe");

        // 3. List
        const list = await storage.listLocalRecipes(tmp);
        assert.equal(list.length, 1);

        // 4. Delete
        const delOk = await storage.deleteRecipeDisk(saveRes.path, tmp);
        assert.equal(delOk, true);

        // Zero calls to any storage API
        assert.equal(storageAccessCount, 0, `Expected 0 DataStore/WebStorage calls, got ${storageAccessCount}`);
    } finally {
        globalThis.Vencord = originalVencord;
        delete globalThis.localStorage;
        delete globalThis.sessionStorage;
        delete globalThis.indexedDB;
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("CHALLENGE_D02: Static analysis verifies zero DataStore or WebStorage in userplugin code", () => {
    const adventurerDir = resolve("adventurer");
    const violations = [];

    function scanDir(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                scanDir(full);
            } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes("test")) {
                const lines = readFileSync(full, "utf-8").split("\n");
                lines.forEach((line, idx) => {
                    // Ignore comment lines
                    const trimmed = line.trim();
                    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
                        return;
                    }
                    if (/\bDataStore\b/.test(line)) {
                        violations.push(`${full}:${idx + 1}: DataStore reference found: ${trimmed}`);
                    }
                    if (/\b(localStorage|sessionStorage|indexedDB)\b/.test(line)) {
                        violations.push(`${full}:${idx + 1}: WebStorage reference found: ${trimmed}`);
                    }
                });
            }
        }
    }

    scanDir(adventurerDir);
    assert.deepEqual(violations, [], `Storage violations in source files:\n${violations.join("\n")}`);
});
