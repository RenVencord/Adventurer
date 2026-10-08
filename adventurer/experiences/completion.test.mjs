// Run with: node --test completion.test.mjs
// Imports completion.ts directly (node strips the types), so the tests execute the exact string that
// buildCompletionScript() returns, inside a vm sandbox with a mock PlayCanvas app that reproduces the VALORANT Aces
// event chain (runHistory, ariseRewards, ariseLeaderboard). No Vencord imports, no deps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import * as cp from "./completion.ts";
import { makeAcesGame, NO_GUARD_SCRIPTS, UNVERIFIABLE_SCRIPTS } from "./fakegame.mjs";
import { buildGraphScript } from "./graph.ts";

const BUNDLED = JSON.parse(readFileSync(new URL("./recipes.json", import.meta.url), "utf8"));
const NATIVE_SRC = readFileSync(new URL("../native.ts", import.meta.url), "utf8");

const APP_ID = "1536318183873454090";
const SCENE = "GlobalAces_MASTER";
const GOAL = "arise:questComplete";
const j = x => JSON.parse(JSON.stringify(x)); // vm realms differ, compare plain JSON
const DASHES = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)]; // em and en dash, never allowed in injected code

const quest = (over = {}) => ({ [APP_ID]: { questId: "1537134637686591699", name: "VALORANT Aces", enrolled: true, completed: false, ...over } });
const OPEN = quest();
const DONE = quest({ completed: true });
const NOT_ENROLLED = quest({ enrolled: false });

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------
class EventHandler {
    constructor() { this._cb = Object.create(null); }
    on(name, fn, scope = this) { (this._cb[name] ||= []).push({ fn, scope }); return this; }
    off(name, fn) {
        if (this._cb[name]) this._cb[name] = this._cb[name].filter(l => l.fn !== fn);
        return this;
    }
    fire(name, ...args) {
        for (const l of (this._cb[name] || []).slice()) l.fn.call(l.scope, ...args);
        return this;
    }
}

class Entity extends EventHandler {
    constructor(name, guid) {
        super();
        this.name = name;
        this._guid = guid;
        this.children = [];
    }
    getGuid() { return this._guid; }
}

// The app records every event that reaches it (so an event the runner dropped is missing from `trace`).
class GameApp extends EventHandler {
    constructor(trace) { super(); this._trace = trace; }
    fire(name, ...args) {
        this._trace.push(name);
        return super.fire(name, ...args);
    }
}

// Reproduces the verified chain of the VALORANT Aces activity.
function makeGame(opts = {}) {
    const trace = [];
    const app = new GameApp(trace);
    const root = new Entity("Root", "g-root");
    const director = new Entity("Shot Director", "g-director");
    root.children.push(director);
    app.root = root;
    if (opts.scene !== null) app.scenes = { list: () => [{ name: opts.scene ?? SCENE }] };

    const history = { active: opts.historyActive ?? true, completed: new Set(), records: [] };
    const game = {
        app, root, director, trace, history,
        runArgs: [], leaderboardCalls: [], entityCalls: [], bridge: [],
        reportDue: false, announced: false,
        arise: opts.arise ?? { postMessage(m) { game.bridge.push(m); } },
        count: name => trace.filter(n => n === name).length,
        play: () => app.fire("select:play", { cardInfo: {} }),
        shoot: () => app.fire("shot:fire", { hit: true, zone: "head" }),
        // ariseRewards' update loop reports a queued quest to Discord through the bridge
        tick() {
            if (!game.reportDue) return;
            game.reportDue = false;
            game.arise.postMessage({ type: "quest:report", questId: "1537134637686591699" });
        }
    };

    // runHistory: _onComplete(t){ this.active && t && this.record(t) }, _toRecord is null unless total is finite
    app.on("run:complete", t => {
        game.runArgs.push(t);
        if (!history.active || !t) return;
        const total = Number(t.total);
        if (!Number.isFinite(total)) return;
        const rec = { total, kills: Number(t.kills) || 0, levelId: "ace:03" };
        history.completed.add(rec.levelId);
        history.records.push(rec);
        app.fire("level:recorded", rec);
        app.fire("run:recorded", rec);
        app.fire("leaderboard:submit", rec);
    });
    // ariseRewards: on run:recorded of a completed ace, fires arise:questComplete once and reports from its loop
    app.on("run:recorded", rec => {
        if (game.announced || opts.noRewards) return;
        if (/^ace:\d+$/.test(rec.levelId) && history.completed.has(rec.levelId)) {
            game.announced = true;
            game.reportDue = true;
            app.fire(GOAL, { runs: 1, max: 1, why: "ace" });
        }
    });
    // ariseLeaderboard: submits through the arise bridge
    app.on("leaderboard:submit", rec => {
        game.leaderboardCalls.push(rec);
        game.arise.postMessage({ type: "leaderboard:submit", record: rec });
    });
    // experienceSelect.select()
    app.on("select:play", () => {
        app.fire("transition:play");
        app.fire("shot:restart");
    });
    // an entity entry: fires app run:complete when it receives the call
    director.on("director:go", arg => {
        game.entityCalls.push(arg);
        app.fire("run:complete", { total: 0 });
    });
    return game;
}

function makeClock() {
    let now = 0, nextId = 1;
    let timers = [];
    return {
        setTimeout(fn, ms = 0) { const id = nextId++; timers.push({ id, at: now + Math.max(0, ms), fn }); return id; },
        clearTimeout(id) { timers = timers.filter(t => t.id !== id); },
        tick(ms) {
            const target = now + ms;
            for (;;) {
                const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (!due) break;
                now = due.at;
                timers = timers.filter(t => t !== due);
                due.fn();
            }
            now = target;
        },
        pending() { return timers.length; }
    };
}

class Bus {
    constructor() { this._l = Object.create(null); }
    on(name, fn) { (this._l[name] ||= []).push(fn); }
    count(name) { return (this._l[name] || []).length; }
    fire(name, ev) { for (const fn of (this._l[name] || []).slice()) fn(ev); }
}

// Loads the injected string into a sandbox the way native.ts would (profile placeholder replaced when `local` is given).
function load(game, o = {}) {
    const clock = makeClock();
    const bus = new Bus();
    const logs = { info: [], warn: [] };
    const toasts = [];
    const body = {
        children: [],
        appendChild(c) { this.children.push(c); c.parentNode = this; toasts.push(c.textContent); },
        removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; }
    };
    const document = { body, documentElement: body, createElement: tag => ({ tag, style: {}, textContent: "", parentNode: null }) };
    const parent = { name: "discord" };
    const sandbox = {
        console: { info: (...a) => logs.info.push(a.join(" ")), warn: (...a) => logs.warn.push(a.join(" ")), log: () => { } },
        document,
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        location: { hostname: o.host ?? `${APP_ID}.discordsays.com` },
        parent,
        ...(game ? { pc: { app: game.app }, arise: game.arise } : {}),
        // the real event graph reads the app's _callbacks Map with instanceof, so it needs the Map of the test's realm
        ...(o.graph ? { Map } : {}),
        ...(o.extra ?? {})
    };
    sandbox.window = sandbox;
    sandbox.addEventListener = (n, f) => bus.on(n, f);
    vm.createContext(sandbox);
    if (o.graph) vm.runInContext(buildGraphScript(), sandbox); // before the runner, like index.tsx

    const env = {
        sandbox, clock, logs, toasts, body, parent, bus, game,
        inject(opts = {}) {
            const has = k => Object.prototype.hasOwnProperty.call(opts, k);
            const src = cp.buildCompletionScript({
                recipes: has("recipes") ? opts.recipes : (o.recipes ?? BUNDLED),
                quests: has("quests") ? opts.quests : (o.quests ?? OPEN)
            });
            const local = has("local") ? opts.local : o.local;
            vm.runInContext(local === undefined ? src : src.split(cp.PROFILES_PLACEHOLDER).join(JSON.stringify(local)), sandbox);
        },
        post(data, source = parent) { bus.fire("message", { data, source }); },
        status() { return j(sandbox.__adventurerCompletion.status()); },
        logText() { return env.status().log.join("\n"); }
    };
    env.inject();
    return env;
}

// A spy above the runner's wrapper: sees every fire call, including the ones the runner drops.
function spyOuter(game) {
    const seen = [];
    const inner = game.app.fire;
    game.app.fire = function (name, ...args) { seen.push(name); return inner.call(this, name, ...args); };
    return seen;
}

const profile = (completion, over = {}) => ({
    application_id: APP_ID, scene: SCENE, name: "Edited", created: "2026-10-02T00:00:00", completion, ...over
});
const recipe = (over = {}) => ({
    version: 1, goal: GOAL, triggers: ["select:play", "shot:fire"],
    entries: [{ name: "run:complete", scope: "app", args: [{ total: 0 }] }], source: "edited", ...over
});

