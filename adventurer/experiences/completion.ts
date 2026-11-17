/*
 * Adventurer: in-activity quest completion (recipe runner).
 *
 * buildCompletionScript() returns plain JS source that is injected into the activity iframe (same transport as the
 * game overlay, see index.tsx / native.ts). It is data driven: a "recipe" says which app events mean "the player
 * did something" (triggers), which app events to fire then (entries), which event proves the game queued the quest
 * report (goal) and which events must never reach the game while that happens (suppress, always at least
 * "leaderboard"). Recipes learned later by Vencord Workbench only need to be saved, no code changes.
 *
 * ---------------------------------------------------------------------------------------------------------------
 * Recipe schema (field `completion` of a profile object {application_id, scene, name?, completion?, ...})
 * ---------------------------------------------------------------------------------------------------------------
 *   version     1
 *   goal        app event that proves the game queued the quest report (for example "arise:questComplete")
 *   triggers    app events that are user actions. After the first occurrence of each one an attempt is scheduled
 *   entries     [{name, scope: "app" | "entity", entity?, guid?, args?, source?}] fired in order until the goal fires.
 *               Entity entries fire on the entity found by guid, then by name. A string arg "@entity:<guid>" is
 *               replaced by that entity
 *   suppress    case-insensitive substrings. During an attempt (plus 3 s) app events and window.arise.postMessage
 *               messages whose name or type contains one are dropped. "leaderboard" is always included
 *   delay_ms    wait after the trigger so the click's own synchronous event chain has finished (default 0)
 *   notes       free text
 *   source      "recorded" | "guessed" | "edited" | "bundled"
 * An entry is never fired when its name starts with "arise:" (those are the game's own reports to Discord), equals
 * the goal, or contains a suppress pattern. The attempt logs and skips it.
 *
 * ---------------------------------------------------------------------------------------------------------------
 * Where recipes come from (merged, the runner picks one for this frame)
 * ---------------------------------------------------------------------------------------------------------------
 *   bundled   experiences/recipes.json, passed in through options.recipes by index.tsx
 *   local     profiles saved by Vencord Workbench (~/.vencord_workbench/profiles). native.ts replaces the profile
 *             placeholder (PROFILES_PLACEHOLDER) in the injected script with a JSON array of this application's
 *             profiles, newest first. Profiles without `completion` are ignored
 *   guessed   the recipe the event graph (graph.ts, window.__adventurerGraph) guessed from the scripts' own code, for
 *             scenes that no local or bundled recipe covers (see "Guessed recipes" below)
 * A recipe matches when its application_id is this frame's (first label of location.hostname) and its scene equals
 * a scene name of the app, or is "*". An exact scene beats "*", and at equal specificity a local recipe beats a
 * bundled one (so a recorded recipe replaces the bundled guess for the same application and scene).
 * Precedence is local > bundled > guessed: a guessed recipe is only picked when no local or bundled recipe matches the
 * scene at all, not even a "*" one. It never competes on scene specificity.
 *
 * ---------------------------------------------------------------------------------------------------------------
 * Guessed recipes (fallback for a quest with no recipe at all)
 * ---------------------------------------------------------------------------------------------------------------
 * The runner looks for window.__adventurerGraph (injected whenever the completion runner is on, see index.tsx) and
 * subscribes to its onChange. Each time the graph announces something it reads guessedRecipe({ usableOnly: true }) and
 * the graph's scene. That recipe is the guess of the source analysis (a port of the Workbench's) in the recipe schema
 * above (source "guessed", triggers and entries inferred from the scripts, suppress at least "leaderboard"). It goes through exactly the
 * same validation, triggers, suppression window, entry refusals and goal verification as any other recipe, and the
 * quest gate applies unchanged. Rules:
 *   - Only entries the graph marks usable are ever fired. An entry is not usable when the analysis found that it skips
 *     the writer of the state the goal path reads (guardOk false), and, conservatively, none is usable while the goal
 *     path reads state of another script that no known event writes (nothing can be verified). When the goal path
 *     reads no state of another script (the no-guard case) every entry is usable: there is nothing to verify, the
 *     entries stay in the order closest to the goal first, and the goal check after each entry stops the attempt at the
 *     first one that works. A guess without a usable entry is not used (logged once).
 *   - The guess belongs to the scene the graph analysed: it is only picked while that scene name is a scene of the app,
 *     so a scene change never applies the old guess. The graph drops its guess on a scene change.
 *   - Attempts with a guessed recipe are capped (MAX_GUESSED_ATTEMPTS per frame), so a guess that keeps changing cannot
 *     fire game events without end. A changed guess earns fresh attempts like any changed recipe, up to the cap.
 *   - Nothing is hooked until a recipe exists, so with a guess only the triggers after the analysis finished are seen.
 *   - If the graph is not there yet the runner polls for it (about 2 minutes, again on every repeated injection), but only
 *     while a guess could be used: the app exists, the quest gate is open and no local or bundled recipe covers the
 *     scene. Otherwise no timer is queued. If the graph is there but has no guess yet the runner waits for its onChange.
 * Every pick logs which origin is used ("using the guessed recipe ..."), status().recipe.origin and
 * status().attemptOrigin say it too, and status().guessed describes the guess and the graph connection.
 *
 * ---------------------------------------------------------------------------------------------------------------
 * Quest gate
 * ---------------------------------------------------------------------------------------------------------------
 * options.quests is {applicationId: {questId, name, enrolled, completed}}, computed by index.tsx from QuestStore.
 * Attempts only run while the quest for this application is enrolled and not completed. Nothing is hooked while the
 * gate is closed or when no recipe (a guessed one included) exists for this application. Injecting the script again (index.tsx does that
 * whenever quest data or settings change) updates the running runner's recipes and quest status in place.
 *
 * ---------------------------------------------------------------------------------------------------------------
 * Behaviour in the frame
 * ---------------------------------------------------------------------------------------------------------------
 *   - Waits for window.pc.app (or window.app), then wraps the app instance's own `fire` (EventHandler.prototype is
 *     not patched). The wrapper sees triggers, the goal and, during a suppression window, drops matching events.
 *   - A trigger schedules one attempt per trigger name through setTimeout(delay_ms). The slot of a trigger name is
 *     only used up when an attempt really runs, so attempts are bounded by the number of trigger names and a closed
 *     gate or a missing recipe does not waste them. Events fired by the attempt itself never schedule attempts.
 *   - An attempt opens the suppression window (it also wraps window.arise.postMessage and restores it afterwards),
 *     fires the entries in order and stops at the first one after which the goal event was seen. Success marks the
 *     frame done, shows a small toast and logs to the console. Failure is logged and the next trigger retries.
 *   - If the game fires the goal on its own the frame is marked done and nothing is fired.
 *   - Every entry point is wrapped so nothing is thrown into the game; problems go to the log.
 *
 * ---------------------------------------------------------------------------------------------------------------
 * API (window.__adventurerCompletion, installed immediately, read-only apart from the internal update hook)
 * ---------------------------------------------------------------------------------------------------------------
 *   status(): CompletionStatus   plain snapshot: application id, scene names, hooked, picked recipe (with its origin),
 *                                the guessed recipe and graph connection, quest gate, attempts, the origin of the last
 *                                attempt, done, suppression window, dropped count and the last log lines
 *   update(config)               not enumerable, used by a repeated injection of this script only
 * A postMessage {__adventurerOverlay: true, type: "completion", enabled} from the parent window switches the runner
 * on or off without reloading the frame (see buildCompletionMessage).
 *
 * Source layout: the page code lives in one String.raw constant (GLUE_SRC) so there is exactly one copy, esbuild
 * cannot rename anything inside it, and completion.test.mjs executes the very string that is injected. Rules for
 * editing it: no backticks, no dollar-brace sequences, no em-dashes. Backslashes are literal.
 *
 * This file only uses erasable TypeScript syntax so node can import it directly for the tests.
 */

export interface CompletionQuestStatus {
    questId: string;
    name: string;
    enrolled: boolean;
    completed: boolean;
}

export interface CompletionEntry {
    name: string;
    scope?: "app" | "entity";
    entity?: string | null;
    guid?: string | null;
    args?: unknown[];
    delay_ms?: number;
    repeat_for?: string;
    source?: string;
}

export interface CompletionRecipe {
    version?: number;
    goal: string;
    triggers: string[];
    entries: CompletionEntry[];
    suppress?: string[];
    delay_ms?: number;
    entry_delay_ms?: number;
    repeat_for?: string;
    notes?: string;
    source?: "recorded" | "guessed" | "edited" | "bundled";
}

/** A Workbench profile (or a bundled one). Only the fields below are read, a profile without `completion` is ignored. */
export interface CompletionProfile {
    application_id?: string;
    scene: string;
    name?: string;
    completion?: CompletionRecipe;
}

export interface CompletionOptions {
    /** Bundled profiles (experiences/recipes.json). Entries that are not valid recipes are ignored in the frame. */
    recipes: unknown[];
    /** Quest status per application id (see the quest gate above). */
    quests: Record<string, CompletionQuestStatus>;
    /** Whether automatic completion hooks are active on startup (defaults to true). */
    enabled?: boolean;
}

