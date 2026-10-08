// Tests for experiences/graph.ts. Run:  node --test src/userplugins/adventurer/experiences/graph.test.mjs
// (or plain `node graph.test.mjs`). No dependencies. The generated script string from buildGraphScript() is what
// every test executes, against a mock PlayCanvas world; nothing here touches a live game.
//
// Parity fixtures in __fixtures__/*.json come from the Python reference (dump_fixtures.py): each has the synthetic
// scan and the Python Analysis summary that the JS port must reproduce exactly.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildGraphScript, GRAPH_SRC, TABLES_SRC } from "./graph.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "__fixtures__");
const fixtures = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith(".json") && f !== "tables.json").sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), "utf8")));
const byName = Object.fromEntries(fixtures.map(f => [f.name, f]));
const clone = v => structuredClone(v);

// ---------------------------------------------------------------------------------------------------------------
// mock PlayCanvas world
// ---------------------------------------------------------------------------------------------------------------
const SPY_NAMES = ["fire", "fire1", "emit", "execute", "onUse", "use", "activate", "click", "play", "onInsert", "enable", "swap"];

function makeWorld(scan, opts = {}) {
    const violations = [];
    const spy = label => (...args) => { violations.push([label, ...args]); };
    const app = {
        root: null, _callbacks: new Map(), scene: opts.noScene ? undefined : { name: scan.scene || "" },
        fire: spy("app.fire"), on: spy("app.on"), off: spy("app.off"), once: spy("app.once"), drawLine: spy("app.drawLine")
    };
    const world = { app, violations, entities: [], byGuid: new Map(), window: null };

    function makeEntity(rec) {
        const e = {
            name: rec.name, enabled: rec.enabled !== false, children: [], _callbacks: new Map(), path: "Root/" + rec.name,
            getGuid() { return rec.guid; },
            getPosition() { violations.push(["getPosition"]); return { x: 0, y: 0, z: 0 }; },
            tags: { list: () => [...(rec.tags || [])], has: t => (rec.tags || []).includes(t) },
            script: { scripts: [] }
        };
        for (const n of SPY_NAMES) e[n] = spy("entity." + n);
        for (const s of rec.scripts || []) {
            const inst = {
                __scriptType: { __name: s.name }, __attributes: clone(s.attrs || {}), _enabled: s.enabled !== false, entity: e,
                app, system: {}
            };
            for (const n of SPY_NAMES) inst[n] = spy(s.name + "." + n);
            e.script.scripts.push(inst);
        }
        return e;
    }

    for (const rec of scan.entities) {
        const e = makeEntity(rec);
        world.entities.push(e);
        if (rec.guid) world.byGuid.set(rec.guid, e);
    }
    const root = {
        name: "Root", children: world.entities, _callbacks: new Map(), getGuid: () => "root", tags: { list: () => [] },
        findByTag(tag) { return world.entities.filter(e => e.tags.has(tag)); },
        findComponents(type) { return world.entities.filter(e => (type === "script" ? e.script.scripts.length : false)).map(e => e.script); }
    };
    app.root = root;

    for (const [name, recs] of Object.entries(scan.listeners || {})) {
        if (!Array.isArray(recs)) continue;
        const handles = [];
        for (const r of recs) {
            if (!r || typeof r !== "object") continue;
            const ent = r.guid ? world.byGuid.get(r.guid) : null;
            const inst = ent ? ent.script.scripts.find(i => i.__scriptType.__name === r.script) : null;
            handles.push({ callback: spy("listener"), scope: inst || app });
        }
        app._callbacks.set(name, handles);
    }
    return world;
}

function makeClock() {
    let t = 1_000_000;
    let id = 0;
    const queue = [];
    return {
        date: { now: () => t },
        setTimeout(fn, ms) { queue.push({ id: ++id, at: t + ms, fn }); return id; },
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
        pending: () => queue.length
    };
}

/** Execute the generated script like the injected frame would: against `window`, with controllable timers. */
function inject(world, { window: win, clock = makeClock(), warnings = [] } = {}) {
    const window = win ?? {
        pc: world ? { app: world.app } : undefined, performance, arise: { postMessage: () => { world?.violations.push(["arise.postMessage"]); } }
    };
    if (world) world.window = window;
    const quiet = { warn: (...a) => warnings.push(a.join(" ")), log() {}, error: (...a) => warnings.push(a.join(" ")) };
    const script = buildGraphScript();
    const run = new Function("window", "setTimeout", "Date", "console", script);
    run(window, clock.setTimeout.bind(clock), clock.date, quiet);
    return { window, clock, warnings, api: window.__adventurerGraph, script };
}

function build(scan, opts) {
    const world = makeWorld(scan, opts);
    const ctx = inject(world);
    ctx.api.refresh();
    return { world, ...ctx };
}

