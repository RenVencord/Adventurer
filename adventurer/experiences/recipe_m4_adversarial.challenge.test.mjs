// adventurer/experiences/recipe_m4_adversarial.challenge.test.mjs
// Milestone 4 Challenger 2 Adversarial Stress Suite:
// Edge cases, failure recovery, storage boundaries, and execution protocols.
// Run with: node --test adventurer/experiences/recipe_m4_adversarial.challenge.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register, createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// ============================================================================
// ESM Loader Registration for .tsx transpilation & Webpack mocks in Node.js
// ============================================================================

const vencordPkgPath = "C:/Users/Serenity/Documents/Vencord/package.json";
const requireVencord = createRequire(vencordPkgPath);
const esbuildPath = requireVencord.resolve("esbuild");

register("data:text/javascript," + encodeURIComponent(`
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(${JSON.stringify(vencordPkgPath)});
const esbuild = require(${JSON.stringify(esbuildPath)});

export async function resolve(specifier, context, next) {
    if (specifier === "@webpack/common" || specifier === "react") {
        return {
            url: "data:text/javascript,export const React = globalThis.React || { useReducer: (r, i) => [i, () => {}], useState: (s) => [s, () => {}], useEffect: () => {}, useCallback: (f) => f }; export default React; export const useReducer = React.useReducer; export const useState = React.useState; export const useEffect = React.useEffect; export const useCallback = React.useCallback; export const FluxDispatcher = {}; export const UserStore = {}; export const RestAPI = globalThis.__mockRestApi || {}; export const showToast = (opts) => { if (typeof globalThis.__onToast === 'function') globalThis.__onToast(opts); };",
            shortCircuit: true
        };
    }
    if (specifier === "@webpack") {
        return {
            url: "data:text/javascript,export const findByProps = (...props) => null; export const find = (fn) => null; export const findStoreLazy = () => null;",
            shortCircuit: true
        };
    }
    if (specifier === "@components/Button") {
        return {
            url: "data:text/javascript,export const Button = (props) => (globalThis.React.createElement ? globalThis.React.createElement('button', props, props.children) : { type: 'button', props }); export default Button;",
            shortCircuit: true
        };
    }
    if (specifier === "@api/MessageAccessories") {
        return {
            url: "data:text/javascript,export const accessories = new Map(); export const addMessageAccessory = (id, render, pos) => accessories.set(id, { render, pos }); export const removeMessageAccessory = (id) => accessories.delete(id);",
            shortCircuit: true
        };
    }
    if (specifier === "electron") {
        return {
            url: "data:text/javascript,export class IpcMainInvokeEvent {}; export class WebContents {}; export class WebFrameMain {};",
            shortCircuit: true
        };
    }
    return next(specifier, context);
}

export async function load(url, context, next) {
    if (url.endsWith(".tsx")) {
        const raw = readFileSync(fileURLToPath(url), "utf8");
        const transformed = esbuild.transformSync(raw, {
            loader: "tsx",
            format: "esm",
            target: "node22",
            jsx: "transform"
        });
        return {
            format: "module",
            source: transformed.code,
            shortCircuit: true
        };
    }
    return next(url, context);
}
`));

globalThis.React = {
    createElement(type, props, ...children) {
        return { type, props: { ...props, children } };
    },
    useReducer(reducer, initial) {
        let state = initial;
        return [state, (action) => { state = reducer(state, action); }];
    },
    useState(initial) {
        let state = typeof initial === "function" ? initial() : initial;
        return [state, (next) => {
            state = typeof next === "function" ? next(state) : next;
        }];
    },
    useEffect(fn) {
        // no-op in node unit test runner
    },
    useCallback(fn) {
        return fn;
    }
};

// ============================================================================
// Production Module Imports
// ============================================================================

import {
    validateRecipe
} from "./recipe.ts";

import {
    saveRecipeDisk,
    loadRecipeDisk,
    listLocalRecipes,
    deleteRecipeDisk,
    recipeFileName
} from "./storage.ts";

