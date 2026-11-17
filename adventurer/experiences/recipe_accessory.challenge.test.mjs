// adventurer/experiences/recipe_accessory.challenge.test.mjs
// Adversarial Stress Test Suite for Milestone 4:
// - Concurrency & double-click protection (Import / Execute)
// - Malformed / corrupted inputs (empty strings, truncated JSON, invalid types, extreme lengths)
// - Missing fields (goal, triggers, entries, verifiedCompletion, metadata)
// - Multi-attachment messages (10 mixed attachments, case-insensitivity, non-recipe filtering)
// - Frame communication edge cases (throwing listeners, null frames, spoofed origins)
// Run with: node --test adventurer/experiences/recipe_accessory.challenge.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register, createRequire } from "node:module";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
            url: "data:text/javascript,export const React = globalThis.React || { useReducer: (r, i) => [i, () => {}], useState: (s) => [s, () => {}], useEffect: () => {}, useCallback: (f) => f }; export default React; export const useReducer = React.useReducer; export const useState = React.useState; export const useEffect = React.useEffect; export const useCallback = React.useCallback; export const FluxDispatcher = {}; export const UserStore = {}; export const RestAPI = globalThis.__mockRestApi || {}; export const showToast = (opts) => {};",
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
        const flatChildren = children.length === 1 && Array.isArray(children[0]) ? children[0] : children;
        return { type, props: { ...props, children: flatChildren } };
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
    useEffect(fn) {},
    useCallback(fn) {
        return fn;
    }
};

// ============================================================================
// Deliverable Imports Under Test
// ============================================================================

import {
    validateRecipe,
    validateAdvRecipeFile,
    validateCompletionRecipe
} from "./recipe.ts";

import {
    saveRecipeDisk,
    loadRecipeDisk,
    listLocalRecipes
} from "./storage.ts";

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

function createValidRecipe(overrides = {}) {
    return {
        format: "advrecipe",
        version: 1,
        application_id: "123456789012345678",
        scene: "main_arena",
        name: "Test Quest Recipe",
        created: "2026-11-08T00:00:00.000Z",
        verifiedCompletion: true,
        completion: {
            version: 1,
            goal: "quest:complete",
            triggers: ["match:start"],
            entries: [
                { name: "player:fire", scope: "app", args: [1] }
            ],
            suppress: ["leaderboard"],
            delay_ms: 100
        },
        ...overrides
    };
}

// ============================================================================
// SUITE 1: Concurrency & Double-Click Stress Tests
// ============================================================================