// ---------------------------------------------------------------------------------------------------------------
// the analysis summary in the shape dump_fixtures.py writes
// ---------------------------------------------------------------------------------------------------------------
function dumpAnalysis(an, state) {
    const events = {};
    for (const [k, e] of an.events) {
        events[k] = {
            key: e.key, name: e.name, scope: e.scope, entity: e.entity, guid: e.guid, firedBy: e.firedBy, listenedBy: e.listenedBy,
            isGoal: e.isGoal, isProgress: e.isProgress, progress: e.progress, inGoalClosure: e.inGoalClosure, depth: e.depth,
            count: e.count, origin: e.origin, args: e.args
        };
    }
    const objective = an.interactables.filter(i => i.inClosure);
    return {
        ok: an.ok, hasQuestManager: an.hasQuestManager, scene: an.scene, goalEvents: an.goalEvents,
        progressEvents: an.progressEvents, rootKeys: an.rootKeys, eventOrder: [...an.events.keys()], events,
        edges: an.edges, interactables: an.interactables,
        closureKeys: [...an.events].filter(([, e]) => e.inGoalClosure).map(([k]) => k),
        closureOrder: state.closureEvents, objectiveNames: objective.map(i => i.entity),
        objectiveGuids: state.objectiveGuids, entityCount: an.entityCount
    };
}

// ---------------------------------------------------------------------------------------------------------------
// the script itself
// ---------------------------------------------------------------------------------------------------------------
test("generated script is syntactically valid (node --check) and free of em-dashes", () => {
    const script = buildGraphScript();
    const file = path.join(os.tmpdir(), "adventurer-graph-check-" + process.pid + ".js");
    fs.writeFileSync(file, script);
    try {
        const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
    } finally {
        fs.rmSync(file, { force: true });
    }
    assert.ok(!script.includes("\u2014") && !script.includes("\u2013"), "no em/en dashes");
    assert.ok(!GRAPH_SRC.includes("`") && !TABLES_SRC.includes("`") && !script.includes("${"), "no backticks or dollar-brace");
    for (const f of ["graph.ts", "graph.test.mjs"]) {
        const text = fs.readFileSync(path.join(HERE, f), "utf8");
        assert.ok(!text.includes("\u2014") && !text.includes("\u2013"), f + " has no em/en dashes");
    }
});

test("embedded tables are identical to the Python tables", () => {
    const py = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "tables.json"), "utf8"));
    const js = new Function(TABLES_SRC + "\nreturn { SCRIPT_EVENTS, LEAF_SCRIPTS, LEAF_LISTEN, LEAF_FIRE, INTERACTABLE_SCRIPTS, QUEST_SCRIPT, MAX_COUNT };")();
    const tables = Object.fromEntries(Object.entries(py.SCRIPT_EVENTS).map(([s, t]) => [s, t]));
    assert.deepEqual(Object.keys(js.SCRIPT_EVENTS), Object.keys(tables), "same scripts in the same order");
    for (const [script, table] of Object.entries(py.SCRIPT_EVENTS)) assert.deepEqual(js.SCRIPT_EVENTS[script], table, script);
    for (const k of ["LEAF_SCRIPTS", "LEAF_LISTEN", "LEAF_FIRE", "INTERACTABLE_SCRIPTS"]) assert.deepEqual([...js[k]].sort(), py[k], k);
    assert.equal(js.QUEST_SCRIPT, py.QUEST_SCRIPT);
    assert.equal(js.MAX_COUNT, py.MAX_COUNT);
});

test("API exists before the first build and is inert", () => {
    const ctx = inject(null, { window: { performance } });
    const g = ctx.api;
    assert.deepEqual(Object.keys(g).filter(k => !k.startsWith("_")).sort(),
        ["eventOrigin", "guessedRecipe", "isDerived", "isObjective", "onChange", "refresh", "role", "state"]);
    assert.equal(g.state().ok, false);
    assert.equal(g.state().hasQuestManager, false);
    assert.deepEqual(g.state().objectiveGuids, []);
    assert.equal(g.state().recipe, null);
    assert.equal(g.state().source.status, "idle");
    assert.equal(g.guessedRecipe(), null);
    assert.equal(g.guessedRecipe({ usableOnly: true }), null);
    assert.equal(g.isObjective({ getGuid: () => "x" }), false);
    assert.equal(g.role({ getGuid: () => "x" }), "");
    assert.equal(g.isDerived("quest:complete"), false);
    assert.equal(g.isDerived(undefined), false);
    assert.doesNotThrow(() => g.refresh());
    assert.equal(g.isObjective(null), false);
    assert.equal(g.isObjective({ getGuid() { throw new Error("boom"); } }), false);
    assert.equal(g.role({ getGuid() { throw new Error("boom"); } }), "");
    const off = g.onChange(() => {});
    assert.equal(typeof off, "function");
    off();
});