import {
    COMPLETION_MESSAGE_TAG,
    ADVENTURER_EXECUTE_RECIPE_TYPE,
    buildExecuteRecipeMessage
} from "./completion.ts";

const recipeAccessoryModule = await import("../components/RecipeAccessory.tsx");
const {
    RecipeAccessory,
    RecipeAccessoryCard,
    renderRecipeAccessory,
    isRecipeAttachment,
    getRecipeAttachments,
    getCardHeader,
    renderAccessoryDom,
    parseRecipeContent,
    fetchRecipeAttachment,
    importRecipe,
    executeRecipe
} = recipeAccessoryModule;

// ============================================================================
// Fixtures
// ============================================================================

function createValidRecipe(overrides = {}) {
    return {
        format: "advrecipe",
        version: 1,
        application_id: "1536318183873454090",
        scene: "GlobalAces_MASTER",
        name: "VALORANT Aces Speedrun",
        created: "2026-11-08T00:00:00.000Z",
        verifiedCompletion: true,
        completion: {
            version: 1,
            goal: "arise:questComplete",
            triggers: ["select:play"],
            entries: [
                { name: "select:play", scope: "app" },
                { name: "target:eliminated", scope: "app" }
            ],
            suppress: ["leaderboard"],
            delay_ms: 100
        },
        ...overrides
    };
}

// ============================================================================
// SUITE 1: Payload Boundaries (10MB, 10MB+1, 0B, Whitespace)
// ============================================================================