// ---------------------------------------------------------------------------
// Source hygiene
// ---------------------------------------------------------------------------
test("generated string parses (new Function and node --check), has no em-dashes and one placeholder", () => {
    const src = cp.buildCompletionScript({ recipes: BUNDLED, quests: OPEN });
    assert.doesNotThrow(() => new Function(src));
    const dir = mkdtempSync(join(tmpdir(), "completion-"));
    try {
        const f = join(dir, "script.js");
        writeFileSync(f, src);
        const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    assert.ok(!src.includes(DASHES[0]) && !src.includes(DASHES[1]));
    assert.equal(src.split(cp.PROFILES_PLACEHOLDER).length - 1, 1);
    // what native.ts replaces is the very token the builder emits
    assert.ok(NATIVE_SRC.includes(`const PROFILE_PLACEHOLDER = "${cp.PROFILES_PLACEHOLDER}";`));
    // the replaced script still parses with a real profile array in it
    const filled = src.split(cp.PROFILES_PLACEHOLDER).join(JSON.stringify([profile(recipe())]));
    assert.doesNotThrow(() => new Function(filled));
});

test("builder sanitises quests and passes recipes through", () => {
    const src = cp.buildCompletionScript({
        recipes: BUNDLED,
        quests: { abc: { questId: "1", name: "x", enrolled: true, completed: false }, [APP_ID]: { questId: 5, name: "Q", enrolled: 1, completed: 0 }, "1": null }
    });
    assert.ok(!src.includes('"abc"'));
    assert.match(src, new RegExp(`"${APP_ID}":\\{"questId":"5","name":"Q","enrolled":true,"completed":false\\}`));
    assert.doesNotThrow(() => cp.buildCompletionScript({ recipes: undefined, quests: undefined }));
});

test("buildCompletionMessage shape", () => {
    assert.deepEqual(cp.buildCompletionMessage(true), { __adventurerOverlay: true, type: "completion", enabled: true });
    assert.deepEqual(cp.buildCompletionMessage(0), { __adventurerOverlay: true, type: "completion", enabled: false });
});

test("bundled recipes.json holds the VALORANT Aces recipe", () => {
    assert.ok(Array.isArray(BUNDLED));
    const p = BUNDLED.find(x => x.application_id === APP_ID && x.scene === SCENE);
    assert.ok(p);
    assert.equal(p.name, "VALORANT Aces");
    assert.deepEqual(j(p.completion), {
        version: 1, goal: GOAL, triggers: ["select:play", "shot:fire"],
        entries: [{ name: "run:complete", scope: "app", args: [{ total: 0 }], source: "inferred" }],
        suppress: ["leaderboard"], delay_ms: 0, notes: p.completion.notes, source: "bundled"
    });
    assert.ok(p.completion.notes.length > 20);
    assert.ok(!JSON.stringify(BUNDLED).includes(DASHES[0]));
    // and the runner accepts it
    const env = load(makeGame());
    const s = env.status();
    assert.equal(s.recipe.origin, "bundled");
    assert.equal(s.recipe.name, "VALORANT Aces");
    assert.deepEqual(s.invalid, []);
});

// ---------------------------------------------------------------------------
// The main flow
// ---------------------------------------------------------------------------
test("play completes the quest, the leaderboard is dropped and never called", () => {
    const g = makeGame();
    const env = load(g);
    const outer = spyOuter(g);
    assert.equal(env.status().hooked, true);

    g.play();
    // the attempt waits until the click's own synchronous chain has finished
    assert.deepEqual(g.trace, ["select:play", "transition:play", "shot:restart"]);
    assert.equal(env.status().attempts, 0);

    env.clock.tick(0);
    assert.deepEqual(g.trace, ["select:play", "transition:play", "shot:restart", "run:complete", "level:recorded", "run:recorded", GOAL]);
    assert.deepEqual(j(g.runArgs), [{ total: 0 }]);
    assert.equal(g.count(GOAL), 1);
    // the game fired leaderboard:submit, the runner dropped it before any listener saw it
    assert.ok(outer.includes("leaderboard:submit"));
    assert.equal(g.count("leaderboard:submit"), 0);
    assert.equal(g.leaderboardCalls.length, 0);

    g.tick();
    assert.deepEqual(g.bridge.map(m => m.type), ["quest:report"]);

    const s = env.status();
    assert.equal(s.done, true);
    assert.match(s.doneBy, /^attempt 1 on select:play via run:complete/);
    assert.equal(s.attempts, 1);
    assert.deepEqual(s.used, ["select:play"]);
    assert.equal(s.dropped, 1);
    assert.equal(env.logs.info.some(l => /quest completion queued/.test(l)), true);
    assert.deepEqual(env.toasts, ["Adventurer: quest completion queued"]);
});

test("the toast is small, unobtrusive and removed again", () => {
    const g = makeGame();
    const env = load(g);
    g.play();
    env.clock.tick(0);
    assert.equal(env.body.children.length, 1);
    assert.match(env.body.children[0].style.cssText, /pointer-events:none/);
    env.clock.tick(3999);
    assert.equal(env.body.children.length, 1);
    env.clock.tick(1);
    assert.equal(env.body.children.length, 0);
});

test("shot:fire alone completes the quest when play was not used", () => {
    const g = makeGame();
    const env = load(g);
    g.shoot();
    assert.equal(g.count("run:complete"), 0);
    env.clock.tick(0);
    assert.equal(g.count("run:complete"), 1);
    assert.equal(g.count(GOAL), 1);
    assert.equal(g.leaderboardCalls.length, 0);
    assert.equal(env.status().done, true);
    assert.match(env.status().doneBy, /on shot:fire/);
});

test("after success nothing else is attempted", () => {
    const g = makeGame();
    const env = load(g);
    g.play();
    env.clock.tick(0);
    g.shoot();
    g.play();
    env.clock.tick(5000);
    assert.equal(g.count("run:complete"), 1);
    assert.equal(env.status().attempts, 1);
});

test("a trigger seen several times schedules one attempt", () => {
    const g = makeGame({ historyActive: false });
    const env = load(g);
    g.play(); g.play(); g.play();
    env.clock.tick(0);
    assert.equal(g.count("run:complete"), 1);
    g.play();
    env.clock.tick(0);
    assert.equal(g.count("run:complete"), 1);
});

test("recipe without a suppress list still drops the leaderboard", () => {
    const g = makeGame();
    const env = load(g, { local: [profile(recipe())] });
    assert.deepEqual(env.status().recipe.suppress, ["leaderboard"]);
    g.play();
    env.clock.tick(0);
    assert.equal(g.count(GOAL), 1);
    assert.equal(g.leaderboardCalls.length, 0);
    assert.equal(g.bridge.some(m => /leaderboard/.test(m.type)), false);
});

test("extra suppress patterns are lower-cased, de-duplicated and applied", () => {
    const g = makeGame();
    const env = load(g, { local: [profile(recipe({ suppress: ["LeaderBoard", "Level:Recorded", " ", 5] }))] });
    assert.deepEqual(env.status().recipe.suppress, ["leaderboard", "level:recorded"]);
    g.play();
    env.clock.tick(0);
    assert.equal(g.count("level:recorded"), 0);
    assert.equal(g.count(GOAL), 1);
});

test("no leaderboard bridge message is sent at any point of the attempt", () => {
    const g = makeGame();
    const env = load(g);
    g.play();
    env.clock.tick(0);
    env.clock.tick(3000);
    g.tick();
    assert.equal(g.bridge.some(m => /leaderboard/i.test(JSON.stringify(m))), false);
    assert.equal(g.leaderboardCalls.length, 0);
});

test("delay_ms postpones the attempt and is clamped", () => {
    const g = makeGame();
    const env = load(g, { local: [profile(recipe({ delay_ms: 500 }))] });
    g.play();
    env.clock.tick(499);
    assert.equal(g.count("run:complete"), 0);
    env.clock.tick(1);
    assert.equal(g.count("run:complete"), 1);

    const env2 = load(makeGame(), { local: [profile(recipe({ delay_ms: 99999 }))] });
    assert.equal(env2.status().recipe.delayMs, 10000);
    const env3 = load(makeGame(), { local: [profile(recipe({ delay_ms: -5 }))] });
    assert.equal(env3.status().recipe.delayMs, 0);
});

test("the wrapper is an own property, the prototype is untouched and event chaining still works", () => {
    const proto = EventHandler.prototype.fire;
    const gameProto = GameApp.prototype.fire;
    const g = makeGame();
    assert.equal(Object.hasOwn(g.app, "fire"), false);
    load(g);
    assert.equal(Object.hasOwn(g.app, "fire"), true);
    assert.equal(EventHandler.prototype.fire, proto);
    assert.equal(GameApp.prototype.fire, gameProto);
    assert.equal(g.app.fire("nothing:listens"), g.app);
});

// ---------------------------------------------------------------------------
// Quest gate
// ---------------------------------------------------------------------------
for (const [label, quests, reason] of [
    ["completed", DONE, /already completed/],
    ["not enrolled", NOT_ENROLLED, /not enrolled/],
    ["for another application", { "42": OPEN[APP_ID] }, /no quest known for application/],
    ["unknown", {}, /no quest known for application/]
]) {
    test(`not attempted when the quest is ${label}`, () => {
        const g = makeGame();
        const env = load(g, { quests });
        assert.equal(Object.hasOwn(g.app, "fire"), false);
        g.play();
        g.shoot();
        env.clock.tick(10000);
        assert.equal(g.count("run:complete"), 0);
        const s = env.status();
        assert.equal(s.hooked, false);
        assert.equal(s.gate.open, false);
        assert.match(s.gate.reason, reason);
        assert.equal(env.clock.pending(), 0);
    });
}

test("not attempted in a frame that is not an application host", () => {
    const g = makeGame();
    const env = load(g, { host: "example.discordsays.com" });
    g.play();
    env.clock.tick(100);
    assert.equal(g.count("run:complete"), 0);
    assert.equal(env.status().appId, "");
    assert.match(env.status().gate.reason, /not an application host/);
});

test("an application with no recipe is left alone", () => {
    const g = makeGame();
    const env = load(g, { host: "999.discordsays.com", quests: { "999": OPEN[APP_ID] } });
    assert.equal(Object.hasOwn(g.app, "fire"), false);
    g.play();
    env.clock.tick(100);
    assert.equal(g.count("run:complete"), 0);
    assert.equal(env.status().recipes.forApp, 0);
});

test("a closed gate does not use up the trigger, opening it later works", () => {
    const g = makeGame();
    const env = load(g, { quests: NOT_ENROLLED });
    g.play();
    env.clock.tick(0);
    assert.equal(g.count("run:complete"), 0);
    env.inject({ quests: OPEN });
    assert.equal(env.status().hooked, true);
    g.play();
    env.clock.tick(0);
    assert.equal(g.count("run:complete"), 1);
    assert.equal(env.status().done, true);
});

test("the gate is checked again when the attempt runs", () => {
    const g = makeGame();
    const env = load(g, { local: [profile(recipe({ delay_ms: 200 }))] });
    g.play();
    env.inject({ quests: DONE, local: [profile(recipe({ delay_ms: 200 }))] });
    env.clock.tick(200);
    assert.equal(g.count("run:complete"), 0);
    assert.deepEqual(env.status().used, []);
    assert.match(env.logText(), /already completed/);
});

test("a gate that closes after hooking stops attempts without unhooking", () => {
    const g = makeGame();
    const env = load(g);
    env.inject({ quests: DONE });
    g.play();
    g.shoot();
    env.clock.tick(100);
    assert.equal(g.count("run:complete"), 0);
    assert.equal(env.status().hooked, true);
    assert.equal(env.status().log.filter(l => /no attempt: .*already completed/.test(l)).length, 1);
});

// ---------------------------------------------------------------------------
// Failure, retry and bounds
// ---------------------------------------------------------------------------
test("goal not reached: logged, the next trigger retries, attempts are bounded", () => {
    const g = makeGame({ historyActive: false });
    const env = load(g);
    g.play();
    env.clock.tick(0);
    let s = env.status();
    assert.equal(s.attempts, 1);
    assert.equal(s.done, false);
    assert.match(s.log.join("\n"), /attempt 1 on select:play did not reach arise:questComplete; ran: run:complete; waiting for another trigger/);

    g.play(); g.play();
    env.clock.tick(0);
    assert.equal(env.status().attempts, 1);

    g.shoot();
    env.clock.tick(0);
    s = env.status();
    assert.equal(s.attempts, 2);
    assert.match(s.log.join("\n"), /attempt 2 on shot:fire did not reach arise:questComplete; ran: run:complete; no triggers left/);
    assert.deepEqual(s.used.sort(), ["select:play", "shot:fire"]);

    for (let i = 0; i < 5; i++) { g.play(); g.shoot(); env.clock.tick(5000); }
    assert.equal(env.status().attempts, 2);
    assert.equal(g.count("run:complete"), 2);
    assert.equal(env.logs.info.some(l => /did not reach/.test(l)), true);
});

test("a failed first attempt is followed by a successful one on the next trigger", () => {
    const g = makeGame({ historyActive: false });
    const env = load(g);
    g.play();
    env.clock.tick(0);
    assert.equal(env.status().done, false);
    g.history.active = true;
    g.shoot();
    env.clock.tick(0);
    assert.equal(env.status().done, true);
    assert.equal(g.count(GOAL), 1);
    assert.equal(g.leaderboardCalls.length, 0);
});

test("entries are tried in order and the first success stops the rest", () => {
    const g = makeGame();
    const env = load(g, {
        local: [profile(recipe({
            entries: [
                { name: "noop:first" },
                { name: "run:complete", args: [{ total: 0 }] },
                { name: "run:complete", args: [{ total: 99 }] }
            ]
        }))]
    });
    g.play();
    env.clock.tick(0);
    assert.deepEqual(j(g.runArgs), [{ total: 0 }]);
    assert.equal(g.count("noop:first"), 1);
    assert.equal(env.status().done, true);
});

test("a changed recipe earns fresh attempts", () => {
    const g = makeGame({ historyActive: false });
    const env = load(g, { local: [profile(recipe({ triggers: ["select:play"] }))] });
    g.play();
    env.clock.tick(0);
    assert.equal(env.status().attempts, 1);
    g.play();
    env.clock.tick(0);
    assert.equal(env.status().attempts, 1);
    env.inject({ local: [profile(recipe({ triggers: ["select:play"], entries: [{ name: "run:complete", args: [{ total: 3 }] }] }))] });
    g.history.active = true;
    g.play();
    env.clock.tick(0);
    assert.equal(env.status().attempts, 2);
    assert.deepEqual(j(g.runArgs.slice(-1)), [{ total: 3 }]);
    assert.equal(env.status().done, true);
});

// ---------------------------------------------------------------------------
// Entries that must never fire
// ---------------------------------------------------------------------------
test("arise:*, goal and suppressed entries are never fired", () => {
    const g = makeGame({ noRewards: true });
    const env = load(g, {
        local: [profile(recipe({
            suppress: ["suppressme"],
            entries: [
                { name: GOAL },
                { name: "arise:other" },
                { name: "ARISE:UPPER" },
                { name: "leaderboard:submit" },
                { name: "My:LeaderBoard:thing" },
                { name: "custom:SuppressMe" },
                { name: "scope:entity:leaderboard", scope: "entity", guid: "g-director" },
                { name: "run:complete", args: [{ total: 0 }] }
            ]
        }))]
    });
    const outer = spyOuter(g);
    g.play();
    env.clock.tick(0);
    // leaderboard:submit appears once: the game's own call (dropped by the runner), not the entry
    assert.deepEqual(outer.filter(n => !/^(select:play|transition:play|shot:restart)$/.test(n)), ["run:complete", "level:recorded", "run:recorded", "leaderboard:submit"]);
    assert.equal(g.count("leaderboard:submit"), 0);
    assert.equal(g.entityCalls.length, 0);
    const log = env.logText();
    assert.match(log, /skipped: .*arise:questComplete \(arise events are the game's own reports\)/);
    assert.match(log, /ARISE:UPPER \(arise events are the game's own reports\)/);
    assert.match(log, /leaderboard:submit \(it matches a suppress pattern\)/);
    assert.match(log, /My:LeaderBoard:thing \(it matches a suppress pattern\)/);
    assert.match(log, /custom:SuppressMe \(it matches a suppress pattern\)/);
    assert.match(log, /scope:entity:leaderboard \(it matches a suppress pattern\)/);
    assert.equal(env.status().done, false);
});

test("a custom goal event is never fired as an entry", () => {
    const g = makeGame({ noRewards: true });
    const env = load(g, {
        local: [profile(recipe({
            goal: "quest:done",
            entries: [{ name: "Quest:Done" }, { name: "run:complete", args: [{ total: 0 }] }]
        }))]
    });
    const outer = spyOuter(g);
    g.play();
    env.clock.tick(0);
    assert.equal(outer.some(n => /quest:done/i.test(n)), false);
    assert.match(env.logText(), /Quest:Done \(it is the goal event\)/);
});

test("the goal event is not dropped even when a suppress pattern matches it", () => {
    const g = makeGame();
    const env = load(g, { local: [profile(recipe({ suppress: ["arise"] }))] });
    g.play();
    env.clock.tick(0);
    assert.equal(g.count(GOAL), 1);
    assert.equal(env.status().done, true);
});

test("events fired by the attempt itself never schedule attempts", () => {
    const g = makeGame();
    const env = load(g, {
        local: [profile(recipe({ entries: [{ name: "shot:fire" }, { name: "select:play" }, { name: "run:complete", args: [{ total: 0 }] }] }))]
    });
    g.play();
    env.clock.tick(0);
    env.clock.tick(5000);
    assert.equal(env.status().attempts, 1);
    assert.deepEqual(env.status().used, ["select:play"]);
    assert.equal(env.status().done, true);
});

// ---------------------------------------------------------------------------
// Recipe selection
// ---------------------------------------------------------------------------
test("a local recipe overrides the bundled one for the same application and scene", () => {
    const g = makeGame();
    const env = load(g, {
        local: [profile(recipe({ triggers: ["select:play"], entries: [{ name: "run:complete", args: [{ total: 7, kills: 2 }] }] }))]
    });
    const s = env.status();
    assert.equal(s.recipe.origin, "local");
    assert.equal(s.recipe.source, "edited");
    assert.deepEqual(s.recipe.triggers, ["select:play"]);
    assert.deepEqual(s.recipes, { local: 1, bundled: 1, forApp: 2 });
    // shot:fire belongs to the bundled recipe only, so it does nothing now
    g.shoot();
    env.clock.tick(0);
    assert.equal(g.count("run:complete"), 0);
    g.play();
    env.clock.tick(0);
    assert.deepEqual(j(g.runArgs), [{ total: 7, kills: 2 }]);
});

test("the newest local profile wins and profiles without completion or for another application are ignored", () => {
    const g = makeGame();
    const env = load(g, {
        local: [
            profile(recipe({ entries: [{ name: "run:complete", args: [{ total: 1 }] }] }), { name: "newest" }),
            profile(recipe({ entries: [{ name: "run:complete", args: [{ total: 2 }] }] }), { name: "older" }),
            { application_id: APP_ID, scene: SCENE, steps: [{ index: 1, events: [] }] },
            profile(recipe({ entries: [{ name: "run:complete", args: [{ total: 3 }] }] }), { application_id: "42", name: "other app" }),
            "garbage", null
        ]
    });
    const s = env.status();
    assert.equal(s.recipe.name, "newest");
    assert.deepEqual(s.recipes, { local: 3, bundled: 1, forApp: 3 });
    g.play();
    env.clock.tick(0);
    assert.deepEqual(j(g.runArgs), [{ total: 1 }]);
});

test("a local profile without application_id belongs to this frame's application", () => {
    const g = makeGame();
    const p = profile(recipe({ entries: [{ name: "run:complete", args: [{ total: 4 }] }] }));
    delete p.application_id;
    const env = load(g, { local: [p] });
    assert.equal(env.status().recipe.origin, "local");
    g.play();
    env.clock.tick(0);
    assert.deepEqual(j(g.runArgs), [{ total: 4 }]);
});

test("scene * matches any scene", () => {
    const g = makeGame({ scene: "SomethingElse" });
    const env = load(g, {
        recipes: [],
        local: [profile(recipe({ entries: [{ name: "run:complete", args: [{ total: 6 }] }] }), { scene: "*" })]
    });
    assert.equal(env.status().recipe.scene, "*");
    g.play();
    env.clock.tick(0);
    assert.deepEqual(j(g.runArgs), [{ total: 6 }]);
});

test("a bundled recipe for another scene is not used", () => {
    const g = makeGame({ scene: "SomethingElse" });
    const env = load(g);
    assert.equal(env.status().recipe, null);
    g.play();
    env.clock.tick(100);
    assert.equal(g.count("run:complete"), 0);
    assert.match(env.logText(), /no recipe for scene \[SomethingElse\], select:play ignored/);
    assert.equal(env.status().attempts, 0);
});

test("an exact scene beats * and a local * beats nothing but a non-matching bundled recipe", () => {
    // bundled exact vs local *: the more specific bundled recipe wins
    const g = makeGame();
    const env = load(g, { local: [profile(recipe({ entries: [{ name: "run:complete", args: [{ total: 9 }] }] }), { scene: "*" })] });
    assert.equal(env.status().recipe.origin, "bundled");
    g.play();
    env.clock.tick(0);
    assert.deepEqual(j(g.runArgs), [{ total: 0 }]);
    // local exact vs bundled exact: local wins
    const g2 = makeGame();
    const env2 = load(g2, { local: [profile(recipe(), { scene: "*" }), profile(recipe({ source: "recorded" }))] });
    assert.equal(env2.status().recipe.source, "recorded");
    assert.equal(env2.status().recipe.scene, SCENE);
});

test("the scene name is found through app.scene.name and app.scenes.list()", () => {
    const g = makeGame({ scene: null });
    g.app.scene = { name: SCENE };
    const env = load(g);
    assert.deepEqual(env.status().scene, [SCENE]);
    assert.equal(env.status().recipe.name, "VALORANT Aces");
    const g2 = makeGame({ scene: "Other" });
    g2.app.scene = { name: SCENE };
    assert.deepEqual(load(g2).status().scene, [SCENE, "Other"]);
});

test("invalid recipes are reported and ignored", () => {
    const g = makeGame();
    const env = load(g, {
        recipes: [],
        local: [
            profile(recipe({ version: 2 }), { name: "v2" }),
            profile(recipe({ goal: "" }), { name: "nogoal" }),
            profile(recipe({ triggers: [] }), { name: "notrig" }),
            profile(recipe({ entries: [{ scope: "entity", name: "x" }, { name: "" }, 5] }), { name: "noentries" }),
            profile(recipe(), { name: "noscene", scene: "" }),
            profile(recipe({ entries: [{ name: "x", scope: "weird" }] }), { name: "badscope" })
        ]
    });
    const s = env.status();
    assert.equal(s.recipe, null);
    assert.equal(s.recipes.local, 0);
    assert.equal(s.invalid.length, 6);
    assert.match(s.invalid.join("\n"), /v2 \(local\): unsupported completion version 2/);
    assert.match(s.invalid.join("\n"), /nogoal \(local\): missing goal/);
    assert.match(s.invalid.join("\n"), /notrig \(local\): no triggers/);
    assert.match(s.invalid.join("\n"), /noentries \(local\): no usable entries/);
    assert.match(s.invalid.join("\n"), /noscene \(local\): missing scene/);
    assert.equal(env.logs.warn.length, 6);
});

// ---------------------------------------------------------------------------
// Entity scope
// ---------------------------------------------------------------------------
test("entity entries fire on the entity found by guid, then by name, and decode @entity args", () => {
    const g = makeGame({ noRewards: false });
    const env = load(g, {
        local: [profile(recipe({
            entries: [
                { name: "director:go", scope: "entity", entity: "Nobody", guid: "g-missing", args: ["@entity:g-director"] },
                { name: "run:complete", args: [{ total: 0, who: "@entity:g-missing" }] },
                { name: "director:go", scope: "entity", entity: "Shot Director", guid: "wrong", args: ["@entity:g-director", { nested: ["@entity:g-root"], plain: 1 }] }
            ]
        }))]
    });
    g.play();
    env.clock.tick(0);
    assert.equal(g.entityCalls.length, 1);
    assert.equal(g.entityCalls[0], g.director);
    assert.match(env.logText(), /director:go \(entity Nobody not found\)/);
    assert.match(env.logText(), /run:complete \(entity g-missing not found\)/);
    assert.equal(env.status().done, true);
});

test("entity lookup by guid wins over the name and decoded args are copies", () => {
    const g = makeGame();
    const other = new Entity("Shot Director", "g-other");
    other.on("director:go", () => { throw new Error("must not be called"); });
    g.root.children.unshift(other);
    const args = [{ list: ["@entity:g-root"] }];
    const env = load(g, { local: [profile(recipe({ entries: [{ name: "director:go", scope: "entity", entity: "Shot Director", guid: "g-director", args }] }))] });
    let seen = null;
    g.director.on("director:go", a => { seen = a; });
    g.play();
    env.clock.tick(0);
    assert.equal(g.entityCalls.length, 1);
    assert.deepEqual(seen.list[0], g.root);
    assert.equal(typeof args[0].list[0], "string");
});

// ---------------------------------------------------------------------------
// Suppression window and bridge
// ---------------------------------------------------------------------------
test("the suppression window lasts the attempt plus 3 s and then postMessage is restored", () => {
    const g = makeGame();
    const original = g.arise.postMessage;
    const env = load(g);
    assert.equal(g.arise.postMessage, original);
    g.play();
    env.clock.tick(0);
    assert.equal(env.status().windowOpen, true);
    assert.notEqual(g.arise.postMessage, original);

    // inside the window: leaderboard events and bridge messages are dropped, everything else passes
    env.clock.tick(2999);
    g.app.fire("leaderboard:submit", { late: true });
    g.arise.postMessage({ type: "leaderboard:submit" });
    g.arise.postMessage({ type: "x", payload: { action: "Leaderboard.Submit" } });
    g.arise.postMessage('{"type":"leaderboard.sync"}');
    g.arise.postMessage({ type: "quest:report", questId: "1" });
    g.arise.postMessage("ping");
    g.arise.postMessage(null);
    assert.equal(g.leaderboardCalls.length, 0);
    assert.deepEqual(g.bridge.map(m => (m && m.type) || m), ["quest:report", "ping", null]);

    env.clock.tick(1);
    assert.equal(env.status().windowOpen, false);
    assert.equal(g.arise.postMessage, original);

    // after the window the game is untouched again
    g.app.fire("leaderboard:submit", { after: true });
    assert.equal(g.leaderboardCalls.length, 1);
    g.arise.postMessage({ type: "leaderboard:submit" });
    assert.equal(g.bridge.at(-1).type, "leaderboard:submit");
});

test("postMessage defined on the prototype is restored without an own property", () => {
    const proto = { postMessage(m) { calls.push(m); } };
    const calls = [];
    const arise = Object.create(proto);
    const g = makeGame({ arise });
    const env = load(g);
    g.play();
    env.clock.tick(0);
    assert.equal(Object.hasOwn(arise, "postMessage"), true);
    arise.postMessage({ type: "leaderboard:submit" });
    arise.postMessage({ type: "quest:report" });
    assert.deepEqual(calls.map(c => c.type), ["quest:report"]);
    env.clock.tick(3000);
    assert.equal(Object.hasOwn(arise, "postMessage"), false);
    assert.equal(arise.postMessage, proto.postMessage);
});

test("a postMessage replaced during the window is left alone", () => {
    const g = makeGame();
    const env = load(g);
    g.play();
    env.clock.tick(0);
    const other = () => "other";
    g.arise.postMessage = other;
    env.clock.tick(3000);
    assert.equal(g.arise.postMessage, other);
    assert.match(env.logText(), /replaced during the window/);
});

test("a second attempt extends the window, only the last timer closes it", () => {
    const g = makeGame({ historyActive: false });
    const env = load(g);
    g.play();
    env.clock.tick(0);
    env.clock.tick(2000);
    g.shoot();
    env.clock.tick(0);
    env.clock.tick(2000);
    assert.equal(env.status().windowOpen, true);
    env.clock.tick(1000);
    assert.equal(env.status().windowOpen, false);
});

test("a goal that arrives after the attempt, inside the window, still counts", () => {
    const g = makeGame({ noRewards: true });
    const env = load(g);
    g.play();
    env.clock.tick(0);
    assert.equal(env.status().done, false);
    env.clock.tick(500);
    g.app.fire(GOAL, {});
    assert.equal(env.status().done, true);
    assert.match(env.status().doneBy, /after the attempt/);
    assert.deepEqual(env.toasts, ["Adventurer: quest completion queued"]);
});

test("when the game fires the goal on its own the runner marks done and fires nothing", () => {
    const g = makeGame();
    const env = load(g);
    g.app.fire(GOAL, { why: "own" });
    assert.equal(env.status().done, true);
    assert.equal(env.status().doneBy, "game");
    assert.deepEqual(env.toasts, []);
    g.play();
    g.shoot();
    env.clock.tick(100);
    assert.equal(g.count("run:complete"), 0);
});

// ---------------------------------------------------------------------------
// Re-injection
// ---------------------------------------------------------------------------
test("injecting twice is idempotent", () => {
    const g = makeGame();
    const env = load(g);
    const wrapper = g.app.fire;
    const api = env.sandbox.__adventurerCompletion;
    env.inject();
    env.inject();
    assert.equal(g.app.fire, wrapper);
    assert.equal(env.sandbox.__adventurerCompletion, api);
    assert.equal(env.bus.count("message"), 1);
    g.play();
    env.clock.tick(0);
    assert.equal(g.count("run:complete"), 1);
    assert.equal(g.count(GOAL), 1);
    assert.equal(env.status().attempts, 1);
});

test("re-injection updates quest status and recipes in the running runner", () => {
    const g = makeGame({ historyActive: false });
    const env = load(g, { quests: NOT_ENROLLED });
    assert.equal(env.status().gate.open, false);
    assert.equal(env.status().gate.quest.enrolled, false);

    env.inject({ quests: OPEN });
    let s = env.status();
    assert.equal(s.gate.open, true);
    assert.equal(s.gate.quest.questId, "1537134637686591699");
    assert.equal(s.hooked, true);

    // new local recipe arrives with the same injection path native.ts uses
    env.inject({ quests: OPEN, local: [profile(recipe({ entries: [{ name: "run:complete", args: [{ total: 5 }] }], source: "recorded" }))] });
    s = env.status();
    assert.equal(s.recipe.origin, "local");
    assert.equal(s.recipe.source, "recorded");
    assert.equal(s.recipes.local, 1);

    g.history.active = true;
    g.play();
    env.clock.tick(0);
    assert.deepEqual(j(g.runArgs), [{ total: 5 }]);
    assert.equal(env.status().done, true);

    // an unchanged bundled recipe set with the quest now completed closes the gate again
    env.inject({ quests: DONE });
    assert.equal(env.status().gate.open, false);
    assert.equal(env.status().gate.reason.includes("already completed"), true);
});

test("re-injection before the app exists updates the config the boot uses", () => {
    const g = makeGame();
    const env = load(g, { extra: { pc: undefined }, quests: NOT_ENROLLED });
    assert.equal(env.status().ready, false);
    env.inject({ quests: OPEN });
    env.sandbox.pc = { app: g.app };
    env.clock.tick(250);
    const s = env.status();
    assert.equal(s.ready, true);
    assert.equal(s.hooked, true);
    g.play();
    env.clock.tick(0);
    assert.equal(g.count(GOAL), 1);
});

test("the runner can be switched off and on from the parent window", () => {
    const g = makeGame();
    const env = load(g);
    env.post({ __adventurerOverlay: true, type: "completion", enabled: false });
    assert.equal(env.status().enabled, false);
    g.play();
    env.clock.tick(100);
    assert.equal(g.count("run:complete"), 0);

    // not from the parent, or without the tag: ignored
    env.post({ __adventurerOverlay: true, type: "completion", enabled: true }, { name: "someone else" });
    env.post({ type: "completion", enabled: true });
    assert.equal(env.status().enabled, false);

    env.post({ __adventurerOverlay: true, type: "completion", enabled: true });
    assert.equal(env.status().enabled, true);
    g.play();
    env.clock.tick(0);
    assert.equal(g.count(GOAL), 1);
});

test("switching off closes an open suppression window", () => {
    const g = makeGame({ historyActive: false });
    const original = g.arise.postMessage;
    const env = load(g);
    g.play();
    env.clock.tick(0);
    assert.equal(env.status().windowOpen, true);
    env.post({ __adventurerOverlay: true, type: "completion", enabled: false });
    assert.equal(env.status().windowOpen, false);
    assert.equal(g.arise.postMessage, original);
});

test("status() is a snapshot, mutating it changes nothing", () => {
    const g = makeGame();
    const env = load(g);
    const s = env.sandbox.__adventurerCompletion.status();
    s.recipe.triggers.push("hacked");
    s.recipe.suppress.length = 0;
    s.log.push("x");
    s.gate.quest.completed = true;
    const again = env.status();
    assert.deepEqual(again.recipe.triggers, ["select:play", "shot:fire"]);
    assert.deepEqual(again.recipe.suppress, ["leaderboard"]);
    assert.equal(again.gate.open, true);
    assert.deepEqual(Object.keys(env.sandbox.__adventurerCompletion), ["status"]);
});

// ---------------------------------------------------------------------------
// Hostile environments: nothing may throw into the game
// ---------------------------------------------------------------------------
test("an app without fire() never throws and the runner gives up after a minute", () => {
    const env = load(null, { extra: { pc: { app: {} } } });
    assert.doesNotThrow(() => env.clock.tick(61000));
    const s = env.status();
    assert.equal(s.ready, false);
    assert.equal(s.hooked, false);
    assert.equal(env.clock.pending(), 0);
    assert.equal(env.logs.info.some(l => /no PlayCanvas app with fire\(\) found/.test(l)), true);
});

test("no PlayCanvas app at all: polls quietly and gives up", () => {
    const env = load(null);
    assert.equal(env.clock.pending(), 1);
    assert.doesNotThrow(() => env.clock.tick(61000));
    assert.equal(env.status().ready, false);
    assert.equal(env.clock.pending(), 0);
});

test("a throwing listener of an entry is logged and the next entry still runs", () => {
    const g = makeGame();
    g.app.on("hostile:event", () => { throw new Error("boom"); });
    const env = load(g, {
        local: [profile(recipe({ entries: [{ name: "hostile:event" }, { name: "run:complete", args: [{ total: 0 }] }] }))]
    });
    g.play();
    assert.doesNotThrow(() => env.clock.tick(0));
    assert.equal(g.count(GOAL), 1);
    assert.equal(env.status().done, true);
    assert.match(env.logText(), /entry hostile:event threw: boom/);
    assert.equal(env.logs.warn.some(l => /entry hostile:event threw: boom/.test(l)), true);
});

test("when every entry throws the attempt fails quietly and the window still closes", () => {
    const g = makeGame({ historyActive: false });
    const original = g.arise.postMessage;
    g.app.on("run:complete", () => { throw new Error("always"); });
    const env = load(g);
    g.play();
    assert.doesNotThrow(() => env.clock.tick(0));
    assert.equal(env.status().done, false);
    assert.match(env.logText(), /ran: run:complete \(threw always\)/);
    env.clock.tick(3000);
    assert.equal(env.status().windowOpen, false);
    assert.equal(g.arise.postMessage, original);
});

test("a throwing listener on the trigger keeps its game behaviour and the attempt still happens", () => {
    const g = makeGame();
    g.app.on("select:play", () => { throw new Error("game bug"); });
    const env = load(g);
    // the game's own exception propagates exactly as before
    assert.throws(() => g.play(), /game bug/);
    assert.doesNotThrow(() => env.clock.tick(0));
    assert.equal(g.count(GOAL), 1);
});

test("a frozen app cannot be wrapped: logged, nothing throws, the game keeps working", () => {
    const g = makeGame();
    Object.freeze(g.app);
    const env = load(g);
    const s = env.status();
    assert.equal(s.hooked, false);
    assert.equal(env.logs.warn.some(l => /could not wrap app\.fire/.test(l)), true);
    assert.doesNotThrow(() => g.play());
    assert.doesNotThrow(() => env.clock.tick(100));
    assert.equal(g.count("run:complete"), 0);
});

test("an unreadable scene root skips entity entries without throwing", () => {
    const g = makeGame();
    Object.defineProperty(g.app, "root", { get() { throw new Error("no root"); } });
    const env = load(g, {
        local: [profile(recipe({ entries: [{ name: "director:go", scope: "entity", guid: "g-director" }, { name: "run:complete", args: [{ total: 0 }] }] }))]
    });
    g.play();
    assert.doesNotThrow(() => env.clock.tick(0));
    assert.match(env.logText(), /scene root unreadable: no root/);
    assert.match(env.logText(), /director:go \(entity g-director not found\)/);
    assert.equal(env.status().done, true);
});

test("a throwing scene list never breaks recipe lookup for scene *", () => {
    const g = makeGame();
    g.app.scenes = { list() { throw new Error("no scenes"); } };
    const env = load(g, {
        recipes: [],
        local: [profile(recipe(), { scene: "*" })]
    });
    assert.equal(env.status().recipe.scene, "*");
    g.play();
    assert.doesNotThrow(() => env.clock.tick(0));
    assert.equal(g.count(GOAL), 1);
});

test("a hostile window.arise (throwing getter, non-function postMessage) does not break the attempt", () => {
    const g = makeGame();
    const env = load(g);
    Object.defineProperty(env.sandbox, "arise", { get() { throw new Error("no arise"); }, configurable: true });
    g.play();
    assert.doesNotThrow(() => env.clock.tick(0));
    assert.equal(g.count(GOAL), 1);
    assert.equal(g.leaderboardCalls.length, 0); // the app event is still dropped

    const g2 = makeGame({ arise: { postMessage: 5 } });
    const env2 = load(g2);
    g2.play();
    assert.doesNotThrow(() => env2.clock.tick(0));
    assert.match(env2.logText(), /window\.arise\.postMessage not found/);
    assert.equal(g2.count(GOAL), 1);
});

test("a frame without arise still completes", () => {
    const g = makeGame();
    const env = load(g);
    delete env.sandbox.arise;
    g.play();
    assert.doesNotThrow(() => env.clock.tick(0));
    assert.equal(g.count(GOAL), 1);
    assert.equal(g.count("leaderboard:submit"), 0);
});

test("non-string event names pass straight through", () => {
    const g = makeGame();
    load(g);
    assert.doesNotThrow(() => g.app.fire(undefined));
    assert.doesNotThrow(() => g.app.fire(42));
});

test("a missing or hostile local placeholder value yields no local recipes", () => {
    const g = makeGame();
    // older native module: the token is never replaced, the runner still works with the bundled recipe
    const env = load(g);
    assert.equal(env.status().recipes.local, 0);
    // a replaced value that is not an array is ignored
    const env2 = load(makeGame(), { local: { not: "an array" } });
    assert.equal(env2.status().recipes.local, 0);
    assert.equal(env2.status().recipe.origin, "bundled");
});

// ---------------------------------------------------------------------------
// Guessed recipes: the fallback for a quest that has no recipe at all (the guess comes from the event graph)
// ---------------------------------------------------------------------------
const guess = (over = {}) => ({
    version: 1, goal: GOAL, triggers: ["select:play", "shot:fire"],
    entries: [{ name: "run:complete", scope: "app", args: [{ total: 7 }], source: "inferred" }],
    suppress: ["leaderboard"], delay_ms: 0, notes: "guessed from the scripts", source: "guessed", ...over
});

// A stand-in for window.__adventurerGraph with the parts of its API the runner uses. `usable` lists the entries the
// graph would offer with { usableOnly: true } (all of them when null), like the guard analysis of the real one.
function mockGraph(recipe = guess(), o = {}) {
    const subs = [];
    const graph = {
        scene: o.scene ?? SCENE, recipe, usable: o.usable ?? null, subs,
        state() { return { scene: graph.scene, recipe: graph.recipe }; },
        guessedRecipe(opts) {
            if (!graph.recipe) return null;
            const copy = JSON.parse(JSON.stringify(graph.recipe));
            if (opts && opts.usableOnly) {
                copy.entries = copy.entries.filter(e => !graph.usable || graph.usable.includes(e.name));
                if (!copy.entries.length) return null;
            }
            return copy;
        },
        onChange(cb) { subs.push(cb); return () => { subs.splice(subs.indexOf(cb), 1); }; },
        set(next, scene) {
            graph.recipe = next;
            if (scene !== undefined) graph.scene = scene;
            for (const cb of subs.slice()) cb(graph.state());
        }
    };
    return graph;
}

const withGraph = graph => ({ extra: { __adventurerGraph: graph } });

test("guessed: a quest with no recipe at all gets the guessed recipe, with the leaderboard block and the goal check", () => {
    const g = makeGame();
    const env = load(g, { recipes: [], ...withGraph(mockGraph()) });
    let s = env.status();
    assert.equal(s.recipe.origin, "guessed");
    assert.equal(s.recipe.source, "guessed");
    assert.equal(s.recipe.goal, GOAL);
    assert.deepEqual(s.recipe.triggers, ["select:play", "shot:fire"]);
    assert.deepEqual(s.recipes, { local: 0, bundled: 0, forApp: 0 }, "the counts of local and bundled recipes are unchanged");
    assert.deepEqual(s.guessed, { graph: "connected", available: true, scene: SCENE, goal: GOAL, triggers: ["select:play", "shot:fire"], entries: ["run:complete"], attempts: 0 });
    assert.equal(s.hooked, true);
    assert.equal(s.attemptOrigin, "");

    g.play();
    assert.deepEqual(g.trace, ["select:play", "transition:play", "shot:restart"], "the attempt waits for the click's own chain");
    env.clock.tick(0);
    assert.deepEqual(j(g.runArgs), [{ total: 7 }]);
    assert.equal(g.count(GOAL), 1);
    assert.equal(g.count("leaderboard:submit"), 0, "the leaderboard event never reached the game");
    assert.equal(g.leaderboardCalls.length, 0);
    g.tick();
    assert.deepEqual(g.bridge.map(m => m.type), ["quest:report"], "only the quest report went through the bridge");

    s = env.status();
    assert.equal(s.done, true);
    assert.match(s.doneBy, /^attempt 1 on select:play via run:complete/);
    assert.equal(s.attemptOrigin, "guessed");
    assert.equal(s.guessed.attempts, 1);
    assert.equal(s.dropped, 1);
    const log = env.logText();
    assert.match(log, /guessed recipe from the scripts \(scene GlobalAces_MASTER\): goal arise:questComplete; triggers select:play, shot:fire; entries run:complete; used only while no local or bundled recipe applies/);
    assert.match(log, /using the guessed recipe \(source guessed\) for scene GlobalAces_MASTER: goal arise:questComplete; triggers select:play, shot:fire; entries run:complete/);
    assert.equal(env.logs.info.some(l => /using the guessed recipe/.test(l)), true, "the origin is on the console too");
});

test("guessed: precedence is local, then bundled, then guessed (not even a star local recipe loses to an exact guessed scene)", () => {
    // bundled beats the guess
    const g1 = makeGame();
    const env1 = load(g1, withGraph(mockGraph()));
    assert.equal(env1.status().recipe.origin, "bundled");
    assert.equal(env1.status().guessed.available, true, "the guess is held, just not picked");
    g1.play();
    env1.clock.tick(0);
    assert.deepEqual(j(g1.runArgs), [{ total: 0 }], "the bundled entry ran, not the guessed one");
    assert.equal(env1.status().attemptOrigin, "bundled");
    assert.equal(env1.status().guessed.attempts, 0);
    assert.match(env1.logText(), /using the bundled recipe/);

    // a local recipe beats both
    const g2 = makeGame();
    const env2 = load(g2, { local: [profile(recipe({ entries: [{ name: "run:complete", args: [{ total: 3 }] }] }))], ...withGraph(mockGraph()) });
    assert.equal(env2.status().recipe.origin, "local");
    g2.play();
    env2.clock.tick(0);
    assert.deepEqual(j(g2.runArgs), [{ total: 3 }]);
    assert.equal(env2.status().attemptOrigin, "local");

    // the guess never competes on scene specificity: a local "*" recipe still wins over the exact scene of the guess
    const g3 = makeGame();
    const env3 = load(g3, { recipes: [], local: [profile(recipe({ entries: [{ name: "run:complete", args: [{ total: 5 }] }] }), { scene: "*" })], ...withGraph(mockGraph()) });
    assert.equal(env3.status().recipe.origin, "local");
    assert.equal(env3.status().recipe.scene, "*");
    g3.play();
    env3.clock.tick(0);
    assert.deepEqual(j(g3.runArgs), [{ total: 5 }]);

    // a bundled recipe for another scene does not cover this one: the guess fills the gap
    const other = [{ ...BUNDLED[0], scene: "SomewhereElse" }];
    const env4 = load(makeGame(), { recipes: other, ...withGraph(mockGraph()) });
    assert.equal(env4.status().recipe.origin, "guessed");
});

test("guessed: only used for the scene the graph analysed", () => {
    const g = makeGame();
    const graph = mockGraph(guess(), { scene: "Other" });
    const env = load(g, { recipes: [], ...withGraph(graph) });
    assert.equal(env.status().recipe, null);
    g.play();
    g.shoot();
    env.clock.tick(100);
    assert.equal(g.count("run:complete"), 0);
    assert.match(env.logText(), /no recipe for scene \[GlobalAces_MASTER\], select:play ignored/);
    graph.set(guess(), SCENE); // the graph analysed this scene now
    assert.equal(env.status().recipe.origin, "guessed");
    g.play();
    env.clock.tick(0);
    assert.equal(g.count(GOAL), 1);
});

test("guessed: entries the graph does not offer are never fired", () => {
    const g = makeGame();
    const fired = [];
    g.app.on("skip:me", () => fired.push("skip:me"));
    const graph = mockGraph(guess({ entries: [{ name: "skip:me", args: [{}] }, { name: "run:complete", args: [{ total: 7 }] }] }), { usable: ["run:complete"] });
    const env = load(g, { recipes: [], ...withGraph(graph) });
    assert.deepEqual(env.status().recipe.entries.map(e => e.name), ["run:complete"]);
    g.play();
    env.clock.tick(0);
    assert.deepEqual(fired, []);
    assert.equal(g.trace.includes("skip:me"), false);
    assert.equal(g.count(GOAL), 1);
});

test("guessed: a guess without a single usable entry is not used and nothing is hooked", () => {
    const g = makeGame();
    const env = load(g, { recipes: [], ...withGraph(mockGraph(guess(), { usable: [] })) });
    const s = env.status();
    assert.equal(s.recipe, null);
    assert.equal(s.guessed.available, false);
    assert.equal(s.guessed.graph, "connected");
    assert.equal(s.hooked, false);
    assert.equal(Object.hasOwn(g.app, "fire"), false);
    assert.match(env.logText(), /a guessed recipe for arise:questComplete exists but none of its entries is known to run the state the goal path needs, not used/);
    g.play();
    g.shoot();
    env.clock.tick(1000);
    assert.equal(g.count("run:complete"), 0);
    assert.equal(env.clock.pending(), 0);
});

test("guessed: the suppress list always has the leaderboard, and arise, goal and leaderboard entries are refused as for any recipe", () => {
    const g = makeGame();
    const graph = mockGraph(guess({
        suppress: [],
        entries: [{ name: GOAL }, { name: "leaderboard:submit", args: [{}] }, { name: "run:complete", args: [{ total: 1 }] }]
    }));
    const env = load(g, { recipes: [], ...withGraph(graph) });
    assert.deepEqual(env.status().recipe.suppress, ["leaderboard"]);
    g.play();
    env.clock.tick(0);
    assert.equal(g.count(GOAL), 1, "the game fired the goal, the runner did not");
    assert.equal(g.count("leaderboard:submit"), 0);
    assert.equal(g.leaderboardCalls.length, 0);
    const log = env.logText();
    assert.match(log, /skipped entry arise:questComplete \(arise events are the game's own reports\)/);
    assert.match(log, /skipped entry leaderboard:submit \(it matches a suppress pattern\)/);
    assert.deepEqual(g.bridge.map(m => m.type), [], "the leaderboard bridge message was dropped as well");
});

for (const [label, quests, reason] of [
    ["completed", DONE, /already completed/],
    ["not enrolled", NOT_ENROLLED, /not enrolled/],
    ["unknown", {}, /no quest known for application/]
]) {
    test(`guessed: the quest gate is respected (quest ${label}), and a repeated injection with an open gate starts it`, () => {
        const g = makeGame();
        const env = load(g, { recipes: [], quests, ...withGraph(mockGraph()) });
        assert.equal(Object.hasOwn(g.app, "fire"), false);
        g.play();
        g.shoot();
        env.clock.tick(10000);
        assert.equal(g.count("run:complete"), 0);
        const s = env.status();
        assert.equal(s.hooked, false);
        assert.equal(s.gate.open, false);
        assert.match(s.gate.reason, reason);
        assert.equal(s.attempts, 0);
        assert.equal(env.clock.pending(), 0);

        env.inject({ recipes: [], quests: OPEN });
        assert.equal(env.status().hooked, true);
        g.play();
        env.clock.tick(0);
        assert.equal(g.count(GOAL), 1);
        assert.equal(env.status().attemptOrigin, "guessed");
    });
}

test("guessed: while the graph is not there yet the runner waits for it, and picks the guess up when it appears", () => {
    const g = makeGame();
    const env = load(g, { recipes: [] });
    let s = env.status();
    assert.equal(s.guessed.graph, "waiting");
    assert.equal(s.recipe, null);
    assert.equal(s.hooked, false);
    assert.equal(env.clock.pending(), 1, "one poll for the graph");
    g.play();
    env.clock.tick(100);
    assert.equal(g.count("run:complete"), 0);

    const graph = mockGraph();
    env.sandbox.__adventurerGraph = graph;
    env.clock.tick(500);
    s = env.status();
    assert.equal(s.guessed.graph, "connected");
    assert.equal(s.recipe.origin, "guessed");
    assert.equal(s.hooked, true);
    assert.equal(env.clock.pending(), 0, "no poll any more");
    assert.equal(graph.subs.length, 1, "subscribed once");
    g.play();
    env.clock.tick(0);
    assert.equal(g.count(GOAL), 1);
});

test("guessed: a graph without a guess yet is waited for through its onChange, no timers", () => {
    const g = makeGame();
    const graph = mockGraph(null);
    const env = load(g, { recipes: [], ...withGraph(graph) });
    let s = env.status();
    assert.equal(s.guessed.graph, "connected");
    assert.equal(s.recipe, null);
    assert.equal(s.hooked, false);
    assert.equal(env.clock.pending(), 0);
    graph.set(guess());
    s = env.status();
    assert.equal(s.recipe.origin, "guessed");
    assert.equal(s.hooked, true, "the hook is installed as soon as a recipe exists");
    g.play();
    env.clock.tick(0);
    assert.equal(g.count(GOAL), 1);
});

test("guessed: the runner gives up looking for the graph after about two minutes and looks again on a repeated injection", () => {
    const g = makeGame();
    const env = load(g, { recipes: [] });
    assert.doesNotThrow(() => env.clock.tick(121000));
    let s = env.status();
    assert.equal(s.guessed.graph, "missing");
    assert.equal(env.clock.pending(), 0);
    assert.match(env.logText(), /no event graph found after about two minutes/);
    env.sandbox.__adventurerGraph = mockGraph();
    env.inject({ recipes: [] });
    s = env.status();
    assert.equal(s.guessed.graph, "connected");
    assert.equal(s.recipe.origin, "guessed");
});

test("guessed: no polling when no guess could be used (a bundled recipe covers the scene, the gate is closed, no app)", () => {
    const env1 = load(makeGame());
    assert.equal(env1.clock.pending(), 0);
    assert.equal(env1.status().guessed.graph, "waiting");
    const env2 = load(makeGame(), { recipes: [], quests: DONE });
    assert.equal(env2.clock.pending(), 0);
    const env3 = load(null, { recipes: [] });
    assert.equal(env3.clock.pending(), 1, "only the poll for the app");
});

test("guessed: when the graph changes its guess the runner picks up the new one, a failed attempt does not use the slot up", () => {
    const g = makeGame();
    const graph = mockGraph(guess({ entries: [{ name: "nothing:here", args: [{}] }] }));
    const env = load(g, { recipes: [], ...withGraph(graph) });
    g.play();
    env.clock.tick(0);
    let s = env.status();
    assert.equal(s.done, false);
    assert.equal(s.attempts, 1);
    assert.deepEqual(s.used, ["select:play"]);
    assert.match(env.logText(), /attempt 1 on select:play did not reach arise:questComplete; ran: nothing:here; waiting for another trigger/);

    graph.set(guess()); // a better guess arrives (a late listener, a new script type)
    s = env.status();
    assert.deepEqual(s.recipe.entries.map(e => e.name), ["run:complete"]);
    assert.match(env.logText(), /guessed recipe from the scripts .*entries run:complete/);
    g.play();
    env.clock.tick(0);
    assert.equal(g.count(GOAL), 1);
    s = env.status();
    assert.equal(s.done, true);
    assert.match(s.doneBy, /^attempt 2 on select:play via run:complete/);
    assert.equal(s.guessed.attempts, 2);
});

test("guessed: an identical guess announced again changes nothing", () => {
    const g = makeGame();
    const graph = mockGraph();
    const env = load(g, { recipes: [], ...withGraph(graph) });
    g.play();
    env.clock.tick(0);
    const before = env.status();
    const lines = before.log.length;
    graph.set(guess());
    graph.set(guess());
    assert.equal(env.status().log.length, lines, "nothing was logged");
    assert.deepEqual(env.status().used, before.used);
});

test("guessed: a withdrawn guess (scene change, graph rebuilt) stops being used", () => {
    const g = makeGame();
    const graph = mockGraph();
    const env = load(g, { recipes: [], ...withGraph(graph) });
    assert.equal(env.status().recipe.origin, "guessed");
    graph.set(null);
    let s = env.status();
    assert.equal(s.recipe, null);
    assert.equal(s.guessed.available, false);
    assert.match(env.logText(), /the guessed recipe was withdrawn/);
    g.play();
    env.clock.tick(0);
    assert.equal(g.count("run:complete"), 0);
    graph.set(guess(), "Other"); // a guess for another scene
    s = env.status();
    assert.equal(s.recipe, null);
    assert.equal(s.guessed.scene, "Other");
});

test("guessed: attempts with guessed recipes are capped, a guess that keeps changing cannot fire game events without end", () => {
    const g = makeGame();
    const graph = mockGraph(guess({ entries: [{ name: "noop:0", args: [{}] }] }));
    const env = load(g, { recipes: [], ...withGraph(graph) });
    for (let i = 0; i < 6; i++) {
        graph.set(guess({ entries: [{ name: "noop:" + i, args: [{}] }] }));
        g.play();
        env.clock.tick(0);
        g.shoot();
        env.clock.tick(0);
    }
    const s = env.status();
    assert.equal(s.attempts, 6, "three guesses with two triggers each");
    assert.equal(s.guessed.attempts, 6);
    assert.match(env.logText(), /no attempt: 6 attempts with guessed recipes were used/);
    assert.equal(s.done, false);
    assert.equal(g.count("run:complete"), 0);
});

test("guessed: a throwing graph never reaches the game", () => {
    const g = makeGame();
    const graph = mockGraph();
    graph.guessedRecipe = () => { throw new Error("graph exploded"); };
    const env = load(g, { recipes: [], ...withGraph(graph) });
    assert.equal(env.status().recipe, null);
    assert.match(env.logText(), /could not read the guessed recipe: graph exploded/);
    assert.doesNotThrow(() => graph.set(guess()));
    const bad = { state() { return {}; }, guessedRecipe() { return null; }, onChange() { throw new Error("no subscription"); } };
    const env2 = load(makeGame(), { recipes: [], ...withGraph(bad) });
    assert.match(env2.logText(), /could not subscribe to the event graph: no subscription/);
});

test("guessed: a malformed guess is ignored with a log line", () => {
    const g = makeGame();
    const env = load(g, { recipes: [], ...withGraph(mockGraph(guess({ goal: "" }))) });
    assert.equal(env.status().recipe, null);
    assert.match(env.logText(), /ignored guessed recipe: Guessed from the scripts \(guessed\): missing goal/);
    const env2 = load(makeGame(), { recipes: [], ...withGraph(mockGraph(guess({ version: 2 }))) });
    assert.equal(env2.status().recipe, null);
});

test("guessed: a disabled runner does not attempt anything and a re-enabled one uses the guess", () => {
    const g = makeGame();
    const env = load(g, { recipes: [], ...withGraph(mockGraph()) });
    env.post({ __adventurerOverlay: true, type: "completion", enabled: false });
    g.play();
    env.clock.tick(0);
    assert.equal(g.count("run:complete"), 0);
    env.post({ __adventurerOverlay: true, type: "completion", enabled: true });
    g.shoot();
    env.clock.tick(0);
    assert.equal(g.count(GOAL), 1);
});

// ---------------------------------------------------------------------------
// Guessed recipes end to end: the real event graph analysing a fake Aces game whose scripts really run
// ---------------------------------------------------------------------------
// Lets the mock clock run until the graph has built and analysed the scene and the runner has read the guess.
function settle(env, until, maxMs = 20000) {
    for (let t = 0; t < maxMs && !until(env.status()); t += 50) env.clock.tick(50);
}

test("end to end: the real graph guesses the Aces recipe from the scripts and the runner completes the quest with it", () => {
    const game = makeAcesGame();
    const env = load(game, { recipes: [], graph: true });
    assert.equal(env.status().recipe, null, "nothing is known yet");
    assert.equal(env.status().hooked, false);
    settle(env, s => s.guessed.available);
    let s = env.status();
    assert.equal(s.guessed.available, true);
    assert.equal(s.recipe.origin, "guessed");
    assert.deepEqual(s.recipe.triggers, ["select:play", "shot:fire"]);
    assert.deepEqual(s.recipe.entries.map(e => e.name), ["run:complete", "shot:complete"], "run:recorded skips the state writer and is withheld");
    assert.deepEqual(s.recipe.suppress, ["leaderboard"]);
    assert.equal(s.hooked, true);
    assert.equal(game.count(GOAL), 0);

    game.play();
    env.clock.tick(0);
    assert.equal(game.count(GOAL), 1, "the guessed run:complete reached the goal through the game's own scripts");
    assert.equal(game.count("leaderboard:submit"), 0, "the leaderboard stayed blocked");
    assert.equal(game.count("shot:complete"), 0, "the attempt stopped at the first entry that worked");
    game.tick();
    assert.deepEqual(game.bridge.map(m => m.type), ["quest:report"]);
    s = env.status();
    assert.equal(s.done, true);
    assert.equal(s.attemptOrigin, "guessed");
    assert.match(s.doneBy, /^attempt 1 on select:play via run:complete/);
    assert.match(env.logText(), /using the guessed recipe/);
});

test("end to end: a trigger before the analysis finished is not lost for good, the next one is used", () => {
    const game = makeAcesGame();
    const env = load(game, { recipes: [], graph: true });
    game.play(); // too early, nothing is hooked yet
    env.clock.tick(0);
    assert.equal(game.count("run:complete"), 0);
    settle(env, s => s.guessed.available);
    game.shoot(); // shot:fire is the second trigger of the guess
    env.clock.tick(0);
    assert.equal(game.count(GOAL), 1);
    assert.match(env.status().doneBy, /^attempt 1 on shot:fire via run:complete/);
});

test("end to end: a bundled recipe still wins over the real graph's guess", () => {
    const game = makeAcesGame();
    const env = load(game, { graph: true }); // the bundled Aces recipe
    settle(env, s => s.guessed.available);
    const s = env.status();
    assert.equal(s.guessed.available, true);
    assert.equal(s.recipe.origin, "bundled");
    game.play();
    env.clock.tick(0);
    assert.equal(game.count(GOAL), 1);
    assert.equal(env.status().attemptOrigin, "bundled");
    assert.equal(env.status().guessed.attempts, 0);
});

test("end to end: the quest gate holds with the real graph", () => {
    const game = makeAcesGame();
    const env = load(game, { recipes: [], graph: true, quests: DONE });
    settle(env, s => s.guessed.available);
    assert.equal(env.status().recipe.origin, "guessed");
    assert.equal(env.status().hooked, false);
    game.play();
    game.shoot();
    env.clock.tick(1000);
    assert.equal(game.count("run:complete"), 0);
    assert.equal(env.status().attempts, 0);
});

test("end to end: the no-guard chain is tried closest to the goal first", () => {
    const game = makeAcesGame({ scripts: NO_GUARD_SCRIPTS });
    const env = load(game, { recipes: [], graph: true });
    settle(env, s => s.guessed.available);
    const s = env.status();
    assert.equal(s.recipe.origin, "guessed");
    assert.deepEqual(s.recipe.entries.map(e => e.name), ["run:recorded", "run:complete"], "nothing to verify: every entry is usable");
    game.play();
    env.clock.tick(0);
    assert.equal(game.count(GOAL), 1);
    assert.match(env.status().doneBy, /^attempt 1 on select:play via run:recorded/);
});

test("end to end: a guard no event can satisfy leaves the runner without a guessed recipe", () => {
    const game = makeAcesGame({ scripts: UNVERIFIABLE_SCRIPTS });
    const env = load(game, { recipes: [], graph: true });
    settle(env, () => false, 4000);
    const s = env.status();
    assert.equal(s.guessed.graph, "connected");
    assert.equal(s.guessed.available, false);
    assert.equal(s.recipe, null);
    assert.equal(s.hooked, false);
    assert.match(env.logText(), /a guessed recipe for arise:questComplete exists but none of its entries is known to run the state the goal path needs, not used/);
    game.play();
    env.clock.tick(100);
    assert.equal(game.count("run:complete"), 0);
});

test("end to end: the graph script is idempotent, injecting it twice leaves one analysis", () => {
    const game = makeAcesGame();
    const env = load(game, { recipes: [], graph: true });
    vm.runInContext(buildGraphScript(), env.sandbox); // the overlay path and the runner path both push it
    settle(env, s => s.guessed.available);
    const api = env.sandbox.__adventurerGraph;
    assert.equal(api._sourceStats().jobs, 1);
    assert.equal(api.state().builds, 1);
    assert.equal(env.status().guessed.attempts, 0);
});

test("index.tsx injects the event graph once, whenever the overlay or the completion runner is on, before both", () => {
    const src = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
    const start = src.indexOf("function buildInjectedScript()");
    assert.ok(start > 0);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    assert.equal((body.match(/buildGraphScript\(\)/g) || []).length, 1, "exactly one push of the graph script");
    const graphAt = body.indexOf("buildGraphScript()");
    const overlayAt = body.indexOf("buildOverlayScript()");
    const completionAt = body.indexOf("buildCompletionScript(");
    assert.ok(graphAt > 0 && graphAt < overlayAt && graphAt < completionAt, "the graph is pushed before the overlay and the runner");
    const guard = body.slice(body.lastIndexOf("if (", graphAt), graphAt);
    assert.match(guard, /settings\.store\.experiencesHack\s*\|\|\s*settings\.store\.experiencesAutoComplete/);
    assert.match(body.slice(body.lastIndexOf("if (", overlayAt), overlayAt), /^if \(settings\.store\.experiencesHack\)/);
});