test("a second injection does not replace the API or restart the poller", () => {
    const world = makeWorld(byName.holocube.scan);
    const first = inject(world);
    const { api } = first;
    const timers = first.clock.pending();
    const second = inject(world, { window: first.window, clock: first.clock });
    assert.equal(second.window.__adventurerGraph, api);
    assert.equal(first.clock.pending(), timers);
});

// ---------------------------------------------------------------------------------------------------------------
// parity with the Python analysis
// ---------------------------------------------------------------------------------------------------------------
for (const f of fixtures) {
    test("parity with Python: " + f.name, () => {
        const { api, world } = build(f.scan);
        const st = api.state();
        assert.equal(st.ok, true);
        const got = dumpAnalysis(api._analyze(api._scan()), st);
        const exp = f.expected;
        assert.deepEqual(got.eventOrder, exp.eventOrder, "event insertion order");
        assert.deepEqual(got.events, exp.events, "events (fired_by, listened_by, closure, depth, count, origin, args)");
        assert.deepEqual(got.edges, exp.edges, "edges");
        assert.deepEqual(got.interactables, exp.interactables, "interactables");
        assert.deepEqual(got.goalEvents, exp.goalEvents);
        assert.deepEqual(got.progressEvents, exp.progressEvents);
        assert.deepEqual(got.rootKeys, exp.rootKeys);
        assert.deepEqual(got.closureKeys, exp.closureKeys);
        assert.deepEqual(got.closureOrder, exp.closureOrder, "closure ordering (deepest first)");
        assert.deepEqual(got.objectiveNames, exp.objectiveNames);
        assert.deepEqual(got.objectiveGuids, exp.objectiveGuids);
        assert.equal(got.hasQuestManager, exp.hasQuestManager);
        assert.equal(got.scene, exp.scene);
        assert.equal(got.entityCount, exp.entityCount);
        // public state agrees too
        assert.equal(st.hasQuestManager, exp.hasQuestManager);
        assert.deepEqual(st.goalEvents, exp.goalEvents);
        assert.deepEqual(st.closureEvents, exp.closureOrder);
        assert.deepEqual(st.objectiveGuids, exp.objectiveGuids);
        assert.equal(st.scene, exp.scene);
        for (const guid of exp.objectiveGuids) {
            assert.equal(api.isObjective({ getGuid: () => guid }), true, guid);
            assert.equal(typeof st.roles[guid], "string");
            assert.ok(st.roles[guid].length > 0, "role for " + guid);
        }
        assert.deepEqual(Object.keys(st.roles).sort(), [...exp.objectiveGuids].sort());
        assert.deepEqual(world.violations, [], "read-only");
    });

    test("scan round trip: " + f.name, () => {
        const { api } = build(f.scan);
        const scan = api._scan();
        assert.equal(scan.ok, true);
        assert.equal(scan.entities.length, f.scan.entities.length);
        scan.entities.forEach((rec, i) => {
            const src = f.scan.entities[i];
            assert.equal(rec.guid, src.guid);
            assert.equal(rec.name, src.name);
            assert.deepEqual(rec.tags, src.tags);
            assert.deepEqual(rec.scripts.map(s => [s.name, s.attrs]), src.scripts.map(s => [s.name, s.attrs]));
        });
        for (const [name, recs] of Object.entries(f.scan.listeners ?? {})) {
            assert.deepEqual(scan.listeners[name].map(r => [r.guid, r.script, r.target]), recs.map(r => [r.guid, r.script, "app"]), name);
        }
    });
}

// ---------------------------------------------------------------------------------------------------------------
// holocube-style chain
// ---------------------------------------------------------------------------------------------------------------
test("holocube chain: closure, objectives, roles, optional lamp chain excluded", () => {
    const { api, world } = build(byName.holocube.scan);
    const st = api.state();
    assert.equal(st.ok, true);
    assert.equal(st.hasQuestManager, true);
    assert.deepEqual(st.goalEvents, ["quest:complete"]);
    for (const k of ["quest:complete", "quest:progress:1", "quest:progress:2", "quest:progress:3", "holocube:inserted", "item:cubeA", "item:cubeB", "item:cubeC"]) {
        assert.ok(st.closureEvents.includes(k), k + " in closure");
    }
    for (const k of ["lamp:toggle", "lamp:glow", "cube:A:taken", "quest:progress"]) assert.ok(!st.closureEvents.includes(k), k + " not in closure");

    assert.deepEqual([...st.objectiveGuids].sort(), ["c0", "c1", "c2", "s0", "s1", "s2"]);
    assert.equal(api.isObjective(world.byGuid.get("lb")), false, "Lamp Button is cosmetic");
    assert.equal(api.isObjective(world.byGuid.get("lamp")), false);
    assert.equal(api.isObjective(world.byGuid.get("cnt")), false, "a counter is not an interactable");
    assert.equal(api.isObjective(world.byGuid.get("s1")), true);
    assert.deepEqual(st.roles, {
        c0: "collect holocube 1/3", c1: "collect holocube 2/3", c2: "collect holocube 3/3",
        s0: "use holocube 1/3", s1: "use holocube 2/3", s2: "use holocube 3/3"
    });
    assert.equal(api.role(world.byGuid.get("c1")), "collect holocube 2/3");
    assert.equal(api.role(world.byGuid.get("lb")), "");

    const detail = Object.fromEntries(st.closureDetail.map(e => [e.key, e]));
    assert.equal(detail["holocube:inserted"].count, 3);
    assert.equal(detail["holocube:inserted"].origin, "interaction");
    assert.equal(detail["quest:progress:2"].origin, "derived");
    assert.equal(detail["quest:complete"].goal, true);
    assert.equal(detail["item:cubeA"].count, 1);
    assert.equal(st.closureEvents[st.closureEvents.length - 1] === "quest:complete" || detail[st.closureEvents[st.closureEvents.length - 1]].depth === 0, true);
    assert.deepEqual(st.progressEvents.filter(p => p.progress !== null), [
        { event: "quest:progress:1", progress: 1 }, { event: "quest:progress:2", progress: 2 }, { event: "quest:progress:3", progress: 3 }]);
    assert.ok(st.buildMs >= 0 && st.builtAt > 0 && st.builds === 1 && st.error === null);
    assert.deepEqual(world.violations, []);
});

