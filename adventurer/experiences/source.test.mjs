// Tests for the script source analysis in experiences/graph.ts (SOURCE_SRC): static facts of script types, listener
// attribution, the event chain / guards / guessed recipe, the time-sliced pipeline and the cache. Run:
//   node --test src/userplugins/adventurer/experiences/source.test.mjs
// Every test executes the string buildGraphScript() returns, against a mock PlayCanvas world whose script types hold real
// functions (their source text is what the extraction reads). Nothing here touches a live game.
//
// Parity fixtures in __fixtures__/source/*.json come from the Python reference (dump_source_fixtures.py):
//   analysis_*   scan + knowledge -> what workbench/experience_source.py makes of it
//   extraction_* fake game spec    -> the scan workbench/js/experience_scan.js returns for it
//
// Documented differences from Python (everything else is compared with deepEqual):
//   * owners that tie on (fires the goal, script name) have no defined order in Python (set iteration): both sides are
//     fully sorted before comparing.
//   * the in-page entries carry two extra fields (usable, reason) that the Python EntryInfo does not have.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ACES_SCRIPTS, makeAcesGame, makeBigSpec, NO_GUARD_SCRIPTS, UNVERIFIABLE_SCRIPTS } from "./fakegame.mjs";
import { buildGraphScript, SOURCE_SRC } from "./graph.ts";

const DASH = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)]; // em and en dash, never allowed
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "__fixtures__", "source");
const loadFixtures = prefix => fs.readdirSync(FIXTURE_DIR).filter(f => f.startsWith(prefix) && f.endsWith(".json")).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), "utf8")));
const analysisFixtures = loadFixtures("analysis_");
const extractionFixtures = loadFixtures("extraction_");
const analysisByName = Object.fromEntries(analysisFixtures.map(f => [f.name, f]));
const clone = v => structuredClone(v);
const j = v => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------------------------------------------
// mock world with real script types
// ---------------------------------------------------------------------------------------------------------------
globalThis.__called = [];
const ScriptTypeProto = { initScriptType() { }, initEventHandler() { } };

/**
 * spec: { scene, scripts: { name: { methods: { m: "function(){...}" } } }, entities: [{ name, guid, enabled?, tags?, scripts: [
 *   { name, attrs, enabled?, own: {prop: method}, ownFns: {prop: "function(){}"}, ownArrays: {prop: [[event, method]]} }] }],
 *   listeners: [{ event, scope: "app" | {entity, script}, holder?: {entity, script}, handler: {proto} | {own} | {path} | {native} }] }
 * The same format as the Python harness tests/fixtures/run_scan_js.js, so its specs run unchanged.
 */
function makeWorld(spec, opts = {}) {
    const types = {};
    for (const [name, def] of Object.entries(spec.scripts || {})) {
        const ctor = function () { };
        ctor.__name = name;
        ctor.prototype = Object.create(ScriptTypeProto);
        for (const [m, src] of Object.entries(def.methods || {})) {
            Object.defineProperty(ctor.prototype, m, { value: (0, eval)("(" + src + ")"), writable: true, configurable: true, enumerable: true });
        }
        types[name] = ctor;
    }
    const mk = (name, guid) => ({
        name, guid, children: [], enabled: true, _callbacks: new Map(), tags: { list: () => [] }, script: { scripts: [] },
        getGuid() { return guid; }
    });
    const root = mk("Root", "root");
    const byName = {}, instByKey = {};
    for (const def of spec.entities || []) {
        const e = mk(def.name, def.guid);
        if (def.enabled === false) e.enabled = false;
        if (def.tags) e.tags = { list: () => [...def.tags] };
        root.children.push(e);
        byName[def.name] = e;
        for (const s of def.scripts || []) {
            const ctor = types[s.name];
            const inst = Object.create(ctor.prototype);
            inst.__scriptType = ctor;
            inst.__attributes = clone(s.attrs || {});
            inst._enabled = s.enabled !== false;
            inst.entity = e;
            for (const [prop, m] of Object.entries(s.own || {})) inst[prop] = ctor.prototype[m].bind(inst);
            for (const [prop, src] of Object.entries(s.ownFns || {})) inst[prop] = (0, eval)("(" + src + ")");
            for (const [prop, pairs] of Object.entries(s.ownArrays || {})) inst[prop] = pairs.map(([ev, m]) => [ev, ctor.prototype[m].bind(inst)]);
            e.script.scripts.push(inst);
            instByKey[def.name + "/" + s.name] = inst;
        }
    }
    const app = { root, _callbacks: new Map(), scene: { name: spec.scene || "" } };
    for (const l of spec.listeners || []) {
        const owner = l.scope === "app" ? null : instByKey[l.scope.entity + "/" + l.scope.script];
        const holder = l.holder ? instByKey[l.holder.entity + "/" + l.holder.script] : owner;
        const h = l.handler || {};
        let callback;
        if (h.proto) callback = holder.__scriptType.prototype[h.proto];
        else if (h.own) callback = holder[h.own];
        else if (h.path) callback = h.path.split(".").reduce((o, k) => o[k], holder);
        else callback = (function () { }).bind(null);
        if (!app._callbacks.has(l.event)) app._callbacks.set(l.event, []);
        app._callbacks.get(l.event).push({ callback, scope: owner || app });
    }
    return { app, root, types, byName, instByKey, spec };
}

/** A world from a Python analysis scan (entities + listeners only, no real scripts): script types without prototypes. */
function makeClock() {
    let t = 1_000_000, id = 0;
    const queue = [];
    return {
        date: { now: () => t },
        setTimeout(fn, ms) { queue.push({ id: ++id, at: t + ms, ms, fn }); return id; },
        advance(ms) {
            const end = t + ms;
            for (;;) {
                queue.sort((a, b) => a.at - b.at || a.id - b.id);
                const next = queue[0];
                if (!next || next.at > end) break;
                queue.shift();
                t = next.at;
                next.fn();
            }
            t = end;
        },
        // timers still queued, or only those with a given delay (8 ms is the gap between two analysis slices)
        pending: ms => (ms === undefined ? queue.length : queue.filter(q => q.ms === ms).length)
    };
}

/** Execute the generated script like the injected frame would. `perf` replaces window.performance (a fake clock). */
function inject(world, { window: win, clock = makeClock(), warnings = [], perf = performance, extra = {} } = {}) {
    const window = win ?? { pc: world ? { app: world.app } : undefined, performance: perf, ...extra };
    const quiet = { warn: (...a) => warnings.push(a.join(" ")), log() { }, error: (...a) => warnings.push(a.join(" ")) };
    const run = new Function("window", "setTimeout", "Date", "console", buildGraphScript());
    run(window, clock.setTimeout.bind(clock), clock.date, quiet);
    return { window, clock, warnings, api: window.__adventurerGraph };
}

