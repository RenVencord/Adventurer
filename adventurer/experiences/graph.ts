/*
 * Adventurer: experience event-graph analysis (which interactable entities lead to the quest goal).
 *
 * buildGraphScript() returns plain JS source that is injected into the activity iframe (same transport as the game
 * overlay, see index.tsx / native.ts). It is a self-contained, read-only port of the Python analysis in
 * VencordWorkbench (workbench/experience_graph.py + workbench/js/experience_scan.js): it snapshots the PlayCanvas
 * scene wiring (entities, script attributes, the app event listener registry), classifies every event attribute as
 * LISTEN or FIRE, builds the "script S fires event E once all the events it listens for happened" graph, and walks it
 * backwards from the discordQuestManager events (questCompleteEvent, questProgressEvent, progressEvents[].event).
 * Every interactable entity that fires an event (or hands out an item) in that backward closure is an "objective".
 * It never fires events, never calls script or arise methods; it only reads properties.
 *
 * ---------------------------------------------------------------------------------------------------------------
 * API (installed on the activity window as window.__adventurerGraph, available immediately, before the first build)
 * ---------------------------------------------------------------------------------------------------------------
 *   refresh(): void
 *       Force a rebuild now (ignores the 3 s throttle and the "nothing changed" skip). No-op while the PlayCanvas
 *       app does not exist yet. Never throws.
 *   state(): GraphState   (treat as read-only; a new object is created on every build)
 *       ok               true once a scene scan succeeded (false before the first build or when it failed)
 *       hasQuestManager  a discordQuestManager script exists in the scene. When false the scene is not a quest
 *                        puzzle (or its quest logic lives in game code): objectiveGuids is empty and callers should
 *                        keep their own heuristics.
 *       goalEvents       questCompleteEvent names (quest complete)
 *       closureEvents    event keys in the backward closure, nearest to the goal first (name for app events,
 *                        "name@guid" for entity-scoped events, "item:<id>" for an obtainable inventory item)
 *       objectiveGuids   guids of interactable entities that fire a closure event
 *       roles            { guid: "collect holocube 1/3" } for every objective entity
 *       scene, builtAt (ms epoch, 0 before the first build)
 *       plus: progressEvents, closureDetail [{key,name,scope,entity,depth,count,origin,args,goal,progress}],
 *       entityCount, notes, truncated, builds, buildMs, error
 *   isObjective(entity): boolean   entity.getGuid() is in objectiveGuids (false for null / unknown / before build)
 *   role(entity): string           role text of an objective entity, "" otherwise
 *   isDerived(eventName): boolean  true when something in the scene itself fires the event (an event has a
 *                                  producer script, or its origin is derived/automatic); false for events nothing
 *                                  in the scene fires (engine or game code fires them) and for unknown names.
 *                                  Accepts a plain name or a graph key. False before the first build, never throws.
 *   eventOrigin(eventName): string "interaction" | "derived" | "automatic" | "external" for events in the quest
 *                                  closure, "" otherwise. Lets callers tell a player-driven producer (a useItem or
 *                                  button script) from a purely scripted one, which isDerived does not.
 *   guessedRecipe(opts?): GuessedRecipe | null
 *                                  A fresh copy of state().recipe, the completion recipe guessed from the own code
 *                                  of the scripts (see below), or null. With { usableOnly: true } only the entries
 *                                  the guard analysis allows are kept (state().source.entries[i].usable); null when
 *                                  none is left, and the dropped ones are named at the end of notes ("Not offered").
 *   onChange(cb): () => void       cb(state) runs after a build or a finished source analysis whose objectives,
 *                                  closure, roles or guessed recipe differ from the previous announcement (including
 *                                  the first one). Returns an unsubscribe function.
 *   (_scan / _analyze / _source* are test hooks)
 *
 * Script source analysis (state().source and state().recipe)
 *   Some games have no discordQuestManager: their quest logic is game code (VALORANT Aces fires arise:questComplete
 *   from a script method). SOURCE_SRC ports the Python source analysis (workbench/experience_source.py plus the
 *   fact extraction of workbench/js/experience_scan.js): it reads the source text of every script type
 *   (Function.prototype.toString, never calls anything), extracts the events each method registers, fires and the
 *   state it reads and writes, attributes the live app event listeners to script methods, walks the event graph
 *   backwards from the goal event and guesses a completion recipe in the exact schema of the Workbench profiles
 *   (source "guessed"). A scene with a discordQuestManager is skipped (status "skipped"): its objectives come from the
 *   attributes. state().source: status "idle" | "pending" | "done" | "skipped" | "unavailable" | "error", the goal(s),
 *   the chain hops with their provenance and an approximate flag, the goal-owning scripts, the state guards and the
 *   entries with usable/reason. state().recipe is null when no chain to a goal was found. The work runs in slices of
 *   about 4 ms (requestIdleCallback when the page has it, else setTimeout 8 ms), the facts of a script type are cached
 *   until its constructor or a script type it reads through .script.NAME changes, and a new build replaces a running
 *   job. Parity with the Python implementation is asserted in source.test.mjs (differences are listed there).
 *
 * Build policy: polls every 500 ms until the scene has entities and script instances and the scene is stable for one
 * poll, builds once, then (1 s poll) rebuilds only when the entity count, script instance count, scene name or the
 * number of events with a listener changed, at most every 3 s. A build over ~450 entities takes a few milliseconds;
 * the source analysis follows it in the background and is only started for scenes without a discordQuestManager.
 *
 * Source layout: the page code lives in three String.raw constants below (TABLES_SRC, GRAPH_SRC, SOURCE_SRC) so there
 * is exactly one copy, esbuild cannot rename anything inside it, and the tests execute the very string that is
 * injected. Rules for editing them: no backticks, no dollar-brace sequences, no em-dashes. Backslashes are literal.
 * TABLES_SRC is generated from the Python tables (experiences/__fixtures__/dump_fixtures.py writes tables.json and
 * graph.test.mjs checks the two stay identical). Everything stays in this file: an import of a sibling .ts file does
 * not type check under the bundler resolution of this repo.
 *
 * This file only uses erasable TypeScript syntax so node can import it directly for the tests.
 */

export interface GraphClosureEvent {
    key: string;
    name: string;
    scope: "app" | "entity" | "item";
    entity: string | null;
    depth: number | null;
    count: number;
    origin: string;
    args: unknown[];
    goal: boolean;
    progress: number | null;
}

export interface GraphGoal {
    key: string;
    strength: number;
    learned: boolean;
}

export interface GraphSourceEvent {
    key: string;
    name: string;
    scope: "app" | "entity";
    entity: string | null;
    depth: number;
    root: boolean;
}

export interface GraphSourceStep {
    script: string;
    entity: string;
    method: string;
    inst: number;
    how: "handler" | "guess" | "call";
    approximate: boolean;
}

/** One link of the chain: src is handled by a script, whose code leads to the firing of dst. */
export interface GraphSourceHop {
    src: string;
    dst: string;
    how: "runtime" | "runtime+static" | "static";
    ambiguous: boolean;
    approximate: boolean;
    path: string;
    steps: GraphSourceStep[];
}

export interface GraphSourceOwner {
    script: string;
    entity: string;
    why: string;
}

export interface GraphSourceWriter {
    method: string;
    events: string[];
    via: string;
    onPath: boolean;
}

/** State the goal path reads: foreign when it belongs to another script than the reader. */
export interface GraphSourceGuard {
    state: string;
    foreign: boolean;
    readers: string[];
    text: string;
    writers: GraphSourceWriter[];
}

export interface GraphSourceEntry {
    name: string;
    depth: number;
    approximate: boolean;
    /** true: runs the writer of the guarded state, false: skips it, null: nothing to verify */
    guardOk: boolean | null;
    /** the entry may be fired by the completion runner (see usableOnly of guessedRecipe) */
    usable: boolean;
    reason: string;
    fields: Record<string, string>;
    note: string;
}

export interface GraphSource {
    status: "idle" | "pending" | "done" | "skipped" | "unavailable" | "error";
    reason: string;
    available: boolean;
    found: boolean;
    scriptTypes: number;
    listeners: number;
    unattributed: number;
    goal: string;
    goals: GraphGoal[];
    unreachedGoals: string[];
    events: GraphSourceEvent[];
    hops: GraphSourceHop[];
    owners: GraphSourceOwner[];
    guards: GraphSourceGuard[];
    entries: GraphSourceEntry[];
    preferred: string;
    triggerNotes: string[];
    notes: string[];
    truncated: { scripts: boolean; sources: boolean; };
    builtAt: number;
    ms: number;
    slices: number;
    units: number;
    maxSliceMs: number;
    types: { total: number; extracted: number; reused: number; };
}

export interface GuessedRecipeEntry {
    name: string;
    scope: "app";
    args: unknown[];
    source: "inferred";
}

/** The completion recipe schema of the Workbench profiles (RECIPE_VERSION 1). */
export interface GuessedRecipe {
    version: number;
    goal: string;
    triggers: string[];
    entries: GuessedRecipeEntry[];
    suppress: string[];
    delay_ms: number;
    notes: string;
    source: "guessed";
}

export interface GraphState {
    ok: boolean;
    hasQuestManager: boolean;
    goalEvents: string[];
    closureEvents: string[];
    objectiveGuids: string[];
    roles: Record<string, string>;
    scene: string;
    builtAt: number;
    progressEvents: { event: string; progress: number | null; }[];
    closureDetail: GraphClosureEvent[];
    entityCount: number;
    notes: string[];
    truncated: Record<string, boolean>;
    builds: number;
    buildMs: number;
    error: string | null;
    source: GraphSource;
    recipe: GuessedRecipe | null;
}

export interface AdventurerGraphApi {
    refresh(): void;
    state(): GraphState;
    isObjective(entity: unknown): boolean;
    role(entity: unknown): string;
    isDerived(eventName: string): boolean;
    eventOrigin(eventName: string): string;
    guessedRecipe(opts?: { usableOnly?: boolean; }): GuessedRecipe | null;
    onChange(cb: (state: GraphState) => void): () => void;
}

export const TABLES_SRC: string = String.raw`
const L = "listen", F = "fire";
const QUEST_SCRIPT = "discordQuestManager";
const MAX_COUNT = 1000;
const INTERACTABLE_SCRIPTS = new Set([
    "collectable", "door", "focusItem", "focusItemNestable", "focusItemTakeable", "focusItemUsable",
    "itemManipulator", "keypad", "multiPositionSwitch", "pushButton", "scoreable", "sendEventOnClickCollider",
    "slider", "snappingDial", "snappingSlider", "toggleSwitch", "uiSendEvent", "useItem"
]);
const LEAF_SCRIPTS = new Set([
    "cameraFovTween", "entityShake", "fadeAudioOnEvent", "imageSizeTween", "lightColorTween", "lightFlicker",
    "lightIntensityTween", "materialEmissiveTween", "materialOpacityTween", "positionTween", "rotationTween",
    "scaleTween", "spriteOpacityTween", "spriteSizeTween", "textEffectsGlowTween",
    "textEffectsGradientOpacityTween", "textEffectsOutlineTween", "textEffectsShadowTween", "uiBlurTween",
    "uiColorTween", "uiOpacityTween"
]);
const LEAF_LISTEN = new Set([
    "checkFlagEvent", "checkOnEvent", "disableEvent", "enableEvent", "event", "eventName", "eventToCheckOn",
    "eventToCount", "eventToStart", "fireOnEvent", "pauseEvent", "playEvent", "playEvents", "reparentEvent",
    "resetEvent", "resumeEvent", "setFalseEvent", "setTrueEvent", "startCheckingEvent", "startEvent",
    "startFlickerEvent", "startTweenEvent", "stopAllShakesEvent", "stopAllTweensEvent", "stopCheckingEvent",
    "stopEvent", "stopEvents", "stopFlickerEvent", "switchEvent", "triggerEvent", "triggerEvents"
]);
const LEAF_FIRE = new Set([
    "allCollectedEvent", "completeEvent", "eventToEmitOnCorrect", "eventToEmitOnIncorrect", "eventToFire",
    "eventToFireAtAngle", "eventToFireAtPosition", "eventToFireOnComplete", "eventToFireOnCountMet",
    "eventToSend", "eventToSendOnCorrect", "onCompleteEvent", "onFalseEvent", "onStartEvent", "onStopEvent",
    "onTargetEnterEvent", "onTargetExitEvent", "onTargetStayEvent", "onTrueEvent"
]);
const SCRIPT_EVENTS = {
    "discordQuestManager": {"questCompleteEvent": L, "questProgressEvent": L, "progressEvents[].event": L},
    "timelinePlayer": {"completeEvent": F},
    "addItemToInventoryOnEvent": {"eventName": L},
    "badgeManger": {"badges[].event": L},
    "titleManager": {"titles[].event": L},
    "cameraPathNode": {"continueEvent": L, "arrivalEvent": F},
    "cameraPathNodeJunction": {"paths[].switchEvent": L},
    "cameraPath": {"startCameraPathEvent": L},
    "cameraPoi": {"events.onClickPoiEvent": F, "events.onArriveAtPoiEvent": F, "events.onLeavePoiEvent": F},
    "changeCursorOnEvent": {"event": L},
    "changeUrlOnEvent": {"navigateToUrlEvent": L},
    "checkCodeOnEvent": {"eventToCheckOn": L, "eventToEmitOnCorrect": F, "eventToEmitOnIncorrect": F},
    "checkEventPattern": {
        "onEvents[]": L, "offEvents[]": L, "requiredEvents[]": L, "confirmEvent": L, "eventToEmitOnCorrect": F,
        "eventToEmitOnIncorrect": F, "resetEvent": L, "enableEvent": L, "disableEvent": L
    },
    "checkEventSequence": {
        "sequence[]": L, "eventToEmitOnCorrect": F, "eventToEmitOnIncorrect": F, "progressEvents[]": F,
        "resetEvent": L, "enableEvent": L, "disableEvent": L
    },
    "changePoiAttributesOnEvent": {"eventName": L},
    "changeItemAttributesOnEvent": {"eventName": L},
    "checkMultipleFlags": {"checkOnEvent": L, "eventToFireOnCheckPassed": F, "eventToFireOnCheckFailed": F},
    "checkpointManager": {"checkpoints[].triggerEvent": L},
    "collectable": {"collectedEvent": F},
    "scoreable": {"collectedEvent": F},
    "collectablesManager": {"collectables[].allCollectedEvent": F},
    "controlVideoOnEvent": {
        "playEvent": L, "pauseEvent": L, "stopEvent": L, "muteEvent": L, "unmuteEvent": L, "preloadEvent": L,
        "seekEvent": L, "volumeEvent": L, "loopEvent": L, "videoLoadedEvent": L, "videoEndedEvent": L,
        "videoControlEvent": F, "refireLoadedAs": F, "refireEndedAs": F
    },
    "countEvents": {"eventToCount": L, "counts[].eventToFireOnCountMet": F},
    "destroyEntityOnEvent": {"destroyEvents[].eventName": L},
    "door": {
        "onLockEvent": L, "onUnlockEvent": L, "onOpenEvent": L, "onCloseEvent": L, "doorOpenedEvent": F,
        "doorClosedEvent": F, "doorUnlockedEvent": F, "doorLockedEvent": F
    },
    "enableCameraControlsOnEvent": {"eventConfigs[].eventName": L},
    "enableInteractionInputOnEvent": {"eventConfigs[].eventName": L},
    "enableCollidersOnEvent": {"colliderEvents[].enableEvent": L},
    "enableScriptOnEvent": {"scriptEvents[].enableEvent": L},
    "enableEntitiesOnEvent": {"enableEvents[].enableEvent": L},
    "uiSetInputEnabledOnEvent": {"inputEvents[].enableEvent": L},
    "eventFlagChecker": {
        "allTrueEvent": F, "events[].checkFlagEvent": L, "events[].onTrueEvent": F, "events[].onFalseEvent": F,
        "events[].setTrueEvent": L, "events[].setFalseEvent": L
    },
    "eventRelay": {"triggerEvents[]": L, "eventsToSend[].eventToSend": F},
    "fireEventOnSettingBool": {"trueEvent": F, "falseEvent": F},
    "fireRandomEventOnEvent": {"triggerEvents[]": L, "outputEvents[].eventName": F},
    "focusItem": {
        "events.onFocusingEvent": F, "events.onFocusedEvent": F, "events.onReturningEvent": F,
        "events.onReturnedEvent": F
    },
    "focusItemManager": {
        "events.onFocusEvent": F, "events.onFocusedEvent": F, "events.onUnfocusEvent": F,
        "events.onUnfocusedEvent": F, "events.onTakeItemEvent": F, "events.onUseItemEvent": F
    },
    "focusItemTakeable": {"takeEvent": F},
    "focusItemUsable": {"useEvent": F, "onUseCompleteEvent": L},
    "holographicReveal": {"revealEvent": L, "resetEvent": L, "completeEvent": F},
    "inventoryDragHandler": {"onDragStartEvent": F, "onDragEndEvent": F},
    "inventorySystem": {"itemAddedEvent": F, "itemRemovedEvent": F, "clearInventoryEvent": L},
    "keypad": {
        "keysEvents[]": L, "keyDeleteEvent": L, "keyClearEvent": L, "keyEnterEvent": L, "submitCodeEvent": F,
        "onKeyPressedEvent": F, "onCodeSubmitEvent": F
    },
    "linkOutOnEvent": {"outlinks[].event": L},
    "loadAssetsOnEvent": {"assetEvents[].eventToStart": L, "assetEvents[].eventToFireOnComplete": F},
    "moveToPoiOnEvent": {"eventName": L},
    "multiPositionSwitch": {"onPowerEvent": L, "onSwitchPositionEvent": F, "positions[].eventToFireAtPosition": F},
    "lookAtEntity": {
        "startLookingEvent": L, "stopLookingEvent": L, "setTargetEvent": L, "immediateStopEvent": L,
        "onStartLookingEvent": F, "onReachedTargetEvent": F, "onStoppedLookingEvent": F
    },
    "playAudioOnEvent": {"events[].playEvents[]": L, "loop.stopEvents[]": L},
    "playPfxOnEvent": {"playEvents[].playEvent": L},
    "stopPfxOnEvent": {"stopEvents[].stopEvent": L},
    "newsFeedManager": {"newsEvents[].fireOnEvent": L},
    "pushButton": {
        "onPowerEvent": L, "turnPowerOnEvent": L, "turnPowerOffEvent": L, "onPushEvent": F, "onDownEvent": F,
        "onUpEvent": F
    },
    "randomlyFireEvent": {"startEvent": L, "stopEvent": L, "events[]": F},
    "reparentEntitiesOnEvent": {"reparentEvents[].reparentEvent": L},
    "refreshOnEvent": {"eventName": L},
    "refreshTranslationsOnEvent": {"eventName": L},
    "saveOnEvent": {"eventToListenFor": L},
    "sendEventOnClickCollider": {"mouseDownEvent": F, "mouseUpEvent": F},
    "sendEventOnBreakPoint": {"breakPoints[].eventName": F},
    "sendEventOnCodeCorrect": {
        "listenForCodeEvent": L, "codeEvents[].enableCodeCheckingEvent": L,
        "codeEvents[].disableCodeCheckingEvent": L, "codeEvents[].eventToSendOnCorrect": F
    },
    "sendEventOnEntityAngle": {
        "events[].startCheckingEvent": L, "events[].stopCheckingEvent": L, "events[].checkOnEvent": L,
        "events[].eventToFire": F
    },
    "sendEventOnRollover": {"eventName": F},
    "sendEventOnTrigger": {
        "events[].onTargetEnterEvent": F, "events[].onTargetExitEvent": F, "events[].onTargetStayEvent": F
    },
    "setScreenComponentValuesOnEvent": {"eventsToListen[].eventName": L},
    "setSpriteOnEvent": {"events[].event": L},
    "uiSetSpriteOnEvent": {"events[].event": L},
    "uiSetImageOnEvent": {"events[].event": L},
    "uiSetTextOnEvent": {"events[].event": L},
    "triggerAnimationOnEvent": {"events[].event": L},
    "swapMaterialOnEvent": {"materialSwapEvents[].event": L},
    "shareExperienceOnEvent": {"eventName": L},
    "showNewsfeedOnEvent": {"events[].event": L},
    "viewMediaOnEvent": {"events[].event": L},
    "resetFirstPersonCameraControllerOnEvent": {"events[].event": L},
    "sendAnalyticsOnEvent": {"events[].triggerEvent": L},
    "slider": {"enabledEvent": L, "moveToEvent": L, "movedEvent": F},
    "snappingSlider": {"enabledEvent": L, "movedEvent": F, "snapPositions[].eventToFireAtPosition": F},
    "snappingDial": {"crossedSnapAngleEvent": F, "movedEvent": F, "snapAngles[].eventToFireAtAngle": F},
    "spawnEntityOnEvent": {"eventName": L},
    "spinEntity": {
        "startSpinEvent": L, "stopSpinEvent": L, "immediateStopEvent": L, "onStartWarmUpEvent": F,
        "onStartSpinEvent": F, "onStartCoolDownEvent": F, "onStopSpinEvent": F
    },
    "spineSetAnimationOnEvent": {"setAnimationEvents[].eventName": L},
    "textDisplay": {"showTextEvent": L, "scrollTextStartEvent": L, "scrollTextStopEvent": L},
    "togglePhysicsModeOnEvent": {"physicsEvents[].eventName": L, "physicsEvents[].onCompleteEvent": F},
    "timer": {
        "timeEvents[].eventName": F, "globalStartEvent": L, "globalStopEvent": L, "globalPauseEvent": L,
        "globalResumeEvent": L, "globalResetEvent": L
    },
    "toggleSwitch": {
        "onPowerEvent": L, "switchOnEvent": L, "switchOffEvent": L, "receiveSwitchOnEvent": L,
        "receiveSwitchOffEvent": L, "onSwitchEvent": F, "switchedOnEvent": F, "switchedOffEvent": F
    },
    "triggerPoiBackOnEvent": {"eventToTriggerBackButton": L},
    "tweenAmbientIntensityOnEvent": {"eventName": L},
    "tweenExposureOnEvent": {"eventName": L},
    "unfocusAllItemsOnEvent": {"eventName": L},
    "registerForDiscordBot": {"eventName": L},
    "uiSendEvent": {"clickEvent": F, "enterEvent": F, "leaveEvent": F},
    "uiSpriteAnim": {"playEvent": L, "stopEvent": L, "pauseEvent": L, "resumeEvent": L, "onCompleteEvent": F},
    "useItem": {
        "eventOnCorrectItemUsed": F, "eventOnIncorrectItemUsed": F, "eventOnCorrectItemHover": F,
        "eventOnCorrectItemLeave": F, "validItems[].eventOnCorrectItemUsed": F,
        "validItems[].eventOnCorrectItemHover": F, "validItems[].eventOnCorrectItemLeave": F
    },
    "videoStreamController": {"controlEvent": L, "loadedEvent": F, "endedEvent": F, "cues[].name": F},
    "playTimelineOnEvent": {
        "timelineConfigs[].playEvent": L, "timelineConfigs[].pauseEvent": L, "timelineConfigs[].stopEvent": L,
        "timelineConfigs[].completeEvent": F
    },
};
`;