test("holocube without numbered progress: counts accumulate on the counted event", () => {
    const { api } = build(byName.holocube_no_progress.scan);
    const d = Object.fromEntries(api.state().closureDetail.map(e => [e.key, e]));
    assert.equal(d["holocube:inserted"].count, 3);
    assert.deepEqual(api.state().roles.s0, "use holocube 1/3");
});

test("roles for a keypad code, a focus item and a lone button", () => {
    const keypad = build(byName.code_arguments.scan).api.state();
    assert.deepEqual(keypad.objectiveGuids, ["k"]);
    assert.equal(keypad.roles.k, "enter code 4821");

    const focus = build(byName.focus_items_valid_items.scan).api.state();
    assert.deepEqual(focus.objectiveGuids, ["k1", "l1"]);
    assert.equal(focus.roles.k1, "collect brassKey");
    assert.equal(focus.roles.l1, "use lock");

    const door = build(byName.door_power.scan).api.state();
    assert.ok(door.objectiveGuids.includes("s"), "the switch that unlocks the door is an objective");
    assert.match(door.roles.s, /^press /);
});

test("entity-scoped events stay separate and an entity-scoped chain reaches the goal", () => {
    const st = build(byName.entity_scoped_chain.scan).api.state();
    assert.ok(st.closureEvents.includes("hit@gc") && st.closureEvents.includes("full@gc") && st.closureEvents.includes("quest:complete"));
    const sep = build(byName.entity_scope_separate.scan).api.state();
    assert.ok(!sep.closureEvents.includes("tick@ga"));
});

// ---------------------------------------------------------------------------------------------------------------
// isDerived / eventOrigin
// ---------------------------------------------------------------------------------------------------------------
test("isDerived: true when a scene script fires the event, false for external and unknown events", () => {
    const { api } = build(byName.holocube.scan);
    assert.equal(api.isDerived("quest:complete"), true, "fired by the finish relay");
    assert.equal(api.isDerived("quest:progress:3"), true, "fired by the counter");
    assert.equal(api.isDerived("quest:progress:1"), true);
    assert.equal(api.isDerived("holocube:inserted"), true, "has a producer script (useItem); see eventOrigin for the player-driven part");
    assert.equal(api.isDerived("lamp:glow"), true, "cosmetic but still fired by a scene script");
    assert.equal(api.isDerived("quest:progress"), false, "listened to by the quest manager but nothing fires it");
    assert.equal(api.isDerived("interactable:click"), false);
    assert.equal(api.isDerived("no:such:event"), false);
    assert.equal(api.isDerived(""), false);
    assert.equal(api.isDerived(undefined), false);
    assert.equal(api.isDerived(42), false);
    assert.equal(api.isDerived("item:cubeA"), false, "synthetic item events are not events");
    assert.equal(api.eventOrigin("holocube:inserted"), "interaction");
    assert.equal(api.eventOrigin("quest:progress:2"), "derived");
    assert.equal(api.eventOrigin("lamp:glow"), "");
    assert.equal(api.eventOrigin("nope"), "");

    const ext = build(byName.goal_external.scan).api;
    assert.equal(ext.isDerived("quest:complete"), false, "nothing in the scene fires the goal");
    assert.equal(ext.eventOrigin("quest:complete"), "external");

    const ent = build(byName.entity_scoped_chain.scan).api;
    assert.equal(ent.isDerived("full"), true, "entity-scoped event, accepted by plain name");
    assert.equal(ent.isDerived("full@gc"), true, "and by graph key");
    assert.equal(ent.isDerived("hit"), false);

    const none = build(byName.aim_no_quest_manager.scan).api;
    assert.equal(none.isDerived("enemy:hit"), true, "the generic fallback sees hitEvent as fired by the enemy script (Python: fired_by)");
    assert.equal(none.isDerived("never:fired"), false);
});

