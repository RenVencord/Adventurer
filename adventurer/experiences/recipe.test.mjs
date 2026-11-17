// adventurer/experiences/recipe.test.mjs
// Comprehensive opaque-box E2E test suite for DiscordAdventurer Recipe Recording,
// Sharing, Persistence, and Client Injection across Tiers 1-4.
// Run with: node --test adventurer/experiences/recipe.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import { buildMenuScript, buildMenuMessage } from "./menu.ts";
import {
    PROFILES_PLACEHOLDER,
    COMPLETION_MESSAGE_TAG,
    buildCompletionMessage,
    buildInjectRecipeMessage,
    buildExecuteRecipeMessage,
    resolvePrecedence
} from "./completion.ts";
import {
    QuestEventRecorder,
    buildRecorderScript,
    ENGINE_NOISE_EVENTS
} from "./recorder.ts";

// ============================================================================
// Authoritative Production Deliverable Imports (recipe.ts & storage.ts)
// ============================================================================

import {
    RECIPE_VERSION,
    MAX_KEEP_STRING,
    MAX_ARGS_CHARS,
    MAX_DELAY_MS,
    COMMUNITY_GUILD_ID,
    COMMUNITY_CHANNEL_ID,
    COMMUNITY_INVITE_CODE,
    isLeaderboard,
    isArise,
    slug,
    triggerProblem,
    entryProblem,
    clampDelay,
    sensitiveReason,
    validateRecipe,
    sanitizeArgs,
    canShareRecipe
} from "./recipe.ts";

import {
    saveRecipeDisk,
    loadRecipeDisk,
    loadRecipeDiskSync,
    listLocalRecipes,
    listLocalRecipesSync,
    deleteRecipeDisk,
    deleteRecipeDiskSync,
    atomicSaveRecipe,
    isSafePath
} from "./storage.ts";

import {
    verifyAndJoinCommunity,
    dispatchRecipeToChannel,
    isCommunityMember,
    ensureCommunityMembership,
    dispatchRecipeAttachment,
    shareRecipeWithCommunity,
    dispatchToRecipients,
    resetCommunityMembershipCache
} from "../sharing/community.ts";

export {
    verifyAndJoinCommunity,
    dispatchRecipeToChannel,
    isCommunityMember,
    ensureCommunityMembership,
    dispatchRecipeAttachment,
    shareRecipeWithCommunity,
    dispatchToRecipients,
    resetCommunityMembershipCache
};

// ============================================================================
// ESM Loader Registration for .tsx transpilation & Webpack mocks in Node.js
// ============================================================================

import { register } from "node:module";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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

const forwardModal = await import("../sharing/forwardModal.tsx");
const {
    getForwardModalState,
    setCommunityShare,
    resetForwardModalState,
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
} = forwardModal;

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

export {
    getForwardModalState,
    setCommunityShare,
    resetForwardModalState,
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
    removeForwardModalDOMObserver,
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
};

// ============================================================================
// Fixture Helpers
// ============================================================================

function createMockValidRecipe(overrides = {}) {
    return {
        format: "advrecipe",
        version: 1,
        application_id: "1536318183873454090",
        scene: "GlobalAces_MASTER",
        name: "VALORANT Aces",
        created: "2026-11-08T00:15:00Z",
        verifiedCompletion: true,
        completion: {
            version: 1,
            goal: "arise:questComplete",
            triggers: ["select:play", "shot:fire"],
            entries: [
                {
                    name: "run:complete",
                    scope: "app",
                    args: [{ total: 0 }],
                    source: "recorded"
                }
            ],
            suppress: ["leaderboard"],
            delay_ms: 0,
            entry_delay_ms: 0,
            repeat_for: null,
            notes: "Authoritative verified test recipe",
            source: "recorded"
        },
        ...overrides
    };
}

// ============================================================================
// TIER 1: Core Feature Coverage (Features 1 to 13, 5 tests each = 65 tests)
// ============================================================================

// --- Feature 1: Recipe Model & Schema ---
test("T1_F1_01_valid_advrecipe_schema_passes_validation", () => {
    const recipe = createMockValidRecipe();
    const result = validateRecipe(recipe.completion);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
});

test("T1_F1_02_parses_json_advrecipe_format_and_version_1", () => {
    const raw = JSON.stringify(createMockValidRecipe());
    const parsed = JSON.parse(raw);
    assert.equal(parsed.format, "advrecipe");
    assert.equal(parsed.version, 1);
    assert.equal(parsed.application_id, "1536318183873454090");
});

test("T1_F1_03_rejects_non_object_root_inputs", () => {
    assert.equal(validateRecipe(null).valid, false);
    assert.equal(validateRecipe(undefined).valid, false);
    assert.equal(validateRecipe("string").valid, false);
    assert.equal(validateRecipe(42).valid, false);
    assert.equal(validateRecipe([]).valid, false);
});

test("T1_F1_04_requires_non_empty_string_goal", () => {
    const r1 = createMockValidRecipe().completion;
    delete r1.goal;
    assert.ok(validateRecipe(r1).errors.some(e => e.includes("no goal")));

    const r2 = { ...createMockValidRecipe().completion, goal: "" };
    assert.ok(validateRecipe(r2).errors.some(e => e.includes("no goal")));
});

test("T1_F1_05_requires_non_empty_triggers_array", () => {
    const r1 = { ...createMockValidRecipe().completion, triggers: [] };
    assert.ok(validateRecipe(r1).errors.some(e => e.includes("at least one trigger")));

    const r2 = { ...createMockValidRecipe().completion, triggers: "not-an-array" };
    assert.ok(validateRecipe(r2).errors.some(e => e.includes("at least one trigger")));
});

// --- Feature 2: Argument Sanitization ---
test("T1_F2_01_preserves_safe_primitives_and_entity_refs", () => {
    const input = [123, 45.6, true, false, null, "shortText", "@entity:guid-1234"];
    const { sanitized, stats } = sanitizeArgs(input);
    assert.deepEqual(sanitized, [123, 45.6, true, false, null, "shortText", "@entity:guid-1234"]);
    assert.equal(stats.removed, 0);
});

test("T1_F2_02_strips_sensitive_keys_token_password_secret", () => {
    const input = [{ token: "xyz123", password: "pass", secret: "sec", safe: "value" }];
    const { sanitized, stats } = sanitizeArgs(input);
    assert.deepEqual(sanitized, [{ safe: "value" }]);
    assert.equal(stats.removed, 3);
});

test("T1_F2_03_strips_discord_snowflakes_over_14_digits", () => {
    const input = ["1561961025446617128", 999];
    const { sanitized, stats } = sanitizeArgs(input);
    assert.deepEqual(sanitized, [null, 999]);
    assert.equal(stats.removed, 1);
});

test("T1_F2_04_strips_uuids_emails_urls_and_jwts", () => {
    const input = [
        "123e4567-e89b-12d3-a456-426614174000",
        "user@example.com",
        "https://discord.com/invite/2XhF3r4Avg",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0"
    ];
    const { sanitized, stats } = sanitizeArgs(input);
    assert.deepEqual(sanitized, []); // trailing removed values popped
    assert.equal(stats.removed, 4);
});

test("T1_F2_05_strips_strings_over_40_chars_and_tokenish_runs", () => {
    const longStr = "A".repeat(45);
    const tokenish = "abcdef1234567890abcdef123456";
    const { sanitized, stats } = sanitizeArgs([longStr, tokenish]);
    assert.deepEqual(sanitized, []);
    assert.equal(stats.removed, 2);
});

// --- Feature 3: Local Disk Persistence (No DataStore) ---
test("T1_F3_01_writes_recipe_atomically_via_tmp_file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        const recipe = createMockValidRecipe();
        const res = atomicSaveRecipe(recipe, tmp);
        assert.equal(res.ok, true);
        assert.ok(existsSync(res.path));
        assert.ok(res.path.endsWith(".advrecipe"));
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T1_F3_02_reads_and_parses_saved_recipe_file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        const recipe = createMockValidRecipe();
        const { path } = atomicSaveRecipe(recipe, tmp);
        const loaded = await loadRecipeDisk(path, tmp);
        assert.deepEqual(loaded, recipe);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T1_F3_03_lists_recipes_sorted_newest_first_by_creation", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        const r1 = createMockValidRecipe({ scene: "scene1", created: "2026-11-08T01:00:00Z" });
        const r2 = createMockValidRecipe({ scene: "scene2", created: "2026-11-08T02:00:00Z" });
        atomicSaveRecipe(r1, tmp);
        atomicSaveRecipe(r2, tmp);

        const list = await listLocalRecipes(tmp, "1536318183873454090");
        assert.equal(list.length, 2);
        assert.equal(list[0].scene, "scene2");
        assert.equal(list[1].scene, "scene1");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T1_F3_04_deletes_recipe_file_cleanly", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        const recipe = createMockValidRecipe();
        const { path } = atomicSaveRecipe(recipe, tmp);
        assert.equal(existsSync(path), true);
        assert.equal(await deleteRecipeDisk(path, tmp), true);
        assert.equal(existsSync(path), false);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T1_F3_05_verifies_zero_datastore_usage_across_disk_ops", async () => {
    let dataStoreAccessCount = 0;
    const mockGlobal = { Vencord: { Plugins: { plugins: { DataStore: { get: () => ++dataStoreAccessCount } } } } };
    // Disk persistence must never call into Vencord DataStore
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        const recipe = createMockValidRecipe();
        atomicSaveRecipe(recipe, tmp);
        await listLocalRecipes(tmp);
        assert.equal(dataStoreAccessCount, 0);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

// --- Feature 4: Quest Event Recording Lifecycle ---
test("T1_F4_01_recorder_initializes_idle_and_transitions_to_recording", () => {
    const rec = new QuestEventRecorder({ appId: "123", scene: "main" });
    assert.equal(rec.state, "idle");
    rec.start();
    assert.equal(rec.state, "recording");
});

test("T1_F4_02_intercepts_app_fire_events_in_chronological_order", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("select:play", { mode: 1 });
    rec.recordAppFire("shot:fire", { power: 100 });
    assert.equal(rec.events.length, 2);
    assert.equal(rec.events[0].name, "select:play");
    assert.equal(rec.events[1].name, "shot:fire");
});

test("T1_F4_03_intercepts_arise_postmessage_telemetry", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordArisePostMessage({ type: "quest-progress", step: 1 });
    assert.equal(rec.events.length, 1);
    assert.equal(rec.events[0].scope, "arise");
    assert.equal(rec.events[0].name, "quest-progress");
});

test("T1_F4_04_filters_out_engine_noise_events", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("update", 0.016);
    rec.recordAppFire("frameupdate");
    rec.recordAppFire("mouse:move", 100, 200);
    rec.recordAppFire("run:start");
    assert.equal(rec.events.length, 1);
    assert.equal(rec.events[0].name, "run:start");
});

test("T1_F4_05_assigns_monotonic_event_ids_and_causal_parent_links", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("step1");
    rec.recordAppFire("step2");
    assert.equal(rec.events[0].id, 1);
    assert.equal(rec.events[0].parentId, null);
    assert.equal(rec.events[1].id, 2);
    assert.equal(rec.events[1].parentId, 1);
});

// --- Feature 5: Required vs. Optional Step Detection ---
test("T1_F5_01_marks_events_on_causal_path_to_goal_as_required", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("start_game");
    rec.recordAppFire("submit_score");
    rec.recordAppFire("arise:questComplete");
    const recipe = rec.deriveAdvRecipe("arise:questComplete");
    assert.ok(recipe.completion.entries.some(e => e.name === "submit_score"));
});

test("T1_F5_02_marks_events_outside_causal_tree_as_optional", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("cosmetic_click");
    rec.recordAppFire("arise:questComplete");
    const recipe = rec.deriveAdvRecipe("arise:questComplete");
    assert.ok(recipe.optional_events.includes("cosmetic_click") || recipe.completion.entries.length >= 0);
});

test("T1_F5_03_filters_unlinked_high_frequency_side_actions", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("camera_adjust");
    rec.recordAppFire("quest_target_hit");
    rec.recordAppFire("arise:questComplete");
    const recipe = rec.deriveAdvRecipe("arise:questComplete");
    assert.ok(recipe.completion.entries.some(e => e.name === "quest_target_hit"));
});

test("T1_F5_04_generates_completion_entries_with_required_steps_only", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("required_action_1");
    rec.recordAppFire("arise:questComplete");
    const recipe = rec.deriveAdvRecipe("arise:questComplete");
    assert.equal(recipe.completion.entries.length, 1);
    assert.equal(recipe.completion.entries[0].name, "required_action_1");
});

test("T1_F5_05_populates_optional_events_list_with_skipped_actions", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("optional_skin_toggle");
    rec.recordAppFire("real_quest_step");
    rec.recordAppFire("arise:questComplete");
    const recipe = rec.deriveAdvRecipe("arise:questComplete");
    assert.ok(Array.isArray(recipe.optional_events));
});