export const GRAPH_SRC: string = String.raw`
if (window.__adventurerGraphBooting) return;
window.__adventurerGraphBooting = true;

const LISTEN = L, FIRE = F;
const MAX_ENTITIES = 5000, MAX_ATTRS = 200, MAX_DEPTH = 5, MAX_ITEMS = 80, MAX_KEYS = 60, MAX_STR = 300;
const MAX_EVENTS = 4000, MAX_PER_EVENT = 60, MAX_NODES = 4000;
const SKIP_KEYS = new Set(["entity", "app", "system"]);
const POLL_FIRST_MS = 500, POLL_BUILT_MS = 1000, MIN_REBUILD_MS = 3000, MAX_WAIT_POLLS = 240, STABLE_POLLS_NO_SCRIPTS = 6;
const EVENT_NAME_RE = /^[\p{L}\p{N}_.\-]+(:[\p{L}\p{N}_.\-]+)+$/u;
const PLAIN_NAME_RE = /^[^\s\/]{1,100}$/;
const SEP = "\u0001";

const perfNow = function () {
    try { if (window.performance && typeof window.performance.now === "function") return window.performance.now(); } catch (err) { /* fall through */ }
    return Date.now();
};
let warned = false;
function warnOnce(msg, err) {
    if (warned) return;
    warned = true;
    try { console.warn("[Adventurer] graph: " + msg, err && err.message ? err.message : ""); } catch (e) { /* no console */ }
}

// ---- small helpers (mirror the Python _dict/_list/_str/_names/_num) ---------------------------------------------
const hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
const isDict = function (v) { return v !== null && typeof v === "object" && !Array.isArray(v); };
const asDict = function (v) { return isDict(v) ? v : {}; };
const asList = function (v) { return Array.isArray(v) ? v : []; };
const asStr = function (v) { return typeof v === "string" ? v : ""; };

function namesOf(v) {
    if (typeof v !== "string") return [];
    const out = [];
    const parts = v.split(",");
    for (let i = 0; i < parts.length; i++) { const p = parts[i].trim(); if (p) out.push(p); }
    return out;
}

function num(v, def) {
    if (def === undefined) def = 1;
    if (typeof v !== "number" || !Number.isFinite(v)) return def;
    return Math.max(1, Math.min(Math.trunc(v), MAX_COUNT));
}

// ---- scene scan (read-only port of workbench/js/experience_scan.js) ---------------------------------------------
function getApp() {
    const pc = window.pc;
    return (pc && (pc.app || (pc.Application && typeof pc.Application.getApplication === "function" && pc.Application.getApplication()))) || window.app || null;
}

function guidOf(e) { try { return e && typeof e.getGuid === "function" ? e.getGuid() : null; } catch (err) { return null; } }
function isEntity(v) { return !!v && typeof v === "object" && typeof v.getGuid === "function" && Array.isArray(v.children); }
const r2 = function (n) { return Math.round(n * 100) / 100; };

// Plain-data copy of an attribute value: strings, numbers, booleans, null and arrays/objects of those.
function plain(v, depth, bud, trunc) {
    try {
        const t = typeof v;
        if (v === null || t === "boolean") return v;
        if (t === "string") return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
        if (t === "number") return Number.isFinite(v) ? v : null;
        if (t !== "object") return undefined;                                // undefined, function, symbol, bigint
        if (++bud.n > MAX_NODES) { trunc.attrs = true; return undefined; }
        if (isEntity(v)) return "@entity:" + guidOf(v);
        const ctor = v.constructor && v.constructor.name;
        if (typeof v.x === "number" && typeof v.y === "number") {            // Vec2/3/4, Quat
            const o = [], ks = ["x", "y", "z", "w"];
            for (let i = 0; i < ks.length; i++) if (typeof v[ks[i]] === "number") o.push(r2(v[ks[i]]));
            return o;
        }
        if (typeof v.r === "number" && typeof v.g === "number" && typeof v.b === "number") return [r2(v.r), r2(v.g), r2(v.b)];
        if (Array.isArray(v)) {
            if (depth >= MAX_DEPTH) return undefined;
            const out = [];
            for (let i = 0; i < v.length && i < MAX_ITEMS; i++) { const x = plain(v[i], depth + 1, bud, trunc); out.push(x === undefined ? null : x); }
            if (v.length > MAX_ITEMS) trunc.attrs = true;
            return out;
        }
        if (ctor && ctor !== "Object") return undefined;                      // assets, textures, engine objects
        if (depth >= MAX_DEPTH) return undefined;
        const out = {};
        let n = 0;
        const keys = Object.keys(v);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (k.charAt(0) === "_" || SKIP_KEYS.has(k) || k === "__proto__") continue;
            if (n++ >= MAX_KEYS) { trunc.attrs = true; break; }
            const x = plain(v[k], depth + 1, bud, trunc);
            if (x !== undefined) out[k] = x;
        }
        return out;
    } catch (err) {
        return undefined;                                                    // a throwing getter: leave the value out
    }
}

function scriptNameOf(inst) {
    const st = inst && inst.__scriptType;
    return st ? (st.__name || st.name || "") : "";
}

function readAttrs(inst, trunc) {
    const attrs = {};
    const store = inst.__attributes && typeof inst.__attributes === "object" ? inst.__attributes : null;
    const st = inst.__scriptType;
    const idx = st && st.attributes && st.attributes.index && typeof st.attributes.index === "object" ? st.attributes.index : null;
    let keys;
    if (idx && Object.keys(idx).length) keys = Object.keys(idx);
    else keys = Object.keys(store || inst);                                   // undeclared: stored values or own properties
    const bud = { n: 0 };
    let n = 0;
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.charAt(0) === "_" || SKIP_KEYS.has(k) || k === "__proto__") continue;
        if (n >= MAX_ATTRS) { trunc.attrs = true; break; }
        let raw;
        try { raw = store && hasOwn(store, k) ? store[k] : inst[k]; } catch (err) { continue; }
        const x = plain(raw, 0, bud, trunc);
        if (x === undefined) continue;
        attrs[k] = x;
        n++;
    }
    return attrs;
}

function listenerScope(h, app) {
    const s = h && h.scope;
    if (!s) return { scopeKind: "other", guid: null, script: null };
    if (s === app) return { scopeKind: "app", guid: null, script: null };
    if (isEntity(s)) return { scopeKind: "entity", guid: guidOf(s), script: null };
    if (s.entity && isEntity(s.entity)) return { scopeKind: "entity", guid: guidOf(s.entity), script: scriptNameOf(s) || null };
    return { scopeKind: "other", guid: null, script: null };
}

function sceneNameOf(app) {
    let scene = "";
    try {
        if (app.scene && typeof app.scene.name === "string" && app.scene.name) scene = app.scene.name;
        else if (app.scenes && typeof app.scenes.list === "function") {
            const l = app.scenes.list();
            if (Array.isArray(l) && l.length === 1 && l[0] && typeof l[0].name === "string") scene = l[0].name;
        }
    } catch (err) { /* leave empty */ }
    return scene;
}

// { ok, scene, entities:[{guid,name,enabled,tags,scripts:[{name,enabled,attrs}]}], listeners:{name:[{guid,script,
//   scopeKind,target,targetGuid}]}, truncated, counts, ms }. Position and path are not read (the closure does not need
//   them). keep, when given, collects the live objects the script source analysis needs (it is never part of the scan):
//   keep.instances [{inst, guid, name}] for every script instance, keep.handles [{rec, h}] for every listener record.
function scanScene(app, keep) {
    const t0 = perfNow();
    if (!app || !app.root) return { ok: false, error: "No PlayCanvas application in this context" };
    const trunc = { entities: false, attrs: false, events: false, listeners: false };
    const entities = [], entityList = [];
    const stack = [app.root];
    while (stack.length) {
        const e = stack.pop();
        if (!e) continue;
        if (e !== app.root) {
            if (entities.length >= MAX_ENTITIES) { trunc.entities = true; break; }
            const rec = { guid: guidOf(e), name: typeof e.name === "string" ? e.name : "", enabled: !!e.enabled, tags: [], scripts: [] };
            try {
                const tl = e.tags && typeof e.tags.list === "function" ? e.tags.list() : [];
                rec.tags = Array.isArray(tl) ? tl.filter(function (x) { return typeof x === "string"; }) : [];
            } catch (err) { /* keep empty */ }
            try {
                const insts = e.script && Array.isArray(e.script.scripts) ? e.script.scripts : [];
                for (let i = 0; i < insts.length; i++) {
                    const inst = insts[i];
                    if (!inst) continue;
                    const name = scriptNameOf(inst);
                    if (!name || typeof name !== "string") continue;
                    rec.scripts.push({ name: name, enabled: inst._enabled !== false, attrs: readAttrs(inst, trunc) });
                    if (keep) keep.instances.push({ inst: inst, guid: rec.guid, name: name });
                }
            } catch (err) { /* keep what was read */ }
            entities.push(rec);
            entityList.push(e);
        }
        const kids = e.children || [];
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }

    // listener registry: app events live in app._callbacks (Map name -> [EventHandle{callback, scope}]); entity-scoped
    // events (scripts with eventScope "entity") live in each entity's own _callbacks, only script-owned ones are kept.
    const listeners = {};
    let eventCount = 0, recordCount = 0;
    function addListener(name, h, target, targetGuid) {
        if (typeof name !== "string" || name === "__proto__") return;
        let list = hasOwn(listeners, name) ? listeners[name] : null;
        if (!list) {
            if (eventCount >= MAX_EVENTS) { trunc.events = true; return; }
            list = listeners[name] = [];
            eventCount++;
        }
        if (list.length >= MAX_PER_EVENT) { trunc.listeners = true; return; }
        const s = listenerScope(h, app);
        const rec = { guid: s.guid, script: s.script, scopeKind: s.scopeKind, target: target, targetGuid: targetGuid };
        list.push(rec);
        if (keep) keep.handles.push({ rec: rec, h: h });
        recordCount++;
    }
    const handlersOf = function (v) { return Array.isArray(v) ? v : (v && typeof v === "object" ? [v] : []); };
    try {
        const cb = app._callbacks;
        if (cb instanceof Map) cb.forEach(function (v, k) { const hs = handlersOf(v); for (let i = 0; i < hs.length; i++) addListener(k, hs[i], "app", null); });
        else if (cb && typeof cb === "object") Object.keys(cb).forEach(function (k) { const hs = handlersOf(cb[k]); for (let i = 0; i < hs.length; i++) addListener(k, hs[i], "app", null); });
    } catch (err) { /* registry unreadable: the scan is still useful without it */ }
    for (let n = 0; n < entityList.length; n++) {
        const e = entityList[n];
        const cb = e._callbacks;
        if (!(cb instanceof Map) || !cb.size) continue;
        const g = guidOf(e);
        cb.forEach(function (v, k) {
            const hs = handlersOf(v);
            for (let i = 0; i < hs.length; i++) {
                const h = hs[i];
                if (h && h.scope && h.scope !== e && h.scope.__scriptType) addListener(k, h, "entity", g);
            }
        });
    }
    return {
        ok: true, scene: sceneNameOf(app), entities: entities, listeners: listeners, truncated: trunc,
        counts: { entities: entities.length, events: eventCount, listeners: recordCount }, ms: perfNow() - t0
    };
}

// ---- classification (port of experience_graph.py) -----------------------------------------------------------------
const pathCache = new Map();
function splitPath(path) {
    let p = pathCache.get(path);
    if (!p) { p = path.split("."); pathCache.set(path, p); }
    return p;
}

// [[concrete_path, leaf_value, container_dict]] for a table path such as "counts[].eventToFireOnCountMet".
function resolvePath(attrs, path) {
    const out = [];
    const parts = splitPath(path);
    function rec(node, i, concrete) {
        if (!isDict(node) || i >= parts.length) return;
        const part = parts[i];
        const isList = part.slice(-2) === "[]";
        const name = isList ? part.slice(0, -2) : part;
        if (!hasOwn(node, name)) return;
        let val = node[name];
        const base = concrete ? concrete + "." + name : name;
        const last = i === parts.length - 1;
        if (isList) {
            if (typeof val === "string") val = [val];
            if (!Array.isArray(val)) return;
            for (let j = 0; j < val.length; j++) {
                const p = base + "[" + j + "]";
                if (!last) rec(val[j], i + 1, p);
                else out.push([p, val[j], node]);
            }
        } else if (!last) rec(val, i + 1, base);
        else out.push([base, val, node]);
    }
    rec(attrs, 0, "");
    return out;
}

// Every string in an attribute tree as [path, field name, value, containing dict].
function leavesOf(node, path, leaf, parent, out, depth) {
    if (depth > 6) return;
    if (typeof node === "string") out.push([path, leaf, node, parent]);
    else if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) leavesOf(node[i], path + "[" + i + "]", leaf, parent, out, depth + 1);
    } else if (isDict(node)) {
        const keys = Object.keys(node);
        for (let i = 0; i < keys.length; i++) leavesOf(node[keys[i]], path ? path + "." + keys[i] : keys[i], keys[i], node, out, depth + 1);
    }
}

function looksLikeEvent(fieldName, value) {
    if (fieldName.toLowerCase().indexOf("event") >= 0) return PLAIN_NAME_RE.test(value);
    return EVENT_NAME_RE.test(value);
}

// Per script instance: scope rules and the key of an event name.
function makeCtx(entity, script) {
    const attrs = asDict(script.attrs);
    return { ename: asStr(entity.name), guid: typeof entity.guid === "string" ? entity.guid : null, script: asStr(script.name), attrs: attrs };
}

function scopeOf(ctx, container, kind) {
    const attrs = ctx.attrs;
    if (ctx.script === "checkMultipleFlags") return "app";                  // its eventScope is a name prefix, see prefixed()
    if (ctx.script === "eventRelay" && attrs.useAlternativeScope === true) {
        return attrs[kind === LISTEN ? "triggerScope" : "sendScope"] === "entity" ? "entity" : "app";
    }
    const scope = isDict(container) && hasOwn(container, "eventScope") ? container.eventScope : attrs.eventScope;
    return scope === "entity" ? "entity" : "app";
}

function keyOf(ctx, name, scope) { return scope === "entity" ? name + "@" + (ctx.guid || ctx.ename) : name; }

// checkMultipleFlags prefixes every event with its (non-empty) eventScope string.
function prefixed(ctx, name) {
    if (ctx.script === "checkMultipleFlags") {
        const pre = asStr(ctx.attrs.eventScope).trim();
        if (pre) return pre + ":" + name;
    }
    return name;
}

// All event attribute uses of one script instance as [{kind, name, attr, key, leaf}].
function classify(ctx, ownListens) {
    const uses = [];
    const seen = new Set();
    function add(kind, name, attr, container, leaf) {
        name = prefixed(ctx, name);
        const scope = scopeOf(ctx, container, kind);
        const mark = kind + SEP + name + SEP + attr;
        if (seen.has(mark)) return;
        seen.add(mark);
        uses.push({ kind: kind, name: name, attr: attr, key: keyOf(ctx, name, scope), leaf: leaf });
    }
    const table = hasOwn(SCRIPT_EVENTS, ctx.script) ? SCRIPT_EVENTS[ctx.script] : null;
    if (table) {
        const paths = Object.keys(table);
        for (let p = 0; p < paths.length; p++) {
            const path = paths[p], kind = table[path];
            const leaf = path.slice(path.lastIndexOf(".") + 1).split("[]").join("");
            const found = resolvePath(ctx.attrs, path);
            for (let i = 0; i < found.length; i++) {
                const nm = namesOf(found[i][1]);
                for (let j = 0; j < nm.length; j++) add(kind, nm[j], found[i][0], found[i][2], leaf);
            }
        }
    }
    if (table && !LEAF_SCRIPTS.has(ctx.script)) return uses;
    const found = [];
    leavesOf(ctx.attrs, "", "", ctx.attrs, found, 0);
    const known = new Set();
    for (let i = 0; i < uses.length; i++) known.add(uses[i].attr);
    for (let i = 0; i < found.length; i++) {
        const attr = found[i][0], leaf = found[i][1], container = found[i][3];
        if (known.has(attr) || !leaf || leaf === "eventScope") continue;
        const nm = namesOf(found[i][2]);
        for (let j = 0; j < nm.length; j++) {
            const name = nm[j];
            if (LEAF_LISTEN.has(leaf)) add(LISTEN, name, attr, container, leaf);
            else if (LEAF_FIRE.has(leaf)) add(FIRE, name, attr, container, leaf);
            else if (!table && looksLikeEvent(leaf, name)) {
                add(ownListens.has(ctx.guid + SEP + ctx.script + SEP + name) ? LISTEN : FIRE, name, attr, container, leaf);
            }
        }
    }
    return uses;
}

// ---- edges (what has to happen for an event to fire) ----------------------------------------------------------------
function codeArgs(code) { return (typeof code === "string" || typeof code === "number") && code !== "" ? [code] : null; }

// Edges for the FIRE uses of one script instance; scripts with dedicated logic override the generic rule.
function edgesFor(ctx, uses, itemsById) {
    const a = ctx.attrs, sname = ctx.script;
    const listens = uses.filter(function (u) { return u.kind === LISTEN; });
    const covered = new Set(), edges = [];
    const byAttr = new Map();
    for (let i = 0; i < uses.length; i++) byAttr.set(uses[i].attr, uses[i]);
    const edge = function (out, needs) {
        edges.push({ entity: ctx.ename, guid: ctx.guid, script: sname, outKey: out.key, outAttr: out.attr, needs: needs });
        covered.add(out.attr);
    };
    const fire = function (prefix) { return uses.filter(function (u) { return u.kind === FIRE && u.attr.indexOf(prefix) === 0; }); };
    const need = function (u, count, args) { return { key: u.key, attr: u.attr, count: count === undefined ? 1 : count, args: args || null }; };
    const needAll = function (list) { return list.map(function (s) { return need(s); }); };
    const idxOf = function (re, attr) { const m = re.exec(attr); return m ? parseInt(m[1], 10) : -1; };

    if (sname === "countEvents") {
        const src = listens.filter(function (u) { return u.attr === "eventToCount"; });
        fire("counts[").forEach(function (u) {
            const i = idxOf(/^counts\[(\d+)\]/, u.attr);
            const target = i >= 0 ? num(asDict(asList(a.counts)[i]).targetCount) : 1;
            edge(u, src.map(function (s) { return need(s, target); }));
        });
    } else if (sname === "eventFlagChecker") {
        const flags = asList(a.events).map(function (f, i) { return [i, asDict(f)]; });
        const sets = [], checks = [];
        flags.forEach(function (p) {
            const sk = "events[" + p[0] + "].setTrueEvent", ck = "events[" + p[0] + "].checkFlagEvent";
            if (p[1].flag !== true && byAttr.has(sk)) sets.push(byAttr.get(sk));
            if (byAttr.has(ck)) checks.push(byAttr.get(ck));
        });
        fire("allTrueEvent").forEach(function (u) { edge(u, needAll(sets.length ? sets : checks)); });
        flags.forEach(function (p) {
            const i = p[0], f = p[1];
            const chk = byAttr.get("events[" + i + "].checkFlagEvent");
            const st = byAttr.get("events[" + i + "].setTrueEvent");
            ["onTrueEvent", "onFalseEvent"].forEach(function (suffix) {
                const u = byAttr.get("events[" + i + "]." + suffix);
                if (u === undefined) return;
                const ns = [];
                if (chk !== undefined) ns.push(need(chk));
                if (suffix === "onTrueEvent" && f.flag !== true && st !== undefined) ns.push(need(st));
                edge(u, ns);
            });
        });
    } else if (sname === "checkEventSequence") {
        const seq = listens.filter(function (u) { return u.attr.indexOf("sequence[") === 0; });
        const counts = new Map(), first = new Map();
        seq.forEach(function (u) { counts.set(u.key, (counts.get(u.key) || 0) + 1); first.set(u.key, u); });
        const distinct = Array.from(counts.keys());
        fire("eventToEmitOnCorrect").forEach(function (u) {
            edge(u, distinct.map(function (k) { return need(first.get(k), counts.get(k)); }));
        });
        fire("progressEvents[").forEach(function (u) {
            const i = idxOf(/^progressEvents\[(\d+)\]/, u.attr);
            const n = i >= 0 ? i + 1 : seq.length;
            const part = seq.slice(0, n);
            const c2 = new Map();
            part.forEach(function (s) { c2.set(s.key, (c2.get(s.key) || 0) + 1); });
            edge(u, Array.from(c2.keys()).map(function (k) { return need(first.get(k), c2.get(k)); }));
        });
    } else if (sname === "checkEventPattern") {
        const required = listens.filter(function (u) { return u.attr.indexOf("requiredEvents[") === 0; });
        const mode = hasOwn(a, "checkMode") ? a.checkMode : "confirm";
        const confirm = byAttr.has("confirmEvent") && mode === "confirm" ? [byAttr.get("confirmEvent")] : [];
        fire("eventToEmitOnCorrect").forEach(function (u) { edge(u, needAll(required.concat(confirm))); });
    } else if (sname === "checkCodeOnEvent") {
        const trig = byAttr.get("eventToCheckOn");
        const args = codeArgs(a.correctCode);
        if (trig !== undefined) fire("eventToEmitOnCorrect").forEach(function (u) { edge(u, [need(trig, 1, args)]); });
    } else if (sname === "sendEventOnCodeCorrect") {
        const trig = byAttr.get("listenForCodeEvent");
        if (trig !== undefined) {
            fire("codeEvents[").forEach(function (u) {
                const i = idxOf(/^codeEvents\[(\d+)\]/, u.attr);
                const entry = i >= 0 ? asDict(asList(a.codeEvents)[i]) : {};
                edge(u, [need(trig, 1, codeArgs(entry.code))]);
            });
        }
    } else if (sname === "useItem") {
        const top = asStr(a.itemId).trim();
        fire("").forEach(function (u) {
            const i = idxOf(/^validItems\[(\d+)\]/, u.attr);
            let item = i >= 0 ? asStr(asDict(asList(a.validItems)[i]).itemId).trim() : top;
            item = item || top;
            const ns = item && itemsById.has("item:" + item) ? [{ key: "item:" + item, attr: "itemId", count: 1, args: null }] : [];
            edge(u, ns);
        });
    } else if (sname === "door") {
        fire("doorOpenedEvent").forEach(function (u) {
            const ns = a.isLocked === true && byAttr.has("onUnlockEvent") ? [need(byAttr.get("onUnlockEvent"))] : [];
            edge(u, ns);
        });
    }

    // the generic rule: every other fired event needs everything the script listens for
    let drop = null;
    if ((sname === "pushButton" || sname === "toggleSwitch" || sname === "multiPositionSwitch") && a.hasPower !== true) {
        drop = ["onPowerEvent", "turnPowerOnEvent", "turnPowerOffEvent"];
    }
    if ((sname === "slider" || sname === "snappingSlider") && a.controlEnabled === true) drop = ["enabledEvent"];
    const needs = [];
    listens.forEach(function (u) { if (!drop || drop.indexOf(u.attr) < 0) needs.push({ key: u.key, attr: u.attr, count: 1, args: null }); });
    uses.forEach(function (u) {
        if (u.kind === FIRE && !covered.has(u.attr)) {
            edges.push({
                entity: ctx.ename, guid: ctx.guid, script: sname, outKey: u.key, outAttr: u.attr,
                needs: needs.map(function (n) { return { key: n.key, attr: n.attr, count: 1, args: null }; })
            });
        }
    });
    return edges;
}

function rootKeysOf(an, byOut) {
    // A numbered progress event is always a root. The completion event and the payload progress event only when
    // something in the scene fires them; with nothing else, the completion event.
    const numbered = an.progressEvents.filter(function (p) { return p.progress !== null; })
        .sort(function (x, y) { return x.progress - y.progress; });
    let roots = numbered.map(function (p) { return p.key; });
    const optional = an.goalEvents.concat(an.progressEvents.filter(function (p) { return p.progress === null; }).map(function (p) { return p.key; }));
    roots = roots.concat(optional.filter(function (k) { return (byOut.get(k) || []).length > 0; }));
    if (!roots.length) roots = an.goalEvents.slice();
    return Array.from(new Set(roots));
}

// {dist, count, args} for every event that leads to one of the roots (distance 0).
function closureOf(byOut, roots) {
    const dist = new Map();
    roots.forEach(function (r) { dist.set(r, 0); });
    const queue = roots.slice();
    for (let h = 0; h < queue.length; h++) {
        const cur = queue[h];
        const es = byOut.get(cur) || [];
        for (let i = 0; i < es.length; i++) {
            for (let j = 0; j < es[i].needs.length; j++) {
                const k = es[i].needs[j].key;
                if (!dist.has(k)) { dist.set(k, dist.get(cur) + 1); queue.push(k); }
            }
        }
    }
    const count = new Map(), args = new Map();
    roots.forEach(function (r) { count.set(r, 1); });
    const order = Array.from(dist.keys()).sort(function (x, y) { return dist.get(x) - dist.get(y); });
    for (let o = 0; o < order.length; o++) {
        const key = order[o];
        const c = count.has(key) ? count.get(key) : 1;
        const es = byOut.get(key) || [];
        for (let i = 0; i < es.length; i++) {
            for (let j = 0; j < es[i].needs.length; j++) {
                const n = es[i].needs[j];
                if (dist.get(n.key) === dist.get(key) + 1) {
                    const need = n.key.indexOf("item:") === 0 ? 1 : c * n.count;           // an item is obtained once
                    count.set(n.key, Math.max(count.has(n.key) ? count.get(n.key) : 1, Math.min(need, MAX_COUNT)));
                }
                if (n.args && n.args.length && !args.has(n.key)) args.set(n.key, n.args.slice());
            }
        }
    }
    return { dist: dist, count: count, args: args };
}

function eventLabel(e) {
    if (e.scope === "item") return "[item " + e.name + "]";
    return e.scope === "app" ? e.name : e.name + " (on " + e.entity + ")";
}

// Build the event graph from a scan. Never throws on malformed data.
function analyzeScan(scan) {
    const an = {
        scene: "", ok: true, hasQuestManager: false, events: new Map(), interactables: [], goalEvents: [], progressEvents: [],
        notes: [], edges: [], entityCount: 0, rootKeys: [], byOut: new Map(), closure: null
    };
    if (!isDict(scan)) { an.ok = false; an.notes.push("The scan is not an object; nothing could be analysed."); return an; }
    if (scan.ok === false) { an.ok = false; an.notes.push("The scan failed: " + (asStr(scan.error) || "unknown error")); return an; }
    an.scene = asStr(scan.scene);
    const entities = asList(scan.entities).filter(isDict);
    an.entityCount = entities.length;
    const trunc = asDict(scan.truncated);
    const truncKeys = Object.keys(trunc).filter(function (k) { return trunc[k] === true; });
    if (truncKeys.length) an.notes.push("The scan was truncated (" + truncKeys.join(", ") + "); the guess may be incomplete.");

    const listenersReg = asDict(scan.listeners);
    const ownListens = new Set();
    const entityNames = new Map();
    entities.forEach(function (e) { if (typeof e.guid === "string") entityNames.set(e.guid, asStr(e.name)); });
    Object.keys(listenersReg).forEach(function (name) {
        asList(listenersReg[name]).forEach(function (r0) {
            const r = asDict(r0);
            if (r.script && r.guid && (hasOwn(r, "target") ? r.target : "app") === "app") ownListens.add(r.guid + SEP + r.script + SEP + name);
        });
    });

    // item ids that can be obtained (collectable / focus item that can be taken)
    const items = new Map();
    const contexts = [];
    entities.forEach(function (e) {
        const scripts = asList(e.scripts);
        scripts.forEach(function (s) {
            if (!isDict(s) || !asStr(s.name)) return;
            const ctx = makeCtx(e, s);
            contexts.push([e, ctx]);
            if (ctx.script === "collectable" && asStr(ctx.attrs.itemId).trim()) {
                const k = "item:" + ctx.attrs.itemId.trim();
                if (!items.has(k)) items.set(k, []);
                items.get(k).push([e, ctx, "itemId"]);
            }
            if (ctx.script === "focusItem") {
                const iid = asStr(asDict(ctx.attrs.core).itemId).trim();
                if (iid && scripts.some(function (x) { return isDict(x) && asStr(x.name) === "focusItemTakeable"; })) {
                    const k = "item:" + iid;
                    if (!items.has(k)) items.set(k, []);
                    items.get(k).push([e, ctx, "core.itemId"]);
                }
            }
        });
    });

    const infos = an.events;
    function info(key, name, scope, ctx) {
        let ev = infos.get(key);
        if (ev === undefined) {
            const ent = scope === "entity" && ctx;
            ev = {
                key: key, name: name, scope: scope, entity: ent ? ctx.ename : null, guid: ent ? ctx.guid : null,
                firedBy: [], listenedBy: [], lset: new Set(), isGoal: false, isProgress: false, progress: null,
                inGoalClosure: false, depth: null, count: 1, origin: "", args: []
            };
            infos.set(key, ev);
        }
        return ev;
    }
    function addListened(ev, ename, script) {
        const k = ename + SEP + script;
        if (ev.lset.has(k)) return;
        ev.lset.add(k);
        ev.listenedBy.push([ename, script]);
    }

    const firesByEntity = new Map();
    const questUses = [];
    contexts.forEach(function (pair) {
        const e = pair[0], ctx = pair[1];
        const uses = classify(ctx, ownListens);
        uses.forEach(function (u) {
            const scope = u.key !== u.name ? "entity" : "app";
            const ev = info(u.key, u.name, scope, ctx);
            if (u.kind === FIRE) {
                ev.firedBy.push([ctx.ename, ctx.script, u.attr]);
                if (!firesByEntity.has(e)) firesByEntity.set(e, []);
                firesByEntity.get(e).push(u.key);
            } else addListened(ev, ctx.ename, ctx.script);
        });
        const es = edgesFor(ctx, uses, items);
        for (let i = 0; i < es.length; i++) an.edges.push(es[i]);
        if (ctx.script === QUEST_SCRIPT) questUses.push(ctx);
    });

    items.forEach(function (producers, key) {
        const ev = info(key, key.slice(5), "item", null);
        producers.forEach(function (p) {                                       // the producing entity counts as firing the item
            const e = p[0], ctx = p[1], attr = p[2];
            ev.firedBy.push([ctx.ename, ctx.script, attr]);
            an.edges.push({ entity: ctx.ename, guid: ctx.guid, script: ctx.script, outKey: key, outAttr: attr, needs: [] });
            if (!firesByEntity.has(e)) firesByEntity.set(e, []);
            firesByEntity.get(e).push(key);
        });
    });

    // listeners registered by scripts the attributes did not reveal
    Object.keys(listenersReg).forEach(function (name) {
        const ev = infos.get(name);
        if (ev === undefined || ev.scope !== "app") return;
        asList(listenersReg[name]).forEach(function (r0) {
            const r = asDict(r0);
            const script = asStr(r.script);
            if (script) addListened(ev, entityNames.has(r.guid) ? entityNames.get(r.guid) : "", script);
        });
    });

    // ---- quest manager ----
    an.hasQuestManager = questUses.length > 0;
    if (!questUses.length) {
        an.notes.push("No discordQuestManager script in this scene: it is not a quest puzzle, or the quest logic lives in game code.");
    }
    questUses.forEach(function (ctx) {
        const a = ctx.attrs;
        const done = hasOwn(a, "questCompleteEvent") ? asStr(a.questCompleteEvent) : "quest:complete";
        const prog = hasOwn(a, "questProgressEvent") ? asStr(a.questProgressEvent) : "quest:progress";
        if (done && an.goalEvents.indexOf(done) < 0) an.goalEvents.push(done);
        if (prog) an.progressEvents.push({ event: prog, key: prog, progress: null });
        asList(a.progressEvents).forEach(function (p0) {
            const p = asDict(p0);
            if (asStr(p.event)) {
                an.progressEvents.push({ event: p.event, key: p.event, progress: typeof p.progress === "number" && Number.isFinite(p.progress) ? Math.trunc(p.progress) : null });
            }
        });
    });
    an.goalEvents.forEach(function (name) { info(name, name, "app", null).isGoal = true; });
    an.progressEvents.forEach(function (p) {
        const ev = info(p.key, p.event, "app", null);
        ev.isProgress = true;
        ev.progress = p.progress;
    });
    questUses.forEach(function (ctx) {
        an.goalEvents.concat(an.progressEvents.map(function (p) { return p.key; })).forEach(function (name) {
            addListened(infos.get(name), ctx.ename, ctx.script);
        });
    });

    // ---- closure ----
    const byOut = an.byOut;
    an.edges.forEach(function (e) {
        if (!byOut.has(e.outKey)) byOut.set(e.outKey, []);
        byOut.get(e.outKey).push(e);
    });
    an.rootKeys = rootKeysOf(an, byOut);
    const cl = closureOf(byOut, an.rootKeys);
    an.closure = cl;
    cl.dist.forEach(function (d, key) {
        const ev = infos.get(key);
        if (!ev) return;
        ev.inGoalClosure = true; ev.depth = d; ev.count = cl.count.has(key) ? cl.count.get(key) : 1;
        ev.args = cl.args.has(key) ? cl.args.get(key) : [];
    });
    infos.forEach(function (ev) {
        const seenFired = new Set(), uniq = [];
        ev.firedBy.forEach(function (t) { const k = t.join(SEP); if (!seenFired.has(k)) { seenFired.add(k); uniq.push(t); } });
        ev.firedBy = uniq;
        if (!ev.inGoalClosure) return;
        const es = byOut.get(ev.key) || [];
        if (!es.length) ev.origin = "external";
        else if (es.some(function (e) { return INTERACTABLE_SCRIPTS.has(e.script); })) ev.origin = "interaction";
        else if (es.some(function (e) { return !e.needs.length; })) ev.origin = "automatic";
        else ev.origin = "derived";
    });

    // ---- interactables ----
    entities.forEach(function (e) {
        const names = asList(e.scripts).filter(isDict).map(function (s) { return asStr(s.name); });
        const tags = asList(e.tags).filter(function (t) { return typeof t === "string"; });
        if (tags.indexOf("interactable") >= 0 || names.some(function (n) { return INTERACTABLE_SCRIPTS.has(n); })) {
            const fires = Array.from(new Set(firesByEntity.get(e) || []));
            an.interactables.push({
                entity: asStr(e.name), guid: typeof e.guid === "string" ? e.guid : null, tags: tags,
                scripts: names.filter(function (n) { return n; }), fires: fires,
                inClosure: fires.some(function (k) { const ev = infos.get(k); return !!ev && ev.inGoalClosure; })
            });
        }
    });
    return an;
}

// ---- roles ("collect holocube 1/3") ---------------------------------------------------------------------------------
const VERBS = {
    collectable: "collect", scoreable: "collect", focusItemTakeable: "collect", focusItem: "examine", focusItemUsable: "use",
    focusItemNestable: "place", useItem: "use", pushButton: "press", keypad: "enter code", slider: "move",
    snappingSlider: "move", snappingDial: "turn", toggleSwitch: "flip", multiPositionSwitch: "set",
    door: "open", itemManipulator: "manipulate", sendEventOnClickCollider: "click", uiSendEvent: "click"
};

function firstSegment(name) { const m = /^[^:\/._\-\s]+/.exec(name); return m ? m[0] : ""; }
function entityNoun(name) {
    const s = name.replace(/[\s_\-]*\(?\d+\)?\s*$/, "").trim().toLowerCase();
    return s || name.trim().toLowerCase() || "object";
}

// Best-effort human text per objective entity. Entities that serve the same purpose (same verb and the same noun,
// where the noun is the first word of the closure event they feed) are numbered in scene order: "use holocube 2/3".
function computeRoles(an) {
    const ev = an.events;
    const inClosure = function (k) { const e = ev.get(k); return !!e && e.inGoalClosure; };
    const consumers = new Map();                                            // need key -> out keys that need it
    const byGuid = new Map();                                               // guid -> closure edges the entity produces
    an.edges.forEach(function (e) {
        e.needs.forEach(function (n) {
            if (!consumers.has(n.key)) consumers.set(n.key, []);
            consumers.get(n.key).push(e.outKey);
        });
        if (e.guid && inClosure(e.outKey)) {
            if (!byGuid.has(e.guid)) byGuid.set(e.guid, []);
            byGuid.get(e.guid).push(e);
        }
    });
    const questish = new Set(["quest"]);
    an.goalEvents.concat(an.progressEvents.map(function (p) { return p.key; })).forEach(function (n) { questish.add(firstSegment(n).toLowerCase()); });
    const nounOf = function (key, fallback) {
        const e = ev.get(key);
        const seg = firstSegment(e ? e.name : key);
        return !seg || questish.has(seg.toLowerCase()) ? fallback : seg;
    };

    const descs = [];
    an.interactables.forEach(function (it) {
        if (!it.inClosure || !it.guid) return;
        const list = byGuid.get(it.guid) || [];
        const pe = list.filter(function (e) { return INTERACTABLE_SCRIPTS.has(e.script); })[0] || list[0];
        const d = { guid: it.guid, verb: "interact with", noun: entityNoun(it.entity), count: 1, hint: "", text: "" };
        if (pe) {
            if (pe.outKey.indexOf("item:") === 0) {
                const itemId = pe.outKey.slice(5);
                const target = (consumers.get(pe.outKey) || []).filter(function (k) { return inClosure(k) && k.indexOf("item:") !== 0; })[0];
                d.verb = "collect";
                d.noun = target ? nounOf(target, itemId) : itemId;
            } else {
                d.verb = VERBS[pe.script] && hasOwn(VERBS, pe.script) ? VERBS[pe.script] : "interact with";
                d.noun = nounOf(pe.outKey, entityNoun(it.entity));
                d.count = ev.get(pe.outKey).count;
            }
        }
        for (let i = 0; i < it.fires.length && !d.hint; i++) {
            const e = ev.get(it.fires[i]);
            if (e && e.inGoalClosure && e.args.length) d.hint = e.args.join(", ");
        }
        d.group = d.verb + SEP + d.noun;
        descs.push(d);
    });
    const sizes = new Map(), seen = new Map();
    descs.forEach(function (d) { sizes.set(d.group, (sizes.get(d.group) || 0) + 1); });
    const roles = {};
    descs.forEach(function (d) {
        const n = sizes.get(d.group), i = (seen.get(d.group) || 0) + 1;
        seen.set(d.group, i);
        let text;
        if (d.verb === "enter code") text = d.hint ? "enter code " + d.hint : "enter code on " + d.noun;
        else text = d.verb + " " + d.noun;
        if (n > 1) text += " " + i + "/" + n;
        if (d.verb !== "enter code" && d.count > n) text += n > 1 ? " (x" + d.count + " total)" : " x" + d.count;
        roles[d.guid] = text;
    });
    return roles;
}

// ---- state, build and API ---------------------------------------------------------------------------------------------
function emptyState(err) {
    return {
        ok: false, hasQuestManager: false, goalEvents: [], closureEvents: [], objectiveGuids: [], roles: {}, scene: "",
        builtAt: 0, progressEvents: [], closureDetail: [], entityCount: 0, notes: [], truncated: {}, builds: 0, buildMs: 0,
        error: err || null, source: source.emptySummary("idle", ""), recipe: null
    };
}

// The script source analysis (see SOURCE_SRC) runs in time slices after a build and reports back here.
const source = createSource({ publish: onSourceResult });

let current = emptyState(null);
let objectiveSet = new Set();
let derivedNames = new Set();
let originByName = new Map();
let changeSig = "";
let builds = 0;
const listeners = [];

function notify() {
    for (let i = 0; i < listeners.length; i++) {
        try { listeners[i](current); } catch (err) { warnOnce("onChange callback threw", err); }
    }
}

// onChange fires when the quest objectives, the closure or the guessed recipe differ from the last announcement.
function announceChange() {
    const sig = JSON.stringify([current.ok, current.hasQuestManager, current.goalEvents, current.closureEvents, current.objectiveGuids, current.roles, current.recipe]);
    if (sig !== changeSig) { changeSig = sig; notify(); }
}

// A finished source analysis replaces source and recipe of the state (a new state object, like a build).
function onSourceResult(res) {
    current = Object.assign({}, current, { source: res.source, recipe: res.recipe });
    announceChange();
}

function buildNow(app) {
    const t0 = perfNow();
    let next, scan = null, refs = null;
    try {
        refs = { instances: [], handles: [] };
        scan = scanScene(app, refs);
        if (!scan.ok) throw new Error(scan.error || "scan failed");
        const an = analyzeScan(scan);
        const roles = computeRoles(an);
        const detail = [];
        an.events.forEach(function (e) {
            if (e.inGoalClosure) detail.push(e);
        });
        detail.sort(function (x, y) {
            const dx = -(x.depth || 0), dy = -(y.depth || 0);
            if (dx !== dy) return dx - dy;
            const lx = eventLabel(x), ly = eventLabel(y);
            return lx < ly ? -1 : lx > ly ? 1 : 0;
        });
        const objectiveGuids = [];
        an.interactables.forEach(function (it) { if (it.inClosure && it.guid) objectiveGuids.push(it.guid); });
        next = {
            ok: true, hasQuestManager: an.hasQuestManager, goalEvents: an.goalEvents.slice(), closureEvents: detail.map(function (e) { return e.key; }),
            objectiveGuids: objectiveGuids, roles: roles, scene: an.scene, builtAt: Date.now(),
            progressEvents: an.progressEvents.map(function (p) { return { event: p.event, progress: p.progress }; }),
            closureDetail: detail.map(function (e) {
                return {
                    key: e.key, name: e.name, scope: e.scope, entity: e.entity, depth: e.depth, count: e.count, origin: e.origin,
                    args: e.args.slice(), goal: e.isGoal, progress: e.progress
                };
            }),
            entityCount: an.entityCount, notes: an.notes.slice(), truncated: Object.assign({}, scan.truncated), builds: 0, buildMs: 0, error: null,
            source: source.emptySummary("pending", ""), recipe: null
        };
        if (an.hasQuestManager) {
            // a stock-block quest scene: its objectives come from the attributes above, reading the script sources would only cost time
            source.cancel();
            next.source = source.emptySummary("skipped", "the scene has a discordQuestManager, the quest logic is in the stock blocks");
        } else if (current.ok && current.scene === next.scene) {
            // the same scene: the previous guess stays available while the new analysis runs
            next.source = Object.assign({}, current.source, { status: "pending" });
            next.recipe = current.recipe;
        }
        const names = new Set(), origins = new Map();
        an.events.forEach(function (e) {
            if (e.scope === "item") return;
            if (e.firedBy.length || e.origin === "derived" || e.origin === "automatic") { names.add(e.name); names.add(e.key); }
            if (e.inGoalClosure) {
                if (!origins.has(e.name)) origins.set(e.name, e.origin);
                origins.set(e.key, e.origin);
            }
        });
        derivedNames = names;
        originByName = origins;
        objectiveSet = new Set(objectiveGuids);
    } catch (err) {
        warnOnce("scene analysis failed", err);
        next = emptyState(err && err.message ? String(err.message) : String(err));
        derivedNames = new Set(); originByName = new Map(); objectiveSet = new Set();
        source.cancel();
    }
    builds++;
    next.builds = builds;
    next.buildMs = perfNow() - t0;
    current = next;
    announceChange();
    if (next.ok && !next.hasQuestManager) source.request({ scan: scan, refs: refs });
}

function sceneSignature(app) {
    let entities = 0, insts = 0;
    const stack = [app.root];
    while (stack.length && entities <= MAX_ENTITIES) {
        const e = stack.pop();
        if (!e) continue;
        if (e !== app.root) {
            entities++;
            const s = e.script && Array.isArray(e.script.scripts) ? e.script.scripts : null;
            if (s) insts += s.length;
        }
        const kids = e.children;
        if (kids && kids.length) for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    // the number of event names with a listener is part of the key: scripts that register their handlers late change the
    // picture the source analysis reads
    return { entities: entities, insts: insts, key: entities + ":" + insts + ":" + sceneNameOf(app) + ":" + registrySize(app) };
}

function registrySize(app) {
    try {
        const cb = app._callbacks;
        if (cb instanceof Map) return cb.size;
        if (cb && typeof cb === "object") return Object.keys(cb).length;
    } catch (err) { /* unreadable registry: it counts as empty */ }
    return 0;
}

const api = {
    refresh: function () {
        try {
            const app = getApp();
            if (!app || !app.root) return;
            buildNow(app);
            lastBuildAt = Date.now();
            try { builtSig = sceneSignature(app).key; } catch (err) { builtSig = null; }
        } catch (err) { warnOnce("refresh failed", err); }
    },
    state: function () { return current; },
    isObjective: function (entity) {
        try { return !!entity && typeof entity.getGuid === "function" && objectiveSet.has(entity.getGuid()); } catch (err) { return false; }
    },
    role: function (entity) {
        try {
            if (!entity || typeof entity.getGuid !== "function") return "";
            const g = entity.getGuid();
            return hasOwn(current.roles, g) ? current.roles[g] : "";
        } catch (err) { return ""; }
    },
    isDerived: function (eventName) {
        try { return typeof eventName === "string" && derivedNames.has(eventName); } catch (err) { return false; }
    },
    eventOrigin: function (eventName) {
        try { return typeof eventName === "string" && originByName.has(eventName) ? originByName.get(eventName) : ""; } catch (err) { return ""; }
    },
    // The guessed completion recipe (see state().recipe) as a fresh copy, or null. With { usableOnly: true } only the
    // entries the guard analysis allows are kept (see usable in state().source.entries); null when none is left.
    guessedRecipe: function (opts) {
        try {
            const r = current.recipe;
            if (!r) return null;
            const copy = JSON.parse(JSON.stringify(r));
            if (!opts || opts.usableOnly !== true) return copy;
            const info = current.source.entries;
            const kept = [], left = [];
            copy.entries.forEach(function (e, i) {
                if (info[i] && info[i].name === e.name && info[i].usable) kept.push(e);
                else left.push(e.name + " (" + (info[i] ? info[i].reason : "no analysis") + ")");
            });
            if (!kept.length) return null;
            copy.entries = kept;
            if (left.length) copy.notes += " Not offered: " + left.join("; ") + ".";
            return copy;
        } catch (err) { return null; }
    },
    onChange: function (cb) {
        if (typeof cb !== "function") return function () {};
        listeners.push(cb);
        return function () { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    _scan: function () { return scanScene(getApp()); },
    _analyze: function (scan) { return analyzeScan(scan); },
    _sourceDrain: function () { return source.drain(); },
    _sourceAnalyze: function (scan, knowledge) { return source.analyze(scan, knowledge); },
    _sourceScan: function () { return source.lastScan(); },
    _sourceStats: function () { return source.stats(); }
};
window.__adventurerGraph = api;

// ---- polling: build once the scene is populated and stable, rebuild when its size changes -----------------------------
let builtSig = null, prevSig = null, lastBuildAt = 0, stable = 0, waits = 0, seenApp = false;

function tick() {
    let delay = builtSig === null ? POLL_FIRST_MS : POLL_BUILT_MS;
    try {
        const app = getApp();
        if (app && app.root) {
            seenApp = true;
            const s = sceneSignature(app);
            stable = s.key === prevSig ? stable + 1 : 0;
            prevSig = s.key;
            if (builtSig === null) {
                if (s.entities > 0 && ((s.insts > 0 && stable >= 1) || stable >= STABLE_POLLS_NO_SCRIPTS)) {
                    builtSig = s.key;
                    lastBuildAt = Date.now();
                    buildNow(app);
                }
            } else if (s.key !== builtSig && Date.now() - lastBuildAt >= MIN_REBUILD_MS) {
                builtSig = s.key;
                lastBuildAt = Date.now();
                buildNow(app);
            }
        } else if (!seenApp && ++waits > MAX_WAIT_POLLS) {
            warnOnce("gave up waiting for the PlayCanvas app", null);
            return;
        }
    } catch (err) {
        warnOnce("poll failed", err);
    }
    setTimeout(tick, delay);
}
setTimeout(tick, POLL_FIRST_MS);
`;

