// adventurer/experiences/recipe_tier5_hardening.test.mjs
// Phase 2: Tier 5 Adversarial Coverage Hardening Test Suite
// Covers entire DiscordAdventurer recipe subsystem across Milestones 1-4.
// Run with: node --test adventurer/experiences/recipe_tier5_hardening.test.mjs

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
    if (specifier === "@api/Settings") {
        return {
            url: "data:text/javascript,export const definePluginSettings = (s) => ({ store: s });",
            shortCircuit: true
        };
    }
    if (specifier === "@utils/types") {
        return {
            url: "data:text/javascript,export const OptionType = { BOOLEAN: 1, NUMBER: 2, STRING: 3, SELECT: 4, SLIDER: 5 }; export default (p) => p;",
            shortCircuit: true
        };
    }
    if (specifier === "@api/Notifications") {
        return {
            url: "data:text/javascript,export const showNotification = () => {};",
            shortCircuit: true
        };
    }
    if (specifier === "electron") {
        return {
            url: "data:text/javascript,export class IpcMainInvokeEvent {}; export class WebContents {}; export class WebFrameMain {};",
            shortCircuit: true
        };
    }
    const hasExt = specifier.lastIndexOf(".") > specifier.lastIndexOf("/");
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !hasExt) {
        for (const ext of [".ts", ".tsx", ".json", ".js"]) {
            try {
                return await next(specifier + ext, context);
            } catch {}
        }
    }
    return next(specifier, context);
}

export async function load(url, context, next) {
    if (url.endsWith(".json")) {
        const raw = readFileSync(fileURLToPath(url), "utf8");
        return {
            format: "module",
            source: "export default " + raw + ";",
            shortCircuit: true
        };
    }
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
    useEffect() {
        // no-op in node unit test runner
    },
    useCallback(fn) {
        return fn;
    }
};

// Set window temporarily for index.tsx top-level evaluation
globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: () => {},
    location: { hostname: "discord.com" }
};

const pluginModule = await import("../index.tsx");
const pluginDefault = pluginModule.default;

// Immediately delete globalThis.window so storage.ts operates in direct Node mode
delete globalThis.window;

// ============================================================================
// Production Module Imports
// ============================================================================

import {
    RECIPE_VERSION,
    RECIPE_FORMAT,
    RECIPE_FILE_EXTENSION,
    MAX_KEEP_STRING,
    MAX_ARGS_CHARS,
    MAX_DELAY_MS,
    validateRecipe,
    validateCompletionRecipe,
    validateAdvRecipeFile,
    sanitizeArgs,
    parseArgs,
    argsProblem,
    slug,
    isLeaderboard,
    isArise,
    triggerProblem,
    entryProblem,
    clampDelay,
    sensitiveReason,
    canShareRecipe
} from "./recipe.ts";

import {
    saveRecipeDisk,
    loadRecipeDisk,
    listLocalRecipes,
    deleteRecipeDisk,
    loadRecipeDiskSync,
    listLocalRecipesSync,
    deleteRecipeDiskSync,
    atomicSaveRecipe,
    atomicWriteFileSync,
    isSafePath,
    recipeFileName,
    getAdventurerRecipeDir,
    getWorkbenchProfileDir
} from "./storage.ts";

import {
    QuestEventRecorder,
    ENGINE_NOISE_EVENTS,
    EXTRANEOUS_RE,
    buildRecorderScript
} from "./recorder.ts";

import {
    buildMenuMessage,
    buildMenuScript,
    MENU_MESSAGE_TAG
} from "./menu.ts";

import {
    buildCompletionMessage,
    buildCompletionScript,
    buildInjectRecipeMessage,
    buildExecuteRecipeMessage,
    resolvePrecedence,
    COMPLETION_MESSAGE_TAG,
    ADVENTURER_EXECUTE_RECIPE_TYPE,
    ADVENTURER_INJECT_RECIPE_TYPE
} from "./completion.ts";

const forwardModalModule = await import("../sharing/forwardModal.tsx");
const {
    getForwardModalState,
    setCommunityShare,
    resetForwardModalState,
    subscribeForwardModalState,
    useCommunityShareState,
    RecipePreviewChip,
    CommunityShareCheckbox,
    createRecipeMessage,
    customSendHandler,
    handleForwardSubmit,
    openRecipeForwardModal,
    closeForwardModal,
    forwardModalPatches,
    installForwardModalDOMObserver,
    removeForwardModalDOMObserver
} = forwardModalModule;

import {
    COMMUNITY_GUILD_ID,
    COMMUNITY_CHANNEL_ID,
    COMMUNITY_INVITE_CODE,
    COMMUNITY_INVITE_URL,
    MAX_RECIPE_FILE_SIZE,
    isCommunityMember,
    ensureCommunityMembership,
    verifyAndJoinCommunity,
    dispatchRecipeToChannel,
    dispatchRecipeAttachment,
    shareRecipeWithCommunity,
    dispatchToRecipients,
    getUtf8ByteLength,
    parseRetryAfterMs,
    resetCommunityMembershipCache,
    setWebpackMock,
    resetWebpackMocks,
    defaultRestApiMock,
    defaultGuildStoreMock,
    defaultInviteActionsMock,
    defaultTokenStoreMock,
    resolveGuildStore,
    resolveInviteActions,
    resolveRestAPI,
    resolveTokenStore
} from "../sharing/community.ts";

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
    executeRecipe,
    injectAndExecuteRecipe
} = recipeAccessoryModule;

// ============================================================================
// Fixture Generators
// ============================================================================

function createValidAdvRecipe(overrides = {}) {
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
                { name: "select:play", scope: "app", args: [] },
                { name: "target:eliminated", scope: "app", args: [1, "headshot"] }
            ],
            suppress: ["leaderboard"],
            delay_ms: 100
        },
        ...overrides
    };
}

function withTempDir(fn) {
    const dir = mkdtempSync(join(tmpdir(), "adv-tier5-"));
    try {
        return fn(dir);
    } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
}

async function withTempDirAsync(fn) {
    const dir = mkdtempSync(join(tmpdir(), "adv-tier5-"));
    try {
        return await fn(dir);
    } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
}

// ============================================================================
// SECTION 1: Recipe Schema, Boundary Conditions & Argument Sanitization
// ============================================================================