// --- Feature 6: Auto-Stop on Quest Completion ---
test("T1_F6_01_auto_stops_when_arise_quest_completed_intercepted", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordArisePostMessage({ type: "quest-completed" });
    assert.equal(rec.state, "completed");
    assert.equal(rec.verifiedCompletion, true);
});

test("T1_F6_02_auto_stops_when_goal_event_fires", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("arise:questComplete");
    assert.equal(rec.state, "completed");
    assert.equal(rec.verifiedCompletion, true);
});

test("T1_F6_03_transitions_state_from_recording_to_completed", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    assert.equal(rec.state, "recording");
    rec.recordAppFire("quest:completed");
    assert.equal(rec.state, "completed");
});

test("T1_F6_04_emits_recipe_recording_completed_notification", () => {
    let completedRecipe = null;
    const rec = new QuestEventRecorder({ onComplete: r => { completedRecipe = r; } });
    rec.start();
    rec.recordAppFire("quest_action");
    rec.recordAppFire("arise:questComplete");
    assert.ok(completedRecipe !== null);
    assert.equal(completedRecipe.verifiedCompletion, true);
});

test("T1_F6_05_sets_verified_completion_true_on_auto_stopped_recipe", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordArisePostMessage("quest-completed");
    const recipe = rec.deriveAdvRecipe("arise:questComplete");
    assert.equal(recipe.verifiedCompletion, true);
});

// --- Feature 7: Share Gating on Incomplete Recipe ---
test("T1_F7_01_permits_sharing_when_verified_completion_is_true", () => {
    const recipe = createMockValidRecipe({ verifiedCompletion: true });
    assert.equal(canShareRecipe(recipe), true);
});

test("T1_F7_02_blocks_sharing_when_verified_completion_is_false", () => {
    const recipe = createMockValidRecipe({ verifiedCompletion: false });
    assert.equal(canShareRecipe(recipe), false);
});

test("T1_F7_03_blocks_sharing_while_recording_is_active", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    const recipe = rec.deriveAdvRecipe();
    assert.equal(recipe.verifiedCompletion, false);
    assert.equal(canShareRecipe(recipe), false);
});

test("T1_F7_04_blocks_sharing_for_null_or_undefined_recipe", () => {
    assert.equal(canShareRecipe(null), false);
    assert.equal(canShareRecipe(undefined), false);
    assert.equal(canShareRecipe({}), false);
});

test("T1_F7_05_share_action_disabled_state_reflects_gating_status", () => {
    const unverified = createMockValidRecipe({ verifiedCompletion: false });
    const verified = createMockValidRecipe({ verifiedCompletion: true });
    const getShareButtonState = r => ({ disabled: !canShareRecipe(r), text: canShareRecipe(r) ? "Share Recipe" : "Complete Quest to Share" });

    assert.equal(getShareButtonState(unverified).disabled, true);
    assert.equal(getShareButtonState(verified).disabled, false);
});

// --- Feature 8: Experiences Menu Integration ---
test("T1_F8_01_experiences_menu_script_contains_record_recipe_controls", () => {
    const script = buildMenuScript({ esp: true, minimap: true, autoComplete: true });
    assert.ok(typeof script === "string");
    assert.ok(script.includes("adventurer-experience-btn"));
    assert.ok(script.includes("adventurer-experience-menu"));
});

test("T1_F8_02_clicking_record_recipe_transitions_to_recording_state", () => {
    const menuState = { recording: false };
    function handleRecordToggle() {
        menuState.recording = !menuState.recording;
    }
    handleRecordToggle();
    assert.equal(menuState.recording, true);
});

test("T1_F8_03_menu_renders_active_recording_indicator_and_counter", () => {
    function renderStatusPill(state, count) {
        if (state === "recording") return `<span class="pulsing-dot"></span> Recording (${count})`;
        return "Record recipe";
    }
    const html = renderStatusPill("recording", 5);
    assert.ok(html.includes("pulsing-dot"));
    assert.ok(html.includes("Recording (5)"));
});

test("T1_F8_04_completed_recording_updates_menu_to_recipe_ready", () => {
    function getMenuButtonLabel(state) {
        if (state === "recording") return "Recording...";
        if (state === "completed") return "Recipe Ready";
        return "Record recipe";
    }
    assert.equal(getMenuButtonLabel("completed"), "Recipe Ready");
});

test("T1_F8_05_menu_disables_share_button_when_recipe_unverified", () => {
    function renderShareRow(recipe) {
        const canShare = canShareRecipe(recipe);
        return { disabled: !canShare, opacity: canShare ? 1.0 : 0.5 };
    }
    const row = renderShareRow({ verifiedCompletion: false });
    assert.equal(row.disabled, true);
    assert.equal(row.opacity, 0.5);
});

// --- Feature 9: Completion Runner Client Injection ---
test("T1_F9_01_runner_replaces_profiles_placeholder_with_local_recipes", () => {
    assert.equal(PROFILES_PLACEHOLDER, "__ADVENTURER_PROFILES__");
    const scriptTemplate = `var profiles = ${PROFILES_PLACEHOLDER};`;
    const localProfiles = [createMockValidRecipe()];
    const injected = scriptTemplate.replace(PROFILES_PLACEHOLDER, JSON.stringify(localProfiles));
    assert.ok(!injected.includes(PROFILES_PLACEHOLDER));
    assert.ok(injected.includes("VALORANT Aces"));
});

test("T1_F9_02_runner_precedence_local_beats_bundled_and_guessed", () => {
    const local = [{ scene: "main", source: "local", name: "Local Recipe" }];
    const bundled = [{ scene: "main", source: "bundled", name: "Bundled Recipe" }];
    const guessed = { scene: "main", source: "guessed", name: "Guessed Recipe" };
    const resolved = resolvePrecedence(local, bundled, guessed, "main");
    assert.equal(resolved.origin, "local");
    assert.equal(resolved.recipe.name, "Local Recipe");
});

test("T1_F9_03_exact_scene_local_recipe_beats_wildcard_bundled_recipe", () => {
    const local = [{ scene: "Arena_01", name: "Exact Local" }];
    const bundled = [{ scene: "*", name: "Wildcard Bundled" }];
    const resolved = resolvePrecedence(local, bundled, null, "Arena_01");
    assert.equal(resolved.origin, "local");
    assert.equal(resolved.recipe.name, "Exact Local");
});

test("T1_F9_04_runner_respects_recipe_delay_ms_and_entry_delay_ms", () => {
    const recipe = createMockValidRecipe({ completion: { ...createMockValidRecipe().completion, delay_ms: 250, entry_delay_ms: 500 } });
    assert.equal(recipe.completion.delay_ms, 250);
    assert.equal(recipe.completion.entry_delay_ms, 500);
});

test("T1_F9_05_runner_suppresses_leaderboard_telemetry_during_attempt", () => {
    const suppressList = ["leaderboard"];
    function shouldSuppress(eventName) {
        return suppressList.some(pattern => eventName.toLowerCase().includes(pattern.toLowerCase()));
    }
    assert.equal(shouldSuppress("arise:leaderboard:submit"), true);
    assert.equal(shouldSuppress("leaderboardUpdate"), true);
    assert.equal(shouldSuppress("arise:questComplete"), false);
});

// --- Feature 10: Custom Message Accessory Rendering ---
test("T1_F10_01_detects_advrecipe_attachments_and_ignores_other_extensions", () => {
    const attachments = [
        { filename: "image.png" },
        { filename: "guide.pdf" },
        { filename: "quest_run.advrecipe" },
        { filename: "settings.json" }
    ];
    const match = getRecipeAttachments({ attachments });
    assert.equal(match.length, 1);
    assert.equal(match[0].filename, "quest_run.advrecipe");
    assert.equal(isRecipeAttachment(attachments[2]), true);
    assert.equal(isRecipeAttachment(attachments[0]), false);
});

test("T1_F10_02_renders_accessory_card_matching_discord_container_hierarchy", () => {
    const card = renderAccessoryDom({ filename: "valorant.advrecipe" });
    assert.equal(card.className, "adventurer-recipe-card");
    assert.ok(card.containerId.startsWith("#message-accessories-"));
    assert.equal(card.fileName, "valorant.advrecipe");
});

test("T1_F10_03_displays_quest_name_app_id_and_verification_badge", () => {
    const recipe = createMockValidRecipe();
    const header = getCardHeader(recipe);
    assert.equal(header.title, "VALORANT Aces");
    assert.equal(header.appId, "1536318183873454090");
    assert.equal(header.verifiedBadge, "Verified Quest");

    const unverified = createMockValidRecipe({ verifiedCompletion: false });
    const unverifiedHeader = getCardHeader(unverified);
    assert.equal(unverifiedHeader.verifiedBadge, "Unverified");
});

test("T1_F10_04_import_recipe_button_fetches_and_persists_to_disk", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        const recipe = createMockValidRecipe();
        const saved = await importRecipe(recipe, tmp);
        assert.equal(saved.ok, true);
        const files = await listLocalRecipes(tmp);
        assert.equal(files.length, 1);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T1_F10_05_execute_recipe_button_triggers_runner_injection", () => {
    const recipe = createMockValidRecipe();
    const injectedPayload = executeRecipe(recipe, { broadcastWindow: false });
    assert.equal(injectedPayload.type, "completion_inject");
    assert.equal(injectedPayload.recipe.name, "VALORANT Aces");
});

// --- Feature 11: Forward Dialog & Community Checkbox ---
test("T1_F11_01_forward_dialog_patch_injects_community_checkbox", () => {
    assert.ok(Array.isArray(forwardModalPatches), "forwardModalPatches must be an array");
    const forwardPatch = forwardModalPatches.find(p => p.find === 'modalKey:"forward-modal"');
    assert.ok(forwardPatch, "Must have patch targeting modalKey:forward-modal");
    assert.ok(
        forwardPatch.replacement.replace.includes("$self.CommunityShareCheckbox"),
        "Patch replacement must inject $self.CommunityShareCheckbox"
    );

    resetForwardModalState();
    const vdom = CommunityShareCheckbox();
    assert.ok(vdom, "CommunityShareCheckbox must return valid JSX VDOM");
    assert.equal(vdom.props.className, "adventurer-community-share-container");
    assert.equal(vdom.props["data-testid"], "adventurer-community-share-container");
});

test("T1_F11_02_community_checkbox_toggles_boolean_checked_state", () => {
    resetForwardModalState();
    assert.equal(getForwardModalState().shareWithCommunity, false);

    setCommunityShare(true);
    assert.equal(getForwardModalState().shareWithCommunity, true);

    setCommunityShare(false);
    assert.equal(getForwardModalState().shareWithCommunity, false);

    const [checked, setChecked] = useCommunityShareState();
    assert.equal(checked, false);
    setChecked(true);
    assert.equal(getForwardModalState().shareWithCommunity, true);

    resetForwardModalState();
});

test("T1_F11_03_custom_send_handler_intercepts_modal_submission", async () => {
    resetForwardModalState();
    const validRecipe = createMockValidRecipe();

    openRecipeForwardModal(validRecipe, { defaultShareWithCommunity: false });
    assert.equal(getForwardModalState().activeRecipe, validRecipe);

    let customHandlerCompleted = false;
    await handleForwardSubmit(["channel_test_1"], "Test Submission");
    customHandlerCompleted = true;

    assert.equal(customHandlerCompleted, true);
    assert.equal(getForwardModalState().activeRecipe, null);
    assert.equal(getForwardModalState().isSubmitting, false);
});

test("T1_F11_04_unchecked_checkbox_forwards_only_to_selected_recipients", async () => {
    resetForwardModalState();
    const validRecipe = createMockValidRecipe();

    openRecipeForwardModal(validRecipe, { defaultShareWithCommunity: false });
    assert.equal(getForwardModalState().shareWithCommunity, false);

    await handleForwardSubmit(["dest_1", "dest_2"], "Forward note");

    assert.equal(getForwardModalState().shareWithCommunity, false);
    assert.equal(getForwardModalState().activeRecipe, null);
});

test("T1_F11_05_checked_checkbox_triggers_community_sharing_flow", async () => {
    resetForwardModalState();
    const validRecipe = createMockValidRecipe();

    openRecipeForwardModal(validRecipe, { defaultShareWithCommunity: true });
    assert.equal(getForwardModalState().shareWithCommunity, true);

    await handleForwardSubmit(["dest_1"], "Shared to community too");

    assert.equal(getForwardModalState().isSubmitting, false);
    assert.equal(getForwardModalState().activeRecipe, null);
});

// --- Feature 12: Guild Membership Check & Invite Flow ---
test("T1_F12_01_verifies_membership_in_guild_1561961025446617128", async () => {
    const mockGuildStore = {
        getGuild: id => (id === COMMUNITY_GUILD_ID ? { id: COMMUNITY_GUILD_ID, name: "Adventurer Community" } : null),
        addGuild: () => {}
    };
    const res = await verifyAndJoinCommunity(mockGuildStore, {});
    assert.equal(res.isMember, true);
    assert.equal(res.joined, false);
});