/** Inject, build the quest graph and run the source pipeline to completion. */
function build(spec, opts) {
    const world = makeWorld(spec);
    const ctx = inject(world, opts);
    ctx.api.refresh();
    ctx.api._sourceDrain();
    return { world, ...ctx };
}

// ---------------------------------------------------------------------------------------------------------------
// sources of the fake games
// ---------------------------------------------------------------------------------------------------------------
// The patterns of the real VALORANT Aces bundle (minified aliases, pair arrays, inline handlers, own functions, wrappers
// around hidden closures, lookup helpers); the same as tests/test_experience_scan_js.py of the Workbench.
const HISTORY = {
    initialize: "function(){var t=this,e=this.app;e.on('a:lit',this._onComplete,this),this.app.on(this.completeEvent,"
        + "this._onComplete,this),this.app.on('inline:event',function(){t._set('x')},t);"
        + "this._wires=[['pair:event',this._onComplete],[this.completeEvent,this.record]];"
        + "for(var i=0;i<this._wires.length;i++)this.app.on(this._wires[i][0],this._wires[i][1]);"
        + "this._handler=function(n){t.app.fire('from:own',n)},this.app.on('own:event',this._handler);"
        + "this.entity.fire('entity:fired');"
        + "/* this.app.fire('in:comment') */ var s=\"this.app.fire('in:string')\",r=/[{}]/.test(s)}",
    _set: "function(t){this.screen=t,this.changeEvent&&this.app.fire(this.changeEvent,t,this._prev)}",
    _onComplete: "function(t){this.active&&t&&this.record(t)}",
    record: "function(t){var e=this._toRecord(t);if(!e)return null;return this._runs.push(e),"
        + "this._remember(e.levelId,e.total,!0),this.app.fire('level:recorded',e.levelId),"
        + "this.changeEvent&&this.app.fire(this.changeEvent,e),e}",
    _toRecord: "function(t){var e=Number(t.total);return isFinite(e)?{total:Math.round(e),ace:!!t.ace,"
        + "name:String(t.name||''),acc:'number'==typeof t.acc?t.acc:-1,tags:t.tags||[]}:null}",
    _remember: "function(t,e,s){return this._levels[t]={played:!0,completed:!!s,best:e},!0}",
    _onRecord: "function(){if(canUseAccount(this))return s.apply(this,arguments)}",
    _onRun: "function(e){this.app.fire('quest:done',{levelId:e.levelId})}",
    update: "function(){return a.apply(this,arguments)}",
    partial: "function(){this.x=1;return h.call(this)}",
    unused: "function(){__called.push('unused')}"
};
const GATE = {
    _hist: "function(){return this._rh=this.entity.script.hist,this._rh}",
    _check: "function(){var s=this._hist();return s&&s._levels&&!0===s._levels['x'].completed&&!this._done"
        + "&&['a'].map(function(s){return s.trim()}).length&&s.count()}",
    _ping: "function(){this.entity.script.hist.record(1)}"
};

function fakeGameSpec() {
    return {
        scene: "Fake", scripts: { hist: { methods: HISTORY }, gate: { methods: GATE } },
        entities: [{
            name: "Director", guid: "g1", scripts: [
                { name: "hist", attrs: { completeEvent: "run:complete", changeEvent: "run:recorded" }, own: { _onRecord: "_onRecord", _loose: "_onRun" }, ownFns: { _handler: "function(){}" }, ownArrays: { _wires: [["pair:event", "_onComplete"]] } },
                { name: "gate", attrs: {} }]
        }],
        listeners: [
            { event: "run:complete", scope: { entity: "Director", script: "hist" }, handler: { proto: "_onComplete" } },
            { event: "run:recorded", scope: "app", holder: { entity: "Director", script: "hist" }, handler: { own: "_onRecord" } },
            { event: "loose:event", scope: "app", holder: { entity: "Director", script: "hist" }, handler: { own: "_loose" } },
            { event: "pair:event", scope: "app", holder: { entity: "Director", script: "hist" }, handler: { path: "_wires.0.1" } },
            { event: "own:event", scope: "app", holder: { entity: "Director", script: "hist" }, handler: { own: "_handler" } },
            { event: "engine:update", scope: "app", handler: { native: true } }
        ]
    };
}

// ---------------------------------------------------------------------------------------------------------------
// hygiene
// ---------------------------------------------------------------------------------------------------------------
test("the source module is valid page code, free of backticks, dollar-braces and dashes", () => {
    const script = buildGraphScript();
    const file = path.join(os.tmpdir(), "adventurer-source-check-" + process.pid + ".js");
    fs.writeFileSync(file, script);
    try {
        const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
    } finally {
        fs.rmSync(file, { force: true });
    }
    assert.ok(!SOURCE_SRC.includes("`"), "no backtick in the String.raw constant");
    assert.ok(!SOURCE_SRC.includes("${"), "no dollar-brace sequence");
    assert.ok(!SOURCE_SRC.includes(DASH[0]) && !SOURCE_SRC.includes(DASH[1]), "no em or en dash");
    const own = fs.readFileSync(path.join(HERE, "source.test.mjs"), "utf8");
    assert.ok(!own.includes(DASH[0]) && !own.includes(DASH[1]));
    const dump = fs.readFileSync(path.join(HERE, "__fixtures__", "dump_source_fixtures.py"), "utf8");
    assert.ok(!dump.includes(DASH[0]) && !dump.includes(DASH[1]));
});

test("the source module never calls, fires or registers anything", () => {
    for (const forbidden of [".fire(", ".fire1(", ".emit(", ".execute(", ".on(", ".off(", ".once(", ".postMessage(", "window.arise", "new Function", "eval("]) {
        assert.ok(!SOURCE_SRC.includes(forbidden), "page code must not contain " + forbidden);
    }
});