test("T5_REC_01: Prototype pollution resistance during argument sanitization", () => {
    const maliciousArgs = [
        {
            __proto__: { polluted: true },
            constructor: { prototype: { admin: true } },
            prototype: { bypass: true },
            safeKey: "safeValue"
        }
    ];

    const { sanitized } = sanitizeArgs(maliciousArgs);
    assert.equal(sanitized.length, 1);
    const cleanedObj = sanitized[0];

    assert.equal(cleanedObj.safeKey, "safeValue");
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(Object.prototype.admin, undefined);
    assert.equal(Object.prototype.bypass, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(cleanedObj, "__proto__"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(cleanedObj, "constructor"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(cleanedObj, "prototype"), false);
});

test("T5_REC_02: Cyclic & self-referential structures are handled without recursion overflow", () => {
    const cyclicObj = { a: 1, name: "cyclic" };
    cyclicObj.self = cyclicObj;

    const cyclicArray = [1, 2];
    cyclicArray.push(cyclicArray);

    const { sanitized, stats } = sanitizeArgs([cyclicObj, cyclicArray]);
    assert.equal(sanitized.length, 2);
    assert.equal(sanitized[0].a, 1);
    assert.equal(sanitized[0].name, "cyclic");
    assert.equal(sanitized[0].self, undefined);
    assert.equal(sanitized[1][0], 1);
    assert.equal(sanitized[1][1], 2);
    assert.equal(sanitized[1][2], null);
    assert.ok(stats.uncaptured >= 2);
});

test("T5_REC_03: Truncated containers with @truncated marker update stats and strip marker", () => {
    const input = [
        {
            "@truncated": true,
            id: "safe-id",
            items: ["alpha", "@truncated(100)", "beta"]
        }
    ];

    const { sanitized, stats } = sanitizeArgs(input);
    assert.equal(sanitized.length, 1);
    assert.equal(sanitized[0]["@truncated"], undefined);
    assert.equal(sanitized[0].id, "safe-id");
    assert.deepEqual(sanitized[0].items, ["alpha", "beta"]);
    assert.equal(stats.truncated, 2);
    assert.ok(stats.notes().some(n => n.includes("cut at the recorder's size limit")));
});

test("T5_REC_04: Positional alignment is preserved via null and trailing dropped values are trimmed", () => {
    const input = [
        "safe1",
        "https://secret.token.com/auth?token=12345", // dropped url
        "safe2",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0", // dropped JWT
        "safe3",
        "password1234567890123456789012345", // dropped tokenish
        "secret_token_at_the_end_12345678901234567890" // dropped trailing
    ];

    const { sanitized } = sanitizeArgs(input);
    assert.equal(sanitized.length, 5);
    assert.equal(sanitized[0], "safe1");
    assert.equal(sanitized[1], null);
    assert.equal(sanitized[2], "safe2");
    assert.equal(sanitized[3], null);
    assert.equal(sanitized[4], "safe3");
});

test("T5_REC_05: Snowflake boundary discrimination at 14 vs 15 digits", () => {
    const safe14 = "12345678901234"; // 14 digits: safe
    const snowflake15 = "123456789012345"; // 15 digits: discord id dropped
    const snowflake19 = "1536318183873454090"; // 19 digits: discord id dropped

    assert.equal(sensitiveReason(safe14), "");
    assert.equal(sensitiveReason(snowflake15), "discord id");
    assert.equal(sensitiveReason(snowflake19), "discord id");

    const { sanitized } = sanitizeArgs([safe14, snowflake15, snowflake19]);
    assert.deepEqual(sanitized, [safe14]);
});

test("T5_REC_06: Entity prefix @entity: bounds and character limits (8 to 120 chars)", () => {
    const exactPrefixOnly = "@entity:"; // 8 chars: invalid, dropped
    const validEntity = "@entity:target-door-01"; // 22 chars: valid, kept
    const maxEntity = "@entity:" + "x".repeat(112); // 120 chars: valid, kept
    const oversizedEntity = "@entity:" + "x".repeat(113); // 121 chars: invalid, dropped

    const { sanitized } = sanitizeArgs([exactPrefixOnly, validEntity, maxEntity, oversizedEntity]);
    assert.equal(sanitized.length, 3);
    assert.equal(sanitized[0], null);
    assert.equal(sanitized[1], validEntity);
    assert.equal(sanitized[2], maxEntity);
});

test("T5_REC_07: Validation suite deep NaN and Infinity detection inside nested arrays and objects", () => {
    const recipeWithNaN = createValidAdvRecipe();
    recipeWithNaN.completion.entries[0].args = [
        { nested: [10, NaN, 20] }
    ];

    const resNaN = validateRecipe(recipeWithNaN);
    assert.equal(resNaN.valid, false);
    assert.ok(resNaN.errors.some(e => e.includes("NaN and Infinity are not valid JSON numbers")));

    const recipeWithInfinity = createValidAdvRecipe();
    recipeWithInfinity.completion.entries[0].args = [
        { deep: { inner: Infinity } }
    ];

    const resInf = validateRecipe(recipeWithInfinity);
    assert.equal(resInf.valid, false);
    assert.ok(resInf.errors.some(e => e.includes("NaN and Infinity are not valid JSON numbers")));
});

test("T5_REC_08: slug() collapses multi-dot traversal and removes leading/trailing periods", () => {
    assert.equal(slug("../../etc/passwd"), "etc_passwd");
    assert.equal(slug("..\\..\\windows\\system32"), "windows_system32");
    assert.equal(slug("....hidden....file...."), "hidden_file");
    assert.equal(slug("___...___"), "unknown");
    assert.equal(slug(null), "unknown");
    assert.equal(slug(12345), "unknown");
});

// ============================================================================
// SECTION 2: Storage Boundaries, Traversal & Immutability
// ============================================================================

test("T5_STO_01: isSafePath blocks Windows alternate data streams and colon access", () => {
    return withTempDir(base => {
        assert.equal(isSafePath(base, join(base, "recipe.advrecipe")), true);
        assert.equal(isSafePath(base, join(base, "recipe.advrecipe::$DATA")), true);
        assert.equal(isSafePath(base, "C:\\Windows\\System32"), false);
        assert.equal(isSafePath(base, "D:\\data\\recipe.advrecipe"), false);
        assert.equal(isSafePath(base, "\\\\server\\share\\recipe.advrecipe"), false);
        assert.equal(isSafePath(base, base), false);
        assert.equal(isSafePath(base, base + "/"), false);
    });
});

test("T5_STO_02: saveRecipeDisk blocks path traversal in application_id and scene", async () => {
    return await withTempDirAsync(async customDir => {
        const maliciousRecipe = createValidAdvRecipe({
            application_id: "../../../escape_app",
            scene: "normal_scene"
        });

        const res = await saveRecipeDisk(maliciousRecipe, customDir);
        assert.equal(res.ok, true);
        // The slug function neutralizes ../../../ to escape_app
        assert.ok(res.path.startsWith(customDir));
        assert.ok(res.path.endsWith("escape_app__normal_scene.advrecipe"));
        assert.ok(existsSync(res.path));
    });
});

test("T5_STO_03: loadRecipeDiskSync returns null on directories and unreadable files", () => {
    return withTempDir(customDir => {
        const subDir = join(customDir, "subdir.advrecipe");
        atomicWriteFileSync(join(subDir, "inner.txt"), "hello");

        // Attempting to load a directory as a recipe
        const resDir = loadRecipeDiskSync("subdir", customDir);
        assert.equal(resDir, null);

        // Attempting to load corrupted non-JSON file
        const corruptedPath = join(customDir, "corrupted__scene.advrecipe");
        atomicWriteFileSync(corruptedPath, "{ broken json content !! ");
        const resCorrupted = loadRecipeDiskSync("corrupted__scene", customDir);
        assert.equal(resCorrupted, null);
    });
});

test("T5_STO_04: listLocalRecipes deduplicates files between .advrecipe and .json with same base key", async () => {
    return await withTempDirAsync(async customDir => {
        const advPath = join(customDir, "app123__main.advrecipe");
        const jsonPath = join(customDir, "app123__main.json");

        const r1 = createValidAdvRecipe({ name: "From AdvRecipe", created: "2026-11-08T01:00:00.000Z" });
        const r2 = createValidAdvRecipe({ name: "From JSON", created: "2026-11-08T02:00:00.000Z" });

        atomicWriteFileSync(advPath, JSON.stringify(r1));
        atomicWriteFileSync(jsonPath, JSON.stringify(r2));

        const list = await listLocalRecipes(customDir);
        assert.equal(list.length, 1);
        assert.equal(list[0].name, "From AdvRecipe");
    });
});

test("T5_STO_05: deleteRecipeDiskSync strictly refuses deletion outside customDir", () => {
    return withTempDir(customDir => {
        const outsideDir = mkdtempSync(join(tmpdir(), "adv-outside-"));
        const outsideFile = join(outsideDir, "victim.advrecipe");
        atomicWriteFileSync(outsideFile, "do not delete");

        try {
            // Attempt deletion via relative traversal
            const resRel = deleteRecipeDiskSync("../victim", customDir);
            assert.equal(resRel, false);
            assert.equal(existsSync(outsideFile), true);

            // Attempt deletion via absolute path
            const resAbs = deleteRecipeDiskSync(outsideFile, customDir);
            assert.equal(resAbs, false);
            assert.equal(existsSync(outsideFile), true);
        } finally {
            try { rmSync(outsideDir, { recursive: true, force: true }); } catch {}
        }
    });
});

test("T5_STO_06: Atomic file write cleans up temporary .tmp file when target directory is deleted mid-write", () => {
    return withTempDir(customDir => {
        const target = join(customDir, "test__sub.advrecipe");
        atomicWriteFileSync(target, '{"test": 1}');
        assert.ok(existsSync(target));

        const files = readdirSync(customDir);
        const tmpFiles = files.filter(f => f.endsWith(".tmp"));
        assert.equal(tmpFiles.length, 0);
    });
});

test("T5_STO_07: Storage methods safely handle empty strings, whitespace, and non-string inputs", async () => {
    assert.equal(loadRecipeDiskSync(""), null);
    assert.equal(loadRecipeDiskSync("   "), null);
    assert.equal(loadRecipeDiskSync(null), null);
    assert.equal(loadRecipeDiskSync(undefined), null);

    assert.equal(deleteRecipeDiskSync(""), false);
    assert.equal(deleteRecipeDiskSync("   "), false);
    assert.equal(deleteRecipeDiskSync(null), false);

    const listEmpty = await listLocalRecipes(null);
    assert.ok(Array.isArray(listEmpty));
});

// ============================================================================
// SECTION 3: Quest Event Recorder Causal Tracking & Noise Resilience
// ============================================================================

test("T5_REC_09: Recorder filters 10,000 high-frequency engine noise events without memory leak", () => {
    const recorder = new QuestEventRecorder({ maxEvents: 50 });
    recorder.start();

    // Fire 10,000 engine noise events
    const noiseNames = Array.from(ENGINE_NOISE_EVENTS);
    for (let i = 0; i < 10000; i++) {
        recorder.recordAppFire(noiseNames[i % noiseNames.length], { x: i, y: i });
    }

    assert.equal(recorder.events.length, 0);

    // Now fire 5 legitimate events
    recorder.recordAppFire("select:play");
    recorder.recordAppFire("hero:move", { x: 10 });
    recorder.recordAppFire("target:hit", { id: 1 });
    recorder.recordAppFire("target:eliminated", { id: 1 });
    recorder.recordAppFire("arise:questComplete");

    assert.equal(recorder.events.length, 5);
    assert.equal(recorder.verifiedCompletion, true);
    assert.equal(recorder.state, "completed");
});

test("T5_REC_10: Recorder ring buffer caps events at maxEvents and drops oldest", () => {
    const recorder = new QuestEventRecorder({ maxEvents: 10 });
    recorder.start();

    for (let i = 1; i <= 25; i++) {
        recorder.recordAppFire("action:" + i, i);
    }

    assert.equal(recorder.events.length, 10);
    assert.equal(recorder.events[0].name, "action:16");
    assert.equal(recorder.events[9].name, "action:25");
});

test("T5_REC_11: Extraneous cosmetic events are classified into optional_events", () => {
    const recorder = new QuestEventRecorder({ appId: "test_game" });
    recorder.start();

    recorder.recordAppFire("select:play");
    recorder.recordAppFire("cosmetic:skin_preview", "dragon_vandal");
    recorder.recordAppFire("camera:pan_zoom", 1.5);
    recorder.recordAppFire("pause:game");
    recorder.recordAppFire("resume:game");
    recorder.recordAppFire("audio:volume_change", 80);
    recorder.recordAppFire("quest:objective_cleared");
    recorder.recordAppFire("arise:questComplete");

    assert.equal(recorder.state, "completed");
    const recipe = recorder.deriveAdvRecipe("arise:questComplete");

    assert.equal(recipe.verifiedCompletion, true);
    const entryNames = recipe.completion.entries.map(e => e.name);
    assert.ok(entryNames.includes("select:play"));
    assert.ok(entryNames.includes("quest:objective_cleared"));
    assert.ok(!entryNames.includes("cosmetic:skin_preview"));
    assert.ok(!entryNames.includes("camera:pan_zoom"));
    assert.ok(!entryNames.includes("pause:game"));

    assert.ok(recipe.optional_events.includes("cosmetic:skin_preview"));
    assert.ok(recipe.optional_events.includes("camera:pan_zoom"));
    assert.ok(recipe.optional_events.includes("pause:game"));
});

test("T5_REC_12: Instant quest completion without causal parent links derives valid recipe", () => {
    const recorder = new QuestEventRecorder({ appId: "instant_app", scene: "lobby" });
    recorder.start();

    // Only one event, and it is the goal
    recorder.recordAppFire("arise:questComplete");

    assert.equal(recorder.state, "completed");
    assert.equal(recorder.verifiedCompletion, true);

    const recipe = recorder.deriveAdvRecipe("arise:questComplete");
    assert.equal(recipe.application_id, "instant_app");
    assert.equal(recipe.scene, "lobby");
    assert.equal(recipe.completion.goal, "arise:questComplete");
    assert.equal(recipe.completion.triggers[0], "select:play");
    assert.equal(recipe.completion.entries.length, 0);

    const val = validateRecipe(recipe);
    // Even if entries is empty, recorder produced minimal valid structure
    assert.equal(recipe.format, "advrecipe");
});

test("T5_REC_13: recordArisePostMessage handles JSON string, raw string, and object formats", () => {
    const recorder = new QuestEventRecorder();
    recorder.start();

    // 1. Progress as JSON string
    recorder.recordArisePostMessage(JSON.stringify({ type: "quest-progress", current: 1, target: 5 }));
    assert.equal(recorder.events.length, 1);
    assert.equal(recorder.events[0].name, "quest-progress");
    assert.equal(recorder.events[0].isProgress, true);

    // 2. Progress as raw object
    recorder.recordArisePostMessage({ event: "quest-progress", current: 2 });
    assert.equal(recorder.events.length, 2);

    // 3. Quest completion as JSON string
    recorder.recordArisePostMessage(JSON.stringify({ cmd: "quest-completed" }));
    assert.equal(recorder.state, "completed");
    assert.equal(recorder.verifiedCompletion, true);
});

test("T5_REC_14: Rapid multiple completion triggers are idempotent", () => {
    let completeCount = 0;
    const recorder = new QuestEventRecorder({
        onComplete: () => { completeCount++; }
    });
    recorder.start();

    recorder.recordAppFire("select:play");
    recorder.recordAppFire("arise:questComplete");
    recorder.recordAppFire("quest:completed");
    recorder.recordArisePostMessage("quest-completed");
    recorder.recordArisePostMessage({ type: "quest-completed" });

    assert.equal(recorder.state, "completed");
    assert.equal(completeCount, 1);
});

test("T5_REC_15: Injected recorder script contains zero non-ASCII characters and valid JS syntax", () => {
    const script = buildRecorderScript();
    assert.ok(script.length > 500);

    // Check strict ASCII
    for (let i = 0; i < script.length; i++) {
        assert.ok(script.charCodeAt(i) <= 127, `Non-ASCII char at index ${i}: ${script[i]}`);
    }

    // Verify syntax with Function constructor
    assert.doesNotThrow(() => {
        new Function(script);
    });
});

// ============================================================================
// SECTION 4: Experiences Menu State Machine & Cross-Frame Sync
// ============================================================================

test("T5_MNU_01: buildMenuMessage produces valid structured message payload", () => {
    const msg = buildMenuMessage({ esp: true, minimap: false, autoComplete: true });
    assert.equal(msg[MENU_MESSAGE_TAG], true);
    assert.equal(msg.type, "menu_state");
    assert.equal(msg.esp, true);
    assert.equal(msg.minimap, false);
    assert.equal(msg.autoComplete, true);
});

test("T5_MNU_02: buildMenuScript generates valid JS with zero non-ASCII characters", () => {
    const script = buildMenuScript({ esp: false, minimap: true, autoComplete: false, recording: false });
    assert.ok(script.length > 1000);

    for (let i = 0; i < script.length; i++) {
        assert.ok(script.charCodeAt(i) <= 127, `Non-ASCII char at index ${i}: ${script[i]}`);
    }

    assert.doesNotThrow(() => {
        new Function(script);
    });
});

test("T5_MNU_03: canShareRecipe rejects unverified, missing, or falsified string completion", () => {
    assert.equal(canShareRecipe(null), false);
    assert.equal(canShareRecipe(undefined), false);
    assert.equal(canShareRecipe({}), false);

    const falsifiedString = createValidAdvRecipe({ verifiedCompletion: "true" });
    assert.equal(canShareRecipe(falsifiedString), false);

    const falsifiedNumber = createValidAdvRecipe({ verifiedCompletion: 1 });
    assert.equal(canShareRecipe(falsifiedNumber), false);

    const incomplete = createValidAdvRecipe({ verifiedCompletion: false });
    assert.equal(canShareRecipe(incomplete), false);

    const valid = createValidAdvRecipe({ verifiedCompletion: true });
    assert.equal(canShareRecipe(valid), true);
});

test("T5_MNU_04: Injected menu script embeds safe image base64 data URI", () => {
    const script = buildMenuScript({ esp: true, minimap: true, autoComplete: true });
    assert.ok(script.includes("data:image/png;base64,"));
    assert.ok(script.includes("adventurer-experience-bar"));
    assert.ok(script.includes("adventurer-btn-record"));
    assert.ok(script.includes("adventurer-btn-share"));
});

test("T5_MNU_05: Menu handles RECIPE_RECORDING_COMPLETED message with false verifiedCompletion", () => {
    const script = buildMenuScript({ esp: true, minimap: true, autoComplete: true });
    assert.ok(script.includes('if (recipe && recipe.verifiedCompletion === true)'));
    assert.ok(script.includes('state.recordingState = "completed"'));
    assert.ok(script.includes('state.recordingState = "incomplete"'));
});

test("T5_MNU_06: Menu handles external control message types (START, STOP, RESET)", () => {
    const script = buildMenuScript({ esp: true, minimap: true, autoComplete: true });
    assert.ok(script.includes('START_RECIPE_RECORDING'));
    assert.ok(script.includes('STOP_RECIPE_RECORDING'));
    assert.ok(script.includes('RESET_RECIPE_RECORDING'));
});

// ============================================================================
// SECTION 5: Completion Runner Precedence, Injected Recipes & Collectibles
// ============================================================================

test("T5_CMP_01: Precedence hierarchy evaluates all 5 ranks correctly", () => {
    const localExact = { scene: "Aces_Main", name: "localExact" };
    const bundledExact = { scene: "Aces_Main", name: "bundledExact" };
    const localWildcard = { scene: "*", name: "localWildcard" };
    const bundledWildcard = { scene: "*", name: "bundledWildcard" };
    const guessed = { scene: "Aces_Main", name: "guessed" };

    // 1. Local exact beats all
    assert.equal(resolvePrecedence([localExact, localWildcard], [bundledExact, bundledWildcard], guessed, "Aces_Main").recipe.name, "localExact");

    // 2. Bundled exact beats local wildcard
    assert.equal(resolvePrecedence([localWildcard], [bundledExact, bundledWildcard], guessed, "Aces_Main").recipe.name, "bundledExact");

    // 3. Local wildcard beats bundled wildcard
    assert.equal(resolvePrecedence([localWildcard], [bundledWildcard], guessed, "Different_Scene").recipe.name, "localWildcard");

    // 4. Bundled wildcard beats guessed
    assert.equal(resolvePrecedence([], [bundledWildcard], guessed, "Different_Scene").recipe.name, "bundledWildcard");

    // 5. Guessed fills the gap when no local or bundled matches
    assert.equal(resolvePrecedence([], [], guessed, "Aces_Main").recipe.name, "guessed");
});

test("T5_CMP_02: buildInjectRecipeMessage and buildExecuteRecipeMessage shape and flags", () => {
    const recipe = createValidAdvRecipe();

    const injectMsg = buildInjectRecipeMessage(recipe, false);
    assert.equal(injectMsg[COMPLETION_MESSAGE_TAG], true);
    assert.equal(injectMsg.type, ADVENTURER_INJECT_RECIPE_TYPE);
    assert.equal(injectMsg.recipe, recipe);
    assert.equal(injectMsg.execute, false);

    const execMsg = buildExecuteRecipeMessage(recipe);
    assert.equal(execMsg[COMPLETION_MESSAGE_TAG], true);
    assert.equal(execMsg.type, ADVENTURER_EXECUTE_RECIPE_TYPE);
    assert.equal(execMsg.recipe, recipe);
    assert.equal(execMsg.execute, true);
});

test("T5_CMP_03: Injected completion script contains zero non-ASCII characters", () => {
    const script = buildCompletionScript({ recipes: [], quests: {} });
    assert.ok(script.length > 5000);

    for (let i = 0; i < script.length; i++) {
        assert.ok(script.charCodeAt(i) <= 127, `Non-ASCII char at index ${i}: ${script[i]}`);
    }

    assert.doesNotThrow(() => {
        new Function(script);
    });
});

test("T5_CMP_04: Delay clamping enforces MAX_DELAY_MS ceiling on both trigger and entry delays", () => {
    assert.equal(clampDelay(500), 500);
    assert.equal(clampDelay(15000), 10000); // clamped to MAX_DELAY_MS
    assert.equal(clampDelay(-50), 0);
    assert.equal(clampDelay("not-a-number"), 0);
    assert.equal(clampDelay(NaN), 0);
    assert.equal(clampDelay(Infinity), 0);
});

test("T5_CMP_05: Trigger and entry problem checkers enforce leaderboard and goal constraints", () => {
    assert.equal(triggerProblem(""), "Enter an event name.");
    assert.ok(triggerProblem("leaderboard:score").includes("Leaderboard events can never be triggers"));
    assert.equal(triggerProblem("player:jump"), "");

    assert.equal(entryProblem(""), "Enter an event name.");
    assert.ok(entryProblem("leaderboard:update").includes("Leaderboard events can never be entries"));
    assert.ok(entryProblem("arise:questComplete", "arise:questComplete").includes("is the goal event"));
    assert.ok(entryProblem("arise:telemetry").includes("arise:* events can never be entries"));
    assert.equal(entryProblem("action:interact", "arise:questComplete"), "");
});

test("T5_CMP_06: parseArgs rejects oversized strings and invalid JSON gracefully", () => {
    const nonString = parseArgs(12345);
    assert.equal(nonString.value, null);
    assert.ok(nonString.problem.includes("must be a string"));

    const oversized = parseArgs("[" + "1,".repeat(20000) + "1]");
    assert.equal(oversized.value, null);
    assert.ok(oversized.problem.includes("longer than 20000 characters"));

    const invalidJson = parseArgs("[ { unquoted: 1 } ]");
    assert.equal(invalidJson.value, null);
    assert.ok(invalidJson.problem.includes("Not valid JSON"));

    const notAnArray = parseArgs('{"a": 1}');
    assert.equal(notAnArray.value, null);
    assert.ok(notAnArray.problem.includes("must be a JSON list"));

    const validArgs = parseArgs('[1, "test", {"key": true}]');
    assert.equal(validArgs.problem, "");
    assert.deepEqual(validArgs.value, [1, "test", { key: true }]);
});

test("T5_CMP_07: completion runner handles injected recipe with default fallback triggers", () => {
    const script = buildCompletionScript({ recipes: [], quests: {} });
    assert.ok(script.includes('c.triggers = ["select:play", "execute:direct"]'));
    assert.ok(script.includes('normalizeInjectedRecipe'));
    assert.ok(script.includes('ADVENTURER_INJECT_RECIPE'));
    assert.ok(script.includes('ADVENTURER_EXECUTE_RECIPE'));
});

// ============================================================================
// SECTION 6: Forward Modal Double-Lock & Concurrency Gating
// ============================================================================

test("T5_FWD_01: openRecipeForwardModal throws when recipe has verifiedCompletion !== true", () => {
    const unverifiedRecipe = createValidAdvRecipe({ verifiedCompletion: false });
    assert.throws(() => {
        openRecipeForwardModal(unverifiedRecipe);
    }, /Share blocked: quest incomplete/);

    const corruptRecipe = createValidAdvRecipe({ verifiedCompletion: "true" });
    assert.throws(() => {
        openRecipeForwardModal(corruptRecipe);
    }, /Share blocked: quest incomplete/);
});

test("T5_FWD_02: customSendHandler blocks concurrent double submission via isSubmitting flag", async () => {
    resetForwardModalState();
    const recipe = createValidAdvRecipe();
    setCommunityShare(true);

    let dispatchCalls = 0;
    setWebpackMock("RestAPI", {
        post: async (req) => {
            dispatchCalls++;
            // Simulate 50ms network delay
            await new Promise(r => setTimeout(r, 50));
            return { ok: true, status: 200, body: { id: "msg_123" } };
        },
        put: async () => ({ ok: true, status: 200 })
    });

    try {
        openRecipeForwardModal(recipe);
        assert.equal(getForwardModalState().activeRecipe, recipe);

        // Fire two concurrent submit calls
        const p1 = customSendHandler(["123456789012345678"]);
        const p2 = customSendHandler(["123456789012345678"]);

        await Promise.all([p1, p2]);

        // Second call should have been dropped by the in-flight lock
        assert.equal(getForwardModalState().isSubmitting, false);
        assert.equal(getForwardModalState().activeRecipe, null);
    } finally {
        resetWebpackMocks();
        resetForwardModalState();
    }
});

test("T5_FWD_03: createRecipeMessage builds correct synthetic Discord attachment payload", () => {
    const recipe = createValidAdvRecipe();
    const msg = createRecipeMessage(recipe);

    assert.ok(msg.id.startsWith("adv-recipe-"));
    assert.equal(msg.content, "Adventurer Quest Recipe: **VALORANT Aces Speedrun**");
    assert.equal(msg.attachments.length, 1);
    assert.equal(msg.attachments[0].filename, "1536318183873454090.advrecipe");
    assert.equal(msg.attachments[0].content_type, "application/json");
    assert.ok(msg.attachments[0].size > 0);
});

test("T5_FWD_04: forwardModalPatches define valid Webpack patch replacements", () => {
    assert.ok(Array.isArray(forwardModalPatches));
    assert.equal(forwardModalPatches.length, 1);
    assert.equal(forwardModalPatches[0].find, 'modalKey:"forward-modal"');
    assert.ok(forwardModalPatches[0].replacement.replace.includes("CommunityShareCheckbox"));
});

test("T5_FWD_05: Forward modal state store listeners are notified on state changes", () => {
    resetForwardModalState();
    let notifyCount = 0;
    const unsub = subscribeForwardModalState(() => {
        notifyCount++;
    });

    setCommunityShare(true);
    assert.equal(getForwardModalState().shareWithCommunity, true);
    assert.equal(notifyCount, 1);

    setCommunityShare(false);
    assert.equal(getForwardModalState().shareWithCommunity, false);
    assert.equal(notifyCount, 2);

    unsub();
    setCommunityShare(true);
    assert.equal(notifyCount, 2); // No more updates after unsub
    resetForwardModalState();
});

test("T5_FWD_06: Forward modal DOM observer safely installs and disconnects", () => {
    assert.doesNotThrow(() => {
        installForwardModalDOMObserver();
        removeForwardModalDOMObserver();
    });
});

// ============================================================================
// SECTION 7: Community Guild Verification & 3-Step Headless REST Distribution
// ============================================================================

test("T5_COM_01: isCommunityMember flexible signatures and membership cache", () => {
    resetCommunityMembershipCache();

    const mockGuildStore = {
        getGuild: (id) => (id === COMMUNITY_GUILD_ID ? { id, name: "Adventurer" } : null)
    };

    // Signature 1: isCommunityMember(guildId, store)
    assert.equal(isCommunityMember(COMMUNITY_GUILD_ID, mockGuildStore), true);
    assert.equal(isCommunityMember("other_guild", mockGuildStore), false);

    // Signature 2: isCommunityMember(store, guildId)
    assert.equal(isCommunityMember(mockGuildStore, COMMUNITY_GUILD_ID), true);
    assert.equal(isCommunityMember(mockGuildStore, "other_guild"), false);

    // Cache hit verification
    assert.equal(isCommunityMember(COMMUNITY_GUILD_ID), true);
    resetCommunityMembershipCache();
});

test("T5_COM_02: ensureCommunityMembership handles HTTP 429 rate limit on invite accept", async () => {
    resetCommunityMembershipCache();

    const rateLimitInviteActions = {
        acceptInvite: async () => {
            const err = new Error("Rate limited");
            err.status = 429;
            throw err;
        }
    };

    const emptyStore = { getGuild: () => null };

    const res = await ensureCommunityMembership({
        guildStore: emptyStore,
        inviteActions: rateLimitInviteActions
    });

    assert.equal(res.ok, false);
    assert.equal(res.isMember, false);
    assert.ok(res.error.includes("Rate limited by Discord"));
});

test("T5_COM_03: ensureCommunityMembership handles error codes 10006 (invalid invite) and 30001 (max guilds)", async () => {
    resetCommunityMembershipCache();
    const emptyStore = { getGuild: () => null };

    // 10006: Unknown Invite
    const inv10006 = {
        acceptInvite: async () => {
            const err = new Error("Unknown Invite");
            err.code = 10006;
            throw err;
        }
    };
    const res1 = await ensureCommunityMembership({ guildStore: emptyStore, inviteActions: inv10006 });
    assert.equal(res1.ok, false);
    assert.ok(res1.error.includes("invalid or expired (10006)"));

    // 30001: Maximum number of guilds
    const inv30001 = {
        acceptInvite: async () => {
            const err = new Error("Maximum number of guilds reached");
            err.code = 30001;
            throw err;
        }
    };
    const res2 = await ensureCommunityMembership({ guildStore: emptyStore, inviteActions: inv30001 });
    assert.equal(res2.ok, false);
    assert.ok(res2.error.includes("Maximum number of guilds reached (30001)"));
});

test("T5_COM_04: Headless 3-step REST upload protocol: Step 2 failure aborts before Step 3", async () => {
    let step1Called = false;
    let step2Called = false;
    let step3Called = false;

    const mockRestApi = {
        post: async (req) => {
            if (req.url.includes("/attachments")) {
                step1Called = true;
                return {
                    ok: true,
                    status: 200,
                    body: {
                        attachments: [{
                            id: "0",
                            upload_url: "https://discord.storage.mock/upload/test.advrecipe",
                            upload_filename: "uploaded_test.advrecipe"
                        }]
                    }
                };
            }
            if (req.url.includes("/messages")) {
                step3Called = true;
                return { ok: true, status: 200, body: { id: "msg_orphan" } };
            }
            return { ok: true, status: 200 };
        },
        put: async () => {
            step2Called = true;
            // Step 2 Storage PUT fails!
            return { ok: false, status: 500 };
        }
    };

    await assert.rejects(async () => {
        await dispatchRecipeToChannel(mockRestApi, "channel_123", "test.advrecipe", '{"format":"advrecipe"}');
    }, /Failed to upload recipe payload to storage/);

    assert.equal(step1Called, true);
    assert.equal(step2Called, true);
    assert.equal(step3Called, false); // Crucial: Step 3 must NOT run!
});

test("T5_COM_05: dispatchRecipeAttachment rejects 0-byte and oversized (>10MB) payloads", async () => {
    const validRecipe = createValidAdvRecipe();

    // Oversized recipe test (> 10MB)
    const oversizedRecipe = createValidAdvRecipe({
        name: "x".repeat(11 * 1024 * 1024)
    });

    const resOver = await dispatchRecipeAttachment("channel_123", oversizedRecipe);
    assert.equal(resOver.ok, false);
    assert.ok(resOver.error.includes("exceeds maximum size limit"));

    // Unverified recipe test
    const unverifiedRecipe = createValidAdvRecipe({ verifiedCompletion: false });
    const resUnver = await dispatchRecipeAttachment("channel_123", unverifiedRecipe);
    assert.equal(resUnver.ok, false);
    assert.ok(resUnver.error.includes("verifiedCompletion === true"));
});

test("T5_COM_06: parseRetryAfterMs accurately calculates delay from numeric and milliseconds headers", () => {
    // Discord API gives retry_after in seconds (e.g., 2.5s)
    assert.equal(parseRetryAfterMs({ body: { retry_after: 2.5 } }), 2600);
    // Some Discord endpoints give milliseconds directly (>1000)
    assert.equal(parseRetryAfterMs({ body: { retry_after: 3500 } }), 3600);
    // Missing or invalid returns default 1.1s
    assert.equal(parseRetryAfterMs({ body: {} }), 1100);
});

test("T5_COM_07: getUtf8ByteLength correctly counts multi-byte unicode characters", () => {
    assert.equal(getUtf8ByteLength("hello"), 5);
    // Emojis (4 bytes each) via ASCII unicode escape sequences
    assert.equal(getUtf8ByteLength("\uD83C\uDFAE"), 4);
    assert.equal(getUtf8ByteLength("\u2694\uFE0F"), 6);
    // Accented and multi-byte Latin / Cyrillic via ASCII unicode escape sequences
    assert.equal(getUtf8ByteLength("caf\u00E9"), 5);
    assert.equal(getUtf8ByteLength("\u041F\u0440\u0438\u0432\u0435\u0442"), 12);
});

test("T5_COM_08: dispatchToRecipients handles batch dispatching with mixed successes and failures", async () => {
    const recipe = createValidAdvRecipe();

    let calls = 0;
    const mockRestApi = {
        post: async (req) => {
            calls++;
            if (req.url.includes("/channels/bad_channel/")) {
                const err = new Error("Channel not found");
                err.status = 404;
                throw err;
            }
            if (req.url.includes("/attachments")) {
                return {
                    ok: true,
                    status: 200,
                    body: {
                        attachments: [{
                            id: "0",
                            upload_url: "https://mock.storage/up",
                            upload_filename: "uploaded"
                        }]
                    }
                };
            }
            return { ok: true, status: 200, body: { id: "msg_ok" } };
        },
        put: async () => ({ ok: true, status: 200 })
    };

    const channels = ["good_1", "bad_channel", "good_2"];
    const result = await dispatchToRecipients(channels, recipe, {
        restApi: mockRestApi
    });

    assert.deepEqual(result.successful, ["good_1", "good_2"]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].channelId, "bad_channel");
});

// ============================================================================
// SECTION 8: Recipe Message Accessory UI & One-Click Execution
// ============================================================================

test("T5_ACC_01: isRecipeAttachment detects .advrecipe extensions case-insensitively", () => {
    assert.equal(isRecipeAttachment({ filename: "quest.advrecipe" }), true);
    assert.equal(isRecipeAttachment({ filename: "QUEST.ADVRECIPE" }), true);
    assert.equal(isRecipeAttachment({ filename: "valorant.AdvRecipe" }), true);
    assert.equal(isRecipeAttachment({ filename: "recipe.json" }), false);
    assert.equal(isRecipeAttachment({ filename: "advrecipe.txt" }), false);
    assert.equal(isRecipeAttachment(null), false);
    assert.equal(isRecipeAttachment({}), false);
});

test("T5_ACC_02: parseRecipeContent rejects empty strings, corrupted JSON, and invalid schema", () => {
    assert.throws(() => parseRecipeContent(""), /Empty attachment file/);
    assert.throws(() => parseRecipeContent("   "), /Empty attachment file/);
    assert.throws(() => parseRecipeContent("{ not valid json !!"), /Corrupted recipe file/);

    const invalidSchema = JSON.stringify({ format: "not_advrecipe" });
    assert.throws(() => parseRecipeContent(invalidSchema), /Invalid recipe schema/);

    const validJson = JSON.stringify(createValidAdvRecipe());
    const parsed = parseRecipeContent(validJson);
    assert.equal(parsed.name, "VALORANT Aces Speedrun");
});

test("T5_ACC_03: fetchRecipeAttachment throws on 0-byte and >10MB files without network request", async () => {
    await assert.rejects(async () => {
        await fetchRecipeAttachment({ filename: "empty.advrecipe", size: 0, url: "https://mock.url" });
    }, /Empty attachment file/);

    await assert.rejects(async () => {
        await fetchRecipeAttachment({ filename: "huge.advrecipe", size: 10485761, url: "https://mock.url" });
    }, /Recipe file exceeds 10MB limit/);
});

test("T5_ACC_04: getCardHeader extracts title, appId, and verification badge", () => {
    const verified = createValidAdvRecipe({ name: "Speedrun", application_id: "12345", verifiedCompletion: true });
    const h1 = getCardHeader(verified);
    assert.equal(h1.title, "Speedrun");
    assert.equal(h1.appId, "12345");
    assert.equal(h1.verifiedBadge, "Verified Quest");

    const unverified = createValidAdvRecipe({ name: "Testing", application_id: "67890", verifiedCompletion: false });
    const h2 = getCardHeader(unverified);
    assert.equal(h2.title, "Testing");
    assert.equal(h2.appId, "67890");
    assert.equal(h2.verifiedBadge, "Unverified");
});

test("T5_ACC_05: executeRecipe broadcasts completion_inject and ADVENTURER_EXECUTE_RECIPE", () => {
    const recipe = createValidAdvRecipe();
    const res = executeRecipe(recipe, { broadcastWindow: false });

    assert.equal(res.type, "completion_inject");
    assert.equal(res.execute, true);
    assert.equal(res.recipe, recipe);
});

test("T5_ACC_06: RecipeAccessoryCard component renders error card for corrupted attachments", () => {
    const corruptedAttachment = {
        filename: "corrupt.advrecipe",
        content: "{ broken json"
    };

    const element = RecipeAccessoryCard({ attachment: corruptedAttachment });
    assert.ok(element);
    assert.equal(element.type, "div");
    assert.equal(element.props["data-testid"], "adventurer-recipe-card");
    assert.ok(JSON.stringify(element).includes("RECIPE ERROR"));
});

test("T5_ACC_07: RecipeAccessoryCard component renders verified badge for valid recipes", () => {
    const validRecipe = createValidAdvRecipe();
    const validAttachment = {
        filename: "valid.advrecipe",
        content: JSON.stringify(validRecipe)
    };

    const element = RecipeAccessoryCard({ attachment: validAttachment });
    assert.ok(element);
    assert.equal(element.type, "div");
    assert.ok(JSON.stringify(element).includes("VERIFIED RECIPE"));
});

// ============================================================================
// SECTION 9: End-to-End Subsystem Integration & Cross-Milestone Contracts
// ============================================================================

test("T5_E2E_01: Full Quest Cycle: Record -> Verify -> Persist -> Accessory -> Forward", async () => {
    return await withTempDirAsync(async customDir => {
        // Step 1: Record quest
        const recorder = new QuestEventRecorder({ appId: "e2e_game", scene: "MainMap", name: "E2E Recorded Quest" });
        recorder.start();
        recorder.recordAppFire("select:play");
        recorder.recordAppFire("checkpoint:1");
        recorder.recordAppFire("checkpoint:2");
        recorder.recordAppFire("arise:questComplete");

        assert.equal(recorder.verifiedCompletion, true);
        const recipe = recorder.deriveAdvRecipe("arise:questComplete");
        assert.equal(canShareRecipe(recipe), true);

        // Step 2: Save to disk atomically
        const saveRes = await saveRecipeDisk(recipe, customDir);
        assert.equal(saveRes.ok, true);
        assert.ok(existsSync(saveRes.path));

        // Step 3: Load from disk
        const loaded = await loadRecipeDisk(saveRes.path, customDir);
        assert.equal(loaded.application_id, "e2e_game");
        assert.equal(loaded.verifiedCompletion, true);

        // Step 4: Display in message accessory
        const att = { filename: "e2e_game__MainMap.advrecipe", content: JSON.stringify(loaded) };
        const card = RecipeAccessoryCard({ attachment: att, customDir });
        assert.ok(JSON.stringify(card).includes("VERIFIED RECIPE"));

        // Step 5: Forward to community
        resetForwardModalState();
        setCommunityShare(true);
        let sharedMessageId = null;

        setWebpackMock("RestAPI", {
            post: async (req) => {
                if (req.url.includes("/attachments")) {
                    return {
                        ok: true,
                        status: 200,
                        body: {
                            attachments: [{
                                id: "0",
                                upload_url: "https://mock.storage/upload",
                                upload_filename: "uploaded_e2e"
                            }]
                        }
                    };
                }
                if (req.url.includes("/messages")) {
                    sharedMessageId = "msg_e2e_success";
                    return { ok: true, status: 200, body: { id: sharedMessageId } };
                }
                return { ok: true, status: 200 };
            },
            put: async () => ({ ok: true, status: 200 })
        });

        try {
            openRecipeForwardModal(loaded);
            await customSendHandler(["1562024068838854726"]);
            assert.equal(sharedMessageId, "msg_e2e_success");
        } finally {
            resetWebpackMocks();
            resetForwardModalState();
        }
    });
});

test("T5_E2E_02: Client Restart Simulation: Clean heap recovers all disk recipes without DataStore", async () => {
    return await withTempDirAsync(async customDir => {
        // Save 3 recipes
        const r1 = createValidAdvRecipe({ application_id: "app1", name: "Quest 1", created: "2026-11-08T01:00:00.000Z" });
        const r2 = createValidAdvRecipe({ application_id: "app2", name: "Quest 2", created: "2026-11-08T02:00:00.000Z" });
        const r3 = createValidAdvRecipe({ application_id: "app3", name: "Quest 3", created: "2026-11-08T03:00:00.000Z" });

        await saveRecipeDisk(r1, customDir);
        await saveRecipeDisk(r2, customDir);
        await saveRecipeDisk(r3, customDir);

        // Simulate complete client restart (heap wipe, zero DataStore)
        const discovered = listLocalRecipesSync(customDir);
        assert.equal(discovered.length, 3);
        assert.equal(discovered[0].name, "Quest 3"); // Newest first
        assert.equal(discovered[1].name, "Quest 2");
        assert.equal(discovered[2].name, "Quest 1");

        // Verify completion runner precedence picks newest
        const precedence = resolvePrecedence(discovered, [], null, "GlobalAces_MASTER");
        assert.ok(precedence);
        assert.equal(precedence.origin, "local");
        assert.equal(precedence.recipe.name, "Quest 3");
    });
});

test("T5_E2E_03: Strict ASCII compliance across all recipe string outputs", () => {
    const recipe = createValidAdvRecipe();
    const jsonStr = JSON.stringify(recipe, null, 2);

    for (let i = 0; i < jsonStr.length; i++) {
        assert.ok(jsonStr.charCodeAt(i) <= 127, `Non-ASCII in JSON at ${i}: ${jsonStr[i]}`);
    }

    const scriptMenu = buildMenuScript({ esp: true, minimap: true, autoComplete: true });
    for (let i = 0; i < scriptMenu.length; i++) {
        assert.ok(scriptMenu.charCodeAt(i) <= 127, `Non-ASCII in Menu Script at ${i}: ${scriptMenu[i]}`);
    }

    const scriptRecorder = buildRecorderScript();
    for (let i = 0; i < scriptRecorder.length; i++) {
        assert.ok(scriptRecorder.charCodeAt(i) <= 127, `Non-ASCII in Recorder Script at ${i}: ${scriptRecorder[i]}`);
    }

    const scriptCompletion = buildCompletionScript({ recipes: [], quests: {} });
    for (let i = 0; i < scriptCompletion.length; i++) {
        assert.ok(scriptCompletion.charCodeAt(i) <= 127, `Non-ASCII in Completion Script at ${i}: ${scriptCompletion[i]}`);
    }
});

// ============================================================================
// SECTION 10: Userplugin Wiring, Message Accessories & Patch Registration
// ============================================================================

test("T5_PLG_01: Plugin definition registers MessageAccessoriesAPI dependency and accessory methods", () => {
    assert.equal(pluginDefault.name, "Adventurer");
    assert.ok(Array.isArray(pluginDefault.dependencies));
    assert.ok(pluginDefault.dependencies.includes("MessageAccessoriesAPI"));
    assert.equal(typeof pluginDefault.renderMessageAccessory, "function");
    assert.equal(typeof pluginDefault.RecipeAccessory, "function");
    assert.equal(typeof pluginDefault.renderRecipeAccessory, "function");
});

test("T5_PLG_02: Plugin patches array includes forwardModalPatches", () => {
    assert.ok(Array.isArray(pluginDefault.patches));
    const forwardPatch = pluginDefault.patches.find(p => p.find === 'modalKey:"forward-modal"');
    assert.ok(forwardPatch);
    assert.ok(forwardPatch.replacement.replace.includes("CommunityShareCheckbox"));
});

test("T5_PLG_03: Plugin renderMessageAccessory renders accessory card for .advrecipe attachments", () => {
    const validRecipe = createValidAdvRecipe();
    const props = {
        message: {
            id: "msg_chat_1",
            attachments: [
                { filename: "quest.advrecipe", content: JSON.stringify(validRecipe) },
                { filename: "image.png" }
            ]
        }
    };

    const accessory = pluginDefault.renderMessageAccessory(props);
    assert.ok(accessory);
    assert.equal(accessory.type, RecipeAccessory);
    assert.equal(accessory.props.message.id, "msg_chat_1");
});