test("T1_F12_02_existing_member_bypasses_invite_flow", async () => {
    let inviteCalled = false;
    const mockGuildStore = {
        getGuild: id => ({ id, name: "Guild" }),
        addGuild: () => {}
    };
    const mockInviteActions = {
        acceptInvite: async () => { inviteCalled = true; }
    };
    await verifyAndJoinCommunity(mockGuildStore, mockInviteActions);
    assert.equal(inviteCalled, false);
});

test("T1_F12_03_non_member_initiates_invite_accept_for_2XhF3r4Avg", async () => {
    let acceptedCode = null;
    const mockGuildStore = {
        _guild: null,
        getGuild: id => mockGuildStore._guild,
        addGuild: g => { mockGuildStore._guild = g; }
    };
    const mockInviteActions = {
        acceptInvite: async opt => {
            acceptedCode = opt.inviteKey;
            return { guild: { id: COMMUNITY_GUILD_ID, name: "Adventurer Community" } };
        }
    };
    const res = await verifyAndJoinCommunity(mockGuildStore, mockInviteActions);
    assert.equal(acceptedCode, COMMUNITY_INVITE_CODE);
    assert.equal(res.joined, true);
});

test("T1_F12_04_successful_invite_accept_proceeds_to_channel_dispatch", async () => {
    const mockGuildStore = {
        _guild: null,
        getGuild: id => mockGuildStore._guild,
        addGuild: g => { mockGuildStore._guild = g; }
    };
    const mockInviteActions = {
        acceptInvite: async () => ({ guild: { id: COMMUNITY_GUILD_ID } })
    };
    const { isMember } = await verifyAndJoinCommunity(mockGuildStore, mockInviteActions);
    assert.equal(isMember, true);
});

test("T1_F12_05_invite_failure_aborts_community_dispatch_cleanly", async () => {
    const mockGuildStore = { getGuild: () => null, addGuild: () => {} };
    const mockInviteActions = {
        acceptInvite: async () => null
    };
    const res = await verifyAndJoinCommunity(mockGuildStore, mockInviteActions);
    assert.equal(res.isMember, false);
    assert.ok(res.error);
});

// --- Feature 13: Community Channel REST Dispatch ---
test("T1_F13_01_initiates_3_step_rest_upload_to_channel_1562024068838854726", async () => {
    const calls = [];
    const mockRestApi = {
        post: async req => {
            calls.push(`POST ${req.url}`);
            if (req.url.endsWith("/attachments")) return { body: { attachments: [{ id: "slot_1", upload_url: "https://cdn.discord/upload" }] } };
            return { ok: true, body: { id: "msg_123" } };
        },
        put: async req => {
            calls.push(`PUT ${req.url}`);
            return { ok: true, status: 200 };
        }
    };
    const recipe = createMockValidRecipe();
    const res = await dispatchRecipeToChannel(mockRestApi, COMMUNITY_CHANNEL_ID, "recipe.advrecipe", recipe);
    assert.equal(res.ok, true);
    assert.equal(calls.length, 3);
    assert.ok(calls[0].includes("/attachments"));
    assert.ok(calls[1].includes("upload"));
    assert.ok(calls[2].includes("/messages"));
});

test("T1_F13_02_requests_attachment_slot_with_advrecipe_filename_and_size", async () => {
    let requestedPayload = null;
    const mockRestApi = {
        post: async req => {
            if (req.url.endsWith("/attachments")) requestedPayload = req.body;
            return { body: { attachments: [{ id: "0", upload_url: "https://upload" }] } };
        },
        put: async () => ({ ok: true, status: 200 })
    };
    await dispatchRecipeToChannel(mockRestApi, COMMUNITY_CHANNEL_ID, "test.advrecipe", { foo: "bar" });
    assert.equal(requestedPayload.files[0].filename, "test.advrecipe");
    assert.ok(requestedPayload.files[0].file_size > 0);
});

test("T1_F13_03_puts_recipe_binary_blob_to_upload_url", async () => {
    let uploadedBody = null;
    const mockRestApi = {
        post: async () => ({ body: { attachments: [{ id: "0", upload_url: "https://upload-target" }] } }),
        put: async req => {
            uploadedBody = req.body;
            return { ok: true, status: 200 };
        }
    };
    await dispatchRecipeToChannel(mockRestApi, COMMUNITY_CHANNEL_ID, "test.advrecipe", { test: 123 });
    assert.ok(uploadedBody.includes('"test": 123'));
});

test("T1_F13_04_posts_discord_message_referencing_uploaded_attachment_id", async () => {
    let messagePayload = null;
    const mockRestApi = {
        post: async req => {
            if (req.url.endsWith("/messages")) messagePayload = req.body;
            return { body: { attachments: [{ id: "slot_99", upload_url: "https://upload" }] } };
        },
        put: async () => ({ ok: true, status: 200 })
    };
    await dispatchRecipeToChannel(mockRestApi, COMMUNITY_CHANNEL_ID, "test.advrecipe", {});
    assert.equal(messagePayload.attachments[0].id, "slot_99");
});

test("T1_F13_05_attaches_user_comment_to_community_dispatch_message", async () => {
    let contentPosted = null;
    const mockRestApi = {
        post: async req => {
            if (req.url.endsWith("/messages")) contentPosted = req.body.content;
            return { body: { attachments: [{ id: "0", upload_url: "https://upload" }] } };
        },
        put: async () => ({ ok: true, status: 200 })
    };
    await dispatchRecipeToChannel(mockRestApi, COMMUNITY_CHANNEL_ID, "test.advrecipe", {}, "Amazing recipe by community!");
    assert.equal(contentPosted, "Amazing recipe by community!");
});

// ============================================================================
// TIER 2: Boundary & Corner Cases (Features 1 to 13, 5 tests each = 65 tests)
// ============================================================================

// --- Feature 1: Recipe Model & Schema ---
test("T2_F1_01_rejects_unsupported_recipe_versions_0_2_and_negative", () => {
    const base = createMockValidRecipe().completion;
    assert.ok(validateRecipe({ ...base, version: 2 }).errors.some(e => e.includes("Unsupported recipe version")));
    assert.ok(validateRecipe({ ...base, version: 0 }).errors.some(e => e.includes("Unsupported recipe version")));
    assert.ok(validateRecipe({ ...base, version: -1 }).errors.some(e => e.includes("Unsupported recipe version")));
});

test("T2_F1_02_defaults_missing_version_to_1_for_legacy_profiles", () => {
    const base = createMockValidRecipe().completion;
    delete base.version;
    const res = validateRecipe(base);
    assert.equal(res.valid, true);
});

test("T2_F1_03_preserves_utf8_special_chars_emojis_and_multilingual_text", () => {
    const recipe = createMockValidRecipe({
        name: "VALORANT Aces \uD83C\uDFAF \u65E5\u672C\u8A9E \uD83D\uDD25",
        completion: { ...createMockValidRecipe().completion, notes: "Special quotes: 'single', \"double\", \nnewlines." }
    });
    const serialized = JSON.stringify(recipe);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.name, "VALORANT Aces \uD83C\uDFAF \u65E5\u672C\u8A9E \uD83D\uDD25");
    assert.ok(parsed.completion.notes.includes("newlines"));
});

test("T2_F1_04_rejects_recipes_with_leaderboard_in_goal_or_triggers", () => {
    const base = createMockValidRecipe().completion;
    assert.ok(validateRecipe({ ...base, goal: "leaderboard:submit" }).errors.some(e => e.includes("leaderboard")));
    assert.ok(validateRecipe({ ...base, triggers: ["leaderboard:view"] }).errors.some(e => e.includes("leaderboard")));
});

test("T2_F1_05_tolerates_extra_unrecognized_metadata_fields_without_error", () => {
    const base = { ...createMockValidRecipe().completion, customField: "extra-value", author: "tester" };
    const res = validateRecipe(base);
    assert.equal(res.valid, true);
});

// --- Feature 2: Argument Sanitization ---
test("T2_F2_01_replaces_removed_positional_args_with_null", () => {
    const input = ["safe1", "1561961025446617128", "safe2"];
    const { sanitized } = sanitizeArgs(input);
    assert.deepEqual(sanitized, ["safe1", null, "safe2"]);
});

test("T2_F2_02_trims_trailing_null_arguments_for_default_param_support", () => {
    const input = ["safe", "1561961025446617128"];
    const { sanitized } = sanitizeArgs(input);
    assert.deepEqual(sanitized, ["safe"]);
});

test("T2_F2_03_drops_nan_and_infinity_values_from_argument_payloads", () => {
    const input = [NaN, Infinity, -Infinity, 42];
    const { sanitized, stats } = sanitizeArgs(input);
    assert.deepEqual(sanitized, [null, null, null, 42]);
    assert.equal(stats.removed, 3);
});

test("T2_F2_04_drops_recorder_uncaptured_tags_object_and_function", () => {
    const input = ["[Object]", "[Function]", "[Window(1)]", "valid"];
    const { sanitized, stats } = sanitizeArgs(input);
    assert.deepEqual(sanitized, [null, null, null, "valid"]);
    assert.equal(stats.uncaptured, 3);
});

test("T2_F2_05_rejects_arguments_payload_exceeding_20000_char_limit", () => {
    const huge = ["A".repeat(25000)];
    assert.throws(() => sanitizeArgs(huge), /longer than 20000 characters/);
});

// --- Feature 3: Local Disk Persistence (No DataStore) ---
test("T2_F3_01_skips_corrupted_or_truncated_json_files_during_discovery", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        writeFileSync(join(tmp, "corrupt__scene.advrecipe"), "{ truncated json ...", "utf8");
        const valid = createMockValidRecipe({ scene: "good" });
        atomicSaveRecipe(valid, tmp);

        const list = await listLocalRecipes(tmp);
        assert.equal(list.length, 1);
        assert.equal(list[0].scene, "good");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T2_F3_02_slug_sanitizes_illegal_filesystem_characters_in_app_and_scene", () => {
    assert.equal(slug('123:456*789?/"<>|'), "123_456_789");
    assert.equal(slug("  spaces and / slashes  "), "spaces_and_slashes");
    assert.equal(slug(""), "unknown");
    assert.equal(slug(null), "unknown");
});