test("running the whole pipeline calls no script method and registers nothing", () => {
    globalThis.__called.length = 0;
    const world = makeWorld(fakeGameSpec());
    let registered = 0;
    const spy = () => { registered++; };
    world.app.fire = spy; world.app.on = spy; world.app.off = spy; world.app.once = spy;
    const ctx = inject(world);
    ctx.api.refresh();
    ctx.api._sourceDrain();
    assert.equal(ctx.api.state().source.status, "done");
    assert.equal(globalThis.__called.length, 0, "no script method ran");
    assert.equal(registered, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// parity: analysis of a scan with script facts (workbench/experience_source.py)
// ---------------------------------------------------------------------------------------------------------------
const sortOwners = list => [...list].sort((a, b) => (!a.why - !b.why) || (a.script < b.script ? -1 : a.script > b.script ? 1 : 0) || (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0));

/** The Python-shaped part of the summary (the extra in-page fields are removed). */
function comparable(source) {
    const s = j(source);
    s.owners = sortOwners(s.owners);
    s.entries = s.entries.map(({ usable, reason, ...rest }) => rest);
    return {
        available: s.available, found: s.found, scriptTypes: s.scriptTypes, listeners: s.listeners, unattributed: s.unattributed,
        goal: s.goal, goals: s.goals, unreachedGoals: s.unreachedGoals, events: s.events, hops: s.hops, owners: s.owners, guards: s.guards,
        entries: s.entries, preferred: s.preferred, triggerNotes: s.triggerNotes, notes: s.notes
    };
}

const analyzer = (() => {
    const ctx = inject(null, { window: { performance } });
    return ctx.api;
})();

for (const f of analysisFixtures) {
    test("parity with Python (analysis): " + f.name, () => {
        const got = analyzer._sourceAnalyze(clone(f.scan), f.knowledge ?? undefined);
        const exp = f.expected;
        assert.deepEqual(comparable(got.source), comparable({ ...exp.source, entries: exp.source.entries.map(e => ({ ...e, usable: false, reason: "" })) }));
        assert.deepEqual(got.recipe, exp.recipe, "the guessed recipe");
    });
}

test("parity coverage: the fixtures cover the cases of the Python tests", () => {
    for (const name of ["valorant", "valorant_no_listeners", "mini_game", "guarded", "unguarded", "thin_wrapper", "learned_goal", "optional_events",
        "entity_scoped", "loop_only", "leaderboard", "goal_nothing_fires", "bound_copy", "inline_handlers", "ambiguous_handler"]) {
        assert.ok(analysisByName[name], name);
    }
    assert.ok(analysisFixtures.filter(f => f.expected.recipe).length >= 18);
});

// ---------------------------------------------------------------------------------------------------------------
// parity: static facts and listener attribution (workbench/js/experience_scan.js)
// ---------------------------------------------------------------------------------------------------------------
for (const f of extractionFixtures) {
    test("parity with Python (extraction): " + f.name, () => {
        globalThis.__called.length = 0;
        const { api } = build(f.spec);
        const scan = api._sourceScan();
        assert.ok(scan && scan.ok);
        assert.equal(globalThis.__called.length, 0, "no method was called");
        assert.deepEqual(Object.keys(scan.scripts).sort(), Object.keys(f.scan.scripts).sort());
        for (const [name, facts] of Object.entries(f.scan.scripts)) {
            assert.deepEqual(j(scan.scripts[name]), facts, "facts of " + name);
        }
        assert.deepEqual(Object.keys(scan.listeners), Object.keys(f.scan.listeners), "same events in the same order");
        for (const [event, recs] of Object.entries(f.scan.listeners)) assert.deepEqual(j(scan.listeners[event]), recs, "listeners of " + event);
        assert.deepEqual(scan.truncated, { ...f.scan.truncated }, "truncation flags");
    });
}

// the same facts, spelled out (what tests/test_experience_scan_js.py of the Workbench asserts)
test("facts: nothing is called, nothing is truncated, methods without facts are not reported", () => {
    globalThis.__called.length = 0;
    const { api } = build(fakeGameSpec());
    const scan = api._sourceScan();
    assert.ok(scan.ok);
    assert.equal(globalThis.__called.length, 0);
    assert.ok(!Object.values(scan.truncated).some(Boolean));
    const { hist } = scan.scripts;
    assert.equal(hist.n, 1);
    for (const n of ["initialize", "record", "_handler"]) assert.ok(hist.names.includes(n), n);
    assert.equal(hist.m.unused, undefined);
});

test("facts: registrations, fires and inline handlers are read from the source text", () => {
    const { api } = build(fakeGameSpec());
    const { hist } = api._sourceScan().scripts;
    const init = hist.m.initialize;
    const regs = init.o.map(r => r.join("|"));
    for (const r of ["a:lit|_onComplete|a", "@completeEvent|_onComplete|a", "pair:event|_onComplete|a", "@completeEvent|record|a", "own:event|_handler|a"]) {
        assert.ok(regs.includes(r), r);
    }
    const inline = init.o.find(r => r[0] === "inline:event");
    assert.ok(inline[1].startsWith("initialize#"));
    assert.deepEqual(hist.m[inline[1]].c, ["_set"], "t._set(): t is an alias of this");
    assert.deepEqual(init.fe, ["entity:fired"], "an entity target");
    assert.equal(init.d, 1, "the loop registers dynamically");
    assert.equal(init.f, undefined, "strings and comments are not code");
    assert.deepEqual(hist.m._handler.f, ["from:own"]);
});

test("facts: calls, state and payload reads", () => {
    const { api } = build(fakeGameSpec());
    const { m } = api._sourceScan().scripts.hist;
    assert.deepEqual(m._onComplete.c, ["record"]);
    assert.deepEqual(m._onComplete.pp, ["record"]);
    assert.deepEqual(m.record.f, ["level:recorded", "@changeEvent"]);
    assert.deepEqual(new Set(m.record.c), new Set(["_toRecord", "_remember"]));
    assert.deepEqual(m._set.f, ["@changeEvent"]);
    assert.deepEqual(m._set.pf, ["@changeEvent"], "the payload is forwarded");
    assert.equal(m.record.pf, undefined, "a freshly built payload is not");
    assert.deepEqual(m._toRecord.pr, { total: "n", ace: "b", name: "s", acc: "n", tags: "a" });
    assert.deepEqual(m._remember.sw, ["_levels[]", "_levels[].played", "_levels[].completed", "_levels[].best"]);
    assert.ok(m.record.sw.includes("_runs"));
});

test("facts: thin wrappers, hidden closures and lookup helpers", () => {
    const { api } = build(fakeGameSpec());
    const { scripts } = api._sourceScan();
    assert.deepEqual(scripts.hist.m._onRecord, { w: 1 });
    assert.deepEqual(scripts.hist.m.update, { w: 1 });
    assert.deepEqual(scripts.hist.m.partial, { sw: ["x"], h: 1 }, "visible code plus a hidden closure");
    const check = scripts.gate.m._check;
    assert.ok(check.xr.includes("hist:_levels[].completed"));
    assert.deepEqual(check.xc, ["hist:count"], "s.trim() belongs to an inner s");
    assert.deepEqual(scripts.gate.m._ping, { xc: ["hist:record"] });
});

test("facts: every runtime listener is attributed to the script method that holds the function", () => {
    const { api } = build(fakeGameSpec());
    const ls = api._sourceScan().listeners;
    const complete = ls["run:complete"][0];
    assert.deepEqual([complete.script, complete.method, complete.via], ["hist", "_onComplete", "proto"]);
    const recorded = ls["run:recorded"][0];
    assert.deepEqual([recorded.scopeKind, recorded.guid, recorded.script, recorded.method, recorded.via], ["app", "g1", "hist", "_onRecord", "own"]);
    const pair = ls["pair:event"][0];
    assert.equal(pair.script, "hist");
    assert.equal(pair.method, undefined);
    assert.deepEqual(pair.paths, ["_wires[0][1]"]);
    assert.deepEqual(ls["loose:event"][0].paths, ["_loose"], "a bound copy under a name no method has");
    assert.deepEqual([ls["own:event"][0].method, ls["own:event"][0].via], ["_handler", "own"]);
    assert.equal(ls["engine:update"][0].script, null);
    assert.equal(ls["engine:update"][0].method, undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// the whole pipeline on a game that really runs (fakegame.mjs)
// ---------------------------------------------------------------------------------------------------------------
const GOAL = "arise:questComplete";
function analysed(opts) {
    const game = makeAcesGame(opts);
    const ctx = inject(game);
    ctx.api.refresh();
    ctx.api._sourceDrain();
    return { game, ...ctx };
}

test("Aces like game: goal, chain, goal owners and guards come out of the function sources", () => {
    const { api } = analysed();
    const st = api.state();
    assert.equal(st.source.status, "done");
    assert.equal(st.source.found, true);
    assert.equal(st.source.goal, GOAL);
    assert.deepEqual(st.source.goals, [{ key: GOAL, strength: 3, learned: false }]);
    assert.deepEqual(st.source.hops.map(h => [h.src, h.dst]), [["run:recorded", GOAL], ["run:complete", "run:recorded"], ["shot:complete", "run:complete"]]);
    const goalHop = st.source.hops[0];
    assert.equal(goalHop.approximate, true, "the reaching handler is a thin wrapper around a hidden closure");
    assert.equal(goalHop.how, "runtime");
    assert.equal(goalHop.path, "ariseRewards._onRecord -> _onRun (guess: hidden closure) -> _queueQuestCompletion -> _complete");
    assert.deepEqual(goalHop.steps.map(s => s.how), ["handler", "guess", "call", "call"]);
    assert.equal(st.source.hops[1].approximate, false);
    assert.equal(st.source.hops[1].path, "runHistory._onComplete -> record");
    assert.deepEqual(st.source.events.map(e => [e.key, e.depth, e.root]), [[GOAL, 0, false], ["run:recorded", 1, false], ["run:complete", 2, false], ["shot:complete", 3, true]]);
    assert.deepEqual(st.source.owners, [{ script: "ariseRewards", entity: "Shot Director", why: "fires the goal" }]);
    const gd = st.source.guards[0];
    assert.equal(gd.state, "runHistory._levels[].completed");
    assert.equal(gd.foreign, true);
    assert.deepEqual(gd.readers, ["ariseRewards._onRun"]);
    assert.equal(gd.writers[0].method, "runHistory._remember");
    assert.deepEqual(gd.writers[0].events, ["run:complete"]);
    assert.equal(gd.writers[0].via, "runHistory._onComplete -> record -> _remember");
    assert.ok(gd.text.includes("is written by runHistory._remember when run:complete is handled"));
    assert.equal(st.source.unattributed, 0);
    assert.equal(st.source.scriptTypes, 5);
    assert.equal(st.source.listeners, 6);
});

test("Aces like game: the guessed recipe has the exact schema and ranks the state writing entry first", () => {
    const { api } = analysed();
    const st = api.state();
    const r = st.recipe;
    assert.deepEqual(Object.keys(r), ["version", "goal", "triggers", "entries", "suppress", "delay_ms", "notes", "source"]);
    assert.equal(r.version, 1);
    assert.equal(r.goal, GOAL);
    assert.deepEqual(r.triggers, ["select:play", "shot:fire"]);
    assert.deepEqual(r.suppress, ["leaderboard"]);
    assert.equal(r.delay_ms, 0);
    assert.equal(r.source, "guessed");
    assert.deepEqual(r.entries.map(e => e.name), ["run:complete", "shot:complete", "run:recorded"]);
    assert.ok(r.entries.every(e => Object.keys(e).join() === "name,scope,args,source" && e.scope === "app" && e.source === "inferred"));
    assert.deepEqual(r.entries[0].args, [{ total: 0, levelId: "", ace: false, kills: 0 }], "the payload the chain handlers read");
    assert.deepEqual(r.entries[2].args, [{ levelId: 0 }]);
    assert.ok(r.notes.includes("run:complete is listed first") && r.notes.includes("guess"));
    assert.ok(!r.entries.some(e => /leaderboard/i.test(e.name) || e.name.startsWith("arise:")) && !r.triggers.some(n => /leaderboard/i.test(n)));
    assert.deepEqual(j(r), r, "plain JSON");
    assert.equal(st.source.preferred, "run:complete");
    assert.deepEqual(st.source.entries.map(e => [e.name, e.depth, e.guardOk, e.usable]), [["run:complete", 2, true, true], ["shot:complete", 3, true, true], ["run:recorded", 1, false, false]]);
    assert.ok(st.source.entries[0].note.startsWith("guard: _levels[].completed written by runHistory._remember via runHistory._onComplete"));
    assert.deepEqual(st.source.triggerNotes.map(n => n.split(" ")[1]), ["select:play", "shot:fire"]);
});

test("guessedRecipe(): a fresh copy, and usableOnly keeps only the entries that run the state writer", () => {
    const { api } = analysed();
    const full = api.guessedRecipe();
    assert.deepEqual(full, api.state().recipe);
    assert.notEqual(full, api.state().recipe);
    full.entries.length = 0;
    full.goal = "x";
    assert.equal(api.state().recipe.entries.length, 3, "callers cannot change the state");
    const usable = api.guessedRecipe({ usableOnly: true });
    assert.deepEqual(usable.entries.map(e => e.name), ["run:complete", "shot:complete"]);
    assert.ok(usable.notes.includes("Not offered: run:recorded (does not run the state writer the goal path depends on)."));
    assert.equal(usable.source, "guessed");
    assert.equal(api.state().recipe.entries.length, 3);
    assert.deepEqual(api.guessedRecipe({ usableOnly: false }), api.state().recipe);
});

test("the first usable entry of the guess really completes the quest in the game, the withheld one does not", () => {
    const { api, game } = analysed();
    const usable = api.guessedRecipe({ usableOnly: true });
    game.app.fire(usable.entries[0].name, ...usable.entries[0].args);
    assert.equal(game.count(GOAL), 1, "run:complete with the inferred payload reaches the goal");

    const fresh = analysed();
    const withheld = fresh.api.guessedRecipe().entries.find(e => e.name === "run:recorded");
    fresh.game.app.fire(withheld.name, ...withheld.args);
    assert.equal(fresh.game.count(GOAL), 0, "run:recorded on a fresh account skips the state writer");
});

test("without a foreign state guard every entry is usable, closest to the goal first", () => {
    const ctx = inject(makeAcesGame({ scripts: NO_GUARD_SCRIPTS }));
    ctx.api.refresh();
    ctx.api._sourceDrain();
    const st = ctx.api.state();
    assert.equal(st.source.found, true);
    assert.deepEqual(st.source.guards.filter(g => g.foreign), []);
    assert.deepEqual(st.recipe.entries.map(e => e.name), ["run:recorded", "run:complete"]);
    assert.deepEqual(st.source.entries.map(e => [e.guardOk, e.usable]), [[null, true], [null, true]]);
    assert.equal(st.source.preferred, "");
    assert.deepEqual(ctx.api.guessedRecipe({ usableOnly: true }).entries.map(e => e.name), ["run:recorded", "run:complete"]);
});

test("a guard no event is known to satisfy leaves no usable entry, the full guess stays for inspection", () => {
    const ctx = inject(makeAcesGame({ scripts: UNVERIFIABLE_SCRIPTS }));
    ctx.api.refresh();
    ctx.api._sourceDrain();
    const st = ctx.api.state();
    assert.equal(st.source.found, true);
    const gd = st.source.guards.find(g => g.foreign);
    assert.ok(gd, "the foreign read is a guard");
    assert.ok(gd.writers.every(w => w.events.length === 0), "no event writes it");
    assert.ok(st.source.entries.length > 0 && st.source.entries.every(e => e.usable === false));
    assert.ok(st.recipe, "the full guess is still there");
    assert.equal(ctx.api.guessedRecipe({ usableOnly: true }), null, "but nothing is offered to the runner");
    assert.ok(ctx.api.guessedRecipe().entries.length > 0);
});

// ---------------------------------------------------------------------------------------------------------------
// the Valorant assertions of tests/test_experience_source.py, through the in-page analysis
// ---------------------------------------------------------------------------------------------------------------
const valorantFixture = analysisByName.valorant;
const valorantAnalysis = () => analyzer._sourceAnalyze(clone(valorantFixture.scan), valorantFixture.knowledge ?? undefined);

test("valorant: goal, chain, owners, guards", () => {
    const { source: s } = valorantAnalysis();
    assert.equal(s.found, true);
    assert.equal(s.goal, GOAL);
    assert.deepEqual(s.goals.map(g => g.key), [GOAL]);
    assert.deepEqual(s.unreachedGoals, ["arise:questConfirmed"]);
    assert.deepEqual(s.hops.slice(0, 3).map(h => [h.src, h.dst]), [["run:recorded", GOAL], ["run:complete", "run:recorded"], ["shot:complete", "run:complete"]]);
    const goalHop = s.hops[0];
    assert.ok(goalHop.approximate && goalHop.how === "runtime");
    assert.equal(goalHop.path, "ariseRewards._onRecord -> _onRun (guess: hidden closure) -> _queueQuestCompletion -> _complete");
    assert.deepEqual(goalHop.steps.map(x => x.how), ["handler", "guess", "call", "call"]);
    assert.equal(s.hops[1].path, "runHistory._onComplete -> record");
    assert.equal(s.hops[2].path, "shotScore._onComplete");
    assert.deepEqual(s.owners[0], { script: "ariseRewards", entity: "Shot Director", why: "fires the goal" });
    const names = new Set(s.owners.map(o => o.script));
    for (const n of ["ariseRewards", "questComplete", "ariseAnalytics"]) assert.ok(names.has(n), n);
    const gd = s.guards[0];
    assert.equal(gd.state, "runHistory._levels[].completed");
    assert.ok(gd.foreign);
    assert.deepEqual(gd.readers, ["ariseRewards._onRun"]);
    assert.equal(gd.writers[0].method, "runHistory._rememberLevel");
    assert.ok(gd.writers[0].events.includes("run:complete") && gd.writers[0].onPath === false);
    assert.equal(gd.writers[0].via, "runHistory._onComplete -> record -> _rememberLevel");
    const own = s.guards.find(g => g.state === "ariseRewards._done");
    assert.ok(!own.foreign && own.readers.includes("ariseRewards._onRun"));
});

test("valorant: the guessed recipe", () => {
    const { source: s, recipe: r } = valorantAnalysis();
    assert.deepEqual(Object.keys(r).sort(), ["delay_ms", "entries", "goal", "notes", "source", "suppress", "triggers", "version"]);
    assert.equal(r.version, 1);
    assert.equal(r.goal, GOAL);
    assert.deepEqual(r.triggers, ["select:play", "shot:fire"]);
    assert.deepEqual(r.suppress, ["leaderboard"]);
    assert.equal(r.delay_ms, 0);
    assert.equal(r.source, "guessed");
    assert.deepEqual(r.entries.map(e => e.name), ["run:complete", "shot:complete", "run:recorded"]);
    assert.deepEqual(r.entries[0].args, [{ total: 0, matchScore: 0, accMult: 0, ttkMult: 0, kills: 0, takeovers: 0, whiffs: 0, shots: 0, hits: 0, acc: 0, hs: 0, meanTtk: 0, bestTtk: 0, ace: false, flawless: false }]);
    assert.deepEqual(r.entries[1].args, []);
    assert.deepEqual(r.entries[2].args, [{ levelId: "" }]);
    assert.ok(!r.entries.some(e => /leaderboard/i.test(e.name) || e.name.startsWith("arise:")));
    assert.ok(r.notes.includes("run:complete is listed first") && r.notes.includes("guess"));
    assert.equal(s.preferred, "run:complete");
    assert.deepEqual(s.entries.map(e => e.name), ["run:complete", "shot:complete", "run:recorded"]);
    const [top, mid, low] = s.entries;
    assert.ok(top.guardOk === true && top.depth === 2 && !top.approximate);
    assert.ok(top.note.startsWith("guard: _levels[].completed written by runHistory._rememberLevel via runHistory._onComplete"));
    assert.ok(low.guardOk === false && low.approximate && low.depth === 1 && low.note.includes("state writer"));
    assert.ok(mid.guardOk === true && mid.depth === 3);
    assert.deepEqual(s.entries.map(e => e.usable), [true, true, false], "the entry below the state writer is withheld from the runner");
});

test("valorant without live listeners degrades to the registration code", () => {
    const scan = clone(valorantFixture.scan);
    scan.listeners = {};
    const { source: s, recipe: r } = analyzer._sourceAnalyze(scan, valorantFixture.knowledge ?? undefined);
    assert.ok(s.found && s.unattributed === 0);
    assert.deepEqual(s.hops.map(h => [h.src, h.dst, h.how]), [["run:recorded", GOAL, "static"]]);
    assert.deepEqual(r.entries.map(e => e.name), ["run:recorded"]);
    assert.equal(s.preferred, "");
    assert.ok(s.guards[0].text.endsWith("is written by runHistory._rememberLevel"));
});

// ---------------------------------------------------------------------------------------------------------------
// onChange, scene changes, late listeners
// ---------------------------------------------------------------------------------------------------------------
/** A clock for performance.now(): every call returns the current value, then moves it on by step milliseconds. */
function fakePerf(step) {
    let t = 0;
    return { now() { const v = t; t += step; return v; } };
}

/** Let the slice timers run until the analysis is finished. Returns the number of slices that were scheduled. */
function runSlices(ctx) {
    let n = 0;
    while (ctx.api._sourceStats().pending) {
        assert.ok(ctx.clock.pending(8) > 0, "a pending job always has a slice queued");
        ctx.clock.advance(8);
        assert.ok(++n < 100000, "the analysis finishes");
    }
    return n;
}

test("onChange: fires when the guess arrives and when it changes, not when a rebuild finds the same", () => {
    const ctx = inject(makeAcesGame());
    const seen = [];
    const off = ctx.api.onChange(s => seen.push([s.source.status, s.recipe ? s.recipe.goal : null]));
    ctx.api.refresh();
    assert.deepEqual(seen, [["pending", null]], "the build itself");
    ctx.api._sourceDrain();
    assert.deepEqual(seen, [["pending", null], ["done", GOAL]], "the guess arrived");
    ctx.api.refresh();
    ctx.api._sourceDrain();
    assert.equal(seen.length, 2, "the same guess again is not announced");
    off();
    ctx.api.refresh();
    assert.equal(seen.length, 2);
});

test("onChange: a changed recipe is announced, and a vanished one too", () => {
    const game = makeAcesGame();
    const ctx = inject(game);
    ctx.api.refresh();
    ctx.api._sourceDrain();
    const seen = [];
    ctx.api.onChange(s => seen.push(s.recipe ? s.recipe.entries.map(e => e.name).join(",") : null));
    game.app.scene.name = "Elsewhere";
    ctx.api.refresh();
    assert.deepEqual(seen, [null], "a different scene drops the guess at once");
    ctx.api._sourceDrain();
    assert.equal(seen.length, 2);
    assert.equal(seen[1], "run:complete,shot:complete,run:recorded");
});

test("the same scene keeps the previous guess while the new analysis runs, a new scene does not", () => {
    const game = makeAcesGame();
    const ctx = inject(game);
    ctx.api.refresh();
    ctx.api._sourceDrain();
    const first = ctx.api.state().recipe;
    ctx.api.refresh();
    assert.equal(ctx.api.state().source.status, "pending");
    assert.deepEqual(ctx.api.state().recipe, first, "carried over");
    ctx.api._sourceDrain();
    assert.deepEqual(ctx.api.state().recipe, first);
    game.app.scene.name = "Other";
    ctx.api.refresh();
    assert.equal(ctx.api.state().recipe, null);
    assert.equal(ctx.api.state().source.status, "pending");
    assert.equal(ctx.api.state().source.found, false);
});

test("a build is polled once the scene is stable, the analysis follows by itself, and a late listener rebuilds", () => {
    const game = makeAcesGame();
    const ctx = inject(game);
    ctx.clock.advance(1200);
    assert.equal(ctx.api.state().builds, 1, "built after the scene was stable");
    runSlices(ctx);
    assert.equal(ctx.api.state().source.status, "done");
    assert.equal(ctx.api.state().source.listeners, 6);
    ctx.clock.advance(10000);
    assert.equal(ctx.api.state().builds, 1, "nothing changed, nothing is rebuilt");

    // a script registers a handler late (an existing script method under a new event name)
    const hist = game.instances.runHistory;
    game.app.on("late:event", hist._onComplete, hist);
    ctx.clock.advance(5000);
    assert.equal(ctx.api.state().builds, 2, "the number of listened events is part of the build trigger");
    runSlices(ctx);
    const s = ctx.api.state().source;
    assert.equal(s.status, "done");
    assert.equal(s.listeners, 7);
    assert.equal(s.unattributed, 0);
    assert.deepEqual(s.types, { total: 5, extracted: 0, reused: 5 }, "no script type was read again");
    assert.ok(s.events.some(e => e.key === "late:event"), "the late event is part of the chain");
    assert.ok(ctx.api.guessedRecipe().entries.some(e => e.name === "late:event"));
});

test("a quest manager scene is skipped: no job, no timers, no reading of any script", () => {
    const spec = {
        scene: "Quest", scripts: { discordQuestManager: { methods: { initialize: "function(){}" } } },
        entities: [{ name: "Quest", guid: "q", scripts: [{ name: "discordQuestManager", attrs: { questCompleteEvent: "quest:complete" } }] }]
    };
    const { api, clock } = build(spec);
    const st = api.state();
    assert.ok(st.ok && st.hasQuestManager);
    assert.equal(st.source.status, "skipped");
    assert.equal(st.recipe, null);
    assert.equal(api.guessedRecipe(), null);
    assert.equal(clock.pending(8), 0);
    assert.deepEqual([api._sourceStats().pending, api._sourceStats().cached, api._sourceStats().jobs], [false, 0, 0]);
});

test("a scene without readable script prototypes is unavailable at once", () => {
    const world = makeWorld(fakeGameSpec());
    for (const ctor of Object.values(world.types)) ctor.prototype = undefined;
    const ctx = inject(world);
    ctx.api.refresh();
    const st = ctx.api.state();
    assert.equal(st.ok, true);
    assert.equal(st.source.status, "unavailable");
    assert.match(st.source.reason, /no script type with a readable prototype/);
    assert.equal(st.recipe, null);
    assert.equal(ctx.clock.pending(8), 0);
    assert.equal(ctx.api._sourceDrain(), false);
});

test("a script type whose methods cannot be listed is reported as truncated, the others are still read", () => {
    const world = makeWorld(fakeGameSpec());
    world.types.gate.prototype = new Proxy(world.types.gate.prototype, { ownKeys() { throw new Error("no keys for you"); } });
    const warnings = [];
    const ctx = inject(world, { warnings });
    ctx.api.refresh();
    ctx.api._sourceDrain();
    const st = ctx.api.state();
    assert.equal(st.source.status, "done");
    assert.equal(st.source.truncated.sources, true);
    assert.ok(Object.hasOwn(ctx.api._sourceScan().scripts, "hist") && !Object.hasOwn(ctx.api._sourceScan().scripts, "gate"));
    assert.equal(ctx.api._sourceStats().failed, 1);
    assert.ok(warnings.some(w => w.includes("the scripts of gate could not be read") && w.includes("no keys for you")), warnings.join("|"));
});

test("a failing analysis job is reported as an error, the quest graph is unaffected", () => {
    const world = makeWorld(fakeGameSpec());
    const inst = world.instByKey["Director/hist"];
    let armed = false;
    const ctor = inst.__scriptType;
    Object.defineProperty(inst, "__scriptType", { get() { if (armed) throw new Error("the scripts are gone"); return ctor; }, configurable: true });
    const warnings = [];
    const ctx = inject(world, { warnings });
    ctx.api.refresh();
    assert.equal(ctx.api.state().source.status, "pending");
    armed = true;
    runSlices(ctx);
    const st = ctx.api.state();
    assert.equal(st.source.status, "error");
    assert.equal(st.source.reason, "the scripts are gone");
    assert.equal(st.recipe, null);
    assert.equal(st.ok, true);
    assert.ok(warnings.some(w => w.includes("source analysis failed")));
    armed = false;
    ctx.api.refresh();
    ctx.api._sourceDrain();
    assert.equal(ctx.api.state().source.status, "done", "the next build tries again");
});

// ---------------------------------------------------------------------------------------------------------------
// time slicing (fake clocks: setTimeout and performance.now)
// ---------------------------------------------------------------------------------------------------------------
test("nothing runs when the build is made: the first slice is only queued", () => {
    const ctx = inject(makeAcesGame(), { perf: fakePerf(1) });
    ctx.api.refresh();
    assert.equal(ctx.clock.pending(8), 1);
    assert.deepEqual([ctx.api._sourceStats().units, ctx.api._sourceStats().slices, ctx.api._sourceStats().cached], [0, 0, 0]);
    assert.equal(ctx.api.state().source.status, "pending");
    ctx.clock.advance(7);
    assert.equal(ctx.api._sourceStats().slices, 0, "the gap is 8 ms");
    ctx.clock.advance(1);
    assert.equal(ctx.api._sourceStats().slices, 1);
});

test("a slice runs units until about 4 ms are used, and at least one unit", () => {
    const results = {};
    for (const step of [1, 100]) {
        const ctx = inject(makeAcesGame(), { perf: fakePerf(step) });
        ctx.api.refresh();
        runSlices(ctx);
        const s = ctx.api.state().source;
        assert.equal(s.status, "done");
        results[step] = { slices: s.slices, units: s.units, recipe: ctx.api.state().recipe };
    }
    assert.equal(results[1].units, results[100].units, "the same work in both runs");
    assert.ok(results[1].units > 40, "the work is split into many units, not one");
    assert.equal(results[1].slices, Math.ceil(results[1].units / 4), "one unit costs 1 ms: 4 units fit a slice");
    assert.equal(results[100].slices, results[100].units, "one unit costs 100 ms: one unit per slice, never none");
    assert.deepEqual(results[1].recipe, results[100].recipe, "the slice size does not change the result");
    assert.equal(results[1].recipe.goal, GOAL);
});

test("requestIdleCallback is used when the page has it, the budget follows timeRemaining and the timeout flag", () => {
    const idle = [];
    const extra = { requestIdleCallback: (fn, opts) => { idle.push({ fn, opts }); return idle.length; } };
    const ctx = inject(makeAcesGame(), { perf: fakePerf(1), extra });
    ctx.api.refresh();
    assert.equal(ctx.clock.pending(8), 0, "no timer when the idle callback exists");
    assert.equal(idle.length, 1);
    assert.equal(idle[0].opts.timeout, 1000, "a game that never idles still finishes");
    const units = () => ctx.api._sourceStats().units;
    let before = units();
    idle.shift().fn({ didTimeout: false, timeRemaining: () => 2 });
    assert.equal(units() - before, 2, "2 ms left: 2 units");
    before = units();
    idle.shift().fn({ didTimeout: false, timeRemaining: () => 50 });
    assert.equal(units() - before, 4, "the budget never exceeds 4 ms");
    before = units();
    idle.shift().fn({ didTimeout: true, timeRemaining: () => 0 });
    assert.equal(units() - before, 4, "a timed out callback has no idle time left, the budget stays 4 ms");
    assert.equal(idle.length, 1, "one slice is queued at a time");
    while (idle.length) idle.shift().fn({ didTimeout: false, timeRemaining: () => 4 });
    assert.equal(ctx.api.state().source.status, "done");
    assert.equal(ctx.api.state().recipe.goal, GOAL);
});

test("a new build replaces a running job, what the old job already read stays cached", () => {
    const game = makeAcesGame();
    const ctx = inject(game, { perf: fakePerf(100) });
    ctx.api.refresh();
    while (ctx.api._sourceStats().cached < 2) ctx.clock.advance(8);
    assert.equal(ctx.api._sourceStats().pending, true, "the first job is not done");
    const doneBefore = ctx.api._sourceStats().units;
    ctx.api.refresh();
    assert.equal(ctx.api.state().source.status, "pending");
    runSlices(ctx);
    const s = ctx.api.state().source;
    assert.equal(s.status, "done");
    assert.equal(ctx.api._sourceStats().jobs, 1, "only the second job finished");
    assert.ok(s.types.reused >= 2 && s.types.extracted + s.types.reused === 5, JSON.stringify(s.types));
    assert.ok(s.units < ctx.api._sourceStats().units - doneBefore + 1, "the second job did only its own work");
    const fresh = inject(makeAcesGame());
    fresh.api.refresh();
    fresh.api._sourceDrain();
    assert.deepEqual(ctx.api.state().recipe, fresh.api.state().recipe, "the same result as an uninterrupted run");
    assert.deepEqual(j(ctx.api.state().source.hops), j(fresh.api.state().source.hops));
});

// ---------------------------------------------------------------------------------------------------------------
// the facts cache
// ---------------------------------------------------------------------------------------------------------------
test("cache: a second analysis reads nothing again, a new type reads one, a type that mentions it reads again", t => {
    const probe = { check: "function(){var l=this.entity.script.late;return l&&l.x}" };
    const game = makeAcesGame({ scripts: { ...ACES_SCRIPTS, probe } });
    const ctx = inject(game);
    const types = () => { ctx.api.refresh(); ctx.api._sourceDrain(); return ctx.api.state().source.types; };
    assert.deepEqual(types(), { total: 6, extracted: 6, reused: 0 });
    assert.deepEqual(types(), { total: 6, extracted: 0, reused: 6 });
    game.addScript("other", { initialize: "function(){}", go: "function(){this.app.fire('o:p')}" });
    assert.deepEqual(types(), { total: 7, extracted: 1, reused: 6 }, "only the new type");
    game.addScript("late", { initialize: "function(){}", x: "function(){}" });
    assert.deepEqual(types(), { total: 8, extracted: 2, reused: 6 }, "the new type and probe, which reads script.late");
    assert.deepEqual(types(), { total: 8, extracted: 0, reused: 8 });
    assert.equal(ctx.api._sourceStats().cached, 8);
    assert.equal(ctx.api.state().recipe.goal, GOAL, "the result is the same as without the cache");
    t.diagnostic("cache after four builds: " + JSON.stringify(ctx.api._sourceStats()));
});

test("cache: a script type whose constructor was replaced is read again", () => {
    const game = makeAcesGame();
    const ctx = inject(game);
    ctx.api.refresh();
    ctx.api._sourceDrain();
    const old = game.types.shotScore;
    const next = function () { };
    next.__name = "shotScore";
    next.prototype = Object.create(Object.getPrototypeOf(old.prototype), Object.getOwnPropertyDescriptors(old.prototype));
    Object.defineProperty(next.prototype, "_extra", { value: function () { this.app.fire("x:y"); }, writable: true, configurable: true, enumerable: true });
    game.instances.shotScore.__scriptType = next;
    Object.setPrototypeOf(game.instances.shotScore, next.prototype);
    ctx.api.refresh();
    ctx.api._sourceDrain();
    assert.deepEqual(ctx.api.state().source.types, { total: 5, extracted: 1, reused: 4 });
    assert.ok(ctx.api._sourceScan().scripts.shotScore.names.includes("_extra"));
});

// ---------------------------------------------------------------------------------------------------------------
// bad input
// ---------------------------------------------------------------------------------------------------------------
test("malformed scans never throw", () => {
    const good = analysisByName.mini_game.scan;
    const badScripts = [
        { a: null }, { a: [] }, { a: { m: null } }, { a: { m: { x: null } } }, { a: { m: { x: [] } } },
        { a: { m: { x: { f: "no", o: [["only", "two"], [1, 2, 3], null], c: [1, null, "ok"], pr: { a: 1 } } } } },
        { a: { m: { initialize: { o: [["@missing", "x", "a"], ["", "x", "a"], ["e", "nothing", "z"]], xc: ["nocolon", ":", "a:"], xr: [null, "b:c"], sw: [3] } }, names: [1, "x"], binds: { h: 5, 6: "x" }, ar: "x" } },
        { quest: { m: { _onWin: { f: [GOAL], w: 1, h: 1, d: 1 } }, names: "no" } }
    ];
    for (const scripts of badScripts) {
        const scan = clone(good);
        scan.scripts = scripts;
        scan.listeners = { "round:win": [null, 3, { guid: 1, script: ["x"], method: 5 }, { script: "a", method: "x" }], bad: "no", 4: [] };
        scan.entities.push({ scripts: [null, { name: "a", attrs: "x" }, { name: 5 }], guid: 7 });
        const r = analyzer._sourceAnalyze(scan);
        assert.ok(r.source && typeof r.source.found === "boolean");
    }
    for (const scan of [null, [], "x", 5, { scripts: "no" }, { scripts: { a: {} }, entities: "no", listeners: [] }]) {
        const r = analyzer._sourceAnalyze(scan);
        assert.equal(r.source.found, false);
        assert.equal(r.recipe, null);
    }
});

test("scans without facts are not available, truncated facts are reported", () => {
    for (const bad of [{ ok: true, entities: [] }, { ok: false, scripts: { a: {} } }]) {
        const r = analyzer._sourceAnalyze(bad);
        assert.deepEqual([r.source.available, r.source.found, r.recipe], [false, false, null]);
    }
    const scan = clone(analysisByName.mini_game.scan);
    scan.truncated = { scripts: true };
    const r = analyzer._sourceAnalyze(scan);
    assert.ok(r.source.found && r.source.notes.some(n => n.includes("truncated")));
    assert.equal(r.source.truncated.scripts, true);
});

// ---------------------------------------------------------------------------------------------------------------
// load: a big synthetic game, real clocks, the slice timers of the real scheduler (one slice per timer, 8 ms apart)
// ---------------------------------------------------------------------------------------------------------------
function percentile(sorted, p) {
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Run a game's analysis through the scheduler; every slice is measured with the real clock. */
function measure(spec) {
    const world = makeWorld(spec);
    const ctx = inject(world);
    const t0 = performance.now();
    ctx.api.refresh();
    const built = performance.now() - t0;
    const slices = [];
    while (ctx.api._sourceStats().pending) {
        const s0 = performance.now();
        ctx.clock.advance(8);
        slices.push(performance.now() - s0);
    }
    const total = performance.now() - t0;
    slices.sort((a, b) => a - b);
    return { ctx, built, total, slices, p50: percentile(slices, 0.5), p90: percentile(slices, 0.9), p99: percentile(slices, 0.99), max: slices[slices.length - 1] };
}

test("load: 92 script types of about 18 methods are analysed in slices of about 4 ms", t => {
    const spec = makeBigSpec();
    measure(spec); // warm up the JIT, as a real page would have
    const m = measure(spec);
    const st = m.ctx.api.state().source;
    const stats = m.ctx.api._sourceStats();
    const methods = Object.values(spec.scripts).reduce((n, s) => n + Object.keys(s.methods).length, 0);
    const chars = Object.values(spec.scripts).reduce((n, s) => n + Object.values(s.methods).reduce((k, src) => k + src.length, 0), 0);
    t.diagnostic("source analysis, " + st.types.total + " script types, " + methods + " methods, " + Math.round(chars / 1000) + " kB of code: "
        + m.slices.length + " slices, " + stats.units + " units, cpu total " + stats.cpuMs.toFixed(1) + " ms, wall " + m.total.toFixed(1) + " ms (of which the build "
        + m.built.toFixed(1) + " ms); slice median " + m.p50.toFixed(2) + " ms, p90 " + m.p90.toFixed(2) + " ms, p99 " + m.p99.toFixed(2) + " ms, max " + m.max.toFixed(2) + " ms");
    assert.equal(st.status, "done");
    assert.equal(st.types.total, 92);
    assert.equal(st.types.extracted, 92);
    assert.ok(m.slices.length > 50, "split into many slices");
    assert.ok(m.p50 < 6, "median slice " + m.p50);
    assert.ok(m.p90 < 12, "p90 slice " + m.p90);

    // a second analysis of the same scene (cache hot) is far cheaper
    const again = m.ctx;
    const r0 = performance.now();
    again.api.refresh();
    while (again.api._sourceStats().pending) again.clock.advance(8);
    const rerun = performance.now() - r0;
    t.diagnostic("rerun with every script type cached: " + rerun.toFixed(1) + " ms wall, " + JSON.stringify(again.api.state().source.types));
    assert.deepEqual(again.api.state().source.types, { total: 92, extracted: 0, reused: 92 });
});

test("load: very large methods are analysed in several units", t => {
    const spec = makeBigSpec({ types: 12, methods: 8, huge: 4, hugeLength: 60000 });
    measure(spec);
    const m = measure(spec);
    const st = m.ctx.api.state().source;
    t.diagnostic("4 types with a 60 kB initialize among 12 types: " + m.slices.length + " slices, cpu total " + m.ctx.api._sourceStats().cpuMs.toFixed(1)
        + " ms; slice median " + m.p50.toFixed(2) + " ms, p90 " + m.p90.toFixed(2) + " ms, max " + m.max.toFixed(2) + " ms");
    assert.equal(st.status, "done");
    assert.ok(m.p50 < 6 && m.p90 < 12, "median " + m.p50 + " p90 " + m.p90);
    assert.ok(m.max < 40, "no slice may block for a long time: " + m.max);
});