test("STRESS_01_concurrent_importRecipe_burst_and_idempotency", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-stress-import-"));
    try {
        const recipe = createValidRecipe({ name: "Concurrent Import Run" });
        // Burst 25 parallel import operations
        const operations = Array.from({ length: 25 }, () => importRecipe(recipe, tmp));
        const results = await Promise.all(operations);

        for (const res of results) {
            assert.equal(res.ok, true, "Every parallel import must resolve ok: true");
            assert.ok(res.path && existsSync(res.path), "Saved path must exist");
        }

        // Verify only 1 recipe file exists on disk (no duplicate ghost files or lingering .tmp files)
        const entries = readdirSync(tmp);
        const tmpFiles = entries.filter(f => f.endsWith(".tmp"));
        assert.equal(tmpFiles.length, 0, "No temporary swap files should linger after burst writes");

        const recipeFiles = entries.filter(f => f.endsWith(".advrecipe"));
        assert.equal(recipeFiles.length, 1, "Exactly one .advrecipe file should exist for app/scene");

        // Verify file content is clean valid JSON and passes schema validation
        const loaded = await loadRecipeDisk(recipeFiles[0], tmp);
        assert.ok(loaded !== null);
        assert.equal(loaded.name, "Concurrent Import Run");
        const val = validateRecipe(loaded);
        assert.equal(val.valid, true);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("STRESS_02_concurrent_executeRecipe_burst", () => {
    const recipe = createValidRecipe({ name: "Concurrent Execute Run" });
    // Burst 25 parallel execute calls
    const payloads = [];
    for (let i = 0; i < 25; i++) {
        const payload = executeRecipe(recipe, { broadcastWindow: false });
        payloads.push(payload);
    }

    assert.equal(payloads.length, 25);
    for (const p of payloads) {
        assert.equal(p.type, "completion_inject");
        assert.equal(p.execute, true);
        assert.equal(p.recipe.name, "Concurrent Execute Run");
    }
});

test("STRESS_03_concurrent_interleaved_import_and_execute", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-stress-interleaved-"));
    try {
        const recipe = createValidRecipe({ name: "Interleaved Run" });
        const ops = [];

        // 15 imports and 15 executes running interleaved
        for (let i = 0; i < 15; i++) {
            ops.push(importRecipe(recipe, tmp));
            ops.push((async () => executeRecipe(recipe, { broadcastWindow: false }))());
        }

        const outcomes = await Promise.all(ops);
        assert.equal(outcomes.length, 30);

        const list = await listLocalRecipes(tmp);
        assert.equal(list.length, 1);
        assert.equal(list[0].name, "Interleaved Run");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

// ============================================================================
// SUITE 2: Malformed & Corrupted Inputs
// ============================================================================

test("STRESS_04_empty_and_whitespace_content_rejection", async () => {
    // Empty strings
    assert.throws(
        () => parseRecipeContent(""),
        /Empty attachment file/
    );
    assert.throws(
        () => parseRecipeContent("   "),
        /Empty attachment file/
    );
    assert.throws(
        () => parseRecipeContent("\t\n\r  \n"),
        /Empty attachment file/
    );

    // 0-byte attachment object
    await assert.rejects(
        () => fetchRecipeAttachment({ filename: "empty.advrecipe", size: 0, url: "https://mock.cdn/empty" }),
        /Empty attachment file/
    );

    // Empty content property
    await assert.rejects(
        () => fetchRecipeAttachment({ filename: "empty.advrecipe", content: "" }),
        /Empty attachment file/
    );
});

test("STRESS_05_truncated_and_malformed_json_inputs", () => {
    const truncatedPayloads = [
        '{"format": "adv',
        '{"format": "advrecipe", "version": 1,',
        '{"format": "advrecipe", "version": 1, "name": "Quest", "completion": {',
        '{"format": "advrecipe", "version": 1, "completion": {"goal": "test"',
        '{ "format": "advrecipe", "name": "Unclosed',
        'NaN',
        'undefined',
        '<xml>not json</xml>',
        '}{',
        '[1, 2, 3,'
    ];

    for (const badJson of truncatedPayloads) {
        assert.throws(
            () => parseRecipeContent(badJson),
            /Corrupted recipe file/,
            `Truncated payload '${badJson}' must throw Corrupted recipe file`
        );
    }
});

test("STRESS_06_invalid_primitive_types_for_recipe_content", () => {
    // Non-string arguments passed into parseRecipeContent
    const invalidTypes = [null, undefined, 12345, false, true, [], {}];

    for (const badType of invalidTypes) {
        assert.throws(
            () => parseRecipeContent(badType),
            Error,
            `Invalid type ${typeof badType} must throw`
        );
    }

    // Card component rendering with invalid content types does not crash
    for (const badContent of [null, 12345, false]) {
        const card = RecipeAccessoryCard({
            attachment: { filename: "invalid_type.advrecipe", content: badContent }
        });
        assert.ok(card !== null);
        assert.equal(card.props.className, "adventurer-recipe-card");
        assert.ok(JSON.stringify(card).includes("RECIPE ERROR"));
    }
});

test("STRESS_07_extreme_string_lengths_and_oversized_payloads", async () => {
    // Oversized attachment size > 10MB
    await assert.rejects(
        () => fetchRecipeAttachment({
            filename: "huge.advrecipe",
            size: 10 * 1024 * 1024 + 1,
            url: "https://mock.cdn/huge"
        }),
        /Recipe file exceeds 10MB limit/
    );

    await assert.rejects(
        () => fetchRecipeAttachment({
            filename: "massive.advrecipe",
            size: 50 * 1024 * 1024,
            url: "https://mock.cdn/massive"
        }),
        /Recipe file exceeds 10MB limit/
    );

    // Extremely long garbage string (100,000 characters)
    const longGarbage = "A".repeat(100000);
    assert.throws(
        () => parseRecipeContent(longGarbage),
        /Corrupted recipe file/
    );

    // Args exceeding MAX_ARGS_CHARS (20,000 chars)
    const oversizedArgsRecipe = createValidRecipe({
        completion: {
            version: 1,
            goal: "quest:complete",
            triggers: ["match:start"],
            entries: [
                { name: "test:fire", scope: "app", args: ["X".repeat(25000)] }
            ],
            suppress: ["leaderboard"]
        }
    });

    assert.throws(
        () => parseRecipeContent(JSON.stringify(oversizedArgsRecipe)),
        /Invalid recipe schema/
    );
});

// ============================================================================
// SUITE 3: Missing Fields & Schema Invariants
// ============================================================================

test("STRESS_08_recipe_missing_goal_rejected", () => {
    const noGoal1 = createValidRecipe();
    delete noGoal1.completion.goal;

    const val1 = validateRecipe(noGoal1);
    assert.equal(val1.valid, false);
    assert.ok(val1.errors.some(e => e.includes("no goal")));

    assert.throws(
        () => parseRecipeContent(JSON.stringify(noGoal1)),
        /Invalid recipe schema/
    );

    const emptyGoal = createValidRecipe({
        completion: {
            version: 1,
            goal: "   ",
            triggers: ["match:start"],
            entries: [{ name: "step" }],
            suppress: ["leaderboard"]
        }
    });
    const val2 = validateRecipe(emptyGoal);
    assert.equal(val2.valid, false);
    assert.ok(val2.errors.some(e => e.includes("no goal")));
});

test("STRESS_09_recipe_missing_triggers_rejected", () => {
    const noTriggers = createValidRecipe();
    delete noTriggers.completion.triggers;

    const val1 = validateRecipe(noTriggers);
    assert.equal(val1.valid, false);
    assert.ok(val1.errors.some(e => e.includes("needs at least one trigger")));

    const emptyTriggers = createValidRecipe({
        completion: {
            version: 1,
            goal: "quest:complete",
            triggers: [],
            entries: [{ name: "step" }],
            suppress: ["leaderboard"]
        }
    });
    const val2 = validateRecipe(emptyTriggers);
    assert.equal(val2.valid, false);
    assert.ok(val2.errors.some(e => e.includes("needs at least one trigger")));
});

test("STRESS_10_recipe_missing_entries_rejected", () => {
    const noEntries = createValidRecipe();
    delete noEntries.completion.entries;

    const val1 = validateRecipe(noEntries);
    assert.equal(val1.valid, false);
    assert.ok(val1.errors.some(e => e.includes("needs at least one entry")));

    const emptyEntries = createValidRecipe({
        completion: {
            version: 1,
            goal: "quest:complete",
            triggers: ["match:start"],
            entries: [],
            suppress: ["leaderboard"]
        }
    });
    const val2 = validateRecipe(emptyEntries);
    assert.equal(val2.valid, false);
    assert.ok(val2.errors.some(e => e.includes("needs at least one entry")));
});

test("STRESS_11_recipe_missing_verifiedCompletion_rejected", () => {
    const noVerified = createValidRecipe();
    delete noVerified.verifiedCompletion;

    const val1 = validateRecipe(noVerified);
    assert.equal(val1.valid, false);
    assert.ok(val1.errors.some(e => e.includes("verifiedCompletion must be a boolean")));

    assert.throws(
        () => parseRecipeContent(JSON.stringify(noVerified)),
        /Invalid recipe schema/
    );

    // Non-boolean verifiedCompletion
    const stringVerified = createValidRecipe({ verifiedCompletion: "true" });
    const val2 = validateRecipe(stringVerified);
    assert.equal(val2.valid, false);
    assert.ok(val2.errors.some(e => e.includes("verifiedCompletion must be a boolean")));
});

test("STRESS_12_recipe_missing_metadata_fields_rejected", () => {
    // Missing format
    const noFormat = createValidRecipe();
    delete noFormat.format;
    assert.equal(validateRecipe(noFormat).valid, false);

    // Wrong version
    const wrongVersion = createValidRecipe({ version: 999 });
    assert.equal(validateRecipe(wrongVersion).valid, false);

    // Missing application_id
    const noApp = createValidRecipe({ application_id: "" });
    assert.equal(validateRecipe(noApp).valid, false);

    // Missing scene
    const noScene = createValidRecipe({ scene: "  " });
    assert.equal(validateRecipe(noScene).valid, false);

    // Missing name
    const noName = createValidRecipe({ name: "" });
    assert.equal(validateRecipe(noName).valid, false);

    // Invalid created date
    const badCreated = createValidRecipe({ created: "invalid-date-string" });
    assert.equal(validateRecipe(badCreated).valid, false);

    // Missing suppress leaderboard
    const noSuppress = createValidRecipe({
        completion: {
            version: 1,
            goal: "quest:complete",
            triggers: ["start"],
            entries: [{ name: "step" }],
            suppress: ["other"]
        }
    });
    assert.equal(validateRecipe(noSuppress).valid, false);
});

// ============================================================================
// SUITE 4: Multi-Attachment Messages & Filtering
// ============================================================================

test("STRESS_13_ten_mixed_attachments_filtering_and_case_insensitivity", () => {
    const mixedAttachments = [
        { filename: "screenshot.png", size: 102400 },
        { filename: "guide.pdf", size: 512000 },
        { filename: "quest_alpha.advrecipe", size: 1200, content: JSON.stringify(createValidRecipe({ name: "Alpha" })) },
        { filename: "notes.txt", size: 200 },
        { filename: "QUEST_BETA.ADVRECIPE", size: 1300, content: JSON.stringify(createValidRecipe({ name: "Beta" })) },
        { filename: "Quest_Gamma.AdvRecipe", size: 1400, content: JSON.stringify(createValidRecipe({ name: "Gamma" })) },
        { filename: "config.json", size: 400 },
        { filename: "fake.advrecipe.bak", size: 1500 },
        { filename: "archive.zip", size: 2048000 },
        { filename: "gameplay.mp4", size: 5242880 }
    ];

    const message = { id: "msg_mixed_10", attachments: mixedAttachments };

    // Test getRecipeAttachments filters strictly to the 3 genuine .advrecipe extensions
    const filtered = getRecipeAttachments(message);
    assert.equal(filtered.length, 3);
    assert.equal(filtered[0].filename, "quest_alpha.advrecipe");
    assert.equal(filtered[1].filename, "QUEST_BETA.ADVRECIPE");
    assert.equal(filtered[2].filename, "Quest_Gamma.AdvRecipe");

    // Test RecipeAccessory renders exactly 3 cards inside the container
    const rendered = RecipeAccessory({ message });
    assert.ok(rendered !== null);
    assert.equal(rendered.props.className, "adventurer-recipe-accessories-container");
    assert.equal(rendered.props.children.length, 3);
});

test("STRESS_14_all_non_recipe_attachments_returns_null", () => {
    const nonRecipeMessage = {
        id: "msg_all_non",
        attachments: [
            { filename: "a.png" },
            { filename: "b.jpg" },
            { filename: "c.pdf" },
            { filename: "d.txt" },
            { filename: "e.json" },
            { filename: "f.csv" },
            { filename: "g.zip" },
            { filename: "h.exe" },
            { filename: "i.tar.gz" },
            { filename: "j.gif" }
        ]
    };

    assert.deepEqual(getRecipeAttachments(nonRecipeMessage), []);
    // Component returns null when no recipe attachments are present
    assert.equal(RecipeAccessory({ message: nonRecipeMessage }), null);

    // Factory render function returns React Element wrapping RecipeAccessory
    const rendered = renderRecipeAccessory({ message: nonRecipeMessage });
    assert.ok(rendered !== null);
    assert.equal(rendered.type, RecipeAccessory);

    // When the component is evaluated by React, it returns null
    assert.equal(RecipeAccessory(rendered.props), null);

    // Calling renderRecipeAccessory with null message returns null directly
    assert.equal(renderRecipeAccessory(null), null);
    assert.equal(renderRecipeAccessory({}), null);
});

test("STRESS_15_edge_case_attachments_handling", () => {
    assert.equal(isRecipeAttachment(null), false);
    assert.equal(isRecipeAttachment(undefined), false);
    assert.equal(isRecipeAttachment({}), false);
    assert.equal(isRecipeAttachment({ filename: "" }), false);
    assert.equal(isRecipeAttachment({ filename: null }), false);
    assert.equal(isRecipeAttachment({ filename: undefined }), false);
    assert.equal(isRecipeAttachment({ filename: ".advrecipe" }), true);
    assert.equal(isRecipeAttachment({ filename: "advrecipe" }), false);
    assert.equal(isRecipeAttachment({ filename: "test.advrecipe.txt" }), false);
    assert.equal(isRecipeAttachment({ filename: "test.advrecipe " }), false);
});

// ============================================================================
// SUITE 5: Frame Communication & Origin Security
// ============================================================================

test("STRESS_16_frame_postMessage_throwing_listener_survival", () => {
    const recipe = createValidRecipe({ name: "Throwing Listener Quest" });

    // Mock document with an iframe whose contentWindow.postMessage throws
    const throwingIframe = {
        src: "https://activity-12345.discordsays.com/index.html",
        contentWindow: {
            postMessage: () => {
                throw new Error("DOMException: SecurityError frame communication blocked");
            }
        }
    };

    const originalDoc = globalThis.document;
    try {
        globalThis.document = {
            querySelectorAll: (selector) => {
                if (selector === "iframe") return [throwingIframe];
                return [];
            }
        };

        // executeRecipe must swallow frame errors and not throw to caller
        const payload = executeRecipe(recipe, { broadcastWindow: false });
        assert.equal(payload.type, "completion_inject");
        assert.equal(payload.execute, true);
    } finally {
        globalThis.document = originalDoc;
    }
});

test("STRESS_17_null_and_malformed_frames_resilience", () => {
    const recipe = createValidRecipe({ name: "Null Frame Quest" });

    const malformedFrames = [
        { src: null, contentWindow: null },
        { src: "", contentWindow: {} },
        { src: "ht%tp://invalid-url", contentWindow: {} },
        { src: "https://activity.discordsays.com", contentWindow: null },
        { src: "https://activity.discordsays.com", contentWindow: undefined }
    ];

    const originalDoc = globalThis.document;
    try {
        globalThis.document = {
            querySelectorAll: () => malformedFrames
        };

        // executeRecipe survives completely without unhandled errors
        const payload = executeRecipe(recipe, { broadcastWindow: false });
        assert.ok(payload !== null);
    } finally {
        globalThis.document = originalDoc;
    }
});

test("STRESS_18_origin_isolation_strict_discordsays_filter", () => {
    const recipe = createValidRecipe({ name: "Origin Security Quest" });
    const delivered = [];

    const mockFrames = [
        {
            src: "https://evil.com/phishing",
            contentWindow: { postMessage: (msg) => delivered.push({ host: "evil.com", msg }) }
        },
        {
            src: "https://discordsays.com.attacker.com/spoof",
            contentWindow: { postMessage: (msg) => delivered.push({ host: "discordsays.com.attacker.com", msg }) }
        },
        {
            src: "https://notdiscordsays.com/game",
            contentWindow: { postMessage: (msg) => delivered.push({ host: "notdiscordsays.com", msg }) }
        },
        {
            src: "javascript:alert(1)",
            contentWindow: { postMessage: (msg) => delivered.push({ host: "javascript", msg }) }
        },
        {
            src: "https://discordsays.com/quest",
            contentWindow: { postMessage: (msg) => delivered.push({ host: "discordsays.com", msg }) }
        },
        {
            src: "https://subdomain.discordsays.com/quest",
            contentWindow: { postMessage: (msg) => delivered.push({ host: "subdomain.discordsays.com", msg }) }
        }
    ];

    const originalDoc = globalThis.document;
    try {
        globalThis.document = {
            querySelectorAll: () => mockFrames
        };

        executeRecipe(recipe, { broadcastWindow: false });

        // Verify ONLY the 2 discordsays.com frames received messages
        const hostsReceivingMessages = delivered.map(d => d.host);
        assert.ok(!hostsReceivingMessages.includes("evil.com"), "evil.com must never receive postMessage");
        assert.ok(!hostsReceivingMessages.includes("discordsays.com.attacker.com"), "spoofed subdomain must never receive postMessage");
        assert.ok(!hostsReceivingMessages.includes("notdiscordsays.com"), "non-discordsays domain must never receive postMessage");
        assert.ok(!hostsReceivingMessages.includes("javascript"), "javascript: pseudo-URL must never receive postMessage");

        assert.ok(hostsReceivingMessages.includes("discordsays.com"), "discordsays.com must receive postMessage");
        assert.ok(hostsReceivingMessages.includes("subdomain.discordsays.com"), "*.discordsays.com must receive postMessage");
    } finally {
        globalThis.document = originalDoc;
    }
});

// ============================================================================
// SUITE 6: UI Component & Card Accent State Invariants
// ============================================================================

test("STRESS_19_card_accent_color_states", () => {
    const verified = createValidRecipe({ verifiedCompletion: true });
    const verifiedCard = RecipeAccessoryCard({
        attachment: { filename: "v.advrecipe", content: JSON.stringify(verified) }
    });
    assert.ok(JSON.stringify(verifiedCard).includes("VERIFIED RECIPE"));

    const unverified = createValidRecipe({ verifiedCompletion: false });
    const unverifiedCard = RecipeAccessoryCard({
        attachment: { filename: "u.advrecipe", content: JSON.stringify(unverified) }
    });
    assert.ok(JSON.stringify(unverifiedCard).includes("ADVENTURER RECIPE"));

    const corruptedCard = RecipeAccessoryCard({
        attachment: { filename: "bad.advrecipe", content: "{corrupted" }
    });
    assert.ok(JSON.stringify(corruptedCard).includes("RECIPE ERROR"));

    const emptyCard = RecipeAccessoryCard({
        attachment: { filename: "empty.advrecipe", size: 0 }
    });
    assert.ok(JSON.stringify(emptyCard).includes("RECIPE ERROR"));

    const oversizedCard = RecipeAccessoryCard({
        attachment: { filename: "oversized.advrecipe", size: 15 * 1024 * 1024 }
    });
    assert.ok(JSON.stringify(oversizedCard).includes("RECIPE ERROR"));
});

// ============================================================================
// SUITE 7: Remote Attachment Network Fault Injection
// ============================================================================

test("STRESS_20_remote_fetch_network_failure_and_timeout", async () => {
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => {
            throw new Error("Failed to fetch: Network connection timed out");
        };

        await assert.rejects(
            () => fetchRecipeAttachment({
                filename: "remote.advrecipe",
                url: "https://cdn.discordapp.com/attachments/1/2/remote.advrecipe"
            }),
            /Network timeout: Failed to fetch: Network connection timed out/
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("STRESS_21_remote_fetch_http_error_codes_404_500", async () => {
    const originalFetch = globalThis.fetch;
    try {
        // 404 Not Found
        globalThis.fetch = async () => ({
            ok: false,
            status: 404,
            statusText: "Not Found",
            text: async () => "Not Found"
        });

        await assert.rejects(
            () => fetchRecipeAttachment({
                filename: "missing.advrecipe",
                url: "https://cdn.discordapp.com/attachments/1/2/missing.advrecipe"
            }),
            /Failed to download attachment: Not Found/
        );

        // 500 Internal Server Error
        globalThis.fetch = async () => ({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            text: async () => "Internal Server Error"
        });

        await assert.rejects(
            () => fetchRecipeAttachment({
                filename: "server_err.advrecipe",
                url: "https://cdn.discordapp.com/attachments/1/2/server_err.advrecipe"
            }),
            /Failed to download attachment: Internal Server Error/
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("STRESS_22_remote_fetch_uses_proxy_url_fallback_when_url_missing", async () => {
    const originalFetch = globalThis.fetch;
    try {
        let requestedUrl = null;
        globalThis.fetch = async (url) => {
            requestedUrl = url;
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify(createValidRecipe({ name: "Proxy Fetched Recipe" }))
            };
        };

        const result = await fetchRecipeAttachment({
            filename: "proxied.advrecipe",
            proxy_url: "https://media.discordapp.net/attachments/1/2/proxied.advrecipe"
        });

        assert.equal(requestedUrl, "https://media.discordapp.net/attachments/1/2/proxied.advrecipe");
        assert.equal(result.name, "Proxy Fetched Recipe");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("STRESS_23_card_optional_events_and_step_summary_rendering", () => {
    const recipeWithOptional = createValidRecipe({
        name: "Optional Quest",
        optional_events: ["inspect_map", "open_inventory", "emote_dance"],
        completion: {
            version: 1,
            goal: "quest:complete",
            triggers: ["match:start"],
            entries: [
                { name: "step_one", scope: "app" },
                { name: "step_two", scope: "app" }
            ],
            suppress: ["leaderboard"]
        }
    });

    const card = RecipeAccessoryCard({
        attachment: {
            filename: "opt.advrecipe",
            content: JSON.stringify(recipeWithOptional)
        }
    });

    assert.ok(card !== null);
    assert.equal(card.props.className, "adventurer-recipe-card");
    const header = getCardHeader(recipeWithOptional);
    assert.equal(header.title, "Optional Quest");
    assert.equal(header.verifiedBadge, "Verified Quest");
});

test("STRESS_24_renderAccessoryDom_and_getCardHeader_invariants", () => {
    // getCardHeader defaults for empty recipe
    const emptyHeader = getCardHeader(null);
    assert.equal(emptyHeader.title, "Quest Recipe");
    assert.equal(emptyHeader.appId, "");
    assert.equal(emptyHeader.verifiedBadge, "Unverified");

    // renderAccessoryDom DOM contract
    const domDesc = renderAccessoryDom({ filename: "custom.advrecipe" }, "998877");
    assert.equal(domDesc.containerId, "#message-accessories-998877");
    assert.equal(domDesc.className, "adventurer-recipe-card");
    assert.equal(domDesc.fileName, "custom.advrecipe");

    const nullDesc = renderAccessoryDom(null, "111");
    assert.equal(nullDesc.containerId, "#message-accessories-111");
    assert.equal(nullDesc.fileName, "");
});