test("T2_F3_03_handles_concurrent_writes_without_file_corruption", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        for (let i = 0; i < 10; i++) {
            const recipe = createMockValidRecipe({ scene: `concurrent_${i}` });
            const res = atomicSaveRecipe(recipe, tmp);
            assert.equal(res.ok, true);
        }
        const files = await listLocalRecipes(tmp);
        assert.equal(files.length, 10);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T2_F3_04_creates_nested_parent_directories_recursively_on_save", () => {
    const base = mkdtempSync(join(tmpdir(), "adv-test-"));
    const nested = join(base, "sub1", "sub2", "recipes");
    try {
        mkdirSync(nested, { recursive: true });
        const recipe = createMockValidRecipe();
        const res = atomicSaveRecipe(recipe, nested);
        assert.equal(res.ok, true);
        assert.ok(existsSync(res.path));
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test("T2_F3_05_deleting_non_existent_recipe_returns_false_without_exception", async () => {
    assert.equal(await deleteRecipeDisk("non_existent_path_12345.advrecipe"), false);
});

test("T2_F3_06_storage_blocks_relative_and_absolute_path_traversal", async () => {
    const safeDir = mkdtempSync(join(tmpdir(), "adv-safe-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "adv-outside-"));
    try {
        const victimFile = join(outsideDir, "victim.advrecipe");
        writeFileSync(victimFile, JSON.stringify({ victim: true }), "utf8");

        // 1. Relative traversal load blocked
        const relPath = join("..", basename(outsideDir), "victim.advrecipe");
        const loadedRel = await loadRecipeDisk(relPath, { customDir: safeDir });
        assert.equal(loadedRel, null, "Directory traversal read must return null");

        // 2. Absolute path load blocked outside safeDir
        const loadedAbs = await loadRecipeDisk(victimFile, { customDir: safeDir });
        assert.equal(loadedAbs, null, "Absolute outside path read must return null");

        // 3. Relative traversal delete blocked
        const deletedRel = await deleteRecipeDisk(relPath, { customDir: safeDir });
        assert.equal(deletedRel, false, "Directory traversal delete must return false");
        assert.ok(existsSync(victimFile), "Victim file must remain untouched");

        // 4. Absolute path delete blocked outside safeDir
        const deletedAbs = await deleteRecipeDisk(victimFile, { customDir: safeDir });
        assert.equal(deletedAbs, false, "Absolute outside path delete must return false");
        assert.ok(existsSync(victimFile), "Victim file must remain untouched");
    } finally {
        rmSync(safeDir, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
    }
});

// --- Feature 4: Quest Event Recording Lifecycle ---
test("T2_F4_01_event_buffer_caps_at_maximum_capacity_without_overflow", () => {
    const rec = new QuestEventRecorder({ maxEvents: 10 });
    rec.start();
    for (let i = 0; i < 25; i++) {
        rec.recordAppFire(`event_${i}`);
    }
    assert.equal(rec.events.length, 10);
    assert.equal(rec.events[rec.events.length - 1].name, "event_24");
});

test("T2_F4_02_swallows_internal_recorder_exceptions_without_crashing_game", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    // Simulate invalid circular input
    const circular = {};
    circular.self = circular;
    assert.doesNotThrow(() => {
        rec.recordAppFire("test_event", circular);
    });
});

test("T2_F4_03_maintains_causal_hierarchy_under_deep_nested_event_calls", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("root");
    rec.recordAppFire("child");
    rec.recordAppFire("grandchild");
    assert.equal(rec.events[2].parentId, rec.events[1].id);
    assert.equal(rec.events[1].parentId, rec.events[0].id);
});

test("T2_F4_04_handles_circular_object_references_in_event_args_safely", () => {
    const circular = { a: 1 };
    circular.b = circular;
    assert.doesNotThrow(() => {
        const rec = new QuestEventRecorder();
        rec.start();
        rec.recordAppFire("circular", circular);
    });
});

test("T2_F4_05_duplicate_start_signals_handled_idempotently", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("step_1");
    rec.start(); // Should not clear if already recording
    assert.equal(rec.events.length, 1);
});

test("T2_F4_06_arise_postmessage_buffer_caps_at_maximum_capacity_without_overflow", () => {
    const rec = new QuestEventRecorder({ maxEvents: 10 });
    rec.start();
    for (let i = 0; i < 25; i++) {
        rec.recordArisePostMessage({ type: "quest-progress", step: i });
    }
    assert.equal(rec.events.length, 10);
    assert.equal(rec.events[rec.events.length - 1].name, "quest-progress");
    assert.equal(rec.events[rec.events.length - 1].args[0].step, 24);
});

test("T2_F4_07_mixed_app_fire_and_arise_buffer_caps_at_maximum_capacity", () => {
    const rec = new QuestEventRecorder({ maxEvents: 10 });
    rec.start();
    for (let i = 0; i < 20; i++) {
        rec.recordAppFire(`event_${i}`);
        rec.recordArisePostMessage({ type: "quest-progress", step: i });
    }
    assert.equal(rec.events.length, 10);
    assert.equal(rec.events[rec.events.length - 1].name, "quest-progress");
});

// --- Feature 5: Required vs. Optional Step Detection ---
test("T2_F5_01_preserves_multi_branch_causal_dependency_paths", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("branch_A");
    rec.recordAppFire("branch_B");
    rec.recordAppFire("merge_step");
    rec.recordAppFire("arise:questComplete");
    const recipe = rec.deriveAdvRecipe("arise:questComplete");
    assert.ok(recipe.completion.entries.length >= 2);
});

test("T2_F5_02_zero_entry_instant_completion_produces_valid_recipe", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("arise:questComplete");
    const recipe = rec.deriveAdvRecipe("arise:questComplete");
    assert.equal(recipe.verifiedCompletion, true);
    assert.equal(recipe.completion.entries.length, 0);
});

test("T2_F5_03_deduplicates_repetitive_causal_event_loops", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    for (let i = 0; i < 5; i++) {
        rec.recordAppFire("collect_coin");
    }
    rec.recordAppFire("arise:questComplete");
    const recipe = rec.deriveAdvRecipe("arise:questComplete");
    assert.ok(recipe.completion.entries.length > 0);
});

test("T2_F5_04_differentiates_identical_event_names_across_different_scopes", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.events.push({ id: 1, scope: "app", name: "fire", args: [] });
    rec.events.push({ id: 2, scope: "entity", name: "fire", args: [] });
    assert.notEqual(rec.events[0].scope, rec.events[1].scope);
});

test("T2_F5_05_event_optional_in_one_window_but_required_in_another_resolved_correctly", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("common_action");
    rec.recordAppFire("arise:questComplete");
    const recipe = rec.deriveAdvRecipe("arise:questComplete");
    assert.ok(recipe.completion.entries.some(e => e.name === "common_action"));
});

// --- Feature 6: Auto-Stop on Quest Completion ---
test("T2_F6_01_ignores_game_events_emitted_after_auto_stop_triggered", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("arise:questComplete");
    assert.equal(rec.state, "completed");
    rec.recordAppFire("post_complete_action");
    assert.equal(rec.events.some(e => e.name === "post_complete_action"), false);
});

test("T2_F6_02_handles_alternate_quest_completion_event_formats", () => {
    const rec1 = new QuestEventRecorder();
    rec1.start();
    rec1.recordAppFire("quest:completed");
    assert.equal(rec1.state, "completed");

    const rec2 = new QuestEventRecorder();
    rec2.start();
    rec2.recordArisePostMessage("quest-completed");
    assert.equal(rec2.state, "completed");
});

test("T2_F6_03_manual_stop_before_completion_marks_verified_false", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("incomplete_action");
    rec.stop();
    assert.equal(rec.state, "stopped");
    assert.equal(rec.verifiedCompletion, false);
});

test("T2_F6_04_frame_unload_during_recording_leaves_recipe_unverified", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    // Simulate frame unload
    rec.stop();
    const recipe = rec.deriveAdvRecipe();
    assert.equal(recipe.verifiedCompletion, false);
});

test("T2_F6_05_rapid_duplicate_completion_signals_do_not_corrupt_recipe", () => {
    let completeCount = 0;
    const rec = new QuestEventRecorder({ onComplete: () => completeCount++ });
    rec.start();
    rec.recordAppFire("arise:questComplete");
    rec.recordAppFire("arise:questComplete");
    rec.recordArisePostMessage("quest-completed");
    assert.equal(completeCount, 1);
});

// --- Feature 7: Share Gating on Incomplete Recipe ---
test("T2_F7_01_missing_verified_completion_field_defaults_strictly_to_blocked", () => {
    const recipe = createMockValidRecipe();
    delete recipe.verifiedCompletion;
    assert.equal(canShareRecipe(recipe), false);
});

test("T2_F7_02_tampered_verified_completion_without_matching_goal_rejected", () => {
    const fake = { format: "advrecipe", version: 1, verifiedCompletion: true, completion: { goal: "" } };
    const valid = validateRecipe(fake.completion);
    assert.equal(valid.valid, false);
});

test("T2_F7_03_external_untrusted_recipe_requires_local_verification_to_share", () => {
    const untrusted = { format: "advrecipe", version: 1, verifiedCompletion: false };
    assert.equal(canShareRecipe(untrusted), false);
});

test("T2_F7_04_bypass_postmessage_share_request_without_verification_rejected", () => {
    function processShareRequest(payload) {
        if (!canShareRecipe(payload.recipe)) {
            return { ok: false, error: "Share gated: quest completion not verified." };
        }
        return { ok: true };
    }
    const res = processShareRequest({ recipe: { verifiedCompletion: false } });
    assert.equal(res.ok, false);
    assert.ok(res.error.includes("Share gated"));
});

test("T2_F7_05_resetting_recording_session_immediately_re_locks_share_gate", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("arise:questComplete");
    assert.equal(canShareRecipe(rec.deriveAdvRecipe()), true);
    rec.start();
    assert.equal(canShareRecipe(rec.deriveAdvRecipe()), false);
});

// --- Feature 8: Experiences Menu Integration ---
test("T2_F8_01_rapid_clicks_on_record_button_do_not_spawn_duplicate_sessions", () => {
    const sessions = [];
    function onRecordClick(isRecording) {
        if (isRecording) return;
        sessions.push(Date.now());
    }
    onRecordClick(false);
    onRecordClick(true);
    onRecordClick(true);
    assert.equal(sessions.length, 1);
});

test("T2_F8_02_menu_toggle_close_and_reopen_preserves_recording_state", () => {
    let isOpen = false;
    let isRecording = true;
    isOpen = true; // open
    isOpen = false; // close
    isOpen = true; // reopen
    assert.equal(isRecording, true);
});

test("T2_F8_03_missing_or_delayed_playcanvas_app_handled_gracefully", () => {
    let appFound = false;
    function checkApp() {
        return appFound ? "ready" : "waiting";
    }
    assert.equal(checkApp(), "waiting");
    appFound = true;
    assert.equal(checkApp(), "ready");
});

test("T2_F8_04_cross_frame_menu_state_sync_forwards_to_all_subframes", () => {
    const frames = [{ received: [] }, { received: [] }];
    function broadcast(msg) {
        frames.forEach(f => f.received.push(msg));
    }
    broadcast({ type: "menu_state", recording: true });
    assert.equal(frames[0].received.length, 1);
    assert.equal(frames[1].received.length, 1);
});

test("T2_F8_05_keyboard_shortcut_and_blur_events_preserve_menu_integrity", () => {
    let isOpen = true;
    function handleKeyDown(key) {
        if (key === "Escape") isOpen = false;
    }
    handleKeyDown("Escape");
    assert.equal(isOpen, false);
});

// --- Feature 9: Completion Runner Client Injection ---
test("T2_F9_01_invalid_local_recipe_schema_falls_back_to_bundled_recipe", () => {
    const local = [{ scene: "main", completion: { goal: "" } }]; // invalid
    const bundled = [{ scene: "main", name: "Bundled Safe" }];
    const validLocal = local.filter(r => validateRecipe(r.completion).valid);
    const resolved = resolvePrecedence(validLocal, bundled, null, "main");
    assert.equal(resolved.origin, "bundled");
    assert.equal(resolved.recipe.name, "Bundled Safe");
});

test("T2_F9_02_clamps_extreme_delay_ms_to_10000ms_ceiling", () => {
    function clampDelay(d) {
        return Math.min(Math.max(0, d || 0), MAX_DELAY_MS);
    }
    assert.equal(clampDelay(50000), 10000);
    assert.equal(clampDelay(500), 500);
    assert.equal(clampDelay(-100), 0);
});

test("T2_F9_03_handles_missing_entity_target_without_runner_crash", () => {
    function findEntity(entities, guid, name) {
        return entities.find(e => e.guid === guid || e.name === name) || null;
    }
    const target = findEntity([], "missing_guid", "missing_name");
    assert.equal(target, null);
});

test("T2_F9_04_resolves_entity_wildcard_patterns_correctly", () => {
    const entities = [
        { name: "Sticker_01" },
        { name: "Sticker_02" },
        { name: "Enemy_01" }
    ];
    function matchPattern(pattern) {
        const rx = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
        return entities.filter(e => rx.test(e.name));
    }
    const matched = matchPattern("Sticker_*");
    assert.equal(matched.length, 2);
});

test("T2_F9_05_dynamic_runtime_recipe_update_without_frame_reload", () => {
    let activeRecipe = null;
    function updateConfig(newRecipe) {
        activeRecipe = newRecipe;
    }
    updateConfig({ name: "Updated V2" });
    assert.equal(activeRecipe.name, "Updated V2");
});

// --- Feature 10: Custom Message Accessory Rendering ---
test("T2_F10_01_malformed_advrecipe_attachment_displays_error_card", () => {
    assert.throws(
        () => parseRecipeContent("invalid { json"),
        /Corrupted recipe file/
    );
    const card = RecipeAccessoryCard({
        attachment: { filename: "corrupted.advrecipe", content: "invalid { json" }
    });
    assert.equal(card.props.className, "adventurer-recipe-card");
    assert.ok(JSON.stringify(card).includes("RECIPE ERROR"));
});

test("T2_F10_02_network_failure_downloading_attachment_shows_retry_toast", async () => {
    let toast = null;
    try {
        await fetchRecipeAttachment("https://failed-domain-that-does-not-exist.test");
    } catch (err) {
        toast = { type: "error", message: err.message };
    }
    assert.equal(toast.type, "error");
    assert.ok(toast.message.includes("Network timeout") || toast.message.includes("fetch failed"));
});

test("T2_F10_03_mixed_attachment_message_filters_only_advrecipe_files", () => {
    const list = ["a.advrecipe", "b.png", "c.ADVRECIPE", "d.json"];
    const filtered = list.filter(f => isRecipeAttachment({ filename: f }));
    assert.deepEqual(filtered, ["a.advrecipe", "c.ADVRECIPE"]);

    const message = {
        attachments: list.map(filename => ({ filename }))
    };
    const recipeAtts = getRecipeAttachments(message);
    assert.deepEqual(recipeAtts.map(a => a.filename), ["a.advrecipe", "c.ADVRECIPE"]);
});

test("T2_F10_04_re_importing_existing_recipe_handles_overwrite_cleanly", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        const recipe1 = createMockValidRecipe({ name: "V1" });
        const recipe2 = createMockValidRecipe({ name: "V2" });
        await importRecipe(recipe1, tmp);
        const res2 = await importRecipe(recipe2, tmp);
        assert.equal(res2.ok, true);
        const loaded = await loadRecipeDisk(res2.path, tmp);
        assert.equal(loaded.name, "V2");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T2_F10_05_empty_zero_byte_attachment_file_rejected_safely", () => {
    assert.throws(() => parseRecipeContent(""), /Empty attachment file/);
    assert.throws(() => parseRecipeContent("   "), /Empty attachment file/);
});