export const SOURCE_SRC: string = String.raw`
// ---- script source analysis: port of the source-level part of workbench/js/experience_scan.js (static facts of the
// script types, runtime listener attribution) and of workbench/experience_source.py (event graph, goal, chain, guards,
// guessed recipe). Everything below works on strings and plain data: the source of a prototype method is read through
// Function.prototype.toString, never run. Long work runs as generators that yield after every unit, a small scheduler
// runs them in slices of about SLICE_MS (see "scheduler").
function createSource(host) {
    const fnToString = Function.prototype.toString;
    const BT = String.fromCharCode(96);
    const MAX_SRC = 80000, MAX_METHODS = 160, MAX_FACT_BYTES = 600000, MAX_LIST = 40, MAX_INLINE = 60, BIG_TEXT = 6000;
    const SLICE_MS = 4, SLICE_GAP_MS = 8, IDLE_TIMEOUT_MS = 1000;
    const ID = "[A-Za-z_$][\\w$]*";
    const PATH = "(?:\\s*\\[[^\\]]*\\]|\\s*\\.\\s*" + ID + ")";               // [index] or .name, repeated
    const QUOTED = /"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'/.source;
    const SELF_IGNORE = new Set(["app", "entity", "enabled", "fire", "on", "off", "once", "has", "hasEvent", "script", "constructor"]);
    const MUTATORS = "push|unshift|splice|set|add|delete|pop|shift|clear|assign";
    const WRAPPED = /(?<![\w$.])[A-Za-z_$][\w$]*\s*\.\s*(?:apply|call)\s*\(\s*this\b/;
    const ARISE = /(?<![\w$.])window\s*\.\s*arise\b|(?<![\w$.])arise\s*\.\s*(?:postMessage|on|off|once)\b/;

    const rxCache = new Map();                       // compiled patterns; only used with matchAll or without the g flag
    function rx(source, flags) {
        const key = flags + "/" + source;
        let r = rxCache.get(key);
        if (!r) {
            if (rxCache.size > 3000) rxCache.clear();
            r = new RegExp(source, flags);
            rxCache.set(key, r);
        }
        return r;
    }
    const esc = function (s) { return s.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&"); };
    const normPath = function (s) { return s.replace(/\s+/g, "").replace(/\[[^\]]*\]/g, "[]"); };
    const isStr = function (v) { return typeof v === "string"; };
    function setOwn(o, k, v) { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); }
    function skipWs(s, i) { while (i < s.length && /\s/.test(s[i])) i++; return i; }

    function skipQuoted(s, i) {                      // s[i] is a quote: the index after its closing quote
        const q = s[i];
        let j = i + 1;
        while (j < s.length) {
            const c = s[j];
            if (c === "\\") j += 2;
            else if (c === q) return j + 1;
            else if (q === BT && c === "$" && s[j + 1] === "{") { const k = matchClose(s, j + 1); j = k < 0 ? s.length : k + 1; }
            else j++;
        }
        return s.length;
    }
    function regexStarts(s, i) {                     // is the "/" at s[i] the start of a regex literal (not a division)?
        let j = i - 1;
        while (j >= 0 && /\s/.test(s[j])) j--;
        if (j < 0 || "(,=:[!&|?{};+-*%<>~^".indexOf(s[j]) >= 0) return true;
        const m = /[A-Za-z_$][\w$]*$/.exec(s.slice(Math.max(0, j - 12), j + 1));
        return !!m && /^(return|typeof|case|do|else|in|of|void|delete|throw|new|instanceof)$/.test(m[0]);
    }
    function skipRegex(s, i) {                       // s[i] is the "/" opening a regex literal: the index after it and its flags
        let j = i + 1, cls = false;
        while (j < s.length) {
            const c = s[j];
            if (c === "\\") j += 2;
            else if (cls) { if (c === "]") cls = false; j++; }
            else if (c === "[") { cls = true; j++; }
            else if (c === "/") { j++; while (j < s.length && /[a-z]/i.test(s[j])) j++; return j; }
            else if (c === "\n") return i + 1;       // not a regex after all
            else j++;
        }
        return s.length;
    }
    function matchClose(s, open) {                   // index of the bracket closing s[open] ("{", "(" or "["), or -1
        const o = s[open], c = o === "{" ? "}" : o === "(" ? ")" : "]";
        let depth = 0;
        for (let i = open; i < s.length; i++) {
            const ch = s[i];
            if (ch === '"' || ch === "'" || ch === BT) i = skipQuoted(s, i) - 1;
            else if (ch === "/" && s[i + 1] !== "/" && s[i + 1] !== "*" && regexStarts(s, i)) i = skipRegex(s, i) - 1;
            else if (ch === o) depth++;
            else if (ch === c && --depth === 0) return i;
        }
        return -1;
    }
    function stripComments(s) {
        if (s.indexOf("//") < 0 && s.indexOf("/*") < 0) return s;
        let out = "", from = 0, i = 0;
        while (i < s.length) {
            const ch = s[i];
            if (ch === '"' || ch === "'" || ch === BT) i = skipQuoted(s, i);
            else if (ch === "/" && s[i + 1] === "/") { out += s.slice(from, i); while (i < s.length && s[i] !== "\n") i++; from = i; }
            else if (ch === "/" && s[i + 1] === "*") { const j = s.indexOf("*/", i + 2); out += s.slice(from, i) + " "; i = j < 0 ? s.length : j + 2; from = i; }
            else if (ch === "/" && regexStarts(s, i)) i = skipRegex(s, i);
            else i++;
        }
        return out + s.slice(from);
    }
    function readString(s, i) {                      // {v, end} for a plain string literal at s[i], else null
        const q = s[i];
        if (q !== '"' && q !== "'") return null;
        let j = i + 1, v = "";
        while (j < s.length) {
            const c = s[j];
            if (c === "\\") { v += s[j + 1] || ""; j += 2; }
            else if (c === q) return { v: v, end: j + 1 };
            else { v += c; j++; }
        }
        return null;
    }
    function objectKeys(s, open) {                   // top-level keys of the object literal at s[open] === "{"
        const close = matchClose(s, open);
        if (close < 0) return [];
        const keys = [];
        const keyRe = rx("^\\s*(?:(" + ID + ")|\"([^\"]*)\"|'([^']*)')\\s*:", "");
        let start = open + 1;
        const seg = function (a, b) { const m = keyRe.exec(s.slice(a, b)); if (m) keys.push(m[1] || m[2] || m[3]); };
        for (let i = open + 1; i < close; i++) {
            const c = s[i];
            if (c === '"' || c === "'" || c === BT) i = skipQuoted(s, i) - 1;
            else if (c === "{" || c === "(" || c === "[") { const k = matchClose(s, i); if (k < 0) break; i = k; }
            else if (c === ",") { seg(start, i); start = i + 1; }
        }
        seg(start, close);
        return keys.slice(0, MAX_LIST);
    }

    // String and regex literal bodies replaced by NUL characters (same length, quotes kept): the patterns below must not
    // match code that only appears inside a string. Event names are read from the unmasked text at the same index.
    function maskLiterals(s) {
        let out = "", from = 0, i = 0;
        while (i < s.length) {
            const ch = s[i];
            if (ch === '"' || ch === "'" || ch === BT) {
                const j = skipQuoted(s, i);
                out += s.slice(from, i + 1) + "\u0000".repeat(Math.max(0, j - i - 2)) + (j - i >= 2 ? s[j - 1] : "");
                from = i = j;
            } else if (ch === "/" && s[i + 1] !== "/" && s[i + 1] !== "*" && regexStarts(s, i)) {
                const j = skipRegex(s, i);
                out += s.slice(from, i + 1) + "\u0000".repeat(j - i - 1);
                from = i = j;
            } else i++;
        }
        return out + s.slice(from);
    }

    // Names that stand for this / this.app / this.entity in a method (var t=this; var a=this.app).
    function aliasSets(msk) {
        const self = new Set(["this"]);
        for (const m of msk.matchAll(/(?:^|[;,{(\s])(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*this(?![\w$.])/g)) self.add(m[1]);
        const selfAlt = Array.from(self).map(esc).join("|");
        const app = new Set(), ent = new Set();
        const re = rx("(?:^|[;,{(\\s])(?:(?:var|let|const)\\s+)?(" + ID + ")\\s*=\\s*(?:" + selfAlt + ")\\s*\\.\\s*(app|entity)(?![\\w$])", "g");
        for (const m of msk.matchAll(re)) (m[2] === "app" ? app : ent).add(m[1]);
        return { self: self, selfAlt: selfAlt, app: app, ent: ent };
    }
    function firstParam(text) {
        const m = rx("^\\s*(?:async\\s+)?(?:function\\b)?\\s*[\\w$]*\\s*\\(\\s*(" + ID + ")", "").exec(text)
            || rx("^\\s*(?:async\\s+)?(" + ID + ")\\s*=>", "").exec(text);
        return m ? m[1] : "";
    }
    // How a property of the first parameter is used: b boolean (!!p.x), n number, s string, a array, o object, ? unknown.
    function readKind(s, a, b) {
        const before = s.slice(Math.max(0, a - 22), a), after = s.slice(b, b + 18);
        if (/!!\s*$/.test(before)) return "b";
        if (/(?:Number|parseFloat|parseInt|isFinite|isNaN|Math\s*\.\s*[a-z]+)\s*\(\s*$/.test(before)) return "n";
        if (/String\s*\(\s*$/.test(before)) return "s";
        if (/typeof\s*$/.test(before)) {
            const win = s.slice(Math.max(0, a - 30), b + 22);
            return /["']number["']/.test(win) ? "n" : /["']string["']/.test(win) ? "s" : /["']boolean["']/.test(win) ? "b" : "?";
        }
        if (/^\s*\|\|\s*(?:""|'')/.test(after)) return "s";
        if (/^\s*\|\|\s*\[\s*\]/.test(after) || /^\s*\.\s*(?:length|forEach|map|filter|some|every|push|slice)\b/.test(after)) return "a";
        if (/^\s*\|\|\s*\{\s*\}/.test(after)) return "o";
        if (/^\s*(?:\|\|\s*-?\d|[<>*\/%]|-\s*[\w$(]|\.\s*toFixed\b|[!=]==?\s*-?\d)/.test(after)) return "n";
        if (/^\s*[!=]==?\s*["']/.test(after)) return "s";
        if (/^\s*[!=]==?\s*(?:true|false)\b/.test(after)) return "b";
        return "?";
    }

    // Bodies of nested functions that redeclare name as a parameter, as [open, close] ranges: an inner variable of the
    // same name (minified code reuses single letters) must not be mistaken for the outer one. The method's own
    // signature is never a range.
    function shadowRanges(msk, name) {
        const re = rx("function\\b[^(]*\\(([^)]*)\\)\\s*\\{|\\(([^)]*)\\)\\s*=>\\s*\\{|(?<![\\w$.])(" + ID + ")\\s*=>\\s*\\{", "g");
        const out = [];
        let from = 0;
        for (const m of msk.matchAll(re)) {
            if (m.index < from || /^\s*$/.test(msk.slice(0, m.index))) continue;
            const params = (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] || "").split(",").map(function (p) { return p.trim(); });
            if (params.indexOf(name) < 0) continue;
            const open = m.index + m[0].length - 1, close = matchClose(msk, open);
            if (close < 0) continue;
            out.push({ open: open, close: close });
            from = close;
        }
        return out;
    }
    function blankRanges(s, ranges) {                // s with the inside of each {open, close} replaced by spaces
        if (!ranges.length) return s;
        let out = "", from = 0;
        for (let i = 0; i < ranges.length; i++) { const r = ranges[i]; out += s.slice(from, r.open + 1) + " ".repeat(r.close - r.open - 1); from = r.close; }
        return out + s.slice(from);
    }

    // Every script type name reached through .script.NAME (in order of appearance, unique). A method's facts depend on
    // the set of script types in the scene only through these names, which is what the cache invalidation relies on.
    function scriptMentions(text) {
        const out = [];
        for (const m of text.matchAll(rx("\\.\\s*script\\s*(?:\\.\\s*(" + ID + ")|\\[\\s*[\"'](" + ID + ")[\"']\\s*\\])", "g"))) {
            const n = m[1] || m[2];
            if (out.indexOf(n) < 0) out.push(n);
        }
        return out;
    }
    function returnsScript(text, name) {             // does the method return an instance of script type name?
        const carriers = new Set();                  // variables / properties assigned from ... .script.NAME
        const assign = rx("([\\w$.]+)\\s*=[^=;,){}]*\\.\\s*script\\s*(?:\\.\\s*" + esc(name) + "(?![\\w$])|\\[\\s*[\"']" + esc(name) + "[\"']\\s*\\])", "g");
        for (const m of text.matchAll(assign)) carriers.add(m[1].split(".").pop());
        const direct = rx("\\.\\s*script\\s*\\.\\s*" + esc(name) + "(?![\\w$])", "");
        for (const m of text.matchAll(/\breturn\b([^;}]*)/g)) {
            if (direct.test(m[1])) return true;
            for (const c of carriers) if (rx("(?<![\\w$])" + esc(c) + "(?![\\w$])", "").test(m[1])) return true;
        }
        return false;
    }

    // Facts of one piece of code (a method, or an inline event handler found inside it) into out[owner]; inline handlers
    // registered through the app or entity on method, or in [event, function(){...}] pairs, and functions a method stores as this.name = function(){},
    // are analysed on their own and blanked out of the parent. src is the code, msk the same code with literals masked.
    function* analyzeText(src, msk, owner, param, ctx, out) {
        const big = src.length > BIG_TEXT;           // a big method is analysed in several units (see the yields below)
        const f = {};
        const seen = new Set();
        const push = function (key, v) {
            const a = f[key] || (f[key] = []), k = key + "\u0000" + JSON.stringify(v);
            if (a.length < MAX_LIST && !seen.has(k)) { seen.add(k); a.push(v); }
        };
        const SELF = "(?<![\\w$.])(?:" + ctx.selfAlt + ")";
        const aliasAlt = Array.from(ctx.app).concat(Array.from(ctx.ent)).map(esc).join("|");
        const RECV = "(?<![\\w$.])(?:(?:" + ctx.selfAlt + ")\\s*\\.\\s*(app|entity)" + (aliasAlt ? "|(" + aliasAlt + ")" : "") + ")";
        const targetOf = function (m) { return m[1] || (ctx.app.has(m[2]) ? "app" : "entity"); };
        const attrRe = rx("^(?:" + ctx.selfAlt + ")\\s*\\.\\s*(" + ID + ")\\s*(?=[,)])", "");
        const namedRe = rx("^(?:" + ctx.selfAlt + ")\\s*\\.\\s*(" + ID + ")(?:\\s*\\.\\s*(" + ID + "))?", "");
        let dyn = false;

        function evArg(s, i) {                       // event name argument at s[i]: {kind: lit|attr, v, end}, or null
            i = skipWs(s, i);
            const lit = readString(s, i);
            if (lit) { const e = skipWs(s, lit.end); return s[e] === "," || s[e] === ")" ? { kind: "lit", v: lit.v, end: e } : null; }
            const m = attrRe.exec(s.slice(i, i + 80));
            return m ? { kind: "attr", v: m[1], end: i + m[0].length } : null;
        }
        const evName = function (ev) { return ev.kind === "lit" ? ev.v : "@" + ev.v; };
        function handlerAt(s, i) {                   // the handler expression at s[i]: inline function, this.m, this.m.bind(..), this.obj.key
            i = skipWs(s, i);
            const rest = s.slice(i, i + 200);
            let m = /^function\b[^(]*\(([^)]*)\)\s*\{/.exec(rest) || /^(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*\{/.exec(rest);
            if (m) return { inline: true, open: i + m[0].length - 1, param: String((m[1] !== undefined ? m[1] : m[2]) || "").split(",")[0].trim() };
            m = namedRe.exec(rest);
            if (!m) return null;
            if (m[2] === undefined) return { h: m[1] };
            return { h: m[2] === "bind" ? m[1] : "@" + m[2] };
        }

        // registrations: x.on (event, handler) calls and [event, handler] pairs (later bound by a loop)
        const found = [];
        for (const m of msk.matchAll(rx(RECV + "\\s*\\.\\s*(?:on|once)\\s*\\(", "g"))) {
            const ev = evArg(src, m.index + m[0].length);
            if (!ev) { dyn = true; continue; }
            const k = skipWs(src, ev.end);
            const hd = src[k] === "," ? handlerAt(src, k + 1) : null;
            if (hd) found.push({ pos: m.index, target: targetOf(m), ev: ev, hd: hd });
        }
        for (const m of msk.matchAll(rx("\\[\\s*(?:" + QUOTED + "|(?:" + ctx.selfAlt + ")\\s*\\.\\s*" + ID + ")\\s*,", "g"))) {
            const ev = evArg(src, m.index + 1);
            const k = ev ? skipWs(src, ev.end) : -1;
            const hd = k >= 0 && src[k] === "," ? handlerAt(src, k + 1) : null;
            if (hd) found.push({ pos: m.index, target: "app", ev: ev, hd: hd });
        }
        for (const m of msk.matchAll(rx(SELF + "\\s*\\.\\s*(" + ID + ")\\s*=\\s*", "g"))) {
            const hd = ctx.own.has(m[1]) ? handlerAt(src, m.index + m[0].length) : null;
            if (hd && hd.inline) found.push({ pos: m.index, own: m[1], hd: hd });
        }
        if (big) yield;
        found.sort(function (a, b) { return a.pos - b.pos; });
        const inl = [];
        let until = -1;
        for (let fi = 0; fi < found.length; fi++) {
            const r = found[fi];
            if (r.pos < until) continue;             // inside an inline handler that was already taken
            let handler = r.hd.h;
            if (r.hd.inline) {
                const close = matchClose(src, r.hd.open);
                if (close < 0 || ctx.seq.n >= MAX_INLINE) continue;
                handler = r.own || ctx.top + "#" + (++ctx.seq.n);
                inl.push({ id: handler, open: r.hd.open, close: close, param: r.hd.param });
                until = close + 1;
            }
            if (!r.own) push("o", [evName(r.ev), handler, r.target === "app" ? "a" : "e"]);
        }
        const blank = blankRanges(src, inl), mblank = blankRanges(msk, inl);
        if (big) yield;

        // events fired, and whether the first parameter is forwarded as their payload
        for (const m of mblank.matchAll(rx(RECV + "\\s*\\.\\s*fire\\s*\\(", "g"))) {
            const ev = evArg(blank, m.index + m[0].length);
            if (!ev) { dyn = true; continue; }
            push(targetOf(m) === "app" ? "f" : "fe", evName(ev));
            if (param) {
                const k = skipWs(blank, ev.end);
                if (blank[k] === "," && rx("^\\s*" + esc(param) + "\\s*[,)]", "").test(mblank.slice(k + 1, k + 40))) push("pf", evName(ev));
            }
        }
        if (big) yield;
        // this.m(...) calls, other this.m references, state read
        const reads = new Set();
        for (const m of mblank.matchAll(rx(SELF + "\\s*(?:\\?\\.|\\.)\\s*(" + ID + ")", "g"))) {
            const nm = m[1], nxt = mblank.slice(m.index + m[0].length, m.index + m[0].length + 12);
            const call = /^\s*\(/.test(nxt);
            if (ctx.names.has(nm)) {
                if (call || /^\s*\.\s*(?:call|apply)\s*\(/.test(nxt)) push("c", nm);
                else push("r", nm);
            } else if (!SELF_IGNORE.has(nm) && !call && !/^\s*=(?![=>])/.test(nxt)) reads.add(nm);
        }
        if (reads.size) f.st = Array.from(reads).slice(0, MAX_LIST);
        if (big) yield;
        // state written: this.x = ..., this.x[i].y += ..., this.x.push(...); an assigned object literal adds its keys
        const writeRe = rx(SELF + "\\s*\\.\\s*(" + ID + ")(" + PATH + "*)\\s*(=(?![=>])|[-+*/|&^%]=|\\+\\+|--)", "g");
        for (const m of mblank.matchAll(writeRe)) {
            if (ctx.names.has(m[1]) || SELF_IGNORE.has(m[1])) continue;
            const path = m[1] + normPath(m[2]);
            push("sw", path);
            const b = skipWs(blank, m.index + m[0].length);
            if (m[3] === "=" && blank[b] === "{") { const ks = objectKeys(blank, b); for (let ki = 0; ki < ks.length; ki++) push("sw", path + "." + ks[ki]); }
        }
        for (const m of mblank.matchAll(rx(SELF + "\\s*\\.\\s*(" + ID + ")(" + PATH + "*)\\s*\\.\\s*(?:" + MUTATORS + ")\\s*\\(", "g"))) {
            if (!ctx.names.has(m[1]) && !SELF_IGNORE.has(m[1])) push("sw", m[1] + normPath(m[2]));
        }
        if (dyn) f.d = 1;
        if (big) yield;

        // first parameter: properties read, methods it is handed to
        if (param) {
            const pr = {};
            const shadow = shadowRanges(mblank, param), own = blankRanges(mblank, shadow), ownSrc = blankRanges(blank, shadow);
            for (const m of own.matchAll(rx("(?<![\\w$.])" + esc(param) + "\\s*\\??\\.\\s*(" + ID + ")(?![\\w$]|\\s*\\(|\\s*=(?![=>]))", "g"))) {
                const kind = readKind(ownSrc, m.index, m.index + m[0].length);
                if (m[1] === "__proto__") continue;
                if (!hasOwn(pr, m[1]) || pr[m[1]] === "?") pr[m[1]] = kind;
                if (Object.keys(pr).length >= MAX_LIST) break;
            }
            if (Object.keys(pr).length) f.pr = pr;
            for (const m of mblank.matchAll(rx(SELF + "\\s*\\.\\s*(" + ID + ")\\s*\\(\\s*" + esc(param) + "\\s*[,)]", "g"))) {
                if (ctx.names.has(m[1])) push("pp", m[1]);
            }
        }
        for (const m of mblank.matchAll(rx(SELF + "\\s*\\.\\s*(" + ID + ")\\s*\\.\\s*(?:call|apply)\\s*\\(\\s*this\\s*,\\s*(?:" + (param ? esc(param) + "\\s*[,)]|" : "") + "arguments\\b)", "g"))) {
            if (ctx.names.has(m[1])) push("pp", m[1]);
        }

        if (big) yield;
        // another script's instance: obtained through a lookup helper (this._history()) or read directly (x.script.NAME);
        // its state read and its methods called
        const foreign = function (type, prop, rest, call) {
            if (call && rest === "") push("xc", type + ":" + prop);
            else push("xr", type + ":" + prop + (call ? rest.replace(/\.[\w$]+$/, "") : rest));   // a method called on the value read
        };
        for (const m of mblank.matchAll(rx("\\.\\s*script\\s*\\.\\s*(" + ID + ")\\s*\\.\\s*(" + ID + ")(" + PATH + "*)", "g"))) {
            if (ctx.types.has(m[1])) foreign(m[1], m[2], normPath(m[3]), /^\s*\(/.test(mblank.slice(m.index + m[0].length, m.index + m[0].length + 6)));
        }
        if (ctx.helpers.size) {
            const holders = new Map();
            for (const m of mblank.matchAll(rx("(?<![\\w$.])(" + ID + ")\\s*=\\s*(?:" + ctx.selfAlt + ")\\s*\\.\\s*(" + ID + ")\\s*\\(\\s*\\)", "g"))) {
                if (ctx.helpers.has(m[2])) holders.set(m[1], ctx.helpers.get(m[2]));
            }
            for (const hv of holders) {
                const v = hv[0], type = hv[1];
                const ev = esc(v), outer = blankRanges(mblank, shadowRanges(mblank, v));
                for (const m of outer.matchAll(rx("(?<![\\w$.])" + ev + "\\s*(?:\\?\\.|\\.)\\s*(" + ID + ")(" + PATH + "*)", "g"))) {
                    foreign(type, m[1], normPath(m[2]), /^\s*\(/.test(outer.slice(m.index + m[0].length, m.index + m[0].length + 6)));
                }
                const aliasRe = rx("(?<![\\w$.])(" + ID + ")\\s*=\\s*" + ev + "(?:\\s*&&\\s*" + ev + ")?\\s*(?:\\?\\.|\\.)\\s*(" + ID + ")(?![\\w$]|\\s*\\()", "g");
                for (const m of outer.matchAll(aliasRe)) {      // t = holder && holder.levels || {}
                    for (const u of mblank.matchAll(rx("(?<![\\w$.])" + esc(m[1]) + "(" + PATH + "+)", "g"))) {
                        push("xr", type + ":" + m[2] + normPath(u[1]));
                    }
                }
            }
        }

        if (Object.keys(f).length) setOwn(out, owner, f);
        for (let bi = 0; bi < inl.length; bi++) {
            const b = inl[bi];
            yield* analyzeText(src.slice(b.open + 1, b.close), msk.slice(b.open + 1, b.close), b.id, b.param, ctx, out);
        }
    }

    // data properties of the prototype chain below the engine's ScriptType
    function methodTable(proto) {
        const out = new Map();
        for (let p = proto, d = 0; p && p !== Object.prototype && d < 6; p = Object.getPrototypeOf(p), d++) {
            if (hasOwn(p, "initScriptType") || hasOwn(p, "initEventHandler")) break;
            const keys = Object.getOwnPropertyNames(p);
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                if (k === "constructor" || k === "__proto__" || out.has(k)) continue;
                const d2 = Object.getOwnPropertyDescriptor(p, k);
                if (d2 && typeof d2.value === "function") out.set(k, d2.value);
            }
        }
        return out;
    }

    // The facts of one script type (generator: yields after every method). entry receives table, ownFns, facts,
    // mentions, relied, size and the sources flag.
    function* factsOf(entry, ctor, typeNames) {
        const table = methodTable(ctor.prototype);
        entry.table = table;
        const names = Array.from(table.keys());
        if (names.length > MAX_METHODS) { names.length = MAX_METHODS; entry.truncSources = true; }
        const texts = new Map();
        const mentionSet = new Set();
        for (let i = 0; i < names.length; i++) {
            const n = names[i];
            let src;
            try { src = fnToString.call(table.get(n)); } catch (err) { entry.truncSources = true; continue; }
            const text = stripComments(src.length > MAX_SRC ? src.slice(0, MAX_SRC) : src);
            const mentions = scriptMentions(text);
            for (let j = 0; j < mentions.length; j++) mentionSet.add(mentions[j]);
            texts.set(n, { src: text, msk: maskLiterals(text), mentions: mentions });
            yield;
        }
        const ownFns = new Set();                                            // this.name = function(){...} in any method
        for (const t of texts.values()) {
            const al = aliasSets(t.msk);
            for (const m of t.msk.matchAll(rx("(?<![\\w$.])(?:" + al.selfAlt + ")\\s*\\.\\s*(" + ID + ")\\s*=\\s*(?:function\\b|(?:\\([^)]*\\)|" + ID + ")\\s*=>)", "g"))) {
                if (!table.has(m[1]) && m[1] !== "__proto__") ownFns.add(m[1]);
            }
            yield;
        }
        entry.ownFns = ownFns;
        const base = { names: new Set(names.concat(Array.from(ownFns))), own: ownFns, helpers: new Map(), binds: {}, types: typeNames };
        for (const e of texts) {                                             // methods that return another script's instance
            const refs = e[1].mentions.filter(function (x) { return typeNames.has(x); });
            if (refs.length === 1 && returnsScript(e[1].src, refs[0])) base.helpers.set(e[0], refs[0]);
        }
        const m = {};
        let ar = 0, qw = 0;
        for (const e of texts) {
            const n = e[0], src = e[1].src, msk = e[1].msk;
            const ctx = Object.assign({}, base, aliasSets(msk), { top: n, seq: { n: 0 } });
            yield* analyzeText(src, msk, n, firstParam(src), ctx, m);
            if (WRAPPED.test(msk)) {                  // a hidden closure runs: w = nothing visible but that call (and guards), h = visible code too
                const f = hasOwn(m, n) ? m[n] : (setOwn(m, n, {}), m[n]);
                f[Object.keys(f).every(function (k) { return k === "st"; }) && src.length <= 260 ? "w" : "h"] = 1;
            }
            const bind = function (re) { for (const b of msk.matchAll(re)) if (base.names.has(b[2])) setOwn(base.binds, b[1], b[2]); };
            bind(rx("(" + ID + ")\\s*:\\s*(?:" + ctx.selfAlt + ")\\s*\\.\\s*(" + ID + ")\\s*\\.\\s*bind\\s*\\(", "g"));
            bind(rx("(?:" + ctx.selfAlt + ")\\s*\\.\\s*(" + ID + ")\\s*=\\s*(?:" + ctx.selfAlt + ")\\s*\\.\\s*(" + ID + ")\\s*\\.\\s*bind\\s*\\(", "g"));
            if (ARISE.test(msk)) ar++;
            if (/quest/i.test(src)) qw++;
            yield;
        }
        const facts = { names: names.concat(Array.from(ownFns)), m: m };
        if (Object.keys(base.binds).length) facts.binds = base.binds;
        if (ar) facts.ar = ar;
        if (qw) facts.qw = qw;
        entry.facts = facts;
        entry.mentions = Array.from(mentionSet);
        entry.relied = entry.mentions.filter(function (x) { return typeNames.has(x); });
        entry.size = JSON.stringify(Object.assign({ n: 0 }, facts)).length - 1;      // plus the digits of n, added when the scan is assembled
    }

    // ---- runtime listener attribution --------------------------------------------------------------------------------
    // A handler is attributed to the script instance and method that hold that exact function: a prototype method of the
    // scope's script (via "proto"), an own property of an instance with the name of a prototype method, i.e. a bound copy
    // (via "own"), or any other own property / entry of an array or plain object an instance holds (paths, resolved
    // against the static facts by the analysis).
    function makeAttributor(instances, tables, ownFnNames) {
        let ownIdx = null, protoIdx = null;
        function* ownIndex() {                        // function -> [{guid, script, inst, path}]
            if (ownIdx) return ownIdx;
            const idx = new Map();
            for (let xi = 0; xi < instances.length; xi++) {
                const x = instances[xi];
                try {
                    let budget = 400;
                    const visit = function (v, path, depth) {
                        if (budget-- <= 0) return;
                        if (typeof v === "function") {
                            const rec = { guid: x.guid, script: x.name, inst: x.inst, path: path }, l = idx.get(v);
                            if (l) l.push(rec); else idx.set(v, [rec]);
                            return;
                        }
                        if (depth >= 3 || !v || typeof v !== "object") return;
                        if (Array.isArray(v)) { for (let i = 0; i < v.length && i < 64; i++) visit(v[i], path + "[" + i + "]", depth + 1); return; }
                        const proto = Object.getPrototypeOf(v);
                        if (proto !== Object.prototype && proto !== null) return;      // engine objects, other script instances
                        const keys = Object.keys(v);
                        for (let ki = 0; ki < keys.length && ki < 40; ki++) {
                            const d = Object.getOwnPropertyDescriptor(v, keys[ki]);
                            if (d && "value" in d) visit(d.value, path + "." + keys[ki], depth + 1);
                        }
                    };
                    const own = Object.getOwnPropertyNames(x.inst);
                    for (let i = 0; i < own.length; i++) {
                        const k = own[i];
                        if (k.indexOf("__") === 0 || SKIP_KEYS.has(k)) continue;
                        const d = Object.getOwnPropertyDescriptor(x.inst, k);
                        if (d && "value" in d) visit(d.value, k, 0);
                    }
                } catch (err) {
                    warnOnce("a script instance could not be inspected for bound handlers", err);
                }
                yield;
            }
            ownIdx = idx;
            return idx;
        }
        function protoIndex() {                       // prototype function -> [script, method], for handlers registered unbound
            if (protoIdx) return protoIdx;
            protoIdx = new Map();
            tables.forEach(function (table, sname) {
                table.forEach(function (fn, mname) { if (!protoIdx.has(fn)) protoIdx.set(fn, [sname, mname]); });
            });
            return protoIdx;
        }
        function* attribute(h) {
            const fn = h && (h.callback || h.fn);
            if (typeof fn !== "function") return null;
            const scope = h.scope, scoped = scope && scope.__scriptType ? scope : null;
            if (scoped) {
                const table = tables.get(scriptNameOf(scoped));
                if (table) for (const e of table) if (e[1] === fn) return { method: e[0], via: "proto" };
            }
            const index = yield* ownIndex();
            const hits = index.get(fn);
            if (hits) {
                const pick = (scoped && hits.find(function (x) { return x.inst === scoped; })) || hits[0];
                const paths = hits.filter(function (x) { return x.inst === pick.inst; }).map(function (x) { return x.path; }).slice(0, 4);
                const table = tables.get(pick.script);
                const ownNames = ownFnNames.get(pick.script);
                const own = paths.find(function (p) { return (table && table.has(p)) || (ownNames && ownNames.has(p)); });
                return own ? { guid: pick.guid, script: pick.script, method: own, via: "own" } : { guid: pick.guid, script: pick.script, paths: paths };
            }
            const owner = protoIndex().get(fn);
            return owner ? { script: owner[0], method: owner[1], via: "proto" } : null;
        }
        return attribute;
    }

    // The listener registry of the graph scan with every record attributed (method, via, paths).
    function* attributeListeners(scanListeners, handles, attribute) {
        const attrOf = new Map();
        for (let i = 0; i < handles.length; i++) {
            let a = null;
            try {
                a = yield* attribute(handles[i].h);
            } catch (err) {
                warnOnce("a listener could not be attributed to a script method", err);    // its event is known from the registration code only
            }
            attrOf.set(handles[i].rec, a);
        }
        const out = {};
        const names = Object.keys(scanListeners);
        for (let i = 0; i < names.length; i++) {
            const recs = scanListeners[names[i]];
            const list = [];
            for (let j = 0; j < recs.length; j++) {
                const rec = Object.assign({}, recs[j]);
                const a = attrOf.get(recs[j]);
                if (a) {
                    if (!rec.guid && a.guid) rec.guid = a.guid;
                    if (!rec.script && a.script) rec.script = a.script;
                    if (a.method) { rec.method = a.method; rec.via = a.via; }
                    if (a.paths) rec.paths = a.paths;
                }
                list.push(rec);
            }
            setOwn(out, names[i], list);
        }
        return out;
    }

    // ---- source analysis (port of workbench/experience_source.py) -----------------------------------------------------
    const RECIPE_VERSION = 1;
    const LIFECYCLE = new Set(["constructor", "initialize", "postInitialize", "update", "postUpdate", "swap", "onEnable",
        "onDisable", "onDestroy", "onAttributeChange"]);
    const LOOP_HOOKS = ["update", "postUpdate"];
    const MAX_CHAIN_DEPTH = 12, REPORT_DEPTH = 4, MAX_CHAIN_EVENTS = 300, MAX_ENTRY_HOPS = 3, MAX_CROSS_INSTANCES = 8, MAX_HOPS_PER_PAIR = 4, MAX_FIELDS = 24;
    const STATE_IGNORE = ["active", "debug", "enabled"];
    const SUPPRESS = ["leaderboard"];                // the user's rule: no leaderboard involvement at all
    const START_TOKENS = new Map([["select", 3], ["play", 3], ["start", 3], ["begin", 2], ["launch", 2], ["enter", 1], ["open", 1], ["go", 1]]);
    const START_PENALTY = new Map([["again", -3], ["restart", -3], ["replay", -3], ["stop", -3], ["end", -2], ["ended", -2], ["finish", -2],
        ["complete", -3], ["close", -3], ["back", -3], ["watch", -2], ["home", -3], ["exit", -3], ["pause", -2], ["loading", -1],
        ["transition", -1], ["failed", -3], ["timeout", -3]]);
    const ACTION_TOKENS = new Map([["fire", 3], ["shoot", 3], ["click", 3], ["interact", 3], ["press", 2], ["tap", 2], ["hit", 2],
        ["trigger", 2], ["submit", 2], ["collect", 2], ["push", 2], ["use", 2], ["grab", 2], ["shot", 1], ["pull", 1], ["pick", 1]]);
    const ACTION_PENALTY = new Map([["timeout", -3], ["final", -1], ["miss", -1], ["state", -2], ["ended", -2], ["complete", -3],
        ["failed", -3], ["restart", -3]]);
    const PAST_TENSE_PENALTY = -2;                   // shown, dismissed, selected: a notification after the fact, not an action
    const TRIGGER_CHAIN_BONUS = 2;                   // the event is an ancestor of the goal
    const LIST_FACTS = ["f", "fe", "c", "r", "st", "sw", "xr", "xc", "pp", "pf"];
    const EMPTY_FACTS = {};

    const cmp = function (a, b) { return a < b ? -1 : a > b ? 1 : 0; };
    function cmpTuple(a, b) {
        for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; }
        return 0;
    }
    // Python truthiness of a JSON value (an empty list or object is false)
    function pyTruthy(v) {
        if (Array.isArray(v)) return v.length > 0;
        if (isDict(v)) return Object.keys(v).length > 0;
        return !!v;
    }
    const nameOf = function (key) { const i = key.indexOf("@"); return i < 0 ? key : key.slice(0, i); };
    const nodeKey = function (node) { return node.inst + SEP + node.method; };
    const stepLabel = function (s) { return s.script + "." + s.method; };

    function goalStrength(name) {
        if (!isStr(name)) return 0;
        const low = name.toLowerCase();
        if (low.indexOf("leaderboard") >= 0 || low.indexOf("quest") < 0) return 0;
        if (/complet|finish|done|success/i.test(low)) return 3;
        if (low.indexOf("arise:") === 0) return 2;
        return low.indexOf("progress") >= 0 ? 1 : 0;
    }
    function tokensOf(name) { return (name.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) || []).map(function (t) { return t.toLowerCase(); }); }
    function isPastTense(t) { return t.length > 4 && t.slice(-2) === "ed" && !START_TOKENS.has(t) && !ACTION_TOKENS.has(t); }
    function tokenScore(name, tokens, penalty) {
        const toks = tokensOf(name);
        if (!toks.some(function (t) { return tokens.has(t); })) return 0;
        let sum = 0;
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            sum += (tokens.get(t) || 0) + (penalty.get(t) || 0) + (isPastTense(t) ? PAST_TENSE_PENALTY : 0);
        }
        return sum;
    }
    const startScore = function (name) { return tokenScore(name, START_TOKENS, START_PENALTY); };
    const actionScore = function (name) { return tokenScore(name, ACTION_TOKENS, ACTION_PENALTY); };
    const kindDefault = function (kind) { return kind === "b" ? false : kind === "s" ? "" : kind === "a" ? [] : kind === "o" ? {} : 0; };

    // The facts of one method with every list reduced to its well-formed entries (the scan can be JSON from elsewhere).
    function cleanFacts(fx) {
        fx = asDict(fx);
        const out = {};
        for (let i = 0; i < LIST_FACTS.length; i++) {
            const k = LIST_FACTS[i];
            if (pyTruthy(fx[k])) out[k] = asList(fx[k]).filter(isStr);
        }
        const regs = asList(fx.o).filter(function (r) { return Array.isArray(r) && r.length === 3 && r.every(isStr); });
        if (regs.length) out.o = regs;
        const prSrc = asDict(fx.pr), pr = new Map();
        Object.keys(prSrc).forEach(function (k) { if (isStr(prSrc[k])) pr.set(k, prSrc[k]); });
        if (pr.size) out.pr = pr;
        ["w", "h", "d"].forEach(function (flag) { if (pyTruthy(fx[flag])) out[flag] = 1; });
        return out;
    }

    function hasFacts(scan) { return isDict(scan) && isDict(scan.scripts) && Object.keys(scan.scripts).length > 0; }

    // Handlers, reach and hops of one scan (generator: yields every few script types and instances).
    function* makeGraph(scan) {
        const g = {
            insts: [], byGuid: new Map(), byScript: new Map(), facts: new Map(), orphanCache: new Map(), xcalled: new Set(),
            handlers: new Map(), hopsInto: new Map(), hopsFrom: new Map(), producers: new Map(), handlerReach: [],
            reachedBy: new Map(), handlerNodes: new Set(), loopNodes: new Set(), unattributed: 0
        };
        const ents = asList(scan.entities).filter(isDict);
        for (let ei = 0; ei < ents.length; ei++) {
            const e = ents[ei], guid = asStr(e.guid);
            asList(e.scripts).filter(isDict).forEach(function (s) {
                const name = asStr(s.name);
                if (!name) return;
                const inst = {
                    index: g.insts.length, guid: guid, entity: asStr(e.name), script: name, attrs: asDict(s.attrs),
                    enabled: s.enabled !== false && e.enabled !== false
                };
                g.insts.push(inst);
                if (guid) g.byGuid.set(guid + SEP + name, inst);
                if (!g.byScript.has(name)) g.byScript.set(name, []);
                g.byScript.get(name).push(inst);
            });
            if ((ei & 63) === 63) yield;
        }
        const scripts = asDict(scan.scripts), scriptNames = Object.keys(scripts);
        for (let si = 0; si < scriptNames.length; si++) {
            const name = scriptNames[si], v = asDict(scripts[name]);
            const m = new Map(), mo = asDict(v.m);
            Object.keys(mo).forEach(function (k) { m.set(k, cleanFacts(mo[k])); });
            const names = new Set(asList(v.names).filter(isStr));
            m.forEach(function (_fx, k) { if (k.indexOf("#") < 0) names.add(k); });
            const binds = new Map(), bo = asDict(v.binds);
            Object.keys(bo).forEach(function (k) { if (isStr(bo[k])) binds.set(k, bo[k]); });
            g.facts.set(name, { m: m, binds: binds, names: names, ar: pyTruthy(v.ar), qw: pyTruthy(v.qw) });
            if ((si & 3) === 3) yield;
        }
        for (const f of g.facts.values()) {
            f.m.forEach(function (fx) {
                asList(fx.xc).forEach(function (x) {
                    const p = x.indexOf(":");
                    g.xcalled.add((p < 0 ? x : x.slice(0, p)) + SEP + (p < 0 ? "" : x.slice(p + 1)));
                });
            });
        }
        return g;
    }

    const fxOf = function (g, inst, method) {
        const f = g.facts.get(inst.script);
        return (f && f.m.get(method)) || EMPTY_FACTS;
    };
    const hasMethod = function (g, script, method) {
        const f = g.facts.get(script);
        return !!f && (f.names.has(method) || f.m.has(method));
    };

    // Methods never referenced through this.m by another method of the script, not lifecycle hooks, nor called from
    // another script: the places a hidden closure can reach.
    function orphansOf(g, script) {
        if (g.orphanCache.has(script)) return g.orphanCache.get(script);
        const f = g.facts.get(script) || { m: new Map(), names: new Set() };
        const referenced = new Set();
        f.m.forEach(function (fx, name) {
            asList(fx.c).concat(asList(fx.r)).forEach(function (ref) { if (ref !== name) referenced.add(ref); });
        });
        const effect = function (fx) { return !!fx && ["f", "fe", "c", "xc", "o"].some(function (k) { return hasOwn(fx, k); }); };
        const out = Array.from(f.names).filter(function (n) {
            return !LIFECYCLE.has(n) && !referenced.has(n) && !g.xcalled.has(script + SEP + n) && effect(f.m.get(n));
        }).sort();
        g.orphanCache.set(script, out);
        return out;
    }

    // Event keys of a fact: "name" or "@attr" (resolved from the instance's attributes; empty values give nothing).
    function eventKeys(inst, spec, target) {
        if (!isStr(spec) || !spec) return [];
        const names = spec.charAt(0) === "@" ? namesOf(hasOwn(inst.attrs, spec.slice(1)) ? inst.attrs[spec.slice(1)] : undefined) : [spec];
        if (target === "e") return inst.guid ? names.map(function (n) { return n + "@" + inst.guid; }) : [];
        return names;
    }

    // node key -> {node, parent, how, approx} for everything method reaches through calls. With guessOrphans a handler
    // that is a thin wrapper also reaches the orphans of its script: the real body of a registered callback hides in the
    // closure, and its callees are never referenced by the visible code. Wrappers met deeper in a call path are helpers
    // (storage, account checks), not routers, so they reach nothing extra.
    function reachFrom(g, inst, method, guessOrphans) {
        const start = { inst: inst.index, method: method }, startKey = nodeKey(start);
        const seen = new Map();
        seen.set(startKey, { node: start, parent: null, how: "handler", approx: false });
        const queue = [start];
        for (let qh = 0; qh < queue.length; qh++) {
            const node = queue[qh], nkey = nodeKey(node);
            const cur = g.insts[node.inst];
            const fx = fxOf(g, cur, node.method);
            const nxt = [];
            asList(fx.c).forEach(function (c) { if (hasMethod(g, cur.script, c)) nxt.push([{ inst: cur.index, method: c }, "call", false]); });
            asList(fx.xc).forEach(function (x) {
                const p = x.indexOf(":");
                const script = p < 0 ? x : x.slice(0, p), meth = p < 0 ? "" : x.slice(p + 1);
                (g.byScript.get(script) || []).slice(0, MAX_CROSS_INSTANCES).forEach(function (o) {
                    if (o.enabled && hasMethod(g, script, meth)) nxt.push([{ inst: o.index, method: meth }, "cross", false]);
                });
            });
            if (guessOrphans && nkey === startKey && fx.w) {
                orphansOf(g, cur.script).forEach(function (o) { nxt.push([{ inst: cur.index, method: o }, "guess", true]); });
            }
            for (let i = 0; i < nxt.length; i++) {
                const k = nodeKey(nxt[i][0]);
                if (!seen.has(k)) {
                    seen.set(k, { node: nxt[i][0], parent: nkey, how: nxt[i][1], approx: nxt[i][2] });
                    queue.push(nxt[i][0]);
                }
            }
        }
        return seen;
    }

    function stepsOf(g, seen, node) {
        const out = [];
        let key = nodeKey(node);
        while (key !== null) {
            const rec = seen.get(key), inst = g.insts[rec.node.inst];
            out.push({ script: inst.script, entity: inst.entity, method: rec.node.method, inst: inst.index, how: rec.how, approximate: rec.approx });
            key = rec.parent;
        }
        out.reverse();
        return out;
    }

    function firedBy(g, node) {
        const inst = g.insts[node.inst], fx = fxOf(g, inst, node.method);
        let out = [];
        asList(fx.f).forEach(function (spec) { out = out.concat(eventKeys(inst, spec, "a")); });
        asList(fx.fe).forEach(function (spec) { out = out.concat(eventKeys(inst, spec, "e")); });
        return out;
    }

    // event key -> [[inst index, handler method]] from the registration code of every enabled script instance.
    function* staticRegistrations(g) {
        const out = new Map();
        for (let ii = 0; ii < g.insts.length; ii++) {
            const inst = g.insts[ii];
            if ((ii & 15) === 15) yield;
            if (!inst.enabled) continue;
            const f = g.facts.get(inst.script);
            if (!f) continue;
            f.m.forEach(function (fx) {
                asList(fx.o).forEach(function (reg) {
                    let handler = reg[1];
                    if (handler.charAt(0) === "@" || !(f.m.has(handler) || f.names.has(handler))) {
                        const bound = f.binds.get(handler.replace(/^@+/, ""));
                        handler = bound === undefined ? "" : bound;                      // a bound copy stored under that key
                    }
                    if (!handler || !(f.m.has(handler) || f.names.has(handler))) return;
                    eventKeys(inst, reg[0], reg[2]).forEach(function (key) {
                        if (!out.has(key)) out.set(key, []);
                        const list = out.get(key);
                        if (!list.some(function (p) { return p[0] === inst.index && p[1] === handler; })) list.push([inst.index, handler]);
                    });
                });
            });
        }
        return out;
    }

    function addHandler(g, key, handler) {
        if (!g.handlers.has(key)) g.handlers.set(key, []);
        const hs = g.handlers.get(key);
        if (!hs.some(function (h) { return h.inst === handler.inst && h.method === handler.method; })) hs.push(handler);
    }

    function* runtimeHandlers(g, scan, statics) {
        const reg = asDict(scan.listeners), regNames = Object.keys(reg);
        for (let ni = 0; ni < regNames.length; ni++) {
            const name = regNames[ni];
            if ((ni & 63) === 63) yield;
            asList(reg[name]).filter(isDict).forEach(function (r) {
                const key = (hasOwn(r, "target") ? r.target : "app") === "app" ? name : name + "@" + asStr(r.targetGuid);
                const script = asStr(r.script), guid = asStr(r.guid);
                const insts = g.byGuid.has(guid + SEP + script) ? [g.byGuid.get(guid + SEP + script)]
                    : (script && !guid ? (g.byScript.get(script) || []).slice(0, MAX_CROSS_INSTANCES) : []);
                const method = asStr(r.method);
                if (!insts.length || !g.facts.has(script)) { g.unattributed++; return; }
                insts.forEach(function (inst) {
                    if (method && hasMethod(g, script, method)) { addHandler(g, key, { inst: inst.index, method: method, how: "runtime", ambiguous: false }); return; }
                    const set = new Set();
                    (statics.get(key) || []).forEach(function (p) { if (p[0] === inst.index) set.add(p[1]); });
                    const cands = Array.from(set).sort();
                    if (!cands.length) { g.unattributed++; return; }
                    cands.forEach(function (m) { addHandler(g, key, { inst: inst.index, method: m, how: "runtime+static", ambiguous: cands.length > 1 }); });
                });
            });
        }
    }

    function* buildHandlers(g, scan) {
        const statics = yield* staticRegistrations(g);
        yield;
        yield* runtimeHandlers(g, scan, statics);
        statics.forEach(function (regs, key) {
            regs.forEach(function (p) {
                const hs = g.handlers.get(key) || [];
                if (!hs.some(function (h) { return h.inst === p[0] && h.method === p[1]; })) addHandler(g, key, { inst: p[0], method: p[1], how: "static", ambiguous: false });
            });
        });
        yield;
        for (let i = 0; i < g.insts.length; i++) {                // who fires what, from anywhere
            const inst = g.insts[i], f = g.facts.get(inst.script);
            if (!f) continue;
            f.m.forEach(function (_fx, method) {
                const node = { inst: inst.index, method: method }, nk = nodeKey(node);
                firedBy(g, node).forEach(function (key) {
                    if (!g.producers.has(key)) g.producers.set(key, new Set());
                    g.producers.get(key).add(nk);
                });
            });
            if ((i & 15) === 15) yield;
        }
        const entries = Array.from(g.handlers.entries());
        for (let i = 0; i < entries.length; i++) {
            const key = entries[i][0], hs = entries[i][1];
            for (let j = 0; j < hs.length; j++) {
                const h = hs[j];
                const seen = reachFrom(g, g.insts[h.inst], h.method, true);
                g.handlerReach.push({ key: key, h: h, seen: seen });
                seen.forEach(function (_rec, nk) {
                    if (!g.reachedBy.has(nk)) g.reachedBy.set(nk, []);
                    g.reachedBy.get(nk).push({ key: key, h: h, seen: seen });
                });
                yield;
            }
        }
        const seenHops = new Map();
        for (let i = 0; i < g.handlerReach.length; i++) {
            const hr = g.handlerReach[i], firedHere = new Set();
            hr.seen.forEach(function (rec) {
                firedBy(g, rec.node).forEach(function (dst) {
                    if (dst === hr.key || firedHere.has(dst)) return;
                    firedHere.add(dst);
                    const steps = stepsOf(g, hr.seen, rec.node);
                    const hop = {
                        src: hr.key, dst: dst, steps: steps, how: hr.h.how, ambiguous: hr.h.ambiguous,
                        approximate: hr.h.ambiguous || steps.some(function (s) { return s.approximate; })
                    };
                    const pk = hr.key + SEP + dst;
                    if (!seenHops.has(pk)) seenHops.set(pk, []);
                    const pair = seenHops.get(pk);
                    if (pair.length < MAX_HOPS_PER_PAIR) {
                        pair.push(hop);
                        if (!g.hopsInto.has(dst)) g.hopsInto.set(dst, []);
                        g.hopsInto.get(dst).push(hop);
                        if (!g.hopsFrom.has(hr.key)) g.hopsFrom.set(hr.key, []);
                        g.hopsFrom.get(hr.key).push(hop);
                    }
                });
            });
            yield;
        }
        g.reachedBy.forEach(function (_v, nk) { g.handlerNodes.add(nk); });
        for (let i = 0; i < g.insts.length; i++) {
            const inst = g.insts[i];
            if (inst.enabled) {
                LOOP_HOOKS.forEach(function (hook) {
                    if (hasMethod(g, inst.script, hook)) reachFrom(g, inst, hook, false).forEach(function (_r, nk) { g.loopNodes.add(nk); });
                });
            }
            if ((i & 15) === 15) yield;
        }
    }

    // Fields read from the first parameter of method, following it into this.m(param) calls and forwarded events.
    function readsOf(g, instIndex, method, depth, seen) {
        seen = seen || new Set();
        const out = new Map();
        const nk = instIndex + SEP + method;
        if (seen.has(nk) || depth > 4) return out;
        seen.add(nk);
        const inst = g.insts[instIndex], fx = fxOf(g, inst, method);
        if (fx.pr) fx.pr.forEach(function (v, k) { out.set(k, v); });
        const merge = function (more) { more.forEach(function (v, k) { if (!out.has(k) || out.get(k) === "?") out.set(k, v); }); };
        asList(fx.pp).forEach(function (m) { if (hasMethod(g, inst.script, m)) merge(readsOf(g, instIndex, m, depth + 1, seen)); });
        asList(fx.pf).forEach(function (spec) {
            eventKeys(inst, spec, "a").forEach(function (key) {
                (g.handlers.get(key) || []).slice(0, 6).forEach(function (h) { merge(readsOf(g, h.inst, h.method, depth + 1, seen)); });
            });
        });
        return out;
    }

    // Event keys reachable from key through hops (not including itself unless on a cycle).
    function downstream(g, key, memo) {
        if (memo.has(key)) return memo.get(key);
        const out = new Set(), queue = [key];
        for (let qh = 0; qh < queue.length; qh++) {
            (g.hopsFrom.get(queue[qh]) || []).forEach(function (h) {
                if (!out.has(h.dst)) { out.add(h.dst); queue.push(h.dst); }
            });
        }
        memo.set(key, out);
        return out;
    }

    // [{key, strength, learned}] for app events that look like a quest goal, best first.
    function goalCandidates(g, knowledge) {
        const names = new Set(g.producers.keys());
        g.handlers.forEach(function (_v, k) { names.add(k); });
        const out = [];
        names.forEach(function (key) {
            if (key.indexOf("@") >= 0) return;
            const learned = !!knowledge && knowledge.goalNames.has(key);
            const strength = Math.max(goalStrength(key), learned ? 3 : 0);
            if (key.toLowerCase().indexOf("leaderboard") >= 0) return;
            if (strength) out.push({ key: key, strength: strength, learned: learned });
        });
        return out.sort(function (a, b) { return cmpTuple([-a.strength, !a.learned, a.key], [-b.strength, !b.learned, b.key]); });
    }

    // {depth: Map(event key -> hops to the goal), hops: the hops inside the chain, goal side first}.
    function chainOf(g, goal) {
        const depth = new Map([[goal, 0]]), queue = [goal];
        for (let qh = 0; qh < queue.length; qh++) {
            const cur = queue[qh];
            if (depth.get(cur) >= MAX_CHAIN_DEPTH || depth.size >= MAX_CHAIN_EVENTS) continue;
            (g.hopsInto.get(cur) || []).forEach(function (hop) {
                if (!depth.has(hop.src)) { depth.set(hop.src, depth.get(cur) + 1); queue.push(hop.src); }
            });
        }
        let hops = [];
        depth.forEach(function (_d, key) {
            (g.hopsInto.get(key) || []).forEach(function (h) { if (depth.has(h.src)) hops.push(h); });
        });
        hops = hops.sort(function (a, b) { return cmpTuple([depth.get(a.dst), a.approximate, depth.get(a.src), a.src], [depth.get(b.dst), b.approximate, depth.get(b.src), b.src]); });
        return { depth: depth, hops: hops };
    }

    function eventMeta(g, key) {
        const i = key.indexOf("@");
        if (i < 0) return { scope: "app", entity: null };
        const guid = key.slice(i + 1);
        const inst = g.insts.find(function (x) { return x.guid === guid; });
        return { scope: "entity", entity: inst ? inst.entity : null };
    }

    // Scripts that reference the arise bridge together with quest wording: they own the goal (the actual report to the
    // platform may hide in a closure).
    function ownersOf(g, goalHops) {
        const firing = new Set();
        goalHops.forEach(function (h) { firing.add(stepLabel(h.steps[h.steps.length - 1])); });
        const seen = new Set(), out = [];
        g.insts.forEach(function (inst) {
            const f = g.facts.get(inst.script);
            if (!f || !f.ar) return;
            if (!(f.qw || inst.script.toLowerCase().indexOf("quest") >= 0)) return;
            const why = Array.from(firing).some(function (l) { return l.indexOf(inst.script + ".") === 0; }) ? "fires the goal" : "";
            const k = inst.script + SEP + inst.entity + SEP + why;
            if (seen.has(k)) return;
            seen.add(k);
            out.push({ script: inst.script, entity: inst.entity, why: why });
        });
        return out.sort(function (a, b) { return cmpTuple([!a.why, a.script], [!b.why, b.script]); });
    }

    const pathMatches = function (read, write) {
        return write === read || write.indexOf(read + "[") === 0 || write.indexOf(read + ".") === 0
            || read.indexOf(write + "[") === 0 || read.indexOf(write + ".") === 0;
    };

    function findWriters(g, gd, onPath) {
        const dot = gd.state.indexOf(".");
        const script = dot < 0 ? gd.state : gd.state.slice(0, dot), path = dot < 0 ? "" : gd.state.slice(dot + 1);
        const writers = [];
        (g.byScript.get(script) || []).forEach(function (inst) {
            const f = g.facts.get(script);
            if (!f) return;
            f.m.forEach(function (fx, method) {
                if (method.indexOf("#") >= 0 || !asList(fx.sw).some(function (w) { return pathMatches(path, w); })) return;
                const node = { inst: inst.index, method: method }, nk = nodeKey(node);
                const events = [];
                let via = "";
                (g.reachedBy.get(nk) || []).forEach(function (r) {
                    if (events.indexOf(r.key) < 0) {
                        events.push(r.key);
                        if (!via) via = stepsOf(g, r.seen, node).map(function (s, i) { return i === 0 ? stepLabel(s) : s.method; }).join(" -> ");
                    }
                });
                writers.push({ method: script + "." + method, events: events, via: via, onPath: onPath.has(nk) });
            });
        });
        writers.sort(function (a, b) { return cmpTuple([a.events.length === 0, a.method], [b.events.length === 0, b.method]); });
        gd.writers = writers.slice(0, 6);
    }

    // Guards on the methods of the hops that fire the goal, with the methods that write the guarded state.
    function guardsOf(g, goalHops) {
        const nodes = new Map();                      // node key -> step
        goalHops.forEach(function (h) { h.steps.forEach(function (s) { const k = s.inst + SEP + s.method; if (!nodes.has(k)) nodes.set(k, s); }); });
        const onPath = new Set(nodes.keys());
        const guards = new Map();
        const guard = function (state, foreign) {
            if (!guards.has(state)) guards.set(state, { state: state, foreign: foreign, readers: [], writers: [] });
            return guards.get(state);
        };
        nodes.forEach(function (step) {
            const inst = g.insts[step.inst], fx = fxOf(g, inst, step.method);
            const reader = inst.script + "." + step.method;
            asList(fx.xr).forEach(function (x) {
                const p = x.indexOf(":");
                if (p < 0) return;
                const gd = guard(x.slice(0, p) + "." + x.slice(p + 1), true);
                if (gd.readers.indexOf(reader) < 0) gd.readers.push(reader);
            });
            const methods = (g.facts.get(inst.script) || { names: new Set() }).names;
            asList(fx.st).forEach(function (name) {
                if (!hasOwn(inst.attrs, name) && STATE_IGNORE.indexOf(name) < 0 && !methods.has(name)) {
                    const gd = guard(inst.script + "." + name, false);
                    if (gd.readers.indexOf(reader) < 0) gd.readers.push(reader);
                }
            });
        });
        // keep the most specific foreign path per script.root: runHistory._levels is covered by runHistory._levels[].completed
        Array.from(guards.keys()).forEach(function (state) {
            if (guards.get(state).foreign && Array.from(guards.keys()).some(function (o) {
                return o !== state && o.indexOf(state) === 0 && "[.".indexOf(o.charAt(state.length)) >= 0;
            })) guards.delete(state);
        });
        guards.forEach(function (gd) { findWriters(g, gd, onPath); });
        return Array.from(guards.values()).sort(function (a, b) {
            return cmpTuple([!a.foreign, a.writers.length === 0, a.state], [!b.foreign, b.writers.length === 0, b.state]);
        });
    }

    // The best "start/play/select" style event and the best "fire/shoot/click/press" style event among the app events that
    // have a handler in the scene. Score = name tokens, +TRIGGER_CHAIN_BONUS for an event within REPORT_DEPTH hops of the
    // goal (farther is menu wiring, which touches nearly every event); ties broken by name.
    function triggersOf(g, depth, goal, optional) {
        const cands = Array.from(g.handlers.keys()).filter(function (k) {
            return k.indexOf("@") < 0 && k !== goal && k.toLowerCase().indexOf("arise:") !== 0 && k.toLowerCase().indexOf("leaderboard") < 0 && !optional.has(k);
        });
        const picks = [], notes = [];
        [["start/play/select", startScore], ["fire/shoot/click/press", actionScore]].forEach(function (pair) {
            const label = pair[0], scorer = pair[1];
            const scored = cands.filter(function (k) { return scorer(k) > 0; }).map(function (k) {
                const d = depth.get(k);
                return [scorer(k) + (d !== undefined && d <= REPORT_DEPTH ? TRIGGER_CHAIN_BONUS : 0), k];
            }).sort(function (a, b) { return cmpTuple([-a[0], a[1]], [-b[0], b[1]]); });
            if (scored.length) {
                picks.push(scored[0][1]);
                const runner = scored.length > 1 ? "; next " + scored[1][1] + " (" + scored[1][0] + ")" : "";
                notes.push("trigger " + scored[0][1] + " (" + label + " style, score " + scored[0][0] + runner + ")");
            }
        });
        return { triggers: picks, notes: notes };
    }

    // Payload fields the chain handlers of key read from their first parameter, with an inferred kind each.
    function fieldsOf(g, key, chainHops) {
        const reads = new Map();
        chainHops.forEach(function (h) {
            if (h.src !== key) return;
            for (let i = 0; i < h.steps.length; i++) {
                const s = h.steps[i];
                if (i === 0 || s.how === "guess") {         // a hidden closure forwards the payload to the orphan it calls
                    readsOf(g, s.inst, s.method, 0, null).forEach(function (v, k) { if (!reads.has(k) || reads.get(k) === "?") reads.set(k, v); });
                }
                if (i > 0 && s.how !== "guess") break;
            }
        });
        return new Map(Array.from(reads.entries()).slice(0, MAX_FIELDS));
    }

    // {recipe, entryInfo, preferred, triggerNotes}. Events a user marked optional in saved knowledge (optional) are
    // neither triggers nor entries.
    function recipeOf(g, goal, depth, hops, guards, optional) {
        const trig = triggersOf(g, depth, goal, optional);
        const triggers = trig.triggers;
        let cands = [], skippedEntity = 0;
        depth.forEach(function (d, key) {
            const name = nameOf(key);
            if (key === goal || d < 1 || d > MAX_ENTRY_HOPS || name.toLowerCase().indexOf("arise:") === 0 || name.toLowerCase().indexOf("leaderboard") >= 0) return;
            if (key.indexOf("@") >= 0) { skippedEntity++; return; }          // the recipe schema cannot name an entity
            if (triggers.indexOf(name) >= 0 || optional.has(name)) return;
            const fields = fieldsOf(g, key, hops);
            const producers = g.producers.get(key) || new Set();
            if (producers.size && !fields.size) {
                let onlyLoops = true, anyHandler = false;
                producers.forEach(function (p) { if (!g.loopNodes.has(p)) onlyLoops = false; if (g.handlerNodes.has(p)) anyHandler = true; });
                if (onlyLoops && !anyHandler) return;                       // fired only by update loops and read by nobody: it fires by itself
            }
            const approx = hops.some(function (h) { return h.src === key && depth.get(h.dst) === d - 1 && h.approximate; });
            cands.push({ d: d, approx: approx, key: key, fields: fields });
        });
        cands = cands.sort(function (a, b) { return cmpTuple([a.d, a.approx, a.key], [b.d, b.approx, b.key]); });

        // Guard analysis: an entry can satisfy a guard on a fresh account only if the writer of the guarded state runs when it
        // is fired, i.e. the entry is an event whose handler chain writes the state or sits upstream of such an event.
        // Entries below the writer (closer to the goal) skip the write. All guards with a known writer must be satisfied.
        const gated = guards.filter(function (gd) { return gd.foreign && gd.writers.some(function (w) { return w.events.length > 0; }); });
        const gatedEvents = gated.map(function (gd) {
            const s = new Set();
            gd.writers.forEach(function (w) { w.events.forEach(function (e) { s.add(e); }); });
            return s;
        });
        const memo = new Map();
        const runsWriter = function (key) {
            const down = downstream(g, key, memo);
            return gatedEvents.every(function (evs) {
                if (evs.has(key)) return true;
                let hit = false;
                down.forEach(function (e) { if (evs.has(e)) hit = true; });
                return hit;
            });
        };
        const sat = gated.length ? cands.filter(function (c) { return runsWriter(c.key); }) : [];
        const rest = cands.filter(function (c) { return sat.indexOf(c) < 0; });
        const preferred = sat.length ? sat[0].key : "";
        let why = "";
        const entries = [], info = [];
        sat.concat(rest).forEach(function (c) {
            const ok = gated.length ? runsWriter(c.key) : null;
            let note = "";
            if (ok === false) {
                note = "does not run the state writer the goal path depends on, so it only works if that state is already set";
            } else if (ok && c.key === preferred) {
                const gd = gated[0], w = gd.writers[0];
                note = why = "guard: " + gd.state.slice(gd.state.indexOf(".") + 1) + " written by " + w.method + " via " + w.via;
            }
            const args = [];
            if (c.fields.size) {
                const payload = {};
                c.fields.forEach(function (v, k) { setOwn(payload, k, kindDefault(v)); });
                args.push(payload);
            }
            entries.push({ name: nameOf(c.key), scope: "app", args: args, source: "inferred" });
            info.push({ name: nameOf(c.key), depth: c.d, approximate: c.approx, guardOk: ok, fields: c.fields, note: note });
        });
        const notes = [];
        const goalHop = hops.find(function (h) { return h.dst === goal; });
        if (goalHop) {
            notes.push(goal + " is fired by " + stepLabel(goalHop.steps[goalHop.steps.length - 1]) + ", reached from " + nameOf(goalHop.src) + " via " + hopPath(goalHop) + ".");
        }
        if (preferred) {
            notes.push(nameOf(preferred) + " is listed first: the state the goal path checks is written when it is handled ("
                + why.replace(/^guard: /, "") + "); events closer to the goal skip that write.");
        } else {
            notes.push("Entries are in goal-upward order (closest to the goal first); no guard with a known writer was found, so no entry is preferred.");
        }
        if (info.some(function (i) { return i.approximate; })) notes.push("Some links are guesses through a hidden closure; verify with a recorded run.");
        if (skippedEntity) notes.push(skippedEntity + " entity-scoped event(s) on the chain are not offered (the recipe cannot name an entity).");
        const recipe = {
            version: RECIPE_VERSION, goal: nameOf(goal), triggers: triggers.slice(), entries: entries, suppress: SUPPRESS.slice(),
            delay_ms: 0, notes: notes.join(" "), source: "guessed"
        };
        return { recipe: recipe, entryInfo: info, preferred: preferred ? nameOf(preferred) : "", triggerNotes: trig.notes };
    }

    // "ariseRewards._onRecord -> _onRun (guess: hidden closure) -> _complete"
    function hopPath(hop) {
        return hop.steps.map(function (s, i) {
            let text = i === 0 ? stepLabel(s) : s.method;
            if (s.how === "guess") text += " (guess: hidden closure)";
            else if (s.how === "cross") text = stepLabel(s) + " (other script)";
            return text;
        }).join(" -> ");
    }

    function guardText(gd) {
        const rd = gd.readers.slice(0, 3).join(", ");
        if (!gd.writers.length) return gd.state + " (read by " + rd + "): no writer found in the scripts";
        const w = gd.writers[0];
        let when;
        if (w.events.length) when = " when " + w.events.slice(0, 3).map(function (e) { return e.split("@")[0]; }).join(" or ") + " is handled (" + w.via + ")";
        else when = w.onPath ? " (on the goal path itself)" : "";
        return gd.state + " (read by " + rd + ") is written by " + w.method + when;
    }

    // Chain, guards and completion recipe from a scan's script facts, as a generator (yields inside the graph build).
    // knowledge is optional: {goalNames, optionalEvents} (arrays or sets), names learned elsewhere.
    function* analyzeSteps(scan, knowledge) {
        const out = {
            available: false, scriptTypes: 0, listeners: 0, unattributed: 0, goal: "", goals: [], unreachedGoals: [], events: new Map(),
            hops: [], owners: [], guards: [], recipe: null, entryInfo: [], preferred: "", triggerNotes: [], notes: [], found: false
        };
        if (!hasFacts(scan) || scan.ok === false) return out;
        const know = knowledge ? { goalNames: new Set(Array.from(knowledge.goalNames || [])), optionalEvents: new Set(Array.from(knowledge.optionalEvents || [])) } : null;
        out.available = true;
        const g = yield* makeGraph(scan);
        yield* buildHandlers(g, scan);
        out.scriptTypes = g.facts.size;
        const reg = asDict(scan.listeners);
        out.listeners = Object.keys(reg).reduce(function (n, k) { return n + asList(reg[k]).length; }, 0);
        out.unattributed = g.unattributed;
        const trunc = asDict(scan.truncated);
        if (trunc.scripts === true || trunc.sources === true) out.notes.push("The script facts were truncated; the chain may be incomplete.");
        const goals = [];
        goalCandidates(g, know).forEach(function (c) {
            if ((g.hopsInto.get(c.key) || []).length) goals.push(c); else out.unreachedGoals.push(c.key);
        });
        out.goals = goals;
        if (!goals.length) return out;
        yield;
        const top = goals.filter(function (c) { return c.strength === goals[0].strength && c.learned === goals[0].learned; });
        let best = null, bestScore = null;
        top.forEach(function (c) {                    // the longest chain wins, the first of equals keeps its place
            const score = [chainOf(g, c.key).depth.size, c.key === top[0].key];
            if (bestScore === null || cmpTuple(bestScore, score) < 0) { best = c.key; bestScore = score; }
        });
        out.goal = best;
        const chain = chainOf(g, best);
        out.hops = chain.hops;
        chain.depth.forEach(function (d, key) {
            const meta = eventMeta(g, key);
            out.events.set(key, { key: key, name: nameOf(key), scope: meta.scope, entity: meta.entity, depth: d, root: !(g.hopsInto.get(key) || []).length });
        });
        const goalHops = chain.hops.filter(function (h) { return h.dst === best; });
        out.owners = ownersOf(g, goalHops);
        out.guards = guardsOf(g, goalHops);
        yield;
        const optional = know ? know.optionalEvents : new Set();
        const r = recipeOf(g, best, chain.depth, chain.hops, out.guards, optional);
        out.recipe = r.recipe; out.entryInfo = r.entryInfo; out.preferred = r.preferred; out.triggerNotes = r.triggerNotes;
        if (out.unattributed) {
            out.notes.push(out.unattributed + " of " + out.listeners + " listeners could not be tied to a script method (bound functions without a visible source); their events are only known from the registration code.");
        }
        out.found = !!(out.goal && out.hops.length);
        return out;
    }

    // ---- public summary ------------------------------------------------------------------------------------------------
    function emptySummary(status, reason) {
        return {
            status: status, reason: reason || "", available: false, found: false, scriptTypes: 0, listeners: 0, unattributed: 0, goal: "",
            goals: [], unreachedGoals: [], events: [], hops: [], owners: [], guards: [], entries: [], preferred: "", triggerNotes: [],
            notes: [], truncated: { scripts: false, sources: false }, builtAt: 0, ms: 0, slices: 0, units: 0, maxSliceMs: 0,
            types: { total: 0, extracted: 0, reused: 0 }
        };
    }

    // The analysis as plain JSON-able data. An entry is usable for the completion runner when it is known to run the writer
    // of the state the goal path reads (guardOk true), or when the goal path reads no state of another script at all (nothing
    // to verify). An entry that skips the writer (guardOk false), and any entry while the goal path reads state of another
    // script that no event is known to write, is never usable.
    function summarize(a, scan) {
        const foreignGuard = a.guards.some(function (gd) { return gd.foreign; });
        const s = emptySummary("done", "");
        s.available = a.available; s.found = a.found; s.scriptTypes = a.scriptTypes; s.listeners = a.listeners;
        s.unattributed = a.unattributed; s.goal = a.goal;
        s.goals = a.goals.map(function (c) { return { key: c.key, strength: c.strength, learned: c.learned }; });
        s.unreachedGoals = a.unreachedGoals.slice();
        a.events.forEach(function (e) { s.events.push(Object.assign({}, e)); });
        s.hops = a.hops.map(function (h) {
            return {
                src: h.src, dst: h.dst, how: h.how, ambiguous: h.ambiguous, approximate: h.approximate, path: hopPath(h),
                steps: h.steps.map(function (st) { return Object.assign({}, st); })
            };
        });
        s.owners = a.owners.map(function (o) { return Object.assign({}, o); });
        s.guards = a.guards.map(function (gd) {
            return {
                state: gd.state, foreign: gd.foreign, readers: gd.readers.slice(), text: guardText(gd),
                writers: gd.writers.map(function (w) { return { method: w.method, events: w.events.slice(), via: w.via, onPath: w.onPath }; })
            };
        });
        s.entries = a.entryInfo.map(function (i) {
            let usable, reason;
            if (i.guardOk === true) { usable = true; reason = "runs the state writer the goal path depends on"; }
            else if (i.guardOk === false) { usable = false; reason = "does not run the state writer the goal path depends on"; }
            else if (!foreignGuard) { usable = true; reason = "the goal path reads no state of another script"; }
            else { usable = false; reason = "the goal path reads state of another script and no event is known to write it"; }
            const fields = {};
            i.fields.forEach(function (v, k) { setOwn(fields, k, v); });
            return { name: i.name, depth: i.depth, approximate: i.approximate, guardOk: i.guardOk, usable: usable, reason: reason, fields: fields, note: i.note };
        });
        s.preferred = a.preferred;
        s.triggerNotes = a.triggerNotes.slice();
        s.notes = a.notes.slice();
        const t = asDict(scan && scan.truncated);
        s.truncated = { scripts: t.scripts === true, sources: t.sources === true };
        return s;
    }

    // Full analysis of a scan in one go (parity tests, tooling): {source, recipe}.
    function analyzeNow(scan, knowledge) {
        const gen = analyzeSteps(scan, knowledge);
        let r = gen.next();
        while (!r.done) r = gen.next();
        const a = r.value;
        return { source: summarize(a, scan), recipe: a.found && a.recipe ? JSON.parse(JSON.stringify(a.recipe)) : null };
    }

    // ---- pipeline: script facts (cached per script type), listener attribution, analysis ---------------------------------
    // The source of a script type never changes, so its facts are computed once per type. They depend on the other script
    // types of the scene only through the names the type mentions after .script. (mentions); a cached entry is reused
    // while the part of that set that exists in the scene (relied) is the same, and while the constructor is the same.
    const MAX_TYPES = 600;
    const cache = new Map();                          // script name -> entry (see factsOf)
    let job = null, timerPending = false, lastScan = null;
    const totals = { jobs: 0, slices: 0, units: 0, cpuMs: 0, maxSliceMs: 0, extracted: 0, reused: 0, failed: 0 };

    function sameRelied(entry, typeNames) {
        let k = 0;
        for (let i = 0; i < entry.mentions.length; i++) {
            if (typeNames.has(entry.mentions[i])) {
                if (entry.relied[k] !== entry.mentions[i]) return false;
                k++;
            }
        }
        return k === entry.relied.length;
    }

    function* extractType(name, ctor, typeNames) {
        const entry = { ctor: ctor, facts: null, table: null, ownFns: new Set(), mentions: [], relied: [], size: 0, truncSources: false };
        try {
            yield* factsOf(entry, ctor, typeNames);
        } catch (err) {
            warnOnce("the scripts of " + name + " could not be read", err);
            entry.facts = null;
            entry.truncSources = true;
            totals.failed++;
        }
        cache.delete(name);
        cache.set(name, entry);
        if (cache.size > MAX_TYPES) cache.delete(cache.keys().next().value);
        return entry;
    }

    function* pipeline(input) {
        const scan = input.scan, instances = input.refs.instances;
        const typeCount = new Map(), typeCtor = new Map();
        for (let i = 0; i < instances.length; i++) {
            const x = instances[i];
            typeCount.set(x.name, (typeCount.get(x.name) || 0) + 1);
            if (!typeCtor.has(x.name)) typeCtor.set(x.name, x.inst.__scriptType);
        }
        const typeNames = new Set(typeCtor.keys());
        const trunc = { scripts: false, sources: false };
        const scripts = {}, tables = new Map(), ownFnNames = new Map();
        let bytes = 0, extracted = 0, reused = 0;
        yield;
        for (const e of typeCtor) {
            const name = e[0], ctor = e[1];
            if (!ctor || !ctor.prototype) continue;
            let entry = cache.get(name);
            if (entry && entry.ctor === ctor && sameRelied(entry, typeNames)) reused++;
            else { entry = yield* extractType(name, ctor, typeNames); extracted++; }
            if (entry.truncSources) trunc.sources = true;
            if (!entry.facts) continue;
            tables.set(name, entry.table);
            ownFnNames.set(name, entry.ownFns);
            const size = entry.size + String(typeCount.get(name)).length;
            if (bytes + size > MAX_FACT_BYTES) { trunc.scripts = true; continue; }       // a smaller script may still fit
            bytes += size;
            setOwn(scripts, name, Object.assign({ n: typeCount.get(name) }, entry.facts));
        }
        yield;
        const attribute = makeAttributor(instances, tables, ownFnNames);
        const listeners = yield* attributeListeners(scan.listeners, input.refs.handles, attribute);
        const sourceScan = {
            ok: true, scene: scan.scene, entities: scan.entities, listeners: listeners, scripts: scripts,
            truncated: Object.assign({}, scan.truncated, { bytes: false, scripts: trunc.scripts, sources: trunc.sources }), counts: scan.counts
        };
        yield;
        const analysis = yield* analyzeSteps(sourceScan, null);
        return { scan: sourceScan, analysis: analysis, types: { total: typeNames.size, extracted: extracted, reused: reused } };
    }

    function finish(j, value) {
        lastScan = value.scan;
        const s = summarize(value.analysis, value.scan);
        s.builtAt = Date.now();
        s.ms = Math.round(j.cpuMs * 100) / 100;
        s.slices = j.slices;
        s.units = j.units;
        s.maxSliceMs = Math.round(j.maxSliceMs * 100) / 100;
        s.types = value.types;
        totals.extracted += value.types.extracted;
        totals.reused += value.types.reused;
        const a = value.analysis;
        host.publish({ source: s, recipe: a.found && a.recipe ? JSON.parse(JSON.stringify(a.recipe)) : null });
    }

    function fail(err) {
        warnOnce("source analysis failed", err);
        host.publish({ source: emptySummary("error", err && err.message ? String(err.message) : String(err)), recipe: null });
    }

    // ---- scheduler ------------------------------------------------------------------------------------------------------
    // The pipeline is a generator that yields after every unit (a method, an instance, a handler). A slice runs units until
    // about SLICE_MS have passed (at least one unit), then the next slice is queued: requestIdleCallback when the page has
    // it (with a timeout, so a game that never idles still finishes), else setTimeout with a gap that leaves the game most
    // of every frame. A new request replaces a running job; what that job already extracted stays cached.
    function kick() {
        if (timerPending) return;
        timerPending = true;
        const run = function (deadline) { timerPending = false; runSlice(deadline); };
        let idle = null;
        try { idle = window.requestIdleCallback; } catch (err) { idle = null; }
        if (typeof idle === "function") idle.call(window, run, { timeout: IDLE_TIMEOUT_MS });
        else setTimeout(run, SLICE_GAP_MS);
    }

    function runSlice(deadline) {
        const j = job;
        if (!j) return;
        const t0 = perfNow();
        let budget = SLICE_MS;
        if (deadline && !deadline.didTimeout && typeof deadline.timeRemaining === "function") {
            const left = deadline.timeRemaining();
            if (left > 0 && left < budget) budget = left;
        }
        let done = false, value = null, failure = null, units = 0;
        try {
            for (;;) {
                const r = j.gen.next();
                units++;
                if (r.done) { done = true; value = r.value; break; }
                if (perfNow() - t0 >= budget) break;
            }
        } catch (err) {
            failure = err;
        }
        const dt = perfNow() - t0;
        j.cpuMs += dt;
        j.units += units;
        j.slices++;
        if (dt > j.maxSliceMs) j.maxSliceMs = dt;
        totals.slices++;
        totals.units += units;
        totals.cpuMs += dt;
        if (dt > totals.maxSliceMs) totals.maxSliceMs = dt;
        if (failure) { job = null; fail(failure); return; }
        if (done) { job = null; totals.jobs++; finish(j, value); return; }
        kick();
    }

    // Starts (or restarts) the work for a graph scan: {scan, refs: {instances, handles}}. Scenes without a single script
    // type that has a prototype are answered at once, nothing is scheduled for them.
    function request(input) {
        try {
            let readable = false;
            for (let i = 0; i < input.refs.instances.length && !readable; i++) {
                const c = input.refs.instances[i].inst.__scriptType;
                if (c && c.prototype) readable = true;
            }
            if (!readable) {
                job = null;
                host.publish({ source: emptySummary("unavailable", "no script type with a readable prototype in the scene"), recipe: null });
                return;
            }
            job = { gen: pipeline(input), cpuMs: 0, slices: 0, units: 0, maxSliceMs: 0 };
            kick();
        } catch (err) {
            job = null;
            fail(err);
        }
    }

    // Runs the pending job to completion right now (tests, tooling). Returns false when nothing was pending.
    function drain() {
        const j = job;
        if (!j) return false;
        job = null;
        const t0 = perfNow();
        let value = null, failure = null;
        try {
            for (;;) {
                const r = j.gen.next();
                j.units++;
                totals.units++;
                if (r.done) { value = r.value; break; }
            }
        } catch (err) {
            failure = err;
        }
        const dt = perfNow() - t0;
        j.cpuMs += dt;
        j.slices++;
        totals.slices++;
        totals.cpuMs += dt;
        if (dt > j.maxSliceMs) j.maxSliceMs = dt;
        if (dt > totals.maxSliceMs) totals.maxSliceMs = dt;
        if (failure) fail(failure);
        else { totals.jobs++; finish(j, value); }
        return true;
    }

    function cancel() { job = null; }

    return {
        request: request, drain: drain, cancel: cancel, analyze: analyzeNow, emptySummary: emptySummary,
        pending: function () { return job !== null; },
        lastScan: function () { return lastScan; },
        stats: function () { return Object.assign({ cached: cache.size, pending: job !== null }, totals); }
    };
}
`;

export function buildGraphScript(): string {
    return "(function () {\n" + TABLES_SRC + GRAPH_SRC + SOURCE_SRC + "\n})();";
}