// ---------------------------------------------------------------------------------------------------------------
// no quest manager
// ---------------------------------------------------------------------------------------------------------------
test("no quest manager: ok, hasQuestManager false, nothing is an objective", () => {
    const { api, world } = build(byName.aim_no_quest_manager.scan);
    const st = api.state();
    assert.equal(st.ok, true);
    assert.equal(st.hasQuestManager, false);
    assert.deepEqual(st.objectiveGuids, []);
    assert.deepEqual(st.closureEvents, []);
    assert.deepEqual(st.goalEvents, []);
    assert.deepEqual(st.roles, {});
    assert.equal(st.scene, "GlobalAces_MASTER");
    for (const e of world.entities) assert.equal(api.isObjective(e), false);
    assert.ok(st.notes.some(n => n.includes("discordQuestManager")));
});

test("empty scene and missing application", () => {
    const empty = build({ scene: "e", entities: [] });
    assert.equal(empty.api.state().ok, true);
    assert.equal(empty.api.state().hasQuestManager, false);
    assert.equal(empty.api.state().entityCount, 0);

    const none = inject(null, { window: { performance } });
    none.api.refresh();
    assert.equal(none.api.state().ok, false);
    const noRoot = inject(null, { window: { performance, pc: { app: {} } } });
    assert.doesNotThrow(() => noRoot.api.refresh());
    assert.equal(noRoot.api.state().ok, false);
});

// ---------------------------------------------------------------------------------------------------------------
// malformed / odd scripts
// ---------------------------------------------------------------------------------------------------------------
test("odd scripts and engine objects never throw and do not disturb the rest of the graph", () => {
    const base = clone(byName.holocube.scan);
    const world = makeWorld(base);
    const poison = (name, guid, mutate) => {
        const rec = { guid, name, enabled: true, tags: ["interactable"], scripts: [{ name: "pushButton", attrs: { onPushEvent: "odd:" + guid } }] };
        const e = makeWorld({ entities: [rec] }).entities[0];
        mutate(e);
        world.entities.push(e);
        world.byGuid.set(guid, e);
        return e;
    };
    const circ = { name: "loop", onPushEvent: "circ:event" };
    circ.self = circ;
    const hugeArray = Array.from({ length: 500 }, (_, i) => "ev:" + i);
    const deep = { a: { b: { c: { d: { e: { f: { g: "deep:event" } } } } } } };
    poison("NoScriptType", "o1", e => { e.script.scripts.push({ __attributes: { onPushEvent: "x:y" } }, null, undefined, 5); });
    poison("NameFallback", "o2", e => { e.script.scripts.push({ __scriptType: { name: "countEvents" }, __attributes: { eventToCount: "c:1", counts: "nope" } }); });
    poison("ThrowingAttr", "o3", e => {
        const attrs = { onPushEvent: "t:1" };
        Object.defineProperty(attrs, "bad", { enumerable: true, get() { throw new Error("getter"); } });
        e.script.scripts.push({ __scriptType: { __name: "mysteryA" }, __attributes: attrs });
    });
    poison("Circular", "o4", e => { e.script.scripts.push({ __scriptType: { __name: "mysteryB" }, __attributes: { circ, hugeArray, deep } }); });
    poison("ThrowingGuid", "o5", e => { e.getGuid = () => { throw new Error("guid"); }; });
    poison("ThrowingTags", "o6", e => { e.tags = { list() { throw new Error("tags"); } }; });
    poison("NoChildren", "o7", e => { e.children = undefined; });
    poison("WeirdValues", "o8", e => {
        e.script.scripts.push({
            __scriptType: { __name: "mysteryC", attributes: { index: { fn: {}, sym: {}, big: {}, vec: {}, col: {}, ent: {}, asset: {}, nul: {}, num: {} } } },
            fn: () => 1, sym: Symbol("s"), big: 10n, vec: { x: 1.234, y: 2, z: 3 }, col: { r: 1, g: 0.5, b: 0, a: 1 },
            ent: world.entities[0], asset: new (class Asset { constructor() { this.name = "tex"; } })(), nul: null, num: NaN
        });
    });
    poison("BadAttributesStore", "o9", e => { e.script.scripts.push({ __scriptType: { __name: "mysteryD" }, __attributes: "string-not-object", onPushEvent: "own:prop", _private: "x" }); });
    world.app._callbacks.set("odd:o1", [null, undefined, 5, { callback() {}, scope: null }, { callback() {}, scope: { entity: {} } }]);
    world.app._callbacks.set(42, [{ callback() {}, scope: world.app }]);
    world.app._callbacks.set("single", { callback() {}, scope: world.app });
    world.entities[1]._callbacks = new Map([["ent:ev", [{ callback() {}, scope: world.entities[2].script.scripts[0] }]]]);

    const ctx = inject(world);
    assert.doesNotThrow(() => ctx.api.refresh());
    const st = ctx.api.state();
    assert.equal(st.ok, true, st.error ?? "");
    assert.deepEqual([...st.objectiveGuids].sort(), ["c0", "c1", "c2", "s0", "s1", "s2"], "the real chain is unaffected");
    assert.equal(st.truncated.attrs, true, "the 500 item array is reported as truncated");
    for (const guid of ["o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8", "o9"]) {
        assert.doesNotThrow(() => ctx.api.isObjective(world.byGuid.get(guid)));
        assert.doesNotThrow(() => ctx.api.role(world.byGuid.get(guid)));
    }
    assert.equal(ctx.api.isObjective(world.byGuid.get("o5")), false);
    const scan = ctx.api._scan();
    const o8 = scan.entities.find(e => e.name === "WeirdValues").scripts.find(s => s.name === "mysteryC").attrs;
    assert.deepEqual(o8, { vec: [1.23, 2, 3], col: [1, 0.5, 0], ent: "@entity:q", nul: null, num: null });
    assert.deepEqual(world.violations, [], "read-only, and the position is never read");
});