test("M4_ADV_01: Exact 10MB boundary (10,485,760 bytes) is accepted by fetchRecipeAttachment", async () => {
    const recipe = createValidRecipe({ name: "Exact 10MB Boundary Quest" });
    const jsonStr = JSON.stringify(recipe);
    const targetSize = 10 * 1024 * 1024; // 10,485,760 bytes
    assert.equal(targetSize, 10485760);

    // Pad with whitespace to reach exact 10,485,760 bytes
    const padLength = targetSize - jsonStr.length;
    assert.ok(padLength > 0, "Base JSON must be smaller than 10MB");
    const exact10MbPayload = jsonStr + " ".repeat(padLength);
    assert.equal(exact10MbPayload.length, 10485760);

    const origFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response(exact10MbPayload, {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });

        const att = {
            filename: "exact_10mb.advrecipe",
            size: 10485760,
            url: "https://cdn.discordapp.com/attachments/123/exact_10mb.advrecipe"
        };

        const result = await fetchRecipeAttachment(att);
        assert.ok(result, "Should successfully load exact 10MB recipe");
        assert.equal(result.name, "Exact 10MB Boundary Quest");
        assert.equal(result.application_id, "1536318183873454090");
        assert.equal(result.verifiedCompletion, true);
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("M4_ADV_02: Exact 10MB boundary (10,485,760 bytes) in RecipeAccessoryCard enters ready state", () => {
    const recipe = createValidRecipe({ name: "Card 10MB Test" });
    const jsonStr = JSON.stringify(recipe);
    const exact10MbPayload = jsonStr + " ".repeat(10485760 - jsonStr.length);
    assert.equal(exact10MbPayload.length, 10485760);

    const vdom = RecipeAccessoryCard({
        attachment: {
            filename: "exact_10mb.advrecipe",
            size: 10485760,
            content: exact10MbPayload
        }
    });

    assert.equal(vdom.type, "div");
    assert.equal(vdom.props.className, "adventurer-recipe-card");
    assert.ok(JSON.stringify(vdom).includes("VERIFIED RECIPE"));
});

test("M4_ADV_03: 10MB + 1 byte (10,485,761 bytes) metadata size rejected before fetch", async () => {
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => {
            fetchCalled = true;
            return new Response("{}", { status: 200 });
        };

        const att = {
            filename: "oversized_metadata.advrecipe",
            size: 10485761, // 10MB + 1 byte
            url: "https://cdn.discordapp.com/attachments/123/oversized.advrecipe"
        };

        await assert.rejects(
            async () => await fetchRecipeAttachment(att),
            {
                name: "Error",
                message: "Recipe file exceeds 10MB limit"
            }
        );
        assert.equal(fetchCalled, false, "Pre-flight size check must prevent network fetch");
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("M4_ADV_04: 10MB + 1 byte (10,485,761 bytes) payload rejected during download", async () => {
    const oversizedPayload = "x".repeat(10485761);
    const origFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response(oversizedPayload, { status: 200 });

        const att = {
            filename: "lied_size.advrecipe",
            size: 500, // metadata lied
            url: "https://cdn.discordapp.com/attachments/123/lied_size.advrecipe"
        };

        await assert.rejects(
            async () => await fetchRecipeAttachment(att),
            {
                name: "Error",
                message: "Recipe file exceeds 10MB limit"
            }
        );
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("M4_ADV_05: 10MB + 1 byte in RecipeAccessoryCard renders oversized error card", () => {
    const vdom = RecipeAccessoryCard({
        attachment: {
            filename: "oversized.advrecipe",
            size: 10485761
        }
    });

    const jsonString = JSON.stringify(vdom);
    assert.ok(jsonString.includes("RECIPE ERROR"));
    assert.ok(jsonString.includes("Recipe file exceeds 10MB limit"), "Error card must mention 10MB limit");
});

test("M4_ADV_06: 0-byte attachment metadata rejected before fetch and in card", async () => {
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => {
            fetchCalled = true;
            return new Response("", { status: 200 });
        };

        const att = {
            filename: "zero.advrecipe",
            size: 0,
            url: "https://cdn.discordapp.com/attachments/123/zero.advrecipe"
        };

        await assert.rejects(
            async () => await fetchRecipeAttachment(att),
            {
                name: "Error",
                message: "Empty attachment file"
            }
        );
        assert.equal(fetchCalled, false, "0-byte size check must short-circuit network fetch");
    } finally {
        globalThis.fetch = origFetch;
    }

    const vdom = RecipeAccessoryCard({
        attachment: {
            filename: "zero.advrecipe",
            size: 0
        }
    });
    const jsonString = JSON.stringify(vdom);
    assert.ok(jsonString.includes("RECIPE ERROR"));
    assert.ok(jsonString.includes("Empty attachment file"));
});

test("M4_ADV_07: 0-byte downloaded payload rejected by fetchRecipeAttachment", async () => {
    const origFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response("", { status: 200 });

        const att = {
            filename: "empty_stream.advrecipe",
            size: 100, // metadata claims 100 bytes, but body is empty
            url: "https://cdn.discordapp.com/attachments/123/empty.advrecipe"
        };

        await assert.rejects(
            async () => await fetchRecipeAttachment(att),
            {
                name: "Error",
                message: "Empty attachment file"
            }
        );
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("M4_ADV_08: Whitespace-only attachment content rejected safely", async () => {
    const whitespaceInputs = [
        "",
        " ",
        "   \t\n   ",
        "\r\n\r\n\t \t\r\n"
    ];

    for (const ws of whitespaceInputs) {
        assert.throws(
            () => parseRecipeContent(ws),
            {
                name: "Error",
                message: "Empty attachment file"
            }
        );

        await assert.rejects(
            async () => await fetchRecipeAttachment({
                filename: "ws.advrecipe",
                content: ws
            }),
            {
                name: "Error",
                message: "Empty attachment file"
            }
        );

        const vdom = RecipeAccessoryCard({
            attachment: {
                filename: "ws.advrecipe",
                content: ws
            }
        });
        const vdomJson = JSON.stringify(vdom);
        assert.ok(vdomJson.includes("RECIPE ERROR"));
        assert.ok(vdomJson.includes("Empty attachment file"));
    }
});

// ============================================================================
// SUITE 2: Storage Idempotency & Overwrite Stress
// ============================================================================

test("M4_ADV_09: 20 sequential overwrites of exact same recipe verify zero corruption, zero tmp leaks, and atomic rename", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "adv-m4-idempotency-"));

    try {
        const baseRecipe = createValidRecipe({
            application_id: "idempotent-app-42",
            scene: "IdempotentScene_01",
            name: "Idempotent Quest"
        });

        const expectedFileName = recipeFileName("idempotent-app-42", "IdempotentScene_01");

        for (let i = 1; i <= 20; i++) {
            const recipeIter = {
                ...baseRecipe,
                created: new Date(1700000000000 + i * 1000).toISOString(),
                notes: `Sequential write pass ${i} of 20`
            };

            const saveRes = await importRecipe(recipeIter, tempDir);
            assert.equal(saveRes.ok, true, `Save iteration ${i} must succeed`);
            assert.ok(saveRes.path, `Iteration ${i} must return target path`);
            assert.ok(existsSync(saveRes.path), `Iteration ${i} file must exist`);

            // Verify zero temporary files left behind
            const dirFiles = readdirSync(tempDir);
            const tmpFiles = dirFiles.filter(f => f.endsWith(".tmp"));
            assert.equal(tmpFiles.length, 0, `Iteration ${i} must leak zero .tmp files`);
            assert.equal(dirFiles.length, 1, `Iteration ${i} must maintain exactly 1 file in directory`);
            assert.equal(dirFiles[0], expectedFileName);

            // Read back and verify zero corruption and accurate iteration content
            const loaded = await loadRecipeDisk(saveRes.path, tempDir);
            assert.ok(loaded, `Iteration ${i} must load back cleanly`);
            assert.equal(loaded.notes, `Sequential write pass ${i} of 20`);
            assert.equal(loaded.name, "Idempotent Quest");

            const val = validateRecipe(loaded);
            assert.equal(val.valid, true, `Iteration ${i} reloaded recipe must pass validation`);
        }

        // Final directory verification
        const finalListing = await listLocalRecipes(tempDir);
        assert.equal(finalListing.length, 1, "Directory must have exactly 1 recipe after 20 overwrites");
        assert.equal(finalListing[0].notes, "Sequential write pass 20 of 20");
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("M4_ADV_10: Rapid concurrent overwrites maintain atomic consistency without .tmp leaks", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "adv-m4-concurrent-"));

    try {
        const baseRecipe = createValidRecipe({
            application_id: "concurrent-app-99",
            scene: "ConcurrentScene",
            name: "Concurrent Test"
        });

        // Launch 10 simultaneous saves
        const promises = Array.from({ length: 10 }, (_, i) => {
            const r = {
                ...baseRecipe,
                notes: `Concurrent write ${i}`
            };
            return importRecipe(r, tempDir);
        });

        const results = await Promise.all(promises);
        for (const res of results) {
            assert.equal(res.ok, true);
        }

        const dirFiles = readdirSync(tempDir);
        const tmpFiles = dirFiles.filter(f => f.endsWith(".tmp"));
        assert.equal(tmpFiles.length, 0, "Concurrent writes must leak zero .tmp files");

        const listing = await listLocalRecipes(tempDir);
        assert.equal(listing.length, 1, "Must maintain exactly 1 file on disk");
        assert.ok(listing[0].notes.startsWith("Concurrent write"));
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("M4_ADV_11: Path traversal attacks in importRecipe are sanitized to safe slug names", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "adv-m4-traversal-"));

    try {
        const evilRecipe = createValidRecipe({
            application_id: "../../../etc/passwd",
            scene: "..\\..\\windows\\system32\\calc.exe",
            name: "Traversal Attack"
        });

        const res = await importRecipe(evilRecipe, tempDir);
        assert.equal(res.ok, true);
        assert.ok(res.path.startsWith(tempDir), "Saved path must be safely confined inside customDir");

        const dirFiles = readdirSync(tempDir);
        assert.equal(dirFiles.length, 1);
        assert.ok(!dirFiles[0].includes("/"), "Filename must not contain forward slashes");
        assert.ok(!dirFiles[0].includes("\\"), "Filename must not contain backslashes");
        assert.ok(!dirFiles[0].includes(".."), "Filename must not contain dot-dot");
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

// ============================================================================
// SUITE 3: Network Failure, Timeout & Retry Recovery
// ============================================================================

test("M4_ADV_12: Simulated CDN network timeout surfaces formatted error", async () => {
    const origFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => {
            throw new TypeError("fetch failed: socket hang up");
        };

        const att = {
            filename: "timeout.advrecipe",
            size: 1024,
            url: "https://cdn.discordapp.com/timeout.advrecipe"
        };

        await assert.rejects(
            async () => await fetchRecipeAttachment(att),
            {
                name: "Error",
                message: "Network timeout: fetch failed: socket hang up"
            }
        );
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("M4_ADV_13: HTTP 403 expired signature surfaces forbidden error", async () => {
    const origFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response("Signature Expired", {
            status: 403,
            statusText: "Forbidden"
        });

        const att = {
            filename: "expired.advrecipe",
            size: 1024,
            url: "https://cdn.discordapp.com/expired.advrecipe?ex=672d"
        };

        await assert.rejects(
            async () => await fetchRecipeAttachment(att),
            {
                name: "Error",
                message: "Failed to download attachment: Forbidden"
            }
        );
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("M4_ADV_14: HTTP 500 CDN server error surfaces internal server error", async () => {
    const origFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response("Server Outage", {
            status: 500,
            statusText: "Internal Server Error"
        });

        const att = {
            filename: "server_err.advrecipe",
            size: 1024,
            url: "https://cdn.discordapp.com/server_err.advrecipe"
        };

        await assert.rejects(
            async () => await fetchRecipeAttachment(att),
            {
                name: "Error",
                message: "Failed to download attachment: Internal Server Error"
            }
        );
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("M4_ADV_15: Network failure followed by successful retry recovers cleanly", async () => {
    let callCount = 0;
    const recipe = createValidRecipe({ name: "Recovered Quest" });
    const origFetch = globalThis.fetch;

    try {
        globalThis.fetch = async () => {
            callCount++;
            if (callCount === 1) {
                // First call fails
                throw new Error("Temporary network glitch");
            }
            // Second call succeeds
            return new Response(JSON.stringify(recipe), { status: 200 });
        };

        const att = {
            filename: "flaky.advrecipe",
            size: 1024,
            url: "https://cdn.discordapp.com/flaky.advrecipe"
        };

        // 1. Initial attempt fails
        await assert.rejects(
            async () => await fetchRecipeAttachment(att),
            {
                name: "Error",
                message: "Network timeout: Temporary network glitch"
            }
        );
        assert.equal(callCount, 1);

        // 2. Retry attempt succeeds
        const recovered = await fetchRecipeAttachment(att);
        assert.equal(callCount, 2);
        assert.ok(recovered);
        assert.equal(recovered.name, "Recovered Quest");
        assert.equal(recovered.verifiedCompletion, true);
    } finally {
        globalThis.fetch = origFetch;
    }
});

test("M4_ADV_16: Missing attachment URL or proxy_url throws immediately", async () => {
    const att = {
        filename: "missing_url.advrecipe",
        size: 500
    };

    await assert.rejects(
        async () => await fetchRecipeAttachment(att),
        {
            name: "Error",
            message: "Attachment URL is missing"
        }
    );
});

// ============================================================================
// SUITE 4: Cross-Origin Message Payload Conformance
// ============================================================================

test("M4_ADV_17: executeRecipe dispatches both completion_inject and ADVENTURER_EXECUTE_RECIPE messages", () => {
    const recipe = createValidRecipe({ name: "Cross-Origin Execution Quest" });
    const expectedExecuteMsg = buildExecuteRecipeMessage(recipe);

    const frame1Messages = [];
    const frame2Messages = [];
    const evilFrameMessages = [];
    const windowMessages = [];

    const mockFrame1 = {
        src: "https://1536318183873454090.discordsays.com/activity",
        contentWindow: {
            postMessage(msg, origin) {
                frame1Messages.push({ msg, origin });
            }
        }
    };

    const mockFrame2 = {
        src: "https://discordsays.com/embed",
        contentWindow: {
            postMessage(msg, origin) {
                frame2Messages.push({ msg, origin });
            }
        }
    };

    const mockEvilFrame = {
        src: "https://evil-phishing-discordsays.com.attacker.com/malware",
        contentWindow: {
            postMessage(msg, origin) {
                evilFrameMessages.push({ msg, origin });
            }
        }
    };

    const origDoc = globalThis.document;
    const origWin = globalThis.window;

    try {
        globalThis.document = {
            querySelectorAll(selector) {
                if (selector === "iframe") {
                    return [mockFrame1, mockFrame2, mockEvilFrame];
                }
                return [];
            }
        };

        globalThis.window = {
            postMessage(msg, origin) {
                windowMessages.push({ msg, origin });
            }
        };

        const result = executeRecipe(recipe);

        // 1. Verify return value
        assert.deepEqual(result, {
            type: "completion_inject",
            recipe,
            execute: true
        });

        // 2. Verify Frame 1 received exactly 2 payloads matching specifications
        assert.equal(frame1Messages.length, 2, "Matching frame 1 must receive exactly 2 messages");
        assert.deepEqual(frame1Messages[0], {
            msg: {
                type: "completion_inject",
                recipe,
                execute: true
            },
            origin: "*"
        });
        assert.deepEqual(frame1Messages[1], {
            msg: {
                [COMPLETION_MESSAGE_TAG]: true,
                type: ADVENTURER_EXECUTE_RECIPE_TYPE,
                recipe,
                execute: true
            },
            origin: "*"
        });

        // 3. Verify Frame 2 received identical 2 messages
        assert.equal(frame2Messages.length, 2, "Matching frame 2 must receive exactly 2 messages");
        assert.deepEqual(frame2Messages[0].msg.type, "completion_inject");
        assert.deepEqual(frame2Messages[1].msg.type, "ADVENTURER_EXECUTE_RECIPE");

        // 4. Verify Evil Frame received ZERO messages (origin regex strictly guards)
        assert.equal(evilFrameMessages.length, 0, "Attacker frame must receive zero messages");

        // 5. Verify Window broadcast
        assert.equal(windowMessages.length, 2, "Window must receive broadcast messages");
        assert.deepEqual(windowMessages[0].msg.type, "completion_inject");
        assert.deepEqual(windowMessages[1].msg.type, "ADVENTURER_EXECUTE_RECIPE");
    } finally {
        globalThis.document = origDoc;
        globalThis.window = origWin;
    }
});

test("M4_ADV_18: executeRecipe with broadcastWindow: false suppresses window messages", () => {
    const recipe = createValidRecipe();
    const windowMessages = [];

    const origDoc = globalThis.document;
    const origWin = globalThis.window;

    try {
        globalThis.document = {
            querySelectorAll: () => []
        };
        globalThis.window = {
            postMessage(msg) {
                windowMessages.push(msg);
            }
        };

        executeRecipe(recipe, { broadcastWindow: false });
        assert.equal(windowMessages.length, 0, "Window postMessage must be suppressed when broadcastWindow is false");
    } finally {
        globalThis.document = origDoc;
        globalThis.window = origWin;
    }
});

// ============================================================================
// SUITE 5: Execution Without Active Game Frame
// ============================================================================

test("M4_ADV_19: executeRecipe executes gracefully when no iframes exist in DOM", () => {
    const recipe = createValidRecipe();
    const origDoc = globalThis.document;

    try {
        globalThis.document = {
            querySelectorAll(sel) {
                return [];
            }
        };

        assert.doesNotThrow(() => {
            const res = executeRecipe(recipe);
            assert.equal(res.type, "completion_inject");
        });
    } finally {
        globalThis.document = origDoc;
    }
});

test("M4_ADV_20: executeRecipe executes gracefully in headless environment where document is undefined", () => {
    const recipe = createValidRecipe();
    const origDoc = globalThis.document;
    const origWin = globalThis.window;

    try {
        delete globalThis.document;
        delete globalThis.window;

        assert.doesNotThrow(() => {
            const res = executeRecipe(recipe);
            assert.equal(res.type, "completion_inject");
            assert.equal(res.execute, true);
        });
    } finally {
        globalThis.document = origDoc;
        globalThis.window = origWin;
    }
});

test("M4_ADV_21: executeRecipe handles malformed iframe src without throwing", () => {
    const recipe = createValidRecipe();
    const origDoc = globalThis.document;

    try {
        globalThis.document = {
            querySelectorAll(sel) {
                return [
                    { src: null, contentWindow: { postMessage: () => {} } },
                    { src: "", contentWindow: { postMessage: () => {} } },
                    { src: "about:blank", contentWindow: { postMessage: () => {} } },
                    { src: "not a valid url", contentWindow: { postMessage: () => {} } }
                ];
            }
        };

        assert.doesNotThrow(() => {
            executeRecipe(recipe);
        });
    } finally {
        globalThis.document = origDoc;
    }
});

test("M4_ADV_22: isRecipeAttachment returns false for null, non-objects, and non-.advrecipe extensions", () => {
    assert.equal(isRecipeAttachment(null), false);
    assert.equal(isRecipeAttachment(undefined), false);
    assert.equal(isRecipeAttachment(""), false);
    assert.equal(isRecipeAttachment(123), false);
    assert.equal(isRecipeAttachment({}), false);
    assert.equal(isRecipeAttachment({ filename: "notes.txt" }), false);
    assert.equal(isRecipeAttachment({ filename: "image.png" }), false);
    assert.equal(isRecipeAttachment({ filename: "recipe.json" }), false);
    assert.equal(isRecipeAttachment({ filename: "advrecipe" }), false);

    // Case-insensitivity support
    assert.equal(isRecipeAttachment({ filename: "quest.advrecipe" }), true);
    assert.equal(isRecipeAttachment({ filename: "quest.ADVRECIPE" }), true);
    assert.equal(isRecipeAttachment({ filename: "quest.AdvRecipe" }), true);
});

test("M4_ADV_23: getRecipeAttachments filters out non-recipe attachments cleanly", () => {
    const message = {
        attachments: [
            { filename: "cat.png", size: 100 },
            { filename: "speedrun.advrecipe", size: 200 },
            { filename: "guide.pdf", size: 300 },
            { filename: "bonus.ADVRECIPE", size: 400 }
        ]
    };

    const recipes = getRecipeAttachments(message);
    assert.equal(recipes.length, 2);
    assert.equal(recipes[0].filename, "speedrun.advrecipe");
    assert.equal(recipes[1].filename, "bonus.ADVRECIPE");
});

test("M4_ADV_24: RecipeAccessory returns null when message has no .advrecipe attachments", () => {
    assert.equal(RecipeAccessory(null), null);
    assert.equal(RecipeAccessory({}), null);
    assert.equal(RecipeAccessory({ message: null }), null);
    assert.equal(RecipeAccessory({ message: { attachments: [] } }), null);
    assert.equal(RecipeAccessory({ message: { attachments: [{ filename: "shot.png" }] } }), null);
});

test("M4_ADV_25: renderRecipeAccessory delegates to RecipeAccessory safely", () => {
    assert.equal(renderRecipeAccessory(null), null);
    assert.equal(renderRecipeAccessory({}), null);

    const validMessage = {
        attachments: [
            {
                filename: "quest.advrecipe",
                content: JSON.stringify(createValidRecipe())
            }
        ]
    };

    const rendered = renderRecipeAccessory({ message: validMessage });
    assert.ok(rendered);
    assert.equal(rendered.type, RecipeAccessory);
    assert.equal(rendered.props.message, validMessage);

    const container = RecipeAccessory(rendered.props);
    assert.ok(container);
    assert.equal(container.type, "div");
    assert.equal(container.props.className, "adventurer-recipe-accessories-container");
});