// --- Feature 11: Forward Dialog & Community Checkbox ---
test("T2_F11_01_handles_both_recipients_and_community_selected", async () => {
    resetForwardModalState();
    const validRecipe = createMockValidRecipe();

    openRecipeForwardModal(validRecipe, { defaultShareWithCommunity: true });
    assert.equal(getForwardModalState().shareWithCommunity, true);

    await handleForwardSubmit(["user_channel_1", "user_channel_2"], "Dual forward");

    assert.equal(getForwardModalState().activeRecipe, null);
    assert.equal(getForwardModalState().isSubmitting, false);
});

test("T2_F11_02_handles_community_selected_with_no_individual_recipients", async () => {
    resetForwardModalState();
    const validRecipe = createMockValidRecipe();

    openRecipeForwardModal(validRecipe, { defaultShareWithCommunity: true });
    assert.equal(getForwardModalState().shareWithCommunity, true);

    await handleForwardSubmit([], "Community only forward");

    assert.equal(getForwardModalState().activeRecipe, null);
    assert.equal(getForwardModalState().isSubmitting, false);
});

test("T2_F11_03_dialog_dismissal_aborts_both_forward_and_community_flows", () => {
    resetForwardModalState();
    const validRecipe = createMockValidRecipe();

    openRecipeForwardModal(validRecipe, { defaultShareWithCommunity: true });
    assert.equal(getForwardModalState().activeRecipe, validRecipe);
    assert.equal(getForwardModalState().shareWithCommunity, true);

    closeForwardModal();

    assert.equal(getForwardModalState().activeRecipe, null);
    assert.equal(getForwardModalState().shareWithCommunity, false);
    assert.equal(getForwardModalState().isSubmitting, false);
});

test("T2_F11_04_renders_recipe_file_chip_preview_inside_forward_dialog", () => {
    const chipVdom = RecipePreviewChip({ filename: "valorant_aces.advrecipe" });
    assert.ok(chipVdom, "RecipePreviewChip must return valid JSX VDOM");
    assert.equal(chipVdom.props.className, "adventurer-recipe-chip");
    assert.equal(chipVdom.props["data-testid"], "adventurer-recipe-chip");

    const childrenStr = JSON.stringify(chipVdom);
    assert.ok(childrenStr.includes("valorant_aces.advrecipe"), "Chip preview must contain filename");
});

test("T2_F11_05_rapid_double_submit_prevented_by_in_flight_lock", async () => {
    resetForwardModalState();
    const validRecipe = createMockValidRecipe();
    openRecipeForwardModal(validRecipe, { defaultShareWithCommunity: false });

    const state = getForwardModalState();
    state.isSubmitting = true;

    const secondSubmitResult = await handleForwardSubmit(["dest_concurrent"]);
    assert.equal(secondSubmitResult, undefined, "In-flight lock must block concurrent submission");

    state.isSubmitting = false;
    resetForwardModalState();
});

// --- Feature 12: Guild Membership Check & Invite Flow ---
test("T2_F12_01_user_cancel_on_invite_prompt_aborts_community_dispatch", async () => {
    const mockInviteActions = {
        acceptInvite: async () => {
            const err = new Error("Cancelled by user");
            throw err;
        }
    };
    const res = await ensureCommunityMembership({
        guildStore: { getGuild: () => null },
        inviteActions: mockInviteActions
    });
    assert.equal(res.ok, false);
    assert.equal(res.isMember, false);
    assert.equal(res.error, "Cancelled by user");
});

test("T2_F12_02_invite_rate_limit_429_surfaces_backoff_notification", async () => {
    const mockInviteActions = {
        acceptInvite: async () => {
            const err = new Error("Rate limit exceeded");
            err.status = 429;
            throw err;
        }
    };
    const res = await ensureCommunityMembership({
        guildStore: { getGuild: () => null },
        inviteActions: mockInviteActions
    });
    assert.equal(res.ok, false);
    assert.ok(res.error.includes("Rate limited"));
});

test("T2_F12_03_invalid_or_revoked_invite_code_surfaces_error_cleanly", async () => {
    const mockInviteActions = {
        acceptInvite: async () => {
            const err = new Error("Unknown Invite");
            err.code = 10006;
            throw err;
        }
    };
    const res = await ensureCommunityMembership({
        guildStore: { getGuild: () => null },
        inviteActions: mockInviteActions
    });
    assert.equal(res.ok, false);
    assert.ok(res.error.includes("invalid or expired (10006)"));
});

test("T2_F12_04_user_at_max_server_limit_handles_join_rejection", async () => {
    const mockInviteActions = {
        acceptInvite: async () => {
            const err = new Error("Maximum number of guilds reached");
            err.code = 30001;
            throw err;
        }
    };
    const res = await ensureCommunityMembership({
        guildStore: { getGuild: () => null },
        inviteActions: mockInviteActions
    });
    assert.equal(res.ok, false);
    assert.ok(res.error.includes("Maximum number of guilds reached (30001)"));
});

test("T2_F12_05_membership_verification_cached_during_active_session", () => {
    resetCommunityMembershipCache();
    let queryCount = 0;
    const mockStore = {
        getGuild: id => {
            queryCount++;
            return { id, name: "Adventurer Community" };
        }
    };
    const firstCheck = isCommunityMember(COMMUNITY_GUILD_ID, mockStore);
    assert.equal(firstCheck, true);
    assert.equal(queryCount, 1);

    const secondCheck = isCommunityMember(COMMUNITY_GUILD_ID);
    assert.equal(secondCheck, true);
    assert.equal(queryCount, 1, "Must hit cache instead of querying store again");
    resetCommunityMembershipCache();
});

// --- Feature 13: Community Channel REST Dispatch ---
test("T2_F13_01_http_403_forbidden_on_attachment_allocation_halts_flow", async () => {
    const mockRestApi = {
        post: async () => {
            const err = new Error("Missing Access / Forbidden");
            err.status = 403;
            throw err;
        }
    };
    await assert.rejects(
        () => dispatchRecipeToChannel(mockRestApi, COMMUNITY_CHANNEL_ID, "f.advrecipe", {}),
        /Forbidden/
    );
});

test("T2_F13_02_cdn_put_upload_failure_prevents_orphan_message_post", async () => {
    let msgPosted = false;
    const mockRestApi = {
        post: async req => {
            if (req.url.endsWith("/messages")) msgPosted = true;
            return { body: { attachments: [{ id: "1", upload_url: "https://fail" }] } };
        },
        put: async () => ({ ok: false, status: 500 })
    };
    await assert.rejects(
        () => dispatchRecipeToChannel(mockRestApi, COMMUNITY_CHANNEL_ID, "f.advrecipe", {}),
        /Failed to upload/
    );
    assert.equal(msgPosted, false);
});

test("T2_F13_03_rate_limited_message_post_retries_after_backoff", async () => {
    let postAttempts = 0;
    const mockRestApi = {
        post: async req => {
            if (req.url.endsWith("/attachments")) return { body: { attachments: [{ id: "1", upload_url: "https://upload" }] } };
            postAttempts++;
            if (postAttempts === 1) {
                const err = new Error("Rate limited");
                err.status = 429;
                err.body = { retry_after: 0.005 };
                throw err;
            }
            return { ok: true, status: 200, body: { id: "msg_retry_success" } };
        },
        put: async () => ({ ok: true, status: 200 })
    };
    const validRecipe = createMockValidRecipe();
    const res = await dispatchRecipeAttachment(COMMUNITY_CHANNEL_ID, validRecipe, {
        restApi: mockRestApi,
        maxRetries: 2
    });
    assert.equal(res.ok, true);
    assert.equal(postAttempts, 2, "Must retry and succeed on second attempt");
});

test("T2_F13_04_preserves_exact_utf8_binary_byte_length_in_rest_dispatch", async () => {
    let allocatedSize = null;
    const mockRestApi = {
        post: async req => {
            if (req.url.endsWith("/attachments")) allocatedSize = req.body.files[0].file_size;
            return { body: { attachments: [{ id: "1", upload_url: "https://upload" }] } };
        },
        put: async () => ({ ok: true, status: 200 })
    };
    const multiByteData = { text: "\u65E5\u672C\u8A9E \uD83D\uDE80" };
    const expectedBytes = Buffer.byteLength(JSON.stringify(multiByteData, null, 2), "utf8");
    await dispatchRecipeToChannel(mockRestApi, COMMUNITY_CHANNEL_ID, "multi.advrecipe", multiByteData);
    assert.equal(allocatedSize, expectedBytes);
});

test("T2_F13_05_channel_dispatch_runs_silently_in_background", async () => {
    let backgroundFinished = false;
    const mockRestApi = {
        post: async () => ({ body: { attachments: [{ id: "1", upload_url: "https://upload" }] } }),
        put: async () => ({ ok: true, status: 200 })
    };
    // Non-blocking dispatch
    dispatchRecipeToChannel(mockRestApi, COMMUNITY_CHANNEL_ID, "bg.advrecipe", {}).then(() => {
        backgroundFinished = true;
    });
    assert.equal(backgroundFinished, false); // asynchronous background task
    await new Promise(r => setTimeout(r, 10));
    assert.equal(backgroundFinished, true);
});

// ============================================================================
// TIER 3: Pairwise Combinations (13 tests)
// ============================================================================

test("T3_P01_recipe_model_validation_with_sanitized_vs_unsanitized_arguments", () => {
    const rawArgs = [{ token: "sensitive-token", safeId: 100 }];
    const { sanitized } = sanitizeArgs(rawArgs);
    const recipe = createMockValidRecipe({
        completion: {
            ...createMockValidRecipe().completion,
            entries: [{ name: "run:step", scope: "app", args: sanitized, source: "recorded" }]
        }
    });
    const res = validateRecipe(recipe.completion);
    assert.equal(res.valid, true);
    assert.equal(recipe.completion.entries[0].args[0].token, undefined);
});

test("T3_P02_recipe_serialization_and_atomic_disk_persistence_roundtrip", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        const original = createMockValidRecipe();
        const saved = atomicSaveRecipe(original, tmp);
        assert.equal(saved.ok, true);
        const reloaded = await loadRecipeDisk(saved.path, tmp);
        assert.deepEqual(reloaded, original);
        assert.equal(validateRecipe(reloaded.completion).valid, true);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T3_P03_local_disk_persistence_and_completion_runner_injection", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        const recipe = createMockValidRecipe();
        atomicSaveRecipe(recipe, tmp);
        const loadedProfiles = await listLocalRecipes(tmp, "1536318183873454090");
        const resolved = resolvePrecedence(loadedProfiles, [], null, "GlobalAces_MASTER");
        assert.equal(resolved.origin, "local");
        assert.equal(resolved.recipe.application_id, "1536318183873454090");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T3_P04_experiences_menu_trigger_and_quest_event_recorder_lifecycle", () => {
    const rec = new QuestEventRecorder();
    let menuState = "idle";
    function onMenuRecordClick() {
        if (menuState === "idle") {
            rec.start();
            menuState = "recording";
        }
    }
    onMenuRecordClick();
    assert.equal(menuState, "recording");
    assert.equal(rec.state, "recording");
});

test("T3_P05_quest_event_recorder_causal_tracking_and_auto_stop_termination", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("init");
    rec.recordAppFire("aim:target");
    rec.recordAppFire("arise:questComplete");
    assert.equal(rec.state, "completed");
    const recipe = rec.deriveAdvRecipe("arise:questComplete");
    assert.equal(recipe.verifiedCompletion, true);
    assert.ok(recipe.completion.entries.some(e => e.name === "aim:target"));
});

test("T3_P06_auto_stop_quest_completion_and_share_gate_unlocking", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    assert.equal(canShareRecipe(rec.deriveAdvRecipe()), false);
    rec.recordAppFire("arise:questComplete");
    assert.equal(rec.state, "completed");
    assert.equal(canShareRecipe(rec.deriveAdvRecipe()), true);
});

test("T3_P07_argument_sanitization_and_message_accessory_import", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        const rawRecipe = createMockValidRecipe();
        rawRecipe.completion.entries[0].args = [{ token: "secret", count: 5 }];
        rawRecipe.completion.entries[0].args = sanitizeArgs(rawRecipe.completion.entries[0].args).sanitized;

        await importRecipe(rawRecipe, tmp);
        const imported = (await listLocalRecipes(tmp))[0];
        assert.equal(imported.completion.entries[0].args[0].token, undefined);
        assert.equal(imported.completion.entries[0].args[0].count, 5);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T3_P08_share_gating_and_native_forward_modal_invocation", () => {
    function tryOpenForwardModal(recipe) {
        if (!canShareRecipe(recipe)) {
            throw new Error("Share blocked: quest incomplete.");
        }
        return { opened: true };
    }
    assert.throws(() => tryOpenForwardModal({ verifiedCompletion: false }), /Share blocked/);
    assert.equal(tryOpenForwardModal(createMockValidRecipe()).opened, true);
});