test("odd scans fed straight to the analysis never throw (port of the Python malformed-input test)", () => {
    const { api } = build(byName.holocube.scan);
    const bad = [null, [], "x", 5, {}, { ok: false, error: "boom" }, { ok: true, entities: "nope" },
        { ok: true, entities: [null, 3, { scripts: null }, { scripts: [null, { name: 5 }, { name: "countEvents" }] }] },
        { ok: true, entities: [{ name: "x", scripts: [{ name: "countEvents", attrs: { eventToCount: 5, counts: "no" } }] }],
            listeners: { "a:b": "x", "c:d": [null, { guid: 1 }] }, truncated: [] }];
    for (const scan of bad) {
        const an = api._analyze(scan);
        assert.equal(typeof an.ok, "boolean");
    }
    assert.equal(api._analyze({ ok: false, error: "boom" }).ok, false);
    assert.equal(api._analyze(null).ok, false);
    const t = api._analyze({ ok: true, entities: [], truncated: { entities: true, attrs: false } });
    assert.ok(t.notes.some(n => n.includes("truncated") && n.includes("entities")));
});

test("hostile script and attribute names do not touch Object.prototype", () => {
    const scan = { scene: "p", entities: [
        { guid: "h", name: "H", tags: [], scripts: [
            { name: "constructor", attrs: { __proto__x: "a:b", onThing: "c:d" } },
            { name: "__proto__", attrs: { onThing: "e:f" } },
            { name: "toString", attrs: { eventToFire: "g:h" } },
            { name: "discordQuestManager", attrs: { questCompleteEvent: "constructor" } }] }] };
    const { api } = build(scan);
    assert.equal(api.state().ok, true);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(api.state().goalEvents, ["constructor"]);
});

test("a poisoned app (throwing getters) does not escape into the game", () => {
    const world = makeWorld(byName.holocube.scan);
    Object.defineProperty(world.app, "_callbacks", { get() { throw new Error("registry"); } });
    const ctx = inject(world);
    assert.doesNotThrow(() => ctx.api.refresh());
    assert.equal(ctx.api.state().ok, true, "an unreadable listener registry only loses the fallback data");

    const bad = makeWorld(byName.holocube.scan);
    Object.defineProperty(bad.app.root, "children", { get() { throw new Error("children"); } });
    const ctx2 = inject(bad);
    assert.doesNotThrow(() => ctx2.api.refresh());
    assert.equal(ctx2.api.state().ok, false);
    assert.match(ctx2.api.state().error, /children/);
    assert.doesNotThrow(() => ctx2.clock.advance(20000), "poll loop swallows errors");
    assert.ok(ctx2.warnings.length >= 1);
});

// ---------------------------------------------------------------------------------------------------------------
// read-only guarantee
// ---------------------------------------------------------------------------------------------------------------
test("never fires events, calls script methods or touches arise", () => {
    const { world, api, clock } = build(byName.holocube.scan);
    clock.advance(30000);
    api.refresh();
    api.state(); api.isObjective(world.entities[1]); api.role(world.entities[1]); api.isDerived("quest:complete");
    api._scan(); api._analyze(api._scan());
    assert.deepEqual(world.violations, []);
    const src = GRAPH_SRC;
    for (const forbidden of [".fire(", ".fire1(", ".emit(", "postMessage", ".execute(", ".onUse(", ".swap(", "arise", ".on(", ".off(", ".once("]) {
        assert.ok(!src.includes(forbidden), "page code must not contain " + forbidden);
    }
});