export interface CompletionStatus {
    appId: string;
    scene: string[];
    ready: boolean;
    hooked: boolean;
    enabled: boolean;
    recipe: {
        name: string;
        scene: string;
        origin: "local" | "bundled" | "guessed";
        source: string;
        goal: string;
        triggers: string[];
        entries: { name: string; scope: string; source: string; }[];
        suppress: string[];
        delayMs: number;
        notes: string;
    } | null;
    recipes: { local: number; bundled: number; forApp: number; };
    guessed: {
        /** "connected": the event graph is there, "waiting": still looking for it, "missing": it never appeared */
        graph: "waiting" | "connected" | "missing";
        /** a guessed recipe with at least one usable entry exists for the current graph scene */
        available: boolean;
        scene: string;
        goal: string;
        triggers: string[];
        entries: string[];
        /** attempts made with guessed recipes so far */
        attempts: number;
    };
    invalid: string[];
    gate: { open: boolean; reason: string; quest: CompletionQuestStatus | null; };
    attempts: number;
    /** origin of the recipe the last attempt used, "" before the first attempt */
    attemptOrigin: "" | "local" | "bundled" | "guessed";
    used: string[];
    done: boolean;
    doneBy: string;
    windowOpen: boolean;
    dropped: number;
    log: string[];
}

export interface AdventurerCompletionApi {
    status(): CompletionStatus;
}

/** Message tag shared with the existing Adventurer game overlay. */
export const COMPLETION_MESSAGE_TAG = "__adventurerOverlay";

/** Injected and on-demand execution message types */
export const COMPLETION_INJECT_TYPE = "completion_inject";
export const ADVENTURER_INJECT_RECIPE_TYPE = "ADVENTURER_INJECT_RECIPE";
export const ADVENTURER_EXECUTE_RECIPE_TYPE = "ADVENTURER_EXECUTE_RECIPE";
export const ADVENTURER_RECIPE_EXECUTION_COMPLETED = "ADVENTURER_RECIPE_EXECUTION_COMPLETED";

/** Token that native.ts replaces with the JSON array of the profiles saved for the frame's application. */
export const PROFILES_PLACEHOLDER = "__ADVENTURER_PROFILES__";

/** postMessage payload that switches an already injected runner on or off. */
export function buildCompletionMessage(enabled: boolean) {
    return { [COMPLETION_MESSAGE_TAG]: true, type: "completion" as const, enabled: !!enabled };
}

/** postMessage payload that injects a recipe into the running runner. */
export function buildInjectRecipeMessage(recipe: unknown, execute: boolean = false) {
    return { [COMPLETION_MESSAGE_TAG]: true, type: ADVENTURER_INJECT_RECIPE_TYPE, recipe, execute: !!execute };
}

/** postMessage payload that immediately executes a recipe on the active PlayCanvas application. */
export function buildExecuteRecipeMessage(recipe: unknown) {
    return { [COMPLETION_MESSAGE_TAG]: true, type: ADVENTURER_EXECUTE_RECIPE_TYPE, recipe, execute: true };
}

/** Resolves recipe precedence: local exact > bundled exact > local * > bundled * > guessed. */
export function resolvePrecedence(
    localRecipes: any[],
    bundledRecipes: any[],
    guessedRecipe: any | null,
    scene: string
): { origin: "local" | "bundled" | "guessed"; recipe: any } | null {
    const localExact = (localRecipes || []).find(r => r && r.scene === scene);
    if (localExact) return { origin: "local", recipe: localExact };

    const bundledExact = (bundledRecipes || []).find(r => r && r.scene === scene);
    if (bundledExact) return { origin: "bundled", recipe: bundledExact };

    const localWildcard = (localRecipes || []).find(r => r && r.scene === "*");
    if (localWildcard) return { origin: "local", recipe: localWildcard };

    const bundledWildcard = (bundledRecipes || []).find(r => r && r.scene === "*");
    if (bundledWildcard) return { origin: "bundled", recipe: bundledWildcard };

    if (guessedRecipe && (!guessedRecipe.scene || guessedRecipe.scene === scene || guessedRecipe.scene === "*")) {
        return { origin: "guessed", recipe: guessedRecipe };
    } else if (guessedRecipe && !scene) {
        return { origin: "guessed", recipe: guessedRecipe };
    }

    return null;
}

// The placeholder is read once, through this expression. The token is only a variable name until native.ts swaps it
// for an array literal, so an older native module that does not replace it simply yields no local profiles.
const LOCAL_PROFILES_EXPR = "(function () { try { return " + PROFILES_PLACEHOLDER + "; } catch (e) { return []; } })()";