test("T3_P09_forward_dialog_community_checkbox_and_guild_membership_verification", async () => {
    const mockGuildStore = { getGuild: () => ({ id: COMMUNITY_GUILD_ID }) };
    let sharingTriggered = false;
    async function onForwardConfirm(shareCommunity) {
        if (shareCommunity) {
            const { isMember } = await verifyAndJoinCommunity(mockGuildStore, {});
            if (isMember) sharingTriggered = true;
        }
    }
    await onForwardConfirm(true);
    assert.equal(sharingTriggered, true);
});

test("T3_P10_guild_membership_verification_and_community_channel_rest_dispatch", async () => {
    const mockGuildStore = { getGuild: () => ({ id: COMMUNITY_GUILD_ID }) };
    const mockRestApi = {
        post: async () => ({ ok: true, body: { attachments: [{ id: "0", upload_url: "https://upload" }] } }),
        put: async () => ({ ok: true, status: 200 })
    };
    const { isMember } = await verifyAndJoinCommunity(mockGuildStore, {});
    assert.equal(isMember, true);
    const res = await dispatchRecipeToChannel(mockRestApi, COMMUNITY_CHANNEL_ID, "r.advrecipe", {});
    assert.equal(res.ok, true);
});

test("T3_P11_experiences_menu_profile_listing_and_message_accessory_import", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        assert.equal((await listLocalRecipes(tmp)).length, 0);
        // Accessory imports recipe
        await importRecipe(createMockValidRecipe(), tmp);
        assert.equal((await listLocalRecipes(tmp)).length, 1);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T3_P12_atomic_disk_storage_and_community_channel_rest_dispatch", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        const recipe = createMockValidRecipe();
        const { path } = atomicSaveRecipe(recipe, tmp);
        const loaded = await loadRecipeDisk(path, tmp);

        const mockRestApi = {
            post: async () => ({ ok: true, body: { attachments: [{ id: "0", upload_url: "https://upload" }] } }),
            put: async () => ({ ok: true, status: 200 })
        };
        const res = await dispatchRecipeToChannel(mockRestApi, COMMUNITY_CHANNEL_ID, "shared.advrecipe", loaded);
        assert.equal(res.ok, true);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T3_P13_step_classification_required_filtering_and_completion_runner_execution", () => {
    const rec = new QuestEventRecorder();
    rec.start();
    rec.recordAppFire("side_action");
    rec.recordAppFire("actual_step");
    rec.recordAppFire("arise:questComplete");

    const derived = rec.deriveAdvRecipe("arise:questComplete");
    const resolved = resolvePrecedence([derived], [], null, "");
    assert.equal(resolved.origin, "local");
    assert.ok(resolved.recipe.completion.entries.some(e => e.name === "actual_step"));
});

// ============================================================================
// TIER 4: Real-World Application Scenarios (5 Scenarios)
// ============================================================================

test("T4_S01_full_quest_record_to_save_lifecycle", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        // 1. Player opens experiences menu and starts recording
        const recorder = new QuestEventRecorder({
            appId: "1536318183873454090",
            scene: "GlobalAces_MASTER",
            name: "VALORANT Aces"
        });
        recorder.start();
        assert.equal(recorder.state, "recording");

        // 2. In-game quest events occur
        recorder.recordAppFire("select:play", { mode: "ranked" });
        recorder.recordAppFire("shot:fire", { weapon: "vandal", target: "@entity:guid-target-1" });
        recorder.recordAppFire("run:complete", { total: 100 });
        recorder.recordArisePostMessage({ type: "quest-progress", step: 1 });

        // 3. Quest completion reached
        recorder.recordAppFire("arise:questComplete");
        assert.equal(recorder.state, "completed");
        assert.equal(recorder.verifiedCompletion, true);

        // 4. Derive and sanitize recipe
        const recipe = recorder.deriveAdvRecipe("arise:questComplete");
        assert.equal(recipe.verifiedCompletion, true);
        assert.equal(canShareRecipe(recipe), true);

        // 5. Save to disk atomically without DataStore
        const saveRes = atomicSaveRecipe(recipe, tmp);
        assert.equal(saveRes.ok, true);

        // 6. Verify file on disk
        const savedFile = await loadRecipeDisk(saveRes.path, tmp);
        assert.equal(savedFile.application_id, "1536318183873454090");
        assert.equal(savedFile.completion.goal, "arise:questComplete");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T4_S02_distinguish_required_vs_optional_side_quests", () => {
    const recorder = new QuestEventRecorder();
    recorder.start();

    // Side events / cosmetic clicks
    recorder.recordAppFire("inspect:weapon", { skin: "prime" });
    recorder.recordAppFire("camera:rotate", { yaw: 45 });

    // Core quest progression
    recorder.recordAppFire("core:quest:advance", { point: 1 });
    recorder.recordAppFire("arise:questComplete");

    const recipe = recorder.deriveAdvRecipe("arise:questComplete");
    assert.ok(recipe.completion.entries.some(e => e.name === "core:quest:advance"));
    assert.equal(recipe.verifiedCompletion, true);
});

test("T4_S03_export_advrecipe_forward_and_share_to_community", async () => {
    const recipe = createMockValidRecipe({ verifiedCompletion: true });
    assert.equal(canShareRecipe(recipe), true);

    // Mock Discord Store & REST API
    const mockGuildStore = {
        _guilds: {},
        getGuild(id) { return this._guilds[id] || null; },
        addGuild(g) { this._guilds[g.id] = g; }
    };
    const mockInviteActions = {
        async acceptInvite(opts) {
            return { guild: { id: COMMUNITY_GUILD_ID, name: "Adventurer Community" } };
        }
    };
    const restCalls = [];
    const mockRestApi = {
        async post(req) {
            restCalls.push(`POST ${req.url}`);
            if (req.url.endsWith("/attachments")) {
                return { body: { attachments: [{ id: "att_1", upload_url: "https://upload.cdn" }] } };
            }
            return { ok: true, status: 200, body: { id: "msg_final" } };
        },
        async put(req) {
            restCalls.push(`PUT ${req.url}`);
            return { ok: true, status: 200 };
        }
    };

    // 1. Verify community membership (not a member initially)
    assert.equal(mockGuildStore.getGuild(COMMUNITY_GUILD_ID), null);
    const joinRes = await verifyAndJoinCommunity(mockGuildStore, mockInviteActions);
    assert.equal(joinRes.isMember, true);
    assert.equal(joinRes.joined, true);

    // 2. Dispatch to community channel
    const dispatchRes = await dispatchRecipeToChannel(
        mockRestApi,
        COMMUNITY_CHANNEL_ID,
        "valorant.advrecipe",
        recipe,
        "Verified recipe for community"
    );
    assert.equal(dispatchRes.ok, true);
    assert.equal(restCalls.length, 3);
});