// ---------------------------------------------------------------------------------------------------------------
// polling: build once stable, rebuild only on change, throttled
// ---------------------------------------------------------------------------------------------------------------
test("poller builds after the scene is populated and stable, then only rebuilds on change at most every 3 s", () => {
    const scan = clone(byName.holocube.scan);
    const empty = { ...scan, entities: [] };
    const world = makeWorld(empty);
    const ctx = inject(world);
    const { api, clock } = ctx;
    const changes = [];
    api.onChange(s => changes.push(s.objectiveGuids.length));

    clock.advance(3000);
    assert.equal(api.state().builds, 0, "nothing to build in an empty scene");
    assert.equal(api.state().ok, false);

    // populate the scene
    const full = makeWorld(scan);
    for (const e of full.entities) { world.entities.push(e); world.byGuid.set(e.getGuid(), e); }
    world.app._callbacks = full.app._callbacks;
    clock.advance(400);
    assert.equal(api.state().builds, 0, "not before the signature was stable for a poll");
    clock.advance(1600);
    assert.equal(api.state().builds, 1);
    assert.equal(api.state().ok, true);
    assert.equal(api.state().objectiveGuids.length, 6);
    assert.deepEqual(changes, [6], "onChange fires for the first build");

    clock.advance(20000);
    assert.equal(api.state().builds, 1, "unchanged scene: no rebuild");
    assert.deepEqual(changes, [6]);

    // a cosmetic entity appears: rebuild (entity count changed) but nothing observable changes, so no onChange
    const extra = makeWorld({ entities: [{ guid: "x1", name: "Extra", tags: [], scripts: [{ name: "eventRelay", attrs: { triggerEvents: ["zzz"], eventsToSend: [{ eventToSend: "yyy" }] } }] }] });
    world.entities.push(extra.entities[0]); world.byGuid.set("x1", extra.entities[0]);
    clock.advance(1100);
    assert.equal(api.state().builds, 2, "entity count changed: rebuilt at the next poll");
    assert.deepEqual(changes, [6], "same objectives: onChange stays quiet");

    // another change right away: throttled to one build per 3 s
    const slot = makeWorld({ entities: [{ guid: "s9", name: "Slot Z", tags: ["interactable"], scripts: [{ name: "useItem", attrs: { itemId: "cubeA", eventOnCorrectItemUsed: "holocube:inserted" } }] }] });
    world.entities.push(slot.entities[0]); world.byGuid.set("s9", slot.entities[0]);
    clock.advance(1000);
    assert.equal(api.state().builds, 2, "throttled");
    clock.advance(2200);
    assert.equal(api.state().builds, 3);
    assert.equal(api.state().objectiveGuids.length, 7);
    assert.deepEqual(changes, [6, 7]);
    assert.equal(api.state().roles.s9, "use holocube 4/4");

    // script instances appearing later also count as a change
    world.entities[world.entities.length - 1].script.scripts.push(
        { __scriptType: { __name: "pushButton" }, __attributes: { onPushEvent: "none:such" }, entity: null });
    clock.advance(4000);
    assert.equal(api.state().builds, 4);

    // unsubscribe
    const calls = [];
    const off = api.onChange(() => calls.push(1));
    off();
    api.refresh();
    assert.deepEqual(calls, []);
    assert.deepEqual(world.violations, []);
});

test("poller waits for the application to appear and gives up quietly when it never does", () => {
    const window = { performance };
    const clock = makeClock();
    const warnings = [];
    const ctx = inject(null, { window, clock, warnings });
    clock.advance(10000);
    assert.equal(ctx.api.state().ok, false);
    const world = makeWorld(byName.holocube.scan);
    window.pc = { app: world.app };
    clock.advance(3000);
    assert.equal(ctx.api.state().ok, true, "built once the app showed up");

    const lonely = { performance };
    const c2 = makeClock();
    const w2 = [];
    inject(null, { window: lonely, clock: c2, warnings: w2 });
    c2.advance(130000);
    assert.equal(c2.pending(), 0, "poller stopped");
    assert.equal(w2.length, 1);
});

test("a scene with entities but no script instances is still built after a few stable polls", () => {
    const scan = { scene: "plain", entities: [{ guid: "a", name: "A", tags: [], scripts: [] }] };
    const world = makeWorld(scan);
    const ctx = inject(world);
    ctx.clock.advance(2000);
    assert.equal(ctx.api.state().builds, 0);
    ctx.clock.advance(3000);
    assert.equal(ctx.api.state().builds, 1);
    assert.equal(ctx.api.state().hasQuestManager, false);
});