// ---------------------------------------------------------------------------
// GLUE_SRC: everything that runs in the frame. CONFIG ({recipes, quests, local}) is declared by buildCompletionScript.
// ---------------------------------------------------------------------------
export const GLUE_SRC: string = String.raw`
var TAG = "__adventurerOverlay";
var LOG = "[Adventurer] Completion: ";
var POLL_MS = 250, MAX_POLLS = 240;          // wait for the PlayCanvas app for about a minute
var GRAPH_POLL_MS = 500, MAX_GRAPH_POLLS = 240;   // wait for the event graph for about two minutes
var MAX_GUESSED_ATTEMPTS = 6;                 // attempts with guessed recipes per frame (two triggers, three distinct guesses)
var WINDOW_MS = 3000;                         // suppression window after an attempt
var TOAST_MS = 4000;
var MAX_LOG = 100, MAX_ENTITIES = 20000, MAX_DELAY_MS = 10000, MAX_DEPTH = 4;
var ENTITY_PREFIX = "@entity:";
var ALWAYS_SUPPRESS = ["leaderboard"];
var LABEL_KEYS = ["type", "kind", "event", "name", "action", "cmd", "command", "method", "topic"];
var NEST_KEYS = ["payload", "data", "body", "params"];

// A second injection (quest data or settings changed) only updates the running runner.
if (window.__adventurerCompletion) {
    window.__adventurerCompletion.update(CONFIG);
    return;
}

function hasOwn(o, k) { return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k); }
function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function msgOf(e) { return e && e.message ? String(e.message) : String(e); }

function appIdFromHost() {
    var host = "";
    try { host = String((window.location && window.location.hostname) || ""); } catch (e) { host = ""; }
    var label = host.split(".")[0];
    return /^\d+$/.test(label) ? label : "";
}

var S = {
    appId: appIdFromHost(),
    app: null,
    enabled: true,
    hooked: false,
    bundled: [], local: [], quests: Object.create(null), invalid: [],
    watch: Object.create(null),     // trigger names of every recipe for this application
    goals: Object.create(null),     // goal names of every recipe for this application
    recipeSig: "",
    guessed: null,                  // the normalized guessed recipe of the event graph, or null
    graph: null, graphPolls: 0, graphTimer: false,
    guessedAttempts: 0, attemptOrigin: "", lastPick: "",
    used: Object.create(null),      // trigger names whose attempt already ran (for the current recipe)
    pending: Object.create(null),   // trigger names with a scheduled attempt
    pendingExecution: null,         // recipe queued for immediate execution when app becomes ready
    attempts: 0,
    attempting: false, goalSeen: false,
    done: false, doneBy: "",
    windowOpen: false, windowToken: 0, suppress: [], goal: "",
    pm: null, dropped: 0,
    lastGate: "", configSig: "", once: Object.create(null),
    log: []
};

function note(text, level) {
    S.log.push(text);
    if (S.log.length > MAX_LOG) S.log.shift();
    if (level === "info") console.info(LOG + text);
    else if (level === "warn") console.warn(LOG + text);
}

function noteOnce(key, text, level) {
    if (S.once[key]) return;
    S.once[key] = true;
    note(text, level);
}

// Every entry point the game or a timer can reach goes through this, so nothing is ever thrown into the game.
function guarded(label, fn) {
    return function () {
        try {
            return fn.apply(this, arguments);
        } catch (e) {
            note(label + " failed: " + msgOf(e), "warn");
        }
    };
}

// ---- recipes ------------------------------------------------------------------------------------------------------
function hasEntityRef(v, depth) {
    if (typeof v === "string") return v.indexOf(ENTITY_PREFIX) === 0;
    if (v === null || typeof v !== "object" || depth >= MAX_DEPTH) return false;
    var keys = Object.keys(v);
    for (var i = 0; i < keys.length; i++) if (hasEntityRef(v[keys[i]], depth + 1)) return true;
    return false;
}

function normalizeEntry(e) {
    if (!isObj(e)) return { reason: "an entry is not an object" };
    if (typeof e.name !== "string" || !e.name) return { reason: "an entry has no name" };
    var scope = e.scope === undefined || e.scope === null ? "app" : e.scope;
    if (scope !== "app" && scope !== "entity") return { reason: "entry " + e.name + " has unknown scope " + String(scope) };
    var entity = typeof e.entity === "string" ? e.entity : "";
    var guid = typeof e.guid === "string" ? e.guid : "";
    var repeatFor = typeof e.repeat_for === "string" ? e.repeat_for.trim() : "";
    if (scope === "entity" && !entity && !guid && !repeatFor) return { reason: "entity entry " + e.name + " has no entity name, guid or repeat_for" };
    var args = e.args === undefined || e.args === null ? [] : e.args;
    if (!Array.isArray(args)) return { reason: "entry " + e.name + " args is not a list" };
    var delay = Number(e.delay_ms);
    var delayMs = isFinite(delay) && delay > 0 ? Math.min(delay, MAX_DELAY_MS) : 0;
    return {
        entry: {
            name: e.name, scope: scope, entity: entity, guid: guid, args: args,
            delayMs: delayMs, repeatFor: repeatFor,
            source: typeof e.source === "string" ? e.source : "",
            needsIndex: scope === "entity" || hasEntityRef(args, 0) || !!repeatFor
        }
    };
}

// null: not a recipe at all (no completion field). { reason }: a recipe that cannot be used. { recipe }: usable.
function normalizeProfile(p, origin) {
    if (!isObj(p) || !isObj(p.completion)) return null;
    var c = p.completion;
    var sceneVal = typeof p.scene === "string" ? p.scene : "";
    if (!sceneVal && p.format === "advrecipe") sceneVal = "*";
    var label = (typeof p.name === "string" && p.name ? p.name : String(sceneVal)) + " (" + origin + ")";
    if (!sceneVal) return { reason: label + ": missing scene" };
    // Saved profiles are already filtered by application id (file name), so a missing id means "this application".
    var appId = typeof p.application_id === "string" ? p.application_id : "";
    if (!appId && origin !== "local") return { reason: label + ": missing application_id" };
    var version = c.version === undefined ? 1 : Number(c.version);
    if (version !== 1) return { reason: label + ": unsupported completion version " + String(c.version) };
    if (typeof c.goal !== "string" || !c.goal) return { reason: label + ": missing goal" };
    var triggers = [];
    (Array.isArray(c.triggers) ? c.triggers : []).forEach(function (t) {
        if (typeof t === "string" && t && triggers.indexOf(t) < 0) triggers.push(t);
    });
    if (!triggers.length) return { reason: label + ": no triggers" };
    var entries = [];
    var problems = [];
    (Array.isArray(c.entries) ? c.entries : []).forEach(function (e) {
        var r = normalizeEntry(e);
        if (r.entry) entries.push(r.entry); else problems.push(r.reason);
    });
    if (!entries.length) return { reason: label + ": no usable entries" + (problems.length ? " (" + problems.join("; ") + ")" : "") };
    var suppress = ALWAYS_SUPPRESS.slice();
    (Array.isArray(c.suppress) ? c.suppress : []).forEach(function (s) {
        var v = typeof s === "string" ? s.trim().toLowerCase() : "";
        if (v && suppress.indexOf(v) < 0) suppress.push(v);
    });
    var delay = Number(c.delay_ms);
    var delayMs = isFinite(delay) && delay > 0 ? Math.min(delay, MAX_DELAY_MS) : 0;
    var repeatFor = typeof c.repeat_for === "string" ? c.repeat_for.trim() : "";
    var entryDelay = Number(c.entry_delay_ms);
    var entryDelayMs = isFinite(entryDelay) && entryDelay > 0 ? Math.min(entryDelay, MAX_DELAY_MS) : 0;
    var recipe = {
        origin: origin, appId: appId, scene: sceneVal, name: typeof p.name === "string" ? p.name : "",
        goal: c.goal, triggers: triggers, entries: entries, suppress: suppress, delayMs: delayMs,
        repeatFor: repeatFor, entryDelayMs: entryDelayMs,
        notes: typeof c.notes === "string" ? c.notes : "", source: typeof c.source === "string" ? c.source : "",
        problems: problems
    };
    recipe.sig = JSON.stringify([origin, appId, p.scene, c.goal, triggers, entries, suppress, delayMs, repeatFor, entryDelayMs]);
    return { recipe: recipe };
}

function normalizeInjectedRecipe(raw) {
    if (!isObj(raw)) return { reason: "recipe is not an object" };
    var p = raw;
    if (!raw.completion && raw.goal && Array.isArray(raw.entries)) {
        p = {
            application_id: S.appId || "",
            scene: (sceneNames(S.app)[0]) || "*",
            name: raw.name || "Injected Recipe",
            completion: raw
        };
    } else if (raw.format === "advrecipe" && isObj(raw.completion)) {
        p = {
            application_id: raw.application_id || S.appId || "",
            scene: raw.scene || "*",
            name: raw.name || "Injected Recipe",
            completion: raw.completion
        };
    }
    if (p && isObj(p.completion)) {
        var c = p.completion;
        if (!Array.isArray(c.triggers) || !c.triggers.length) {
            c.triggers = ["select:play", "execute:direct"];
        }
    }
    return normalizeProfile(p, "local");
}

function loadProfiles(list, origin) {
    var out = [];
    if (!Array.isArray(list)) return out;
    list.forEach(function (p) {
        var r = normalizeProfile(p, origin);
        if (!r) return;
        if (r.reason) S.invalid.push(r.reason); else out.push(r.recipe);
    });
    return out;
}

function normalizeQuests(q) {
    var out = Object.create(null);
    if (!isObj(q)) return out;
    Object.keys(q).forEach(function (appId) {
        var s = q[appId];
        if (!isObj(s)) return;
        out[appId] = {
            questId: s.questId === undefined || s.questId === null ? "" : String(s.questId),
            name: s.name === undefined || s.name === null ? "" : String(s.name),
            enrolled: !!s.enrolled,
            completed: !!s.completed
        };
    });
    return out;
}

function applyConfig(cfg) {
    S.invalid = [];
    S.bundled = loadProfiles(cfg && cfg.recipes, "bundled");
    S.local = loadProfiles(cfg && cfg.local, "local");
    S.quests = normalizeQuests(cfg && cfg.quests);
    S.enabled = cfg && typeof cfg.enabled === "boolean" ? cfg.enabled : true;
    S.invalid.forEach(function (reason) { noteOnce("invalid:" + reason, "ignored recipe: " + reason, "warn"); });
}

function recipesForApp() {
    if (!S.appId) return [];
    return S.local.concat(S.bundled).filter(function (r) { return !r.appId || r.appId === S.appId; });
}

// Every recipe the runner may pick for this application, the guessed one included (what is watched and hooked for).
function candidateRecipes() {
    var list = recipesForApp();
    if (S.guessed && S.appId) list = list.concat([S.guessed]);
    if (!list.length && S.app && S.appId) {
        var dynQm = detectDynamicQuestManagerRecipe(S.app, sceneNames(S.app));
        if (dynQm) list = [dynQm];
    }
    return list;
}

function sceneNames(app) {
    var names = [];
    function add(n) { if (typeof n === "string" && n && names.indexOf(n) < 0) names.push(n); }
    if (!app) return names;
    try {
        if (app.scene) add(app.scene.name);
        var list = app.scenes && typeof app.scenes.list === "function" ? app.scenes.list() : null;
        if (Array.isArray(list)) list.forEach(function (s) { add(s && s.name); });
    } catch (e) {
        noteOnce("scene", "scene name unreadable: " + msgOf(e));
    }
    return names;
}

// Exact scene beats "*", a local recipe beats a bundled one of the same specificity, earlier beats later. A guessed
// recipe only fills the gap: it is picked when no local or bundled recipe matches, and only for its own scene.
function matchedRecipe(names) {
    var best = null, bestRank = -1;
    recipesForApp().forEach(function (r) {
        var spec = r.scene === "*" ? 0 : (names.indexOf(r.scene) >= 0 ? 1 : -1);
        if (spec < 0) return;
        var rank = spec * 2 + (r.origin === "local" ? 1 : 0);
        if (rank > bestRank) { best = r; bestRank = rank; }
    });
    return best;
}

function detectDynamicCollectibleRecipe(app, sceneNames) {
    if (!app || !app.root || !S.appId) return null;
    var scene = sceneNames && sceneNames.length ? sceneNames[0] : "";
    var stack = [app.root];
    var collectibles = [];
    while (stack.length && collectibles.length < MAX_ENTITIES) {
        var e = stack.pop();
        if (!e) continue;
        if (e !== app.root) {
            var nm = (e.name || "").toLowerCase();
            var isCollect = /collectable|sticker|crystal|pickup|item/i.test(nm);
            if (!isCollect && e.script) {
                isCollect = !!(e.script.inspectionObject || e.script.collectable || e.script.collectible || e.script.sendEventOnClickCollider);
            }
            if (isCollect && e.name) collectibles.push(e);
        }
        var ch = e.children || [];
        for (var i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
    }
    if (collectibles.length < 2) return null;

    var names = collectibles.map(function (c) { return c.name; });
    var prefix = names[0];
    for (var n = 1; n < names.length; n++) {
        while (prefix.length && names[n].indexOf(prefix) !== 0) {
            prefix = prefix.slice(0, prefix.length - 1);
        }
    }
    var pattern = prefix.length >= 4 ? prefix + "*" : "Collectable_*";

    var callbacks = app._callbacks || (app._l || {});
    var evKeys = [];
    if (callbacks) {
        if (typeof callbacks.forEach === "function") {
            callbacks.forEach(function (v, k) { if (typeof k === "string") evKeys.push(k); });
        } else if (typeof callbacks.keys === "function") {
            evKeys = Array.from(callbacks.keys());
        } else {
            evKeys = Object.keys(callbacks);
        }
    }
    var inspectEv = evKeys.find(function (k) { return /^inspect:item/i.test(k); }) || "inspect:item";
    var takeEv = evKeys.find(function (k) { return /button:.*:take|take:item|collect/i.test(k); }) ||
                 evKeys.find(function (k) { return /take/i.test(k); }) ||
                 (pattern.toLowerCase().indexOf("sticker") >= 0 ? "button:sticker:take" : null);
    if (!takeEv) return null;

    var completeEv = evKeys.find(function (k) { return /button:.*:complete|finish.*inspect|uiClose/i.test(k); }) ||
                     (pattern.toLowerCase().indexOf("sticker") >= 0 ? "button:sticker:complete" : null);

    var entries = [
        { name: inspectEv, scope: "app", args: ["@entity:this"], source: "guessed" },
        { name: takeEv, scope: "app", args: [], source: "guessed" }
    ];
    if (completeEv) {
        entries.push({ name: completeEv, scope: "app", args: [], source: "guessed" });
    }

    var triggers = [inspectEv, takeEv];
    var raw = {
        version: 1,
        goal: "quest-completed",
        triggers: triggers,
        repeat_for: pattern,
        entry_delay_ms: 1000,
        entries: entries,
        suppress: ["leaderboard"],
        delay_ms: 0,
        notes: "Dynamic collectible heuristic from scene entities (" + collectibles.length + " items matching " + pattern + ")",
        source: "guessed"
    };

    var norm = normalizeProfile({
        application_id: S.appId,
        scene: scene,
        name: "Dynamic Collectible",
        completion: raw
    }, "guessed");

    if (norm && norm.recipe) {
        noteOnce("dynamic_collectible", "synthesized dynamic recipe for " + collectibles.length + " collectible items: " + pattern, "info");
        return norm.recipe;
    }
    return null;
}

function detectDynamicQuestManagerRecipe(app, names) {
    if (!app || !app.root || !S.appId) return null;
    var qm = findQuestManagers(app);
    if (!qm.bq && !qm.dqm && !qm.generic) return null;
    var scene = names && names.length ? names[0] : "*";
    var triggers = ["select:play", "shot:fire", "drone:tension", "intro:done", "start", "play", "quest:manager"];
    try {
        var cb = app._callbacks || app._l;
        var keys = cb ? (typeof cb.keys === "function" ? Array.from(cb.keys()) : Object.keys(cb)) : [];
        for (var i = 0; i < keys.length && triggers.length < 16; i++) {
            var k = keys[i];
            if (typeof k === "string" && /start|play|intro|begin|shift|tension/i.test(k) && triggers.indexOf(k) < 0) {
                triggers.push(k);
            }
        }
    } catch (e) {}
    var norm = normalizeProfile({
        application_id: S.appId,
        scene: scene || "*",
        name: "Dynamic Quest Manager",
        completion: {
            version: 1,
            goal: "quest-completed",
            triggers: triggers,
            entries: [{ name: "quest:manager", scope: "app", source: "guessed" }],
            suppress: ["leaderboard"],
            delay_ms: 0,
            notes: "Dynamic quest-manager heuristic from scene scripts",
            source: "guessed"
        }
    }, "guessed");
    if (norm && norm.recipe) {
        noteOnce("dynamic_qm", "synthesized dynamic recipe for PlayCanvas quest manager script", "info");
        return norm.recipe;
    }
    return null;
}

function currentRecipe() {
    var names = sceneNames(S.app);
    var best = matchedRecipe(names);
    if (best) return best;
    if (S.guessed && S.appId && names.indexOf(S.guessed.scene) >= 0) return S.guessed;
    return detectDynamicCollectibleRecipe(S.app, names) || detectDynamicQuestManagerRecipe(S.app, names);
}

function gate() {
    if (!S.appId) return { open: false, reason: "this frame is not an application host", quest: null };
    var q = S.quests[S.appId];
    if (!q) return { open: false, reason: "no quest known for application " + S.appId, quest: null };
    if (!q.enrolled) return { open: false, reason: "quest " + q.questId + " is not enrolled", quest: q };
    if (q.completed) return { open: false, reason: "quest " + q.questId + " is already completed", quest: q };
    return { open: true, reason: "", quest: q };
}

function noteGate(reason) {
    if (S.lastGate === reason) return;
    S.lastGate = reason;
    note("no attempt: " + reason);
}

// ---- guessed recipes (event graph) --------------------------------------------------------------------------------
function describeRecipe(r) {
    return "goal " + r.goal + "; triggers " + r.triggers.join(", ") + "; entries " + r.entries.map(function (e) { return e.name; }).join(", ");
}

// Reads the graph's current guess (usable entries only) and makes it the fallback recipe. Runs on connect and on every
// onChange of the graph, and only changes anything when the guess differs from the one held.
function readGuess() {
    var g = S.graph;
    if (!g) return;
    var raw = null, full = null, scene = "";
    try {
        var st = g.state();
        scene = st && typeof st.scene === "string" ? st.scene : "";
        raw = g.guessedRecipe({ usableOnly: true });
        if (!raw) full = g.guessedRecipe();
    } catch (e) {
        noteOnce("graphread", "could not read the guessed recipe: " + msgOf(e), "warn");
        raw = null;
    }
    var next = null;
    if (raw && scene && S.appId) {
        var r = normalizeProfile({ application_id: S.appId, scene: scene, name: "Guessed from the scripts", completion: raw }, "guessed");
        if (r && r.recipe) next = r.recipe;
        else if (r) noteOnce("badguess:" + r.reason, "ignored guessed recipe: " + r.reason, "warn");
    } else if (full && Array.isArray(full.entries) && full.entries.length) {
        noteOnce("unusable:" + String(full.goal) + ":" + full.entries.length, "a guessed recipe for " + String(full.goal) +
            " exists but none of its entries is known to run the state the goal path needs, not used", "info");
    }
    var before = S.guessed ? S.guessed.sig : "";
    if ((next ? next.sig : "") === before) return;
    S.guessed = next;
    if (next) note("guessed recipe from the scripts (scene " + next.scene + "): " + describeRecipe(next) + "; used only while no local or bundled recipe applies", "info");
    else note("the guessed recipe was withdrawn");
    reconcile();
}

function findGraph() {
    var g = null;
    try { g = window.__adventurerGraph || null; } catch (e) { g = null; }
    return g && typeof g.state === "function" && typeof g.guessedRecipe === "function" && typeof g.onChange === "function" ? g : null;
}

// A guess can only be picked while the frame has its app, the quest gate is open and no local or bundled recipe covers
// the scene. Only then is it worth waiting for the graph.
function needsGraph() {
    return !!S.app && !!S.appId && gate().open && !matchedRecipe(sceneNames(S.app));
}

// Finds window.__adventurerGraph, subscribes to its changes and reads the first guess. The graph is injected before this
// runner, but a frame may run the two apart, so it polls for a while when the graph is not there yet and a guess could
// be used. Without that need no timer is queued (reconcile asks again whenever something relevant changed).
function connectGraph() {
    S.graphTimer = false;
    if (S.graph) return;
    var g = findGraph();
    if (g) {
        S.graph = g;
        try { g.onChange(guarded("graph change", readGuess)); } catch (e) { note("could not subscribe to the event graph: " + msgOf(e), "warn"); }
        note("event graph found, watching it for a guessed recipe", "info");
        readGuess();
        return;
    }
    if (!needsGraph()) return;
    S.graphPolls++;
    if (S.graphPolls > MAX_GRAPH_POLLS) {
        noteOnce("nograph", "no event graph found after about two minutes, guessed recipes are not available", "info");
        return;
    }
    S.graphTimer = true;
    setTimeout(guarded("graph poll", connectGraph), GRAPH_POLL_MS);
}

// Called by reconcile: connects to the graph when it is there, starts waiting for it when a guess would be used. A
// repeated injection (which may have added the graph) starts the waiting again after it had given up.
function watchGraph() {
    if (S.graph || S.graphTimer) return;
    S.graphPolls = 0;
    connectGraph();
}

// ---- suppression window -------------------------------------------------------------------------------------------
function findMatch(texts, patterns) {
    for (var i = 0; i < texts.length; i++) {
        var low = String(texts[i]).toLowerCase();
        for (var j = 0; j < patterns.length; j++) if (low.indexOf(patterns[j]) >= 0) return texts[i];
    }
    return "";
}

function messageLabels(m, depth) {
    var out = [];
    if (typeof m === "string") {
        if (m.charAt(0) !== "{") { out.push(m); return out; }
        var parsed = null;
        try { parsed = JSON.parse(m); } catch (e) { parsed = null; }   // not JSON, so it carries no type
        return isObj(parsed) ? messageLabels(parsed, depth) : out;
    }
    if (!isObj(m)) return out;
    LABEL_KEYS.forEach(function (k) { if (typeof m[k] === "string") out.push(m[k]); });
    if (depth < 1) NEST_KEYS.forEach(function (k) { if (isObj(m[k])) out = out.concat(messageLabels(m[k], depth + 1)); });
    return out;
}

function patchPostMessage() {
    var arise = null;
    try { arise = window.arise; } catch (e) { arise = null; }
    if (!arise || typeof arise.postMessage !== "function") {
        noteOnce("noarise", "window.arise.postMessage not found, only app events are filtered");
        return;
    }
    if (S.pm && S.pm.target === arise && arise.postMessage === S.pm.wrapper) return;
    restorePostMessage();
    var orig = arise.postMessage;
    var hadOwn = hasOwn(arise, "postMessage");
    var wrapper = function (message) {
        try {
            var isComp = false;
            if (typeof message === "string" && message.indexOf("quest-completed") >= 0) isComp = true;
            else if (isObj(message) && (message.type === "quest-completed" || message.event === "quest-completed" || message.cmd === "quest-completed")) isComp = true;
            if (isComp) goalSighting();
        } catch (e) { }
        var hit = "";
        try { if (S.windowOpen) hit = findMatch(messageLabels(message, 0), S.suppress); } catch (e) { note("message filter failed: " + msgOf(e), "warn"); }
        if (hit) {
            S.dropped++;
            note("dropped bridge message " + hit);
            return undefined;
        }
        return orig.apply(this, arguments);
    };
    try { arise.postMessage = wrapper; } catch (e) { note("could not wrap arise.postMessage: " + msgOf(e), "warn"); }
    if (arise.postMessage !== wrapper) return;
    S.pm = { target: arise, orig: orig, hadOwn: hadOwn, wrapper: wrapper };
}

function restorePostMessage() {
    var pm = S.pm;
    if (!pm) return;
    S.pm = null;
    try {
        if (pm.target.postMessage !== pm.wrapper) {
            note("arise.postMessage was replaced during the window, left as it is");
            return;
        }
        if (pm.hadOwn) pm.target.postMessage = pm.orig; else delete pm.target.postMessage;
    } catch (e) {
        note("could not restore arise.postMessage: " + msgOf(e), "warn");
    }
}

function openWindow(recipe) {
    S.windowToken++;
    S.windowOpen = true;
    S.suppress = recipe.suppress;
    S.goal = recipe.goal;
    if (recipe && recipe.goal) {
        S.goals[recipe.goal] = true;
    }
    patchPostMessage();
}

function closeWindow() {
    S.windowOpen = false;
    restorePostMessage();
    note("suppression window closed, " + S.dropped + " dropped in total");
}

// A newer attempt bumps the token, so only the last window's timer closes it.
function armWindowClose() {
    var token = S.windowToken;
    setTimeout(guarded("window close", function () { if (token === S.windowToken && S.windowOpen) closeWindow(); }), WINDOW_MS);
}

// ---- toast ----------------------------------------------------------------------------------------------------------
function toast(text) {
    try {
        var host = document.body || document.documentElement;
        if (!host) return;
        var el = document.createElement("div");
        el.textContent = text;
        el.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;" +
            "font:12px/1.3 sans-serif;color:#fff;background:rgba(15,16,18,.82);border:1px solid rgba(255,255,255,.18);" +
            "border-radius:6px;padding:6px 10px;pointer-events:none;user-select:none";
        host.appendChild(el);
        setTimeout(guarded("toast removal", function () { if (el.parentNode) el.parentNode.removeChild(el); }), TOAST_MS);
    } catch (e) {
        note("toast failed: " + msgOf(e), "warn");
    }
}

// ---- entities ---------------------------------------------------------------------------------------------------
function entityIndex(app) {
    var byGuid = Object.create(null), byName = Object.create(null);
    var root = null;
    try { root = app && app.root; } catch (e) { note("scene root unreadable: " + msgOf(e), "warn"); }
    if (!root) return { byGuid: byGuid, byName: byName };
    var stack = [root], visited = new Set(), skipped = 0;
    while (stack.length && visited.size < MAX_ENTITIES) {
        var e = stack.pop();
        if (!e || visited.has(e)) continue;
        visited.add(e);
        try {
            var guid = typeof e.getGuid === "function" ? e.getGuid() : null;
            if (typeof guid === "string" && guid && !byGuid[guid]) byGuid[guid] = e;
            if (typeof e.name === "string" && e.name && !byName[e.name]) byName[e.name] = e;
            var kids = e.children || [];
            for (var i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        } catch (err) {
            skipped++;
        }
    }
    if (skipped) note(skipped + " entities could not be read while indexing");
    return { byGuid: byGuid, byName: byName };
}

function findMatchingEntities(app, pattern) {
    if (!app || !pattern) return [];
    var root = null;
    try { root = app.root; } catch (e) { return []; }
    if (!root) return [];
    var all = [];
    var stack = [root], visited = new Set();
    while (stack.length && visited.size < MAX_ENTITIES) {
        var e = stack.pop();
        if (!e || visited.has(e)) continue;
        visited.add(e);
        all.push(e);
        try {
            var kids = e.children || [];
            for (var i = kids.length - 1; i >= 0; i--) {
                var kid = kids[i];
                if (kid && !visited.has(kid)) stack.push(kid);
            }
        } catch (err) {}
    }
    var matched = [];
    if (pattern.indexOf("@tag:") === 0) {
        var tag = pattern.slice(5).trim().toLowerCase();
        matched = all.filter(function (e) {
            return e && e.enabled !== false && e.tags && typeof e.tags.has === "function" && e.tags.has(tag);
        });
    } else {
        var parts = pattern.split("*");
        var escaped = [];
        for (var p = 0; p < parts.length; p++) {
            var s = parts[p], out = "";
            for (var c = 0; c < s.length; c++) {
                var ch = s.charAt(c);
                if (".+*?^()[]{}|\\$".indexOf(ch) >= 0) out += "\\" + ch;
                else out += ch;
            }
            escaped.push(out);
        }
        var re = new RegExp("^" + escaped.join(".*") + "$", "i");
        matched = all.filter(function (e) {
            return e && e.enabled !== false && typeof e.name === "string" && re.test(e.name);
        });
    }
    matched.sort(function (a, b) {
        var na = String(a.name || ""), nb = String(b.name || "");
        return na.localeCompare(nb, undefined, { numeric: true, sensitivity: "base" });
    });
    return matched;
}

function decodeArg(v, index, state, depth, curEntity) {
    if (typeof v === "string" && (v === "@entity" || v.indexOf(ENTITY_PREFIX) === 0)) {
        var target = v === "@entity" ? "" : v.slice(ENTITY_PREFIX.length);
        if (!target || target === "current" || target === "this") {
            if (curEntity) return curEntity;
        }
        var ent = index ? (index.byGuid[target] || index.byName[target]) : null;
        if (!ent && curEntity && (curEntity.name === target || (typeof curEntity.getGuid === "function" && curEntity.getGuid() === target))) {
            ent = curEntity;
        }
        if (!ent) { state.missing = target; return null; }
        return ent;
    }
    if (v === null || typeof v !== "object" || depth >= MAX_DEPTH) return v;
    if (Array.isArray(v)) return v.map(function (x) { return decodeArg(x, index, state, depth + 1, curEntity); });
    var copy = {};
    Object.keys(v).forEach(function (k) { copy[k] = decodeArg(v[k], index, state, depth + 1, curEntity); });
    return copy;
}

// ---- attempts -----------------------------------------------------------------------------------------------------
function refusal(entry, recipe) {
    var name = entry.name.toLowerCase();
    if (name.indexOf("arise:") === 0) return "arise events are the game's own reports";
    if (name === recipe.goal.toLowerCase()) return "it is the goal event";
    if (findMatch([entry.name], recipe.suppress)) return "it matches a suppress pattern";
    return "";
}

// Guessed recipes are tried a bounded number of times, whatever the graph guesses next.
function budgetLeft(recipe) {
    if (recipe.origin !== "guessed" || S.guessedAttempts < MAX_GUESSED_ATTEMPTS) return true;
    noteOnce("guesscap", "no attempt: " + MAX_GUESSED_ATTEMPTS + " attempts with guessed recipes were used", "info");
    return false;
}

function notePick(recipe) {
    var pick = recipe.origin + ":" + recipe.sig;
    if (S.lastPick === pick) return;
    S.lastPick = pick;
    note("using the " + recipe.origin + " recipe" + (recipe.source ? " (source " + recipe.source + ")" : "") + " for scene " + recipe.scene + ": " + describeRecipe(recipe), "info");
}

function slotFree(recipe, trigger) {
    if (S.recipeSig !== recipe.sig) {
        S.recipeSig = recipe.sig;
        S.used = Object.create(null);     // a changed recipe earns fresh attempts
    }
    return !S.used[trigger];
}

function skip(list, text) {
    list.push(text);
    note("skipped entry " + text);
}

function succeed(how) {
    S.done = true;
    S.doneBy = how;
    note("goal fired, quest completion queued (" + how + ")", "info");
    toast("Adventurer: quest completion queued");
}

function runAttempt(trigger) {
    if (S.done || !S.enabled || S.attempting) return;
    var recipe = currentRecipe();
    if (!recipe || recipe.triggers.indexOf(trigger) < 0) {
        noteOnce("norecipe:" + trigger, "no recipe for scene [" + sceneNames(S.app).join(", ") + "], " + trigger + " ignored");
        return;
    }
    var g = gate();
    if (!g.open) { noteGate(g.reason); return; }
    if (!budgetLeft(recipe)) return;
    if (!slotFree(recipe, trigger)) return;
    S.lastGate = "";
    S.used[trigger] = true;
    S.attempts++;
    S.attemptOrigin = recipe.origin;
    if (recipe.origin === "guessed") S.guessedAttempts++;
    notePick(recipe);
    S.attempting = true;
    S.goalSeen = false;
    openWindow(recipe);

    var index = null;
    var tasks = [];

    var getMatching = function(pattern) {
        return findMatchingEntities(S.app, pattern);
    };

    if (recipe.repeatFor) {
        var targets = getMatching(recipe.repeatFor);
        if (!targets.length) {
            note("repeat_for pattern " + recipe.repeatFor + " matched no enabled entities in the scene", "warn");
        }
        for (var t = 0; t < targets.length; t++) {
            for (var e = 0; e < recipe.entries.length; e++) {
                tasks.push({ entry: recipe.entries[e], entity: targets[t] });
            }
        }
    } else {
        for (var e = 0; e < recipe.entries.length; e++) {
            var ent = recipe.entries[e];
            if (ent.repeatFor) {
                var targets = getMatching(ent.repeatFor);
                for (var t = 0; t < targets.length; t++) {
                    tasks.push({ entry: ent, entity: targets[t] });
                }
            } else {
                tasks.push({ entry: ent, entity: null });
            }
        }
    }

    var ran = [], skipped = [], hit = "";

    function finishAttempt() {
        S.attempting = false;
        armWindowClose();
        if (S.goalSeen) {
            succeed("attempt " + S.attempts + " on " + trigger + " via " + (hit || "goal event"));
            return;
        }
        var left = recipe.triggers.filter(function (t) { return !S.used[t]; }).length;
        note("attempt " + S.attempts + " on " + trigger + " did not reach " + recipe.goal + "; ran: " + (ran.join(", ") || "nothing") +
            (skipped.length ? "; skipped: " + skipped.join(", ") : "") + (left ? "; waiting for another trigger" : "; no triggers left"), "info");
    }

    function step(startIndex) {
        var taskIndex = startIndex;
        var syncSteps = 0;
        var MAX_SYNC_STEPS = 100;
        while (taskIndex < tasks.length) {
            if (S.goalSeen) break;
            if (syncSteps >= MAX_SYNC_STEPS) {
                setTimeout(guarded("next entry bounce", function () { step(taskIndex); }), 0);
                return;
            }
            syncSteps++;

            var task = tasks[taskIndex];
            var entry = task.entry;
            var curEntity = task.entity;

            var why = refusal(entry, recipe);
            if (why) {
                skip(skipped, entry.name + " (" + why + ")");
                taskIndex++;
                continue;
            }

            if ((entry.needsIndex || curEntity) && !index) index = entityIndex(S.app);
            var target = S.app;
            if (entry.scope === "entity") {
                if (curEntity) {
                    target = curEntity;
                } else {
                    target = (entry.guid && index.byGuid[entry.guid]) || (entry.entity && index.byName[entry.entity]) || null;
                }
            }
            if (!target || typeof target.fire !== "function") {
                skip(skipped, entry.name + " (entity " + (entry.entity || entry.guid || (curEntity && curEntity.name)) + " not found)");
                taskIndex++;
                continue;
            }

            var state = { missing: "" };
            var args = decodeArg(entry.args, index, state, 0, curEntity);
            if (state.missing) {
                skip(skipped, entry.name + " (entity " + state.missing + " not found)");
                taskIndex++;
                continue;
            }

            try {
                target.fire.apply(target, [entry.name].concat(args));
                ran.push(entry.name);
            } catch (err) {
                ran.push(entry.name + " (threw " + msgOf(err) + ")");
                note("entry " + entry.name + " threw: " + msgOf(err), "warn");
            }

            if (S.goalSeen) hit = entry.name;
            if (S.goalSeen || taskIndex + 1 >= tasks.length) {
                break;
            }

            var delay = entry.delayMs || recipe.entryDelayMs || 0;
            if (delay > 0) {
                setTimeout(guarded("next entry", function () { step(taskIndex + 1); }), delay);
                return;
            }

            taskIndex++;
        }
        if (!S.goalSeen) {
            tryQuestManagerCompletion(S.app, recipe, function (qmHit) {
                if (qmHit) hit = qmHit;
                finishAttempt();
            });
            return;
        }
        finishAttempt();
    }

    step(0);
}

function isGenericQuestScript(inst) {
    if (!inst || typeof inst !== "object") return false;
    try {
        if (typeof inst.reach === "function" && typeof inst.flush === "function") {
            var fs = Function.prototype.toString.call(inst.flush);
            if (fs.indexOf("quest-completed") >= 0 || fs.indexOf("quest-progress") >= 0 || fs.indexOf("arise") >= 0) return true;
        }
        if (typeof inst.completeQuest === "function" || typeof inst.complete === "function") {
            var fn = inst.completeQuest || inst.complete;
            var cs = Function.prototype.toString.call(fn);
            if (cs.indexOf("quest-completed") >= 0 || cs.indexOf("arise") >= 0) return true;
        }
    } catch (e) {}
    return false;
}

function findQuestManagers(app) {
    var result = { bq: null, dqm: null, generic: null };
    if (!app || !app.root) return result;
    try {
        var stack = [app.root];
        var visited = 0;
        while (stack.length && visited < 4096) {
            var node = stack.pop();
            visited++;
            if (!node) continue;
            if (node.script) {
                if (!result.bq && node.script.buleroQuest17) result.bq = node.script.buleroQuest17;
                if (!result.dqm && node.script.discordQuestManager) result.dqm = node.script.discordQuestManager;
                if (!result.bq && !result.dqm && !result.generic) {
                    var keys = Object.keys(node.script);
                    for (var k = 0; k < keys.length; k++) {
                        if (isGenericQuestScript(node.script[keys[k]])) {
                            result.generic = node.script[keys[k]];
                            break;
                        }
                    }
                }
                if (result.bq && result.dqm) break;
            }
            var kids = node.children;
            if (kids && kids.length) {
                for (var i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
            }
        }
    } catch (err) {
        note("quest manager lookup failed: " + msgOf(err), "warn");
    }
    return result;
}

function runBuleroStep(bq, stepNum) {
    if (typeof bq.t === "number" && typeof bq.minGap === "number") {
        bq.lastSend = bq.t - bq.minGap - 0.1;
    }
    if (typeof bq.sentStep === "number" && bq.sentStep >= stepNum) {
        bq.sentStep = stepNum - 1;
    }
    if (stepNum >= 5 && typeof bq.onHook === "function") {
        bq.onHook("shift_completed", {});
    }
    if (!S.goalSeen && typeof bq.reach === "function" && (typeof bq.target !== "number" || bq.target < stepNum)) {
        bq.reach(stepNum, stepNum >= 5 ? "shift_completed" : "step " + stepNum);
    }
    if (!S.goalSeen && typeof bq.flush === "function") {
        if (typeof bq.t === "number" && typeof bq.minGap === "number") {
            bq.lastSend = bq.t - bq.minGap - 0.1;
        }
        bq.flush();
    }
}

function tryQuestManagerCompletion(app, recipe, onDone) {
    var goal = recipe && recipe.goal ? String(recipe.goal) : "";
    if (goal && goal !== "quest-completed" && goal !== "arise:questComplete") {
        onDone("");
        return;
    }
    var qm = findQuestManagers(app);
    var bq = qm.bq || (qm.generic && typeof qm.generic.reach === "function" && typeof qm.generic.flush === "function" ? qm.generic : null);
    if (bq) {
        var maxStep = 5;
        var current = typeof bq.sentStep === "number" && bq.sentStep > 0 && bq.sentStep < maxStep ? bq.sentStep : 1;
        var nextStep = current < maxStep ? current + 1 : maxStep;
        var initialDelay = (typeof bq.t === "number" && typeof bq.lastSend === "number" && (bq.t - bq.lastSend) < 5.5) ? 5500 : 0;

        function dispatchStep(stepNum) {
            if (!S.attempting || S.goalSeen) {
                onDone(S.goalSeen ? "buleroQuest17.shift_completed" : "");
                return;
            }
            try {
                openWindow(recipe);
                runBuleroStep(bq, stepNum);
            } catch (err) {
                note("buleroQuest17 completion failed: " + msgOf(err), "warn");
                onDone("");
                return;
            }
            if (S.goalSeen || stepNum >= maxStep) {
                onDone(S.goalSeen ? "buleroQuest17.shift_completed" : "");
                return;
            }
            setTimeout(guarded("buleroQuest17 next step", function () {
                dispatchStep(stepNum + 1);
            }), 5500);
        }

        if (initialDelay > 0) {
            setTimeout(guarded("buleroQuest17 first step", function () {
                dispatchStep(nextStep);
            }), initialDelay);
        } else {
            dispatchStep(nextStep);
        }
        return;
    }

    var dqm = qm.dqm || (!bq ? qm.generic : null);
    if (dqm) {
        var matched = "";
        try {
            if (typeof dqm.completeQuest === "function") dqm.completeQuest();
            else if (typeof dqm.complete === "function") dqm.complete();
            else if (typeof dqm.sendComplete === "function") dqm.sendComplete();
            if (S.goalSeen) matched = "discordQuestManager";
        } catch (err) {
            note("discordQuestManager completion failed: " + msgOf(err), "warn");
        }
        onDone(matched);
        return;
    }

    onDone("");
}

function executeRecipeDirectly(recipe, source) {
    if (!S.enabled) S.enabled = true;
    if (S.attempting) {
        note("attempt already in progress, queuing direct execution", "warn");
        return;
    }
    if (!S.app) {
        try { S.app = (window.pc && window.pc.app) || window.app || null; } catch (e) { S.app = null; }
    }
    if (!S.app || typeof S.app.fire !== "function") {
        note("PlayCanvas app instance not ready for direct execution, storing pending execution", "warn");
        S.pendingExecution = { recipe: recipe, source: source };
        return;
    }

    S.done = false;
    S.doneBy = "";
    S.goalSeen = false;
    S.attempts++;
    S.attemptOrigin = recipe.origin;
    note("initiating on-demand execution for recipe: " + (recipe.name || recipe.scene) + " (" + source + ")", "info");

    S.attempting = true;
    if (recipe && recipe.goal) {
        S.goals[recipe.goal] = true;
    }
    openWindow(recipe);
    ensureHook(true);

    var index = null;
    var tasks = [];

    var getMatching = function (pattern) {
        return findMatchingEntities(S.app, pattern);
    };

    if (recipe.repeatFor) {
        var targets = getMatching(recipe.repeatFor);
        if (!targets.length) {
            note("repeat_for pattern " + recipe.repeatFor + " matched no enabled entities in the scene", "warn");
        }
        for (var t = 0; t < targets.length; t++) {
            for (var e = 0; e < recipe.entries.length; e++) {
                tasks.push({ entry: recipe.entries[e], entity: targets[t] });
            }
        }
    } else {
        for (var e = 0; e < recipe.entries.length; e++) {
            var ent = recipe.entries[e];
            if (ent.repeatFor) {
                var targets = getMatching(ent.repeatFor);
                for (var t = 0; t < targets.length; t++) {
                    tasks.push({ entry: ent, entity: targets[t] });
                }
            } else {
                tasks.push({ entry: ent, entity: null });
            }
        }
    }

    var ran = [], skipped = [], hit = "";

    function finishDirectAttempt() {
        S.attempting = false;
        armWindowClose();
        if (S.goalSeen) {
            succeed("on-demand direct execution (" + (hit || "goal event") + ")");
            try {
                if (window.top && window.top !== window) {
                    window.top.postMessage({
                        [TAG]: true,
                        type: "ADVENTURER_RECIPE_EXECUTION_COMPLETED",
                        recipe: recipe,
                        success: true,
                        how: hit || "goal event"
                    }, "*");
                }
            } catch (err) {}
            return;
        }
        note("direct execution attempt did not reach " + recipe.goal + "; ran: " + (ran.join(", ") || "nothing") +
            (skipped.length ? "; skipped: " + skipped.join(", ") : ""), "warn");
        try {
            if (window.top && window.top !== window) {
                window.top.postMessage({
                    [TAG]: true,
                    type: "ADVENTURER_RECIPE_EXECUTION_COMPLETED",
                    recipe: recipe,
                    success: false,
                    reason: "goal not seen"
                }, "*");
            }
        } catch (err) {}
    }

    function stepDirect(startIndex) {
        var taskIndex = startIndex;
        var syncSteps = 0;
        var MAX_SYNC_STEPS = 100;
        while (taskIndex < tasks.length) {
            if (S.goalSeen) break;
            if (syncSteps >= MAX_SYNC_STEPS) {
                setTimeout(guarded("next entry direct bounce", function () { stepDirect(taskIndex); }), 0);
                return;
            }
            syncSteps++;

            var task = tasks[taskIndex];
            var entry = task.entry;
            var curEntity = task.entity;

            var why = refusal(entry, recipe);
            if (why) {
                skip(skipped, entry.name + " (" + why + ")");
                taskIndex++;
                continue;
            }

            if ((entry.needsIndex || curEntity) && !index) index = entityIndex(S.app);
            var target = S.app;
            if (entry.scope === "entity") {
                if (curEntity) {
                    target = curEntity;
                } else {
                    target = (entry.guid && index.byGuid[entry.guid]) || (entry.entity && index.byName[entry.entity]) || null;
                }
            }
            if (!target || typeof target.fire !== "function") {
                skip(skipped, entry.name + " (entity " + (entry.entity || entry.guid || (curEntity && curEntity.name)) + " not found)");
                taskIndex++;
                continue;
            }

            var state = { missing: "" };
            var args = decodeArg(entry.args, index, state, 0, curEntity);
            if (state.missing) {
                skip(skipped, entry.name + " (entity " + state.missing + " not found)");
                taskIndex++;
                continue;
            }

            try {
                target.fire.apply(target, [entry.name].concat(args));
                ran.push(entry.name);
            } catch (err) {
                ran.push(entry.name + " (threw " + msgOf(err) + ")");
                note("entry " + entry.name + " threw: " + msgOf(err), "warn");
            }

            if (S.goalSeen) hit = entry.name;
            if (S.goalSeen || taskIndex + 1 >= tasks.length) {
                break;
            }

            var rawDelay = entry.delayMs || recipe.entryDelayMs || 0;
            var delay = Math.min(Math.max(0, rawDelay), MAX_DELAY_MS);
            if (delay > 0) {
                setTimeout(guarded("next entry direct", function () { stepDirect(taskIndex + 1); }), delay);
                return;
            }

            taskIndex++;
        }
        if (!S.goalSeen) {
            tryQuestManagerCompletion(S.app, recipe, function (qmHit) {
                if (qmHit) hit = qmHit;
                finishDirectAttempt();
            });
            return;
        }
        finishDirectAttempt();
    }

    stepDirect(0);
}

// One attempt per trigger name, after the click's own synchronous chain has finished.
function scheduleAttempt(trigger) {
    if (S.done || !S.enabled || S.pending[trigger]) return;
    var recipe = currentRecipe();
    if (!recipe) {
        noteOnce("norecipe:" + trigger, "no recipe for scene [" + sceneNames(S.app).join(", ") + "], " + trigger + " ignored");
        return;
    }
    if (recipe.triggers.indexOf(trigger) < 0 || !slotFree(recipe, trigger) || !budgetLeft(recipe)) return;
    var g = gate();
    if (!g.open) { noteGate(g.reason); return; }
    S.pending[trigger] = true;
    setTimeout(guarded("attempt", function () {
        S.pending[trigger] = false;
        runAttempt(trigger);
    }), recipe.delayMs);
}

function goalSighting() {
    if (S.attempting) { S.goalSeen = true; return; }
    if (S.done) return;
    if (S.windowOpen) { succeed("goal fired after the attempt"); return; }
    S.done = true;
    S.doneBy = "game";
    note("the game fired the goal on its own, nothing to do", "info");
}

// Called for every app event. Returns true when the event must be dropped.
function onEvent(name) {
    if (!S.enabled || typeof name !== "string") return false;
    if (S.goals[name] || (S.goal && name === S.goal)) goalSighting();
    if (S.windowOpen && name !== S.goal) {
        var hit = findMatch([name], S.suppress);
        if (hit) {
            S.dropped++;
            note("dropped event " + name);
            return true;
        }
    }
    if (!S.attempting && S.watch[name]) scheduleAttempt(name);
    return false;
}

// ---- hook ---------------------------------------------------------------------------------------------------------
function unhook() {
    if (S.hooked && S.app && S.origFire) {
        if (S.app.fire === S.wrapperFire) {
            S.app.fire = S.origFire;
        }
        S.hooked = false;
    }
    if (S.windowOpen) closeWindow();
    S.pending = Object.create(null);
    S.attempting = false;
}

function ensureHook(force) {
    if (S.hooked || !S.app || !S.enabled) return;
    if (!force && !S.attempting && (!gate().open || candidateRecipes().length === 0)) return;
    var app = S.app;
    var orig = app.fire;
    if (typeof orig !== "function") {
        noteOnce("nofire", "the app has no fire(), events cannot be watched", "warn");
        return;
    }
    var wrapper = function (name) {
        if (!S.enabled) return orig.apply(this, arguments);
        var drop = false;
        try { drop = onEvent(name); } catch (e) { note("event hook failed: " + msgOf(e), "warn"); }
        if (drop) return this;
        return orig.apply(this, arguments);
    };
    try { app.fire = wrapper; } catch (e) { note("could not wrap app.fire: " + msgOf(e), "warn"); }
    if (app.fire !== wrapper) {
        noteOnce("nowrap", "could not wrap app.fire, events cannot be watched", "warn");
        return;
    }
    S.origFire = orig;
    S.wrapperFire = wrapper;
    S.hooked = true;
    note("watching app events: " + Object.keys(S.watch).join(", "), "info");
}

function reconcile() {
    if (!S.enabled) {
        unhook();
        S.watch = Object.create(null);
        S.goals = Object.create(null);
        return;
    }
    S.watch = Object.create(null);
    S.goals = Object.create(null);
    candidateRecipes().forEach(function (r) {
        r.triggers.forEach(function (t) { S.watch[t] = true; });
        S.goals[r.goal] = true;
    });
    ensureHook();
    watchGraph();
    if (gate().open && !S.done && !S.attempting && recipesForApp().length === 0 && !S.guessed && S.app && !S.used["quest:manager"]) {
        var qm = findQuestManagers(S.app);
        var activeBq = qm.bq || (qm.generic && typeof qm.generic.reach === "function" ? qm.generic : null);
        if ((activeBq && ((typeof activeBq.sentStep === "number" && activeBq.sentStep >= 1) || (typeof activeBq.t === "number" && activeBq.t > 0))) || qm.dqm) {
            scheduleAttempt("quest:manager");
        }
    }
}

function update(next) {
    applyConfig(next);
    reconcile();
    var sig = JSON.stringify([S.bundled.map(function (r) { return r.sig; }), S.local.map(function (r) { return r.sig; }), S.quests]);
    if (sig !== S.configSig) {
        S.configSig = sig;
        var g = gate();
        note("configuration: " + S.local.length + " local and " + S.bundled.length + " bundled recipes, gate " + (g.open ? "open" : "closed (" + g.reason + ")"));
    }
}

// ---- status -------------------------------------------------------------------------------------------------------
function status() {
    try {
        var r = currentRecipe(), g = gate();
        return {
            appId: S.appId,
            scene: sceneNames(S.app),
            ready: !!S.app,
            hooked: S.hooked,
            enabled: S.enabled,
            recipe: r ? {
                name: r.name, scene: r.scene, origin: r.origin, source: r.source, goal: r.goal,
                triggers: r.triggers.slice(),
                entries: r.entries.map(function (e) { return { name: e.name, scope: e.scope, source: e.source }; }),
                suppress: r.suppress.slice(), delayMs: r.delayMs, notes: r.notes
            } : null,
            recipes: { local: S.local.length, bundled: S.bundled.length, forApp: recipesForApp().length },
            guessed: {
                graph: S.graph ? "connected" : (S.graphPolls > MAX_GRAPH_POLLS ? "missing" : "waiting"),
                available: !!S.guessed,
                scene: S.guessed ? S.guessed.scene : "",
                goal: S.guessed ? S.guessed.goal : "",
                triggers: S.guessed ? S.guessed.triggers.slice() : [],
                entries: S.guessed ? S.guessed.entries.map(function (e) { return e.name; }) : [],
                attempts: S.guessedAttempts
            },
            invalid: S.invalid.slice(),
            gate: { open: g.open, reason: g.reason, quest: g.quest ? { questId: g.quest.questId, name: g.quest.name, enrolled: g.quest.enrolled, completed: g.quest.completed } : null },
            attempts: S.attempts,
            attemptOrigin: S.attemptOrigin,
            used: Object.keys(S.used).filter(function (k) { return S.used[k]; }),
            done: S.done,
            doneBy: S.doneBy,
            windowOpen: S.windowOpen,
            dropped: S.dropped,
            log: S.log.slice()
        };
    } catch (e) {
        return { error: msgOf(e), log: S.log.slice() };
    }
}

// ---- boot ---------------------------------------------------------------------------------------------------------
var api = { status: status };
Object.defineProperty(api, "update", { value: guarded("update", update), enumerable: false });
Object.defineProperty(api, "execute", {
    value: guarded("api.execute", function (recipe) {
        var norm = normalizeInjectedRecipe(recipe);
        if (norm && norm.recipe) {
            executeRecipeDirectly(norm.recipe, "api.execute");
            return true;
        }
        return false;
    }),
    enumerable: false
});
Object.defineProperty(api, "inject", {
    value: guarded("api.inject", function (recipe, execute) {
        var norm = normalizeInjectedRecipe(recipe);
        if (norm && norm.recipe) {
            S.local = [norm.recipe].concat(S.local);
            reconcile();
            if (execute) executeRecipeDirectly(norm.recipe, "api.inject");
            return true;
        }
        return false;
    }),
    enumerable: false
});
window.__adventurerCompletion = api;

window.addEventListener("message", guarded("message handler", function (e) {
    var d = e && e.data;
    if (!d) return;

    var isAllowedSource = !e.source || e.source === window || e.source === window.parent || (window.top && e.source === window.top);
    if (!isAllowedSource) return;

    var isTag = !!d[TAG];
    var type = d.type;

    if (type === "completion") {
        if (!isTag || typeof d.enabled !== "boolean") return;
        S.enabled = d.enabled;
        if (!S.enabled) unhook();
        note("runner " + (S.enabled ? "enabled" : "disabled"));
        reconcile();
        return;
    }

    if (type === "menu_state") {
        if (!isTag || typeof d.autoComplete !== "boolean") return;
        S.enabled = d.autoComplete;
        if (!S.enabled) unhook();
        note("runner " + (S.enabled ? "enabled" : "disabled"));
        reconcile();
        return;
    }

    var isInject = type === "ADVENTURER_INJECT_RECIPE" || type === "completion_inject";
    var isExecute = type === "ADVENTURER_EXECUTE_RECIPE" || (type === "completion_inject" && (d.execute === true || d.execute === undefined));

    if (isInject || isExecute) {
        try {
            var iframes = document.querySelectorAll("iframe");
            for (var fi = 0; fi < iframes.length; fi++) {
                var childFrame = iframes[fi];
                if (childFrame && childFrame.contentWindow && childFrame.contentWindow !== e.source) {
                    childFrame.contentWindow.postMessage(d, "*");
                }
            }
        } catch (err) {}

        var rawRecipe = d.recipe;
        if (typeof rawRecipe === "string") {
            try { rawRecipe = JSON.parse(rawRecipe); } catch (err) { rawRecipe = null; }
        }
        if (!rawRecipe) {
            note("received empty or unreadable recipe payload", "warn");
            return;
        }

        var norm = normalizeInjectedRecipe(rawRecipe);
        if (!norm || !norm.recipe) {
            note("injected recipe could not be normalized: " + (norm ? norm.reason : "unknown"), "warn");
            return;
        }

        var recipe = norm.recipe;
        note("recipe injected: " + (recipe.name || recipe.scene) + " (" + recipe.origin + ")", "info");

        S.local = [recipe].concat(S.local.filter(function (r) {
            return !(r.scene === recipe.scene && (!r.appId || r.appId === recipe.appId) && r.name === recipe.name);
        }));

        S.enabled = true;
        reconcile();

        if (isExecute) {
            executeRecipeDirectly(recipe, "message:" + type);
        }
    }
}));

var polls = 0;
function boot() {
    var app = null;
    try { app = (window.pc && window.pc.app) || window.app || null; } catch (e) { app = null; }
    if (app && typeof app.fire === "function") {
        S.app = app;
        reconcile();     // not update(CONFIG): a re-injection may have changed the config while this was polling
        if (S.pendingExecution) {
            var pending = S.pendingExecution;
            S.pendingExecution = null;
            executeRecipeDirectly(pending.recipe, pending.source + ":pending");
        }
        return;
    }
    polls++;
    if (polls > MAX_POLLS) {
        note("no PlayCanvas app with fire() found after about a minute, runner idle", "info");
        return;
    }
    setTimeout(guarded("boot", boot), POLL_MS);
}

update(CONFIG);
guarded("boot", boot)();
`;

export function buildCompletionScript(options: CompletionOptions): string {
    const quests: Record<string, CompletionQuestStatus> = {};
    for (const [appId, q] of Object.entries(options?.quests ?? {})) {
        if (!/^\d+$/.test(appId) || !q) continue;
        quests[appId] = { questId: String(q.questId ?? ""), name: String(q.name ?? ""), enrolled: !!q.enrolled, completed: !!q.completed };
    }
    const enabled = options?.enabled !== false;
    const config = JSON.stringify({ recipes: Array.isArray(options?.recipes) ? options.recipes : [], quests, enabled });
    return "(function () {\n"
        + "    var CONFIG = " + config + ";\n"
        + "    CONFIG.local = " + LOCAL_PROFILES_EXPR + ";\n"
        + GLUE_SRC
        + "\n})();";
}