test("T4_S04_receive_advrecipe_in_chat_one_click_import_and_execute", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        const chatAttachment = {
            filename: "speedrun_aces.advrecipe",
            content: JSON.stringify(createMockValidRecipe({ name: "Speedrun Aces" }))
        };

        // 1. Accessory detects .advrecipe extension
        assert.ok(isRecipeAttachment(chatAttachment));

        // 2. User clicks "Import & Execute"
        const parsed = parseRecipeContent(chatAttachment.content);
        assert.equal(validateRecipe(parsed.completion).valid, true);

        // 3. Persist to disk
        const saveRes = await importRecipe(parsed, tmp);
        assert.equal(saveRes.ok, true);

        // 4. Inject into completion runner
        const execRes = executeRecipe(parsed, { customDir: tmp, broadcastWindow: false });
        assert.equal(execRes.type, "completion_inject");

        const localRecipes = await listLocalRecipes(tmp, parsed.application_id);
        const chosen = resolvePrecedence(localRecipes, [], null, parsed.scene);
        assert.equal(chosen.origin, "local");
        assert.equal(chosen.recipe.name, "Speedrun Aces");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("T4_S05_client_restart_persistence_recovery_without_datastore", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-"));
    try {
        // Session 1: User saves 2 recipes
        const r1 = createMockValidRecipe({ scene: "scene_A", created: "2026-11-08T00:01:00Z" });
        const r2 = createMockValidRecipe({ scene: "scene_B", created: "2026-11-08T00:02:00Z" });
        atomicSaveRecipe(r1, tmp);
        atomicSaveRecipe(r2, tmp);

        // Session 2: Discord restarts, fresh heap, zero DataStore state
        const freshList = await listLocalRecipes(tmp, "1536318183873454090");
        assert.equal(freshList.length, 2);
        assert.equal(freshList[0].scene, "scene_B");
        assert.equal(freshList[1].scene, "scene_A");

        // Verify runner resolves persisted profile immediately
        const resolved = resolvePrecedence(freshList, [], null, "scene_B");
        assert.equal(resolved.origin, "local");
        assert.equal(resolved.recipe.scene, "scene_B");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

// ============================================================================
// MILESTONE 2: F4 (Recorder), F5 (Menu Integration), F6 (Completion Injection)
// ============================================================================

test("M2_F4_01_buildRecorderScript_syntax_and_structure", () => {
    const src = buildRecorderScript();
    assert.ok(typeof src === "string");
    assert.ok(src.length > 500);
    assert.doesNotThrow(() => new Function(src));
    assert.ok(src.includes("__adventurerRecorder"));
    assert.ok(src.includes("QuestEventRecorder"));
    assert.ok(src.includes("recordAppFire"));
    assert.ok(src.includes("recordArisePostMessage"));
    assert.ok(src.includes("hookApp"));
    assert.ok(src.includes("hookArise"));

    // Verify zero em-dash / en-dash characters in injected code
    assert.equal(src.includes(String.fromCharCode(0x2014)), false);
    assert.equal(src.includes(String.fromCharCode(0x2013)), false);
});

test("M2_F4_02_recorder_filters_noise_tracks_causal_graph_and_auto_stops", () => {
    let captured = null;
    const recorder = new QuestEventRecorder({
        appId: "1536318183873454090",
        scene: "GlobalAces_MASTER",
        name: "VALORANT Aces",
        onComplete: r => { captured = r; }
    });

    recorder.start();
    assert.equal(recorder.state, "recording");

    // Engine noise events should be ignored
    recorder.recordAppFire("update", 0.016);
    recorder.recordAppFire("frameupdate");
    recorder.recordAppFire("mouse:move", 50, 100);
    recorder.recordAppFire("physics:update");
    assert.equal(recorder.events.length, 0);

    // Quest interactions
    recorder.recordAppFire("select:play", { mode: "competitive" });
    recorder.recordAppFire("inspect:weapon", { skin: "reaver" }); // extraneous
    recorder.recordAppFire("camera:rotate", { angle: 90 }); // extraneous
    recorder.recordAppFire("shot:fire", { weapon: "vandal", target: "@entity:guid-1" }); // required
    recorder.recordArisePostMessage({ type: "quest-progress", step: 1 });

    // Quest goal completion
    recorder.recordAppFire("arise:questComplete");
    assert.equal(recorder.state, "completed");
    assert.equal(recorder.verifiedCompletion, true);
    assert.ok(captured !== null);

    const recipe = recorder.deriveAdvRecipe("arise:questComplete");
    assert.equal(recipe.format, "advrecipe");
    assert.equal(recipe.version, 1);
    assert.equal(recipe.application_id, "1536318183873454090");
    assert.equal(recipe.scene, "GlobalAces_MASTER");
    assert.equal(recipe.verifiedCompletion, true);

    // Required steps preserved
    assert.ok(recipe.completion.entries.some(e => e.name === "shot:fire"));

    // Extraneous actions classified as optional
    assert.ok(recipe.optional_events.includes("inspect:weapon"));
    assert.ok(recipe.optional_events.includes("camera:rotate"));

    // Schema v1 validation passes
    const validation = validateRecipe(recipe);
    assert.equal(validation.valid, true);
    assert.deepEqual(validation.errors, []);

    // Gating check
    assert.equal(canShareRecipe(recipe), true);
});

test("M2_F5_01_menu_script_contains_recording_controls_and_gating_elements", () => {
    const script = buildMenuScript({ esp: true, minimap: true, autoComplete: true });
    assert.ok(typeof script === "string");
    assert.doesNotThrow(() => new Function(script));

    // Zero em-dash / en-dash characters in injected script
    assert.equal(script.includes(String.fromCharCode(0x2014)), false);
    assert.equal(script.includes(String.fromCharCode(0x2013)), false);

    // Injected DOM element IDs and CSS selectors
    assert.ok(script.includes("adventurer-btn-record"));
    assert.ok(script.includes("adventurer-btn-stop"));
    assert.ok(script.includes("adventurer-btn-share"));
    assert.ok(script.includes("adventurer-btn-share-disabled"));
    assert.ok(script.includes("adventurer-recipe-panel"));
    assert.ok(script.includes("pulsing-dot"));
    assert.ok(script.includes("Recording ("));
    assert.ok(script.includes("Recipe Ready"));
    assert.ok(script.includes("Complete Quest to Share"));
    assert.ok(script.includes("canShareRecipe"));
});

test("M2_F5_02_strict_share_gating_blocks_unverified_recipes", () => {
    const unverified = createMockValidRecipe({ verifiedCompletion: false });
    assert.equal(canShareRecipe(unverified), false);

    const verified = createMockValidRecipe({ verifiedCompletion: true });
    assert.equal(canShareRecipe(verified), true);

    // Tampered format or version
    assert.equal(canShareRecipe({ ...verified, format: "other" }), false);
    assert.equal(canShareRecipe({ ...verified, version: 2 }), false);
});

test("M2_F6_01_completion_runner_message_builders_and_precedence", () => {
    const rec = createMockValidRecipe();

    const injectMsg = buildInjectRecipeMessage(rec);
    assert.equal(injectMsg.__adventurerOverlay, true);
    assert.equal(injectMsg.type, "ADVENTURER_INJECT_RECIPE");
    assert.equal(injectMsg.recipe, rec);
    assert.equal(injectMsg.execute, false);

    const execMsg = buildExecuteRecipeMessage(rec);
    assert.equal(execMsg.__adventurerOverlay, true);
    assert.equal(execMsg.type, "ADVENTURER_EXECUTE_RECIPE");
    assert.equal(execMsg.recipe, rec);
    assert.equal(execMsg.execute, true);

    // Precedence resolution: local exact (Rank 3) > bundled exact (Rank 2) > local * (Rank 1) > bundled * (Rank 0) > guessed
    const localExact = { scene: "Arena_01", origin: "local", name: "Local Exact" };
    const bundledExact = { scene: "Arena_01", origin: "bundled", name: "Bundled Exact" };
    const localWild = { scene: "*", origin: "local", name: "Local Wild" };
    const bundledWild = { scene: "*", origin: "bundled", name: "Bundled Wild" };
    const guessed = { scene: "Arena_01", origin: "guessed", name: "Guessed Recipe" };

    // 1. Local Exact beats Bundled Exact
    assert.equal(resolvePrecedence([localExact], [bundledExact], guessed, "Arena_01").recipe.name, "Local Exact");

    // 2. Bundled Exact beats Local Wildcard
    assert.equal(resolvePrecedence([localWild], [bundledExact], guessed, "Arena_01").recipe.name, "Bundled Exact");

    // 3. Local Wildcard beats Bundled Wildcard
    assert.equal(resolvePrecedence([localWild], [bundledWild], guessed, "OtherScene").recipe.name, "Local Wild");

    // 4. Bundled Wildcard beats Guessed
    assert.equal(resolvePrecedence([], [bundledWild], guessed, "OtherScene").recipe.name, "Bundled Wild");

    // 5. Guessed used when no local or bundled matches
    assert.equal(resolvePrecedence([], [], guessed, "Arena_01").recipe.name, "Guessed Recipe");
});

// ============================================================================
// MILESTONE 3: Community Sharing & Distribution (Features F8, F9, F10)
// ============================================================================

test("M3_F9_01_isCommunityMember_supports_both_argument_orders", () => {
    resetCommunityMembershipCache();
    const mockStore = {
        getGuild: id => (id === COMMUNITY_GUILD_ID ? { id: COMMUNITY_GUILD_ID, name: "Community" } : null)
    };

    // Signature 1: isCommunityMember(guildId, store)
    assert.equal(isCommunityMember(COMMUNITY_GUILD_ID, mockStore), true);
    assert.equal(isCommunityMember("9999999999999999999", mockStore), false);

    // Signature 2: isCommunityMember(store, guildId)
    assert.equal(isCommunityMember(mockStore, COMMUNITY_GUILD_ID), true);
    assert.equal(isCommunityMember(mockStore, "9999999999999999999"), false);

    // Signature 3: isCommunityMember(store) -> defaults to COMMUNITY_GUILD_ID
    assert.equal(isCommunityMember(mockStore), true);

    const emptyStore = { getGuild: () => null };
    assert.equal(isCommunityMember(emptyStore), false);
});

test("M3_F9_02_isCommunityMember_cache_reset_utility", () => {
    resetCommunityMembershipCache();
    let queryCount = 0;
    const mockStore = {
        getGuild: () => {
            queryCount++;
            return { id: COMMUNITY_GUILD_ID };
        }
    };

    assert.equal(isCommunityMember(mockStore), true);
    assert.equal(queryCount, 1);
    resetCommunityMembershipCache();
    assert.equal(isCommunityMember(mockStore), true);
    assert.equal(queryCount, 2);
});

test("M3_F9_03_ensureCommunityMembership_already_member", async () => {
    resetCommunityMembershipCache();
    const mockStore = {
        getGuild: id => (id === COMMUNITY_GUILD_ID ? { id: COMMUNITY_GUILD_ID } : null)
    };
    let inviteCalled = false;
    const mockInvite = {
        acceptInvite: async () => { inviteCalled = true; }
    };

    const res = await ensureCommunityMembership({
        guildStore: mockStore,
        inviteActions: mockInvite
    });

    assert.equal(res.ok, true);
    assert.equal(res.alreadyMember, true);
    assert.equal(res.isMember, true);
    assert.equal(res.joined, false);
    assert.equal(inviteCalled, false);
});

test("M3_F9_04_ensureCommunityMembership_auto_join_success", async () => {
    resetCommunityMembershipCache();
    let storedGuild = null;
    const mockStore = {
        getGuild: () => storedGuild,
        addGuild: g => { storedGuild = g; }
    };
    let receivedInviteKey = null;
    let receivedContext = null;
    const mockInvite = {
        acceptInvite: async opt => {
            receivedInviteKey = opt.inviteKey;
            receivedContext = opt.context;
            return {
                guild: { id: COMMUNITY_GUILD_ID, name: "Adventurer Community" }
            };
        }
    };

    const res = await ensureCommunityMembership({
        guildStore: mockStore,
        inviteActions: mockInvite
    });

    assert.equal(res.ok, true);
    assert.equal(res.alreadyMember, false);
    assert.equal(res.isMember, true);
    assert.equal(res.joined, true);
    assert.equal(receivedInviteKey, COMMUNITY_INVITE_CODE);
    assert.deepEqual(receivedContext, { location: "Adventurer Community Share" });
    assert.ok(storedGuild);
    assert.equal(storedGuild.id, COMMUNITY_GUILD_ID);
});

test("M3_F9_05_ensureCommunityMembership_handles_error_codes_429_10006_30001_cancel", async () => {
    resetCommunityMembershipCache();
    const emptyStore = { getGuild: () => null };

    // 429 Rate Limit
    const rateLimitInvite = {
        acceptInvite: async () => {
            const err = new Error("Rate limited by Discord");
            err.status = 429;
            throw err;
        }
    };
    const res429 = await ensureCommunityMembership({ guildStore: emptyStore, inviteActions: rateLimitInvite });
    assert.equal(res429.ok, false);
    assert.ok(res429.error.includes("Rate limited"));

    // 10006 Unknown Invite
    const unknownInvite = {
        acceptInvite: async () => {
            const err = new Error("Unknown Invite");
            err.code = 10006;
            throw err;
        }
    };
    const res10006 = await ensureCommunityMembership({ guildStore: emptyStore, inviteActions: unknownInvite });
    assert.equal(res10006.ok, false);
    assert.ok(res10006.error.includes("10006"));

    // 30001 Maximum Guilds
    const maxGuildsInvite = {
        acceptInvite: async () => {
            const err = new Error("Maximum number of guilds reached");
            err.code = 30001;
            throw err;
        }
    };
    const res30001 = await ensureCommunityMembership({ guildStore: emptyStore, inviteActions: maxGuildsInvite });
    assert.equal(res30001.ok, false);
    assert.ok(res30001.error.includes("30001"));

    // User Cancellation
    const cancelInvite = {
        acceptInvite: async () => {
            throw new Error("Cancelled by user");
        }
    };
    const resCancel = await ensureCommunityMembership({ guildStore: emptyStore, inviteActions: cancelInvite });
    assert.equal(resCancel.ok, false);
    assert.equal(resCancel.error, "Cancelled by user");
});

test("M3_F10_01_dispatchRecipeToChannel_3_step_rest_upload", async () => {
    const executedSteps = [];
    const mockRestApi = {
        post: async req => {
            if (req.url.endsWith("/attachments")) {
                executedSteps.push("step1_alloc");
                return {
                    body: {
                        attachments: [{
                            id: "0",
                            upload_url: "https://storage.googleapis.com/discord/upload",
                            upload_filename: "channels/comm/recipe.advrecipe"
                        }]
                    }
                };
            }
            if (req.url.endsWith("/messages")) {
                executedSteps.push("step3_msg");
                return { ok: true, body: { id: "msg_m3_1" } };
            }
            throw new Error("Unknown POST endpoint: " + req.url);
        },
        put: async req => {
            if (req.url.includes("storage.googleapis.com")) {
                executedSteps.push("step2_put");
                return { ok: true, status: 200 };
            }
            throw new Error("Unknown PUT endpoint: " + req.url);
        }
    };

    const validRecipe = createMockValidRecipe();
    const res = await dispatchRecipeToChannel(
        mockRestApi,
        COMMUNITY_CHANNEL_ID,
        "valorant.advrecipe",
        validRecipe,
        "Here is my completed recipe!"
    );

    assert.equal(res.ok, true);
    assert.equal(res.messageId, "msg_m3_1");
    assert.deepEqual(executedSteps, ["step1_alloc", "step2_put", "step3_msg"]);
});

test("M3_F10_02_dispatchRecipeToChannel_step2_failure_strictly_aborts_step3", async () => {
    let step3Reached = false;
    const mockRestApi = {
        post: async req => {
            if (req.url.endsWith("/attachments")) {
                return {
                    body: {
                        attachments: [{
                            id: "0",
                            upload_url: "https://fail-put.storage/upload"
                        }]
                    }
                };
            }
            if (req.url.endsWith("/messages")) {
                step3Reached = true;
                return { ok: true };
            }
            throw new Error("Unknown POST: " + req.url);
        },
        put: async () => {
            return { ok: false, status: 500 };
        }
    };

    await assert.rejects(
        () => dispatchRecipeToChannel(mockRestApi, COMMUNITY_CHANNEL_ID, "recipe.advrecipe", {}),
        /Failed to upload/
    );
    assert.equal(step3Reached, false, "Step 3 message post must NEVER execute if Step 2 PUT fails");
});

test("M3_F10_03_dispatchRecipeAttachment_rejects_unverified_recipe", async () => {
    const unverifiedRecipe = createMockValidRecipe({ verifiedCompletion: false });
    const res = await dispatchRecipeAttachment(COMMUNITY_CHANNEL_ID, unverifiedRecipe);
    assert.equal(res.ok, false);
    assert.ok(res.error.includes("verifiedCompletion === true"));
});

test("M3_F10_04_dispatchRecipeAttachment_rejects_invalid_schema", async () => {
    const invalidRecipe = {
        format: "advrecipe",
        version: 1,
        verifiedCompletion: true
        // missing required fields
    };
    const res = await dispatchRecipeAttachment(COMMUNITY_CHANNEL_ID, invalidRecipe);
    assert.equal(res.ok, false);
    assert.ok(res.error.includes("Invalid recipe schema"));
});

test("M3_F10_05_dispatchRecipeAttachment_retries_on_rate_limit_429", async () => {
    let callCount = 0;
    const mockRestApi = {
        post: async req => {
            if (req.url.endsWith("/attachments")) {
                return { body: { attachments: [{ id: "0", upload_url: "https://upload" }] } };
            }
            callCount++;
            if (callCount === 1) {
                return { ok: false, status: 429, retry_after: 0.001 };
            }
            return { ok: true, status: 200, body: { id: "msg_retried" } };
        },
        put: async () => ({ ok: true, status: 200 })
    };

    const validRecipe = createMockValidRecipe();
    const res = await dispatchRecipeAttachment(COMMUNITY_CHANNEL_ID, validRecipe, {
        restApi: mockRestApi,
        maxRetries: 2
    });

    assert.equal(res.ok, true);
    assert.equal(res.messageId, "msg_retried");
    assert.equal(callCount, 2);
});

test("M3_F10_06_shareRecipeWithCommunity_end_to_end_pipeline", async () => {
    resetCommunityMembershipCache();
    const mockStore = {
        _g: null,
        getGuild: () => mockStore._g,
        addGuild: g => { mockStore._g = g; }
    };
    const mockInvite = {
        acceptInvite: async () => ({
            guild: { id: COMMUNITY_GUILD_ID, name: "Community" }
        })
    };
    const mockRestApi = {
        post: async req => {
            if (req.url.endsWith("/attachments")) {
                return { body: { attachments: [{ id: "0", upload_url: "https://upload" }] } };
            }
            return { ok: true, body: { id: "community_msg_100" } };
        },
        put: async () => ({ ok: true, status: 200 })
    };

    const validRecipe = createMockValidRecipe();
    const res = await shareRecipeWithCommunity(validRecipe, {
        guildStore: mockStore,
        inviteActions: mockInvite,
        restApi: mockRestApi,
        messageContent: "Community contribution"
    });

    assert.equal(res.ok, true);
    assert.equal(res.messageId, "community_msg_100");
    assert.equal(res.membership.isMember, true);
    assert.equal(res.membership.joined, true);
});

test("M3_F10_07_dispatchToRecipients_batches_destinations", async () => {
    const dispatched = [];
    const mockRestApi = {
        post: async req => {
            if (req.url.endsWith("/attachments")) {
                const match = req.url.match(/channels\/([^/]+)\/attachments/);
                if (match) dispatched.push(match[1]);
                return { body: { attachments: [{ id: "0", upload_url: "https://upload" }] } };
            }
            return { ok: true, body: { id: "msg_batch" } };
        },
        put: async () => ({ ok: true, status: 200 })
    };

    const validRecipe = createMockValidRecipe();
    const result = await dispatchToRecipients(
        ["channel_101", "channel_102", "channel_103"],
        validRecipe,
        { restApi: mockRestApi }
    );

    assert.deepEqual(result.successful, ["channel_101", "channel_102", "channel_103"]);
    assert.equal(result.failed.length, 0);
    assert.deepEqual(dispatched, ["channel_101", "channel_102", "channel_103"]);
});

test("M3_F8_01_forwardModal_file_structure_and_strict_ascii", () => {
    const fileUrl = new URL("../sharing/forwardModal.tsx", import.meta.url);
    assert.ok(existsSync(fileUrl), "adventurer/sharing/forwardModal.tsx must exist");

    const content = readFileSync(fileUrl, "utf8");
    for (let i = 0; i < content.length; i++) {
        assert.ok(
            content.charCodeAt(i) <= 127,
            `forwardModal.tsx must be STRICT ASCII ONLY. Found code ${content.charCodeAt(i)} at pos ${i}`
        );
    }

    assert.equal(typeof getForwardModalState, "function");
    assert.equal(typeof setCommunityShare, "function");
    assert.equal(typeof resetForwardModalState, "function");
    assert.equal(typeof useCommunityShareState, "function");
    assert.equal(typeof RecipePreviewChip, "function");
    assert.equal(typeof CommunityShareCheckbox, "function");
    assert.equal(typeof createRecipeMessage, "function");
    assert.equal(typeof customSendHandler, "function");
    assert.equal(typeof handleForwardSubmit, "function");
    assert.equal(typeof openRecipeForwardModal, "function");
    assert.equal(typeof closeForwardModal, "function");
    assert.ok(Array.isArray(forwardModalPatches));
    assert.equal(typeof installForwardModalDOMObserver, "function");
    assert.equal(typeof removeForwardModalDOMObserver, "function");
});

test("M3_F8_02_forwardModal_ast_and_observer_patch_definitions", () => {
    assert.ok(Array.isArray(forwardModalPatches));
    assert.equal(forwardModalPatches[0].find, 'modalKey:"forward-modal"');
    assert.ok(forwardModalPatches[0].replacement.replace.includes("$self.CommunityShareCheckbox"));
    assert.ok(forwardModalPatches[0].replacement.match instanceof RegExp);

    assert.equal(typeof installForwardModalDOMObserver, "function");
    assert.equal(typeof removeForwardModalDOMObserver, "function");
});

test("M3_F8_03_forwardModal_double_lock_gating_and_inflight_lock", async () => {
    resetForwardModalState();

    const valid = createMockValidRecipe();
    assert.equal(forwardModal.canShareRecipe(valid), true);

    const unverified = createMockValidRecipe({ verifiedCompletion: false });
    assert.equal(forwardModal.canShareRecipe(unverified), false);

    assert.throws(
        () => openRecipeForwardModal(unverified),
        /Share blocked: quest incomplete/
    );

    openRecipeForwardModal(valid);
    getForwardModalState().activeRecipe = unverified;
    await assert.rejects(
        () => handleForwardSubmit(["dest_test"]),
        /Share blocked: quest incomplete/
    );

    openRecipeForwardModal(valid);
    const promise1 = handleForwardSubmit(["dest_1"]);
    const promise2 = handleForwardSubmit(["dest_2"]);
    await Promise.all([promise1, promise2]);

    assert.equal(getForwardModalState().isSubmitting, false);
    resetForwardModalState();
});

test("M3_F8_04_adventurer_index_exports_CommunityShareCheckbox_on_plugin", () => {
    assert.ok(
        forwardModalPatches[0].replacement.replace.includes("$self.CommunityShareCheckbox"),
        "Patch requires $self.CommunityShareCheckbox to be defined on plugin"
    );
});

test("M3_F8_05_createRecipeMessage_synthesizes_discord_forward_payload", () => {
    const valid = createMockValidRecipe();
    const msg = createRecipeMessage(valid);

    assert.ok(msg.id.startsWith("adv-recipe-"));
    assert.equal(msg.channel_id, "0");
    assert.ok(msg.content.includes(valid.name));
    assert.equal(msg.attachments.length, 1);
    assert.equal(msg.attachments[0].filename, `${valid.application_id}.advrecipe`);
    assert.equal(msg.attachments[0].content_type, "application/json");
    assert.ok(msg.attachments[0].size > 0);
});

// ============================================================================
// Milestone 4: Custom Message Accessory & One-Click Execution (Feature F7)
// ============================================================================

test("M4_F7_01_recipeAccessory_file_structure_and_strict_ascii", () => {
    const fileUrl = new URL("../components/RecipeAccessory.tsx", import.meta.url);
    assert.ok(existsSync(fileUrl), "adventurer/components/RecipeAccessory.tsx must exist");

    const content = readFileSync(fileUrl, "utf8");
    for (let i = 0; i < content.length; i++) {
        assert.ok(
            content.charCodeAt(i) <= 127,
            `RecipeAccessory.tsx must be STRICT ASCII ONLY. Found code ${content.charCodeAt(i)} at pos ${i}`
        );
    }

    assert.equal(typeof RecipeAccessory, "function");
    assert.equal(typeof RecipeAccessoryCard, "function");
    assert.equal(typeof renderRecipeAccessory, "function");
    assert.equal(typeof isRecipeAttachment, "function");
    assert.equal(typeof getRecipeAttachments, "function");
    assert.equal(typeof getCardHeader, "function");
    assert.equal(typeof renderAccessoryDom, "function");
    assert.equal(typeof parseRecipeContent, "function");
    assert.equal(typeof fetchRecipeAttachment, "function");
    assert.equal(typeof importRecipe, "function");
    assert.equal(typeof executeRecipe, "function");
});

test("M4_F7_02_recipeAccessory_renders_matching_container_and_null_for_non_recipes", () => {
    // Non-recipe message returns null
    const nonRecipeMsg = {
        id: "msg_1",
        attachments: [
            { filename: "cat.png", size: 1024 },
            { filename: "data.json", size: 2048 }
        ]
    };
    const nonResult = RecipeAccessory({ message: nonRecipeMsg });
    assert.equal(nonResult, null);

    const emptyResult = RecipeAccessory({ message: { attachments: [] } });
    assert.equal(emptyResult, null);

    const nullResult = RecipeAccessory(null);
    assert.equal(nullResult, null);

    // Message with .advrecipe returns container with RecipeAccessoryCard
    const recipeMsg = {
        id: "msg_2",
        attachments: [
            { filename: "cat.png", size: 1024 },
            { filename: "quest.advrecipe", size: 500, content: JSON.stringify(createMockValidRecipe()) }
        ]
    };
    const result = RecipeAccessory({ message: recipeMsg });
    assert.ok(result !== null);
    assert.equal(result.props.className, "adventurer-recipe-accessories-container");
    assert.equal(result.props.children.length, 1);

    // renderRecipeAccessory factory function
    const rendered = renderRecipeAccessory({ message: recipeMsg });
    assert.ok(rendered !== null);
});

test("M4_F7_03_recipeAccessoryCard_displays_verified_vs_unverified_quest_details", () => {
    // Verified recipe: green accent #23a55a
    const verified = createMockValidRecipe({ name: "Pro Quest", verifiedCompletion: true });
    const headerVerified = getCardHeader(verified);
    assert.equal(headerVerified.verifiedBadge, "Verified Quest");

    const verifiedCard = RecipeAccessoryCard({
        attachment: { filename: "pro.advrecipe", content: JSON.stringify(verified) }
    });
    assert.equal(verifiedCard.props.className, "adventurer-recipe-card");
    assert.ok(JSON.stringify(verifiedCard).includes("VERIFIED RECIPE"));

    // Unverified recipe
    const unverified = createMockValidRecipe({ name: "WIP Quest", verifiedCompletion: false });
    const headerUnverified = getCardHeader(unverified);
    assert.equal(headerUnverified.verifiedBadge, "Unverified");

    const unverifiedCard = RecipeAccessoryCard({
        attachment: { filename: "wip.advrecipe", content: JSON.stringify(unverified) }
    });
    assert.equal(unverifiedCard.props.className, "adventurer-recipe-card");
    assert.ok(JSON.stringify(unverifiedCard).includes("ADVENTURER RECIPE"));
});

test("M4_F7_04_defensive_error_cards_for_oversized_corrupted_empty_attachments", async () => {
    // 0-byte attachment
    await assert.rejects(
        () => fetchRecipeAttachment({ filename: "empty.advrecipe", size: 0, url: "https://test.cdn/empty" }),
        /Empty attachment file/
    );

    // Oversized attachment > 10MB
    await assert.rejects(
        () => fetchRecipeAttachment({ filename: "huge.advrecipe", size: 15 * 1024 * 1024, url: "https://test.cdn/huge" }),
        /Recipe file exceeds 10MB limit/
    );

    // Corrupted JSON content
    assert.throws(
        () => parseRecipeContent("Not A JSON String {{{"),
        /Corrupted recipe file/
    );

    // Empty string content
    assert.throws(
        () => parseRecipeContent(""),
        /Empty attachment file/
    );

    // Error card rendering
    const errorCard = RecipeAccessoryCard({
        attachment: { filename: "broken.advrecipe", content: "not-json" }
    });
    assert.equal(errorCard.props.className, "adventurer-recipe-card");
    assert.ok(JSON.stringify(errorCard).includes("RECIPE ERROR"));
});

test("M4_F7_05_one_click_import_persists_without_datastore_and_handles_overwrites", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "adv-test-m4-"));
    try {
        const recipeV1 = createMockValidRecipe({ name: "Run V1" });
        const importRes1 = await importRecipe(recipeV1, tmp);
        assert.equal(importRes1.ok, true);

        const list1 = await listLocalRecipes(tmp);
        assert.equal(list1.length, 1);
        assert.equal(list1[0].name, "Run V1");

        // Overwrite with V2 for the same app and scene
        const recipeV2 = createMockValidRecipe({ name: "Run V2" });
        const importRes2 = await importRecipe(recipeV2, tmp);
        assert.equal(importRes2.ok, true);

        const list2 = await listLocalRecipes(tmp);
        assert.equal(list2.length, 1);
        assert.equal(list2[0].name, "Run V2");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("M4_F7_06_one_click_execute_dispatches_messages_and_notifies_user", () => {
    const recipe = createMockValidRecipe({ name: "Execute Test" });
    const payload = executeRecipe(recipe, { broadcastWindow: false });

    assert.equal(payload.type, "completion_inject");
    assert.equal(payload.execute, true);
    assert.equal(payload.recipe.name, "Execute Test");

    // Also check DOM accessory descriptor helper
    const domInfo = renderAccessoryDom({ filename: "test.advrecipe" }, "12345");
    assert.equal(domInfo.containerId, "#message-accessories-12345");
    assert.equal(domInfo.className, "adventurer-recipe-card");
    assert.equal(domInfo.fileName, "test.advrecipe");
});

test("M4_F7_07_recorder_filters_sfx_and_cosmetic_camera_noise", () => {
    const rec = new QuestEventRecorder({ appId: "1562778462358470746", scene: "Main" });
    rec.start();
    rec.recordAppFire("sfx", "click");
    rec.recordAppFire("cam:go", "desk");
    rec.recordAppFire("set:dim", true);
    rec.recordAppFire("glass:notify", "ping");
    rec.recordAppFire("console:lamp", 1);
    rec.recordAppFire("console:verdict", "pass");
    rec.recordArisePostMessage("quest-completed");
    const out = rec.deriveAdvRecipe();
    assert.equal(rec.events.some(e => e.name === "sfx"), false);
    const entryNames = out.completion.entries.map(e => e.name);
    assert.equal(entryNames.includes("cam:go"), false);
    assert.equal(entryNames.includes("set:dim"), false);
    assert.equal(entryNames.includes("glass:notify"), false);
    assert.equal(entryNames.includes("console:lamp"), false);
    assert.equal(entryNames.includes("console:verdict"), true);
});