// ---------------------------------------------------------------------------------------------------------------
// performance
// ---------------------------------------------------------------------------------------------------------------
function bigScan(total = 450) {
    const ent = (name, guid, scripts, tags = []) => ({ guid, name, enabled: true, tags, scripts: scripts.map(([n, a]) => ({ name: n, enabled: true, attrs: a })) });
    const entities = [ent("Quest", "q", [["discordQuestManager", { questCompleteEvent: "quest:complete", questProgressEvent: "quest:progress", progressEvents: [{ event: "quest:progress:1", progress: 1 }] }]])];
    const listeners = {};
    for (let i = 0; i < 60; i++) {
        entities.push(ent("Cube " + i, "c" + i, [["collectable", { itemId: "cube" + i, collectedEvent: "cube:" + i + ":taken", mesh: { a: [1, 2, 3], b: "x" } }]], ["interactable"]));
        entities.push(ent("Slot " + i, "s" + i, [["useItem", { itemId: "cube" + i, eventOnCorrectItemUsed: "holo:in", oneUse: true }]], ["interactable"]));
    }
    entities.push(ent("Counter", "cnt", [["countEvents", { eventToCount: "holo:in", counts: [{ targetCount: 60, eventToFireOnCountMet: "quest:complete" }] }]]));
    let i = 0;
    while (entities.length < total) {
        const k = i++ % 5;
        const g = "f" + i;
        if (k === 0) entities.push(ent("Relay " + i, g, [["eventRelay", { triggerEvents: ["r:" + i, "r:" + (i + 1), "r:" + (i + 2)], eventsToSend: [{ eventToSend: "r:" + (i + 3), delay: 0.5 }, { eventToSend: "r:" + (i + 4) }] }]]));
        else if (k === 1) entities.push(ent("Button " + i, g, [["pushButton", { hasPower: false, onPushEvent: "r:" + i, onPowerEvent: "p:" + i }]], ["interactable"]));
        else if (k === 2) entities.push(ent("Mystery " + i, g, [["mysteryScript", Object.fromEntries(Array.from({ length: 12 }, (_, j) => ["attr" + j, j % 3 ? "value " + j : "m:" + i + ":" + j]))]]));
        else if (k === 3) entities.push(ent("Tween " + i, g, [["positionTween", { tweens: Array.from({ length: 4 }, (_, j) => ({ startTweenEvent: "t:" + i + j, onCompleteEvent: "t:done:" + j, duration: 1 })) }]]));
        else entities.push(ent("Counter " + i, g, [["countEvents", { eventToCount: "r:" + i, counts: Array.from({ length: 5 }, (_, j) => ({ targetCount: j + 1, eventToFireOnCountMet: "c:" + i + ":" + j })) }]]));
        listeners["r:" + i] = [{ guid: g, script: "x" }];
    }
    return { scene: "Big", entities, listeners };
}

test("performance: a build over a 450 entity scene stays well under 30 ms", () => {
    const scan = bigScan(450);
    assert.equal(scan.entities.length, 450);
    const world = makeWorld(scan);
    // give the registry some weight, like a real game
    for (let i = 0; i < 300; i++) world.app._callbacks.set("noise:" + i, [{ callback() {}, scope: world.app }, { callback() {}, scope: world.entities[i % 400].script.scripts[0] ?? world.app }]);
    const ctx = inject(world);
    ctx.api.refresh(); // warm up (JIT)
    const times = [];
    for (let n = 0; n < 15; n++) {
        const t0 = performance.now();
        ctx.api.refresh();
        times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1];
    console.log("    build over 450 entities: median " + median.toFixed(2) + " ms, max " + times[times.length - 1].toFixed(2) + " ms, state.buildMs " + ctx.api.state().buildMs.toFixed(2));
    assert.ok(median < 30, "median " + median);
    assert.ok(times[times.length - 1] < 60, "worst " + times[times.length - 1]);
    const st = ctx.api.state();
    assert.equal(st.hasQuestManager, true);
    assert.ok(st.objectiveGuids.length >= 120, "cubes and slots are objectives: " + st.objectiveGuids.length);
    assert.equal(st.entityCount, 450);

    // the cheap change check done every second is far cheaper than a build
    const t1 = performance.now();
    for (let n = 0; n < 100; n++) ctx.clock.advance(1000);
    const perPoll = (performance.now() - t1) / 100;
    console.log("    idle poll (1 s tick): " + perPoll.toFixed(3) + " ms");
    assert.ok(perPoll < 5);
    assert.equal(ctx.api.state().builds, 16, "idle polls did not rebuild");
});

test("a runaway attribute tree is bounded", () => {
    const wide = () => Object.fromEntries(Array.from({ length: 60 }, (_, i) => ["k" + i, Array.from({ length: 80 }, (_, j) => ({ a: "v" + j, b: [{ c: "w" }] }))]));
    const scan = { scene: "w", entities: Array.from({ length: 5 }, (_, i) => ({ guid: "w" + i, name: "W" + i, tags: [], scripts: [{ name: "mysteryW", attrs: wide() }] })) };
    const t0 = performance.now();
    const { api } = build(scan);
    const dt = performance.now() - t0;
    assert.equal(api.state().ok, true);
    assert.equal(api.state().truncated.attrs, true);
    assert.ok(dt < 500, "bounded work on pathological attributes: " + dt.toFixed(1) + " ms");
});
