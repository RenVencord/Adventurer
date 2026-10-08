// Run with: node minimap.test.mjs
// Imports minimap.ts directly (node strips the types), so the tests execute the
// exact string that buildMinimapScript() returns. No Vencord imports, no deps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import * as mm from "./minimap.ts";

const j = x => JSON.parse(JSON.stringify(x)); // vm realms differ, compare plain JSON

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------
class Bus {
    constructor() { this._l = Object.create(null); }
    on(name, fn, scope) { (this._l[name] ||= []).push({ fn, scope }); return this; }
    off(name, fn) {
        if (!this._l[name]) return this;
        this._l[name] = this._l[name].filter(x => x.fn !== fn);
        return this;
    }
    fire(name, ...args) {
        for (const l of (this._l[name] || []).slice()) l.fn.apply(l.scope, args);
        return this;
    }
    count(name) { return (this._l[name] || []).length; }
}

function makeClock() {
    let now = 0, nextId = 1;
    let timers = [];
    const clock = {
        setTimeout(fn, ms = 0) { const id = nextId++; timers.push({ id, at: now + Math.max(0, ms), fn, every: 0 }); return id; },
        setInterval(fn, ms) { const id = nextId++; timers.push({ id, at: now + ms, fn, every: ms }); return id; },
        clearTimeout(id) { timers = timers.filter(t => t.id !== id); },
        clearInterval(id) { timers = timers.filter(t => t.id !== id); },
        tick(ms) {
            const target = now + ms;
            for (;;) {
                const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (!due) break;
                now = due.at;
                if (due.every) due.at += due.every; else timers = timers.filter(t => t !== due);
                due.fn();
            }
            now = target;
        },
        pending() { return timers.length; }
    };
    return clock;
}

function makeCtx(record) {
    const props = {};
    return new Proxy({}, {
        get(_, name) {
            if (name === "measureText") return s => ({ width: String(s).length * 6 });
            if (name in props) return props[name];
            return (...args) => { record.push([name, args]); };
        },
        set(_, name, v) { props[name] = v; return true; }
    });
}

function makeCanvas() {
    const c = new Bus();
    c.addEventListener = (n, f) => c.on(n, f);
    c.style = {};
    c.width = 300;
    c.height = 150;
    c.calls = [];
    c.stopped = new Set();
    c.ctx = makeCtx(c.calls);
    c.getContext = () => c.ctx;
    c.getBoundingClientRect = () => ({ left: 0, top: 0, width: parseFloat(c.style.width) || c.width, height: parseFloat(c.style.height) || c.height });
    c.parentNode = null;
    c.send = (name, ev = {}) => {
        const e = { clientX: 0, clientY: 0, ...ev, stopPropagation() { c.stopped.add(name); } };
        c.fire(name, e);
        return e;
    };
    c.count = n => c.calls.filter(x => x[0] === n).length;
    return c;
}

function makeEntity(name, pos = { x: 0, y: 0, z: 0 }) {
    const e = new Bus();
    e.name = name;
    e.children = [];
    e.parent = null;
    e.enabled = true;
    e.script = {};
    e.getPosition = () => pos;
    return e;
}

function addChild(parent, child) { parent.children.push(child); child.parent = parent; }

function makeBox(name, c, he, extra = {}) {
    const ent = makeEntity(name);
    const mi = {
        visible: true,
        aabb: { center: { x: c[0], y: c[1], z: c[2] }, halfExtents: { x: he[0], y: he[1], z: he[2] } },
        node: { getWorldTransform: () => ({ data: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) },
        ...extra
    };
    return { entity: ent, enabled: true, meshInstances: [mi] };
}

// A small PlayCanvas-like scene with the game's real camera POI manager logic.
// Graph: A<->B, B<->C, B<->D with D disabled (locked). deadEndC makes C a dead end.
function buildScene(opts = {}) {
    const app = new Bus();
    const root = makeEntity("Root");
    root.comps = { render: [], model: [] };
    root.find = fn => {
        const out = [];
        const walk = n => { for (const c of n.children) { if (fn(c)) out.push(c); walk(c); } };
        walk(root);
        return out;
    };
    root.findComponents = type => root.comps[type] || [];
    app.root = root;

    const gameCanvas = makeCanvas();

    const defs = {
        A: { pos: { x: 0, y: 1.6, z: 0 }, look: { x: 0, y: 1.6, z: -5 } },
        B: { pos: { x: 4, y: 1.6, z: 0 }, look: { x: 9, y: 1.6, z: 0 } },
        C: { pos: { x: 8, y: 1.6, z: 0 }, look: { x: 8, y: 1.6, z: 5 } },
        D: { pos: { x: 4, y: 1.6, z: 6 }, look: { x: 4, y: 1.6, z: 6 } }
    };
    const pois = {};
    for (const [id, d] of Object.entries(defs)) {
        const ent = makeEntity("poi_" + id);
        const target = makeEntity("t_" + id, d.pos);
        const look = makeEntity("l_" + id, d.look);
        const cp = {
            entity: ent, id, poiEnabled: opts.dEnabled ? true : id !== "D", useBackButton: true,
            camTargetEntity: target, camLookAtEntity: look, connectedPois: []
        };
        ent.script.cameraPoi = cp;
        addChild(root, ent);
        pois[id] = { ent, cp };
    }
    const link = (a, b) => pois[a].cp.connectedPois.push({ poiEntity: pois[b].ent, duration: 1 });
    link("A", "B"); link("B", "A"); link("B", "D"); link("D", "B");
    link("B", "C");
    if (!opts.deadEndC) link("C", "B");

    const camEnt = makeEntity("Camera", { x: 0, y: 1.6, z: 0 });
    camEnt.forward = { x: 0, y: 0, z: -1 };

    // --- manager replicating the real cameraPoiManager decision logic ------
    const mgr = {
        entity: makeEntity("Manager"),
        pois: Object.values(pois).map(p => p.ent),
        moving: false,
        poiStack: [],
        currentPoi: null,
        backButtonMode: "stack",
        cameraEntity: camEnt,
        warnings: [],
        getCurrentPoiEntity() { return this.currentPoi && this.currentPoi.entity ? this.currentPoi.entity : null; },
        onPoiClicked(m) {
            if (this.moving) return;
            if (!m.poiEnabled) { this.warnings.push("disabled"); return; }
            const path = this.currentPoi.connectedPois.find(c => c.poiEntity === m.entity);
            if (!path) { this.warnings.push("nopath"); return; }
            this.currentPoi = m;
            this.poiStack.push(m);
            this.moveTo(m);
        },
        onBack() {
            if (this.moving) return;
            const prev = this.poiStack.length > 1 ? this.poiStack[this.poiStack.length - 2] : null;
            if (!prev) { this.warnings.push("noprev"); return; }
            if (!prev.poiEnabled) return;
            const path = prev.connectedPois.find(c => c.poiEntity === this.currentPoi.entity);
            if (!path) { this.warnings.push("noreverse"); return; }
            this.currentPoi = prev;
            this.poiStack.pop();
            this.moveTo(prev);
        },
        moveTo(m) {
            this.moving = true;
            this.pending = m.entity.name;
            app.fire("interactables:enabled", false);
            app.fire("camera:moveRequested", { metadata: { poiName: m.entity.name } });
        },
        onArrived() {
            this.moving = false;
            this.currentPoi = this.poiStack[this.poiStack.length - 1];
            app.fire("interactables:enabled", true);
        }
    };
    app.on("cameraPoi:clicked", mgr.onPoiClicked, mgr);
    app.on("cameraPoi:backButtonClicked", mgr.onBack, mgr);
    app.on("camera:moveComplete", mgr.onArrived, mgr);
    mgr.entity.script.cameraPoiManager = mgr;
    addChild(root, mgr.entity);
    // game CameraPoi.handleMouseUp
    for (const p of Object.values(pois)) {
        p.ent.on("interactable:mouseUp", () => {
            const c = p.cp;
            app.fire("cameraPoi:clicked", { id: c.id, entity: p.ent, poiEnabled: c.poiEnabled, camTargetEntity: c.camTargetEntity, camLookAtEntity: c.camLookAtEntity, connectedPois: c.connectedPois, useBackButton: c.useBackButton });
        });
    }
    mgr.currentPoi = pois.A.cp;
    mgr.poiStack = [pois.A.cp];

    // focus manager
    const focusEnt = makeEntity("FocusItemManager");
    focusEnt.script.focusItemManager = { focusedOnItem: false, transitioning: false };
    addChild(root, focusEnt);

    // geometry
    const floor = makeBox("Floor", [4, -0.05, 2], [7, 0.05, 5]);
    const wallN = makeBox("Wall_North", [4, 1.5, -4], [7, 1.5, 0.1]);
    const panel = makeBox("Panel_01", [-3, 1.5, 0], [0.1, 1.5, 3]);
    const table = makeBox("Table", [2, 0.4, 2], [0.5, 0.4, 0.5]);
    const ceiling = makeBox("Ceiling", [4, 3.2, 2], [7, 0.05, 5]);
    const cyclo = makeBox("Cyclorama", [0, 50, 0], [200, 100, 200]);
    const hidden = makeBox("Floor_hidden", [100, -0.05, 100], [30, 0.05, 30]);
    hidden.entity.enabled = false;
    const invisible = makeBox("Wall_invisible", [100, 1.5, 100], [0.1, 1.5, 30], {});
    invisible.meshInstances[0].visible = false;
    root.comps.render.push(floor, wallN, panel, table, ceiling, cyclo, hidden, invisible);
    for (const c of root.comps.render) addChild(root, c.entity);
    if (opts.bigRoom) {
        const room = makeBox("RoomShell", [4, 1.5, 2], [5, 1.5, 5]);
        // wall quad at z = -3 (x -1..9, y 0..3), plus a horizontal floor quad that must be ignored
        const pos = [-1, 0, -3, 9, 0, -3, 9, 3, -3, -1, 3, -3, -1, 0, 7, 9, 0, 7, 9, 0, -3, -1, 0, -3];
        const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
        room.meshInstances[0].mesh = {
            getPositions(out) { out.length = 0; out.push(...pos); },
            getIndices(out) { out.length = 0; out.push(...idx); }
        };
        root.comps.render.push(room);
        addChild(root, room.entity);
    }

    app.fire_ = app.fire.bind(app);
    const log = { requested: [] };
    app.on("camera:moveRequested", m => log.requested.push(m.metadata.poiName));

    return {
        app, root, mgr, pois, camEnt, focusEnt, gameCanvas, log,
        finishMove() { app.fire("camera:moveComplete", { metadata: { poiName: mgr.pending } }); },
        addPoi(id, pos) {
            const ent = makeEntity("poi_" + id);
            const cp = { entity: ent, id, poiEnabled: true, useBackButton: true, camTargetEntity: makeEntity("t", pos), camLookAtEntity: makeEntity("l", { x: pos.x, y: pos.y, z: pos.z - 1 }), connectedPois: [] };
            ent.script.cameraPoi = cp;
            addChild(root, ent);
            mgr.pois.push(ent);
            return { ent, cp };
        }
    };
}

function loadScript(scene, opts = { enabled: true, size: 220, position: "tr" }, extra = {}) {
    const clock = makeClock();
    const document = {
        hidden: false,
        created: [],
        body: {
            children: [],
            appendChild(c) { this.children.push(c); c.parentNode = this; },
            removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; }
        },
        querySelector: sel => (sel === "canvas" ? scene.gameCanvas : null),
        createElement(tag) {
            assert.equal(tag, "canvas");
            const c = makeCanvas();
            document.created.push(c);
            return c;
        }
    };
    document.documentElement = document.body;
    const winListeners = new Bus();
    const logs = { info: [], warn: [], log: [] };
    const sandbox = {
        console: { info: (...a) => logs.info.push(a.join(" ")), warn: (...a) => logs.warn.push(a.join(" ")), log: (...a) => logs.log.push(a.join(" ")) },
        document,
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        setInterval: clock.setInterval, clearInterval: clock.clearInterval,
        devicePixelRatio: 1,
        pc: scene ? { app: scene.app } : undefined,
        __ADVENTURER_TEST__: true,
        ...extra
    };
    sandbox.window = sandbox;
    sandbox.addEventListener = (n, f) => winListeners.on(n, f);
    sandbox.removeEventListener = (n, f) => winListeners.off(n, f);
    vm.createContext(sandbox);
    const src = mm.buildMinimapScript(opts);
    vm.runInContext(src, sandbox);
    const env = {
        sandbox, clock, document, logs, winListeners, src,
        post(data) { winListeners.fire("message", { data }); },
        key(k) { winListeners.fire("keydown", { key: k }); },
        get panel() { return document.created[0]; },
        get api() { return sandbox.__adventurerMinimap; },
        get hook() { return sandbox.__adventurerMinimapTest; },
        run(src2) { return vm.runInContext(src2, sandbox); },
        // panel pixel of a POI by id using the panel's current transform
        poiPixel(id) {
            const s = j(env.api.state());
            const p = s.pois.find(q => q.id === id);
            const cur = s.pois.find(q => q.current);
            const t = env.hook.makeTransform(s.bounds, s.size, s.scale, cur ? { x: cur.x, z: cur.z } : null, 10);
            return { x: p.x * t.s + t.ox, y: p.z * t.s + t.oz };
        },
        clickPoi(id) {
            const px = env.poiPixel(id);
            env.panel.send("mousemove", { clientX: px.x, clientY: px.y });
            env.panel.send("mousedown", { clientX: px.x, clientY: px.y });
            env.panel.send("mouseup", { clientX: px.x, clientY: px.y });
            env.panel.send("click", { clientX: px.x, clientY: px.y });
        }
    };
    return env;
}

// ---------------------------------------------------------------------------
// Source hygiene
// ---------------------------------------------------------------------------
test("generated string parses (new Function and node --check) and has no em-dashes", () => {
    const src = mm.buildMinimapScript({ enabled: true, size: 220, position: "tl", scale: 2 });
    assert.doesNotThrow(() => new Function(src));
    const dir = mkdtempSync(join(tmpdir(), "mm-"));
    try {
        const f = join(dir, "script.js");
        writeFileSync(f, src);
        const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    assert.ok(!src.includes("—") && !src.includes("–"));
    assert.ok(!src.includes("__OPTS__"));
    assert.match(src, /"position":"tl"/);
    for (const pos of ["tl", "tr", "bl", "br"]) {
        assert.doesNotThrow(() => new Function(mm.buildMinimapScript({ enabled: false, size: 100, position: pos })));
    }
});

test("exported helpers are compiled from the injected helper text", () => {
    const env = loadScript(buildScene());
    const g = { nodes: { a: { enabled: true, out: ["b"] }, b: { enabled: true, out: [] } } };
    assert.deepEqual(j(env.hook.planJump(g, ["a"], "a", "b")), mm.planJump(g, ["a"], "a", "b"));
    const box = { name: "x", w: 10, h: 0.1, d: 10, cy: 0 };
    assert.equal(env.hook.classifyBox(box), mm.classifyBox(box));
    assert.ok(mm.HELPERS_SRC.includes("function planJump"));
    assert.ok(env.src.includes(mm.HELPERS_SRC));
});

test("buildMinimapMessage matches the protocol", () => {
    assert.deepEqual(mm.buildMinimapMessage({ enabled: true, size: 200, position: "bl" }),
        { __adventurerOverlay: true, type: "minimap", enabled: true, size: 200, position: "bl" });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
test("classifyBox: names, sizes, backdrops", () => {
    const k = (name, w, h, d, cy = 0, eye) => mm.classifyBox({ name, w, h, d, cy }, eye);
    assert.equal(k("Floor_Main", 10, 0.2, 10), "floor");
    assert.equal(k("Carpet", 4, 0.05, 3), "floor");
    assert.equal(k("Ground", 50, 1, 50), "floor");
    assert.equal(k("Wall_A", 6, 3, 0.2), "wall");
    assert.equal(k("Room Upper", 8, 3, 8), "wall");
    assert.equal(k("room lower", 8, 3, 8), "wall");
    assert.equal(k("Ceiling", 10, 0.1, 10, 3.2, 1.6), "ceiling");
    assert.equal(k("Roof", 10, 0.1, 10, 3.2), "ceiling");
    assert.equal(k("floor lamp", 0.4, 1.6, 0.4), "furniture", "name hint is ignored when the shape disagrees");
    assert.equal(k("slab", 10, 0.2, 10, 0, 1.6), "floor");
    assert.equal(k("slab_hi", 10, 0.2, 10, 3.2, 1.6), "ceiling");
    assert.equal(k("mat", 3, 0.3, 3), "floor", "h < 0.4 with big area");
    assert.equal(k("p", 8, 3, 0.3), "wall");
    assert.equal(k("pillar", 0.4, 3, 0.4), "furniture");
    assert.equal(k("table", 1.5, 0.8, 0.8), "furniture");
    assert.equal(k("lowbarrier", 8, 1.0, 0.2), "furniture", "taller than 1.5 is required for size based walls");
    assert.equal(k("blob", 6, 3, 6), "furniture");
});

test("dropBackdrops removes boxes above 3x the POI span", () => {
    const rects = [{ x0: 0, z0: 0, x1: 0, z1: 0 }, { x0: 10, z0: 0, x1: 10, z1: 5 }];
    const boxes = [{ n: "room", w: 12, d: 8 }, { n: "cyclo", w: 400, d: 400 }, { n: "edge", w: 30, d: 4 }, { n: "over", w: 31, d: 4 }];
    assert.deepEqual(mm.fitBounds(rects, 0), { minX: 0, maxX: 10, minZ: 0, maxZ: 5 });
    const kept = j(loadScript(buildScene()).hook.dropBackdrops(boxes, rects)).map(b => b.n);
    assert.deepEqual(kept, ["room", "edge"]);
    // tiny POI cluster still allows a normal sized room (floor of 6 units * 3)
    const kept2 = j(loadScript(buildScene()).hook.dropBackdrops([{ n: "ok", w: 17, d: 17 }, { n: "bad", w: 19, d: 3 }], [{ x0: 0, z0: 0, x1: 0, z1: 0 }]));
    assert.deepEqual(kept2.map(b => b.n), ["ok"]);
});

test("fitBounds and makeTransform fit the scene inside the panel", () => {
    assert.equal(mm.fitBounds([], 0.1), null);
    const b = mm.fitBounds([{ x0: -2, z0: 0, x1: 18, z1: 10 }], 0.1);
    assert.deepEqual(b, { minX: -4, maxX: 20, minZ: -2, maxZ: 12 });
    const deg = mm.fitBounds([{ x0: 5, z0: 5, x1: 5, z1: 5 }]);
    assert.ok(deg.maxX - deg.minX >= 2 && deg.maxZ - deg.minZ >= 2);

    const t = mm.makeTransform(b, 220, 1, null, 10);
    const corners = [[b.minX, b.minZ], [b.maxX, b.maxZ], [b.minX, b.maxZ], [b.maxX, b.minZ]];
    for (const [x, z] of corners) {
        const px = x * t.s + t.ox, py = z * t.s + t.oz;
        assert.ok(px >= 10 - 1e-6 && px <= 210 + 1e-6, "x " + px);
        assert.ok(py >= 100 - 100 - 1e-6 && py <= 220 + 1e-6, "y " + py);
    }
    // longest axis fills the inner area exactly, uniform scale, centred
    assert.ok(Math.abs((b.maxX - b.minX) * t.s - 200) < 1e-6);
    assert.ok(Math.abs((b.minX + b.maxX) / 2 * t.s + t.ox - 110) < 1e-6);
    assert.ok(Math.abs((b.minZ + b.maxZ) / 2 * t.s + t.oz - 110) < 1e-6);

    // zoom follows the centre but never leaves the bounds
    const z2 = mm.makeTransform(b, 220, 2, { x: 12, z: 5 }, 10);
    assert.ok(Math.abs(z2.s - t.s * 2) < 1e-9);
    assert.ok(Math.abs(12 * z2.s + z2.ox - 110) < 1e-6, "centre point sits mid panel");
    const z3 = mm.makeTransform(b, 220, 4, { x: 1000, z: -1000 }, 10);
    assert.ok(b.maxX * z3.s + z3.ox >= 210 - 1e-6, "clamped to the right edge");
    assert.ok(b.minZ * z3.s + z3.oz <= 10 + 1e-6, "clamped to the top edge");
});

test("pickPoi, yaw convention", () => {
    const t = { s: 10, ox: 0, oz: 0 };
    const pts = [{ x: 1, z: 1 }, { x: 5, z: 5 }];
    assert.equal(loadScript(buildScene()).hook.pickPoi(pts, t, 11, 9, 5), 0);
    assert.equal(loadScript(buildScene()).hook.pickPoi(pts, t, 30, 30, 5), -1);
    const h = loadScript(buildScene()).hook;
    assert.ok(Math.abs(h.yawFromDelta(0, -1)) < 1e-9, "facing -Z is yaw 0 (points up)");
    const d = h.dirFromYaw(h.yawFromDelta(3, 0));
    assert.ok(Math.abs(d.x - 1) < 1e-9 && Math.abs(d.z) < 1e-9, "facing +X points right");
    const d2 = h.dirFromYaw(h.yawFromDelta(0, 2));
    assert.ok(Math.abs(d2.z - 1) < 1e-9, "facing +Z points down");
});

const G = (nodes, backMode) => ({ nodes, backMode });
const N = (out, enabled = true, useBack = true) => ({ enabled, useBack, out });

test("planJump: forward", () => {
    const g = G({ A: N(["B"]), B: N(["A", "C"]), C: N(["B"]) });
    assert.deepEqual(mm.planJump(g, ["A"], "A", "C"), [{ kind: "forward", id: "B" }, { kind: "forward", id: "C" }]);
    assert.deepEqual(mm.planJump(g, ["A"], "A", "B"), [{ kind: "forward", id: "B" }]);
    assert.deepEqual(mm.planJump(g, ["A"], "A", "A"), []);
});

test("planJump: picks the fewest hops among several routes", () => {
    const g = G({ S: N(["X", "Y"]), X: N(["Z"]), Y: N(["W"]), Z: N(["T"]), W: N([]), T: N([]) });
    assert.deepEqual(mm.planJump(g, ["S"], "S", "T").map(s => s.id), ["X", "Z", "T"]);
    const g2 = G({ S: N(["X", "T"]), X: N(["T"]), T: N([]) });
    assert.deepEqual(mm.planJump(g2, ["S"], "S", "T").map(s => s.id), ["T"]);
});

test("planJump: back then forward", () => {
    // X is a dead end for forward travel, only R->X exists, so go back to R then to Y
    const g = G({ R: N(["X", "Y"]), X: N([]), Y: N(["R"]) });
    assert.deepEqual(mm.planJump(g, ["R", "X"], "X", "Y"), [{ kind: "back", id: "R" }, { kind: "forward", id: "Y" }]);
    // back-only target
    assert.deepEqual(mm.planJump(g, ["R", "X"], "X", "R"), [{ kind: "back", id: "R" }]);
    // two back steps
    const g2 = G({ A: N(["B", "T"]), B: N(["C"]), C: N([]), T: N([]) });
    assert.deepEqual(mm.planJump(g2, ["A", "B", "C"], "C", "T"), [{ kind: "back", id: "B" }, { kind: "back", id: "A" }, { kind: "forward", id: "T" }]);
    // when the forward route is as short as the back route, fewer backs win
    const g3 = G({ A: N(["B", "T"]), B: N(["A", "T"]), T: N([]) });
    assert.deepEqual(mm.planJump(g3, ["A", "B"], "B", "T"), [{ kind: "forward", id: "T" }]);
    // strictly shorter via back
    const g4 = G({ A: N(["B", "T"]), B: N(["C"]), C: N(["D"]), D: N(["T"]), T: N([]) });
    assert.deepEqual(mm.planJump(g4, ["A", "B"], "B", "T"), [{ kind: "back", id: "A" }, { kind: "forward", id: "T" }]);
});

test("planJump: back steps need the reverse edge, an enabled landing and useBack", () => {
    // no reverse edge Y -> X means the game would refuse the back step
    assert.equal(mm.planJump(G({ R: N(["Y"]), X: N([]), Y: N([]) }), ["R", "X"], "X", "Y"), null);
    // landing disabled
    assert.equal(mm.planJump(G({ R: N(["X", "Y"], false), X: N([]), Y: N([]) }), ["R", "X"], "X", "Y"), null);
    // leaving POI has back button disabled
    assert.equal(mm.planJump(G({ R: N(["X", "Y"]), X: N([], true, false), Y: N([]) }), ["R", "X"], "X", "Y"), null);
    // fixed back mode never plans back steps
    assert.equal(mm.planJump(G({ R: N(["X", "Y"]), X: N([]), Y: N([]) }, "fixed"), ["R", "X"], "X", "Y"), null);
    // a stack whose top is not the current POI is ignored
    assert.equal(mm.planJump(G({ R: N(["X", "Y"]), X: N([]), Y: N([]) }), ["R", "Q"], "X", "Y"), null);
});

test("planJump: unreachable and locked", () => {
    const g = G({ A: N(["B"]), B: N(["A"]), C: N(["A"]), D: N(["A"], false) });
    assert.equal(mm.planJump(g, ["A"], "A", "C"), null, "no incoming edge");
    const g2 = G({ A: N(["B", "D"]), B: N(["A"]), D: N(["A"], false) });
    assert.equal(mm.planJump(g2, ["A"], "A", "D"), null, "disabled target");
    const g3 = G({ A: N(["M"]), M: N(["T"], false), T: N([]) });
    assert.equal(mm.planJump(g3, ["A"], "A", "T"), null, "disabled intermediate blocks the route");
    assert.equal(mm.planJump(g3, ["A"], "A", "nope"), null);
    assert.equal(mm.planJump(g3, ["A"], "ghost", "T"), null);
    assert.equal(mm.explainLock(g2, ["A"], "A", "D"), "disabled");
    assert.equal(mm.explainLock(g, ["A"], "A", "C"), "no enabled route from here");
    assert.equal(mm.explainLock(g, ["A"], "A", "A"), "you are here");
    assert.equal(mm.explainLock(g, ["A"], "A", "B"), "");
    assert.equal(mm.explainLock(g, ["A"], "A", "zzz"), "unknown POI");
});

test("extractWallSegments handles transforms, vertical filter and floors", () => {
    const h = loadScript(buildScene()).hook;
    // wall quad at z = 0 from x 0..4, y 0..3, plus horizontal quad
    const pos = [0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4];
    const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
    // translate by (10, 0, 5)
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 5, 1];
    const out = [];
    const end = h.extractWallSegments(pos, idx, m, 1.0, 2.0, out, 0, 99);
    assert.equal(end, 4);
    assert.equal(out.length / 4, 2, "two wall triangles, floor quad ignored");
    for (let i = 0; i < out.length; i += 4) {
        assert.equal(out[i + 1], 5);
        assert.equal(out[i + 3], 5);
        assert.ok(Math.abs(Math.abs(out[i + 2] - out[i]) - 4) < 1e-9, "segment spans the 4 unit wall");
        assert.ok(out[i] >= 10 && out[i] <= 14, "translated into world space");
    }
    // eye band above the wall removes everything
    const none = [];
    h.extractWallSegments(pos, idx, m, 5, 6, none, 0, 99);
    assert.equal(none.length, 0);
    // non-indexed input, chunking
    const flat = [0, 0, 0, 4, 0, 0, 4, 3, 0];
    const o2 = [];
    assert.equal(h.extractWallSegments(flat, null, m, 0, 3, o2, 0, 1), 1);
    assert.equal(o2.length, 4);
    // degenerate triangles produce nothing
    const o3 = [];
    h.extractWallSegments([0, 0, 0, 0, 0, 0, 0, 0, 0], null, m, 0, 3, o3, 0, 1);
    assert.equal(o3.length, 0);
});

// ---------------------------------------------------------------------------
// Scene / script behaviour
// ---------------------------------------------------------------------------
test("boot: finds the manager, builds the panel, scans geometry and POIs", () => {
    const scene = buildScene();
    const env = loadScript(scene, { enabled: true, size: 220, position: "tr" });
    assert.ok(env.api, "debug api exposed");
    assert.equal(env.document.created.length, 2, "visible panel plus static layer");
    const p = env.panel;
    assert.equal(p.id, "adventurer-minimap");
    assert.equal(p.style.pointerEvents, "auto");
    assert.equal(p.style.position, "fixed");
    assert.equal(p.style.width, "220px");
    assert.equal(p.style.right, "12px");
    assert.equal(p.style.top, "12px");
    assert.equal(p.style.bottom, "auto");
    assert.equal(p.parentNode, env.document.body);

    const s = j(env.api.state());
    assert.equal(s.installed, true);
    assert.equal(s.current, "A");
    assert.deepEqual(s.stack, ["A"]);
    assert.deepEqual(s.pois.map(q => q.id), ["A", "B", "C", "D"]);
    // geometry: floor, 2 walls (named + by size), table; ceiling/backdrop/hidden/invisible dropped
    assert.equal(s.geometry.floors, 1);
    assert.equal(s.geometry.walls, 2);
    assert.equal(s.geometry.furniture, 1);
    // yaw: A looks -Z (0), B looks +X, C looks +Z, D has no look vector (same spot)
    const yaw = id => s.pois.find(q => q.id === id).yaw;
    assert.ok(Math.abs(yaw("A")) < 1e-9);
    assert.ok(Math.abs(yaw("B") - Math.atan2(-5, -0)) < 1e-9);
    assert.ok(Math.abs(yaw("C") - Math.atan2(-0, -5)) < 1e-9);
    assert.equal(yaw("D"), null);
    // locks
    const lock = id => s.pois.find(q => q.id === id);
    assert.equal(lock("A").current, true);
    assert.equal(lock("B").locked, false);
    assert.equal(lock("C").locked, false);
    assert.equal(lock("D").locked, true);
    assert.equal(lock("D").reason, "disabled");
    // the cyclorama (400 wide) must not blow up the bounds
    assert.ok(s.bounds.maxX - s.bounds.minX < 40, "bounds " + JSON.stringify(s.bounds));
    assert.ok(env.logs.info.some(l => l.includes("installed")));
});

test("rendering: draws dots/arrows once, then idles when nothing changes", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    env.clock.tick(250);
    const panel = env.panel, stat = env.document.created[1];
    assert.ok(panel.count("drawImage") >= 1);
    assert.equal(panel.count("arc") >= 4 + 1 + 1, true, "4 dots, the ring and the camera marker");
    assert.ok(stat.count("fillRect") > 0, "static geometry went to the offscreen canvas");
    const staticFills = stat.count("fillRect");
    const draws = panel.count("drawImage");
    env.clock.tick(3000);
    assert.equal(panel.count("drawImage"), draws, "no redraw while nothing changed");
    assert.equal(stat.count("fillRect"), staticFills, "static layer is not re-rendered");
    // moving the camera triggers a dynamic redraw only
    scene.camEnt.getPosition = () => ({ x: 1, y: 1.6, z: 0 });
    env.clock.tick(200);
    assert.ok(panel.count("drawImage") > draws);
    assert.equal(stat.count("fillRect"), staticFills);
});

test("hover tooltip shows the id and the lock reason", () => {
    const env = loadScript(buildScene());
    const d = env.poiPixel("D");
    env.panel.send("mousemove", { clientX: d.x, clientY: d.y });
    env.clock.tick(150);
    const texts = env.panel.calls.filter(c => c[0] === "fillText").map(c => c[1][0]);
    assert.ok(texts.includes("D"));
    assert.ok(texts.includes("locked: disabled"));
    env.panel.calls.length = 0;
    const b = env.poiPixel("B");
    env.panel.send("mousemove", { clientX: b.x, clientY: b.y });
    env.clock.tick(150);
    const texts2 = env.panel.calls.filter(c => c[0] === "fillText").map(c => c[1][0]);
    assert.ok(texts2.includes("click to jump"));
    env.panel.send("mouseleave");
    env.clock.tick(150);
});

test("panel mouse events never reach the game", () => {
    const env = loadScript(buildScene());
    for (const n of ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel", "pointerdown", "pointerup", "pointermove", "mouseover", "touchstart", "touchmove", "touchend", "mousemove"]) {
        env.panel.send(n, { clientX: 5, clientY: 5 });
    }
    for (const n of ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel", "pointerdown", "pointerup", "pointermove", "mouseover", "touchstart", "touchmove", "touchend", "mousemove"]) {
        assert.ok(env.panel.stopped.has(n), n + " was not stopped");
    }
});

test("message protocol: enabled, size, position, scale, validation", () => {
    const scene = buildScene();
    const env = loadScript(scene, { enabled: false, size: 220, position: "tr" });
    assert.equal(env.document.created.length, 0, "nothing is added while disabled");
    assert.ok(env.api);
    env.post({ __adventurerOverlay: true, type: "minimap", enabled: true, size: 300, position: "bl" });
    assert.equal(env.panel.style.display, "");
    assert.equal(env.panel.style.width, "300px");
    assert.equal(env.panel.style.left, "12px");
    assert.equal(env.panel.style.bottom, "12px");
    assert.equal(env.panel.style.top, "auto");
    assert.equal(env.panel.width, 300);
    env.post({ __adventurerOverlay: true, type: "minimap", enabled: true, size: 9999, position: "tl", scale: 3 });
    assert.equal(env.panel.style.width, "640px");
    assert.equal(env.panel.style.top, "12px");
    assert.equal(j(env.api.state()).scale, 3);
    env.post({ __adventurerOverlay: true, type: "minimap", size: 10 });
    assert.equal(env.panel.style.width, "120px");
    // ignored messages
    env.post({ type: "minimap", enabled: false });
    env.post({ __adventurerOverlay: true, type: "state", enabled: false });
    env.post({ __adventurerOverlay: true, type: "minimap", position: "zz", size: "abc" });
    env.post(null);
    env.post("string");
    assert.equal(env.panel.style.display, "");
    assert.equal(env.panel.style.width, "120px");
    assert.equal(env.panel.style.top, "12px");
    env.post({ __adventurerOverlay: true, type: "minimap", enabled: false });
    assert.equal(env.panel.style.display, "none");
    env.api.setEnabled(true);
    assert.equal(env.panel.style.display, "");
    env.api.setEnabled(false);
    assert.equal(env.panel.style.display, "none");
    // disabled minimap does no drawing work
    const n = env.panel.count("drawImage");
    scene.camEnt.getPosition = () => ({ x: 3, y: 1.6, z: 3 });
    env.clock.tick(1000);
    assert.equal(env.panel.count("drawImage"), n);
});

test("messages that arrive before the manager exists are applied once it does", () => {
    const scene = buildScene();
    const real = scene.mgr.pois;
    scene.mgr.pois = [];
    const env = loadScript(scene, { enabled: false, size: 220, position: "tr" });
    assert.equal(env.api, undefined);
    env.post({ __adventurerOverlay: true, type: "minimap", enabled: true, size: 260, position: "br" });
    scene.mgr.pois = real;
    env.clock.tick(300);
    assert.ok(env.api);
    assert.equal(env.panel.style.width, "260px");
    assert.equal(env.panel.style.right, "12px");
    assert.equal(env.panel.style.bottom, "12px");
});

test("no cameraPoiManager: nothing is added and one console.info is logged", () => {
    const scene = buildScene();
    scene.root.children = scene.root.children.filter(c => !c.script.cameraPoiManager);
    const env = loadScript(scene);
    env.clock.tick(70000);
    assert.equal(env.document.created.length, 0);
    assert.equal(env.document.body.children.length, 0);
    assert.equal(env.api, undefined);
    assert.equal(env.logs.info.length, 1);
    assert.match(env.logs.info[0], /not installed/);
    assert.equal(env.clock.pending(), 0, "polling stopped");
    // no pc at all behaves the same
    const env2 = loadScript(null);
    env2.clock.tick(70000);
    assert.equal(env2.document.created.length, 0);
    assert.equal(env2.logs.info.length, 1);
});

test("running the script twice installs once", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    const before = { msg: env.winListeners.count("message"), moveComplete: scene.app.count("camera:moveComplete") };
    vm.runInContext(env.src, env.sandbox);
    assert.equal(env.winListeners.count("message"), before.msg);
    assert.equal(scene.app.count("camera:moveComplete"), before.moveComplete);
    assert.equal(env.document.created.length, 2);
});

test("rescans when the POI list changes (checked every ~2 s)", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    assert.equal(j(env.api.state()).pois.length, 4);
    scene.addPoi("E", { x: 12, y: 1.6, z: 3 });
    env.clock.tick(500);
    assert.equal(j(env.api.state()).pois.length, 4, "not re-checked yet");
    env.clock.tick(2000);
    const s = j(env.api.state());
    assert.equal(s.pois.length, 5);
    assert.ok(s.bounds.maxX >= 12);
    assert.equal(s.pois.find(p => p.id === "E").locked, true);
    assert.equal(s.pois.find(p => p.id === "E").reason, "no enabled route from here");
});

test("triangle pass finds wall segments for single huge meshes (idle chunks)", () => {
    const scene = buildScene({ bigRoom: true });
    const env = loadScript(scene);
    assert.equal(j(env.api.state()).geometry.wallSegments, 0, "not done yet, chunks run when idle");
    env.clock.tick(100);
    const s = j(env.api.state());
    assert.equal(s.geometry.wallSegments, 2);
    // vertex readback failing is tolerated and does not throw into the game
    const scene2 = buildScene({ bigRoom: true });
    scene2.root.comps.render.at(-1).meshInstances[0].mesh.getPositions = () => { throw new Error("no readback"); };
    const env2 = loadScript(scene2);
    assert.doesNotThrow(() => env2.clock.tick(200));
    assert.equal(j(env2.api.state()).geometry.wallSegments, 0);
});

// ---- jump execution ---------------------------------------------------------
test("jump: single hop fires interactable:mouseUp on the POI and waits for moveComplete", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    const fired = [];
    scene.pois.B.ent.on("interactable:mouseUp", () => fired.push("B"));
    const r = j(env.api.jumpTo("B"));
    assert.equal(r.ok, true);
    assert.deepEqual(r.plan, [{ kind: "forward", id: "B" }]);
    assert.deepEqual(fired, ["B"]);
    assert.deepEqual(scene.log.requested, ["poi_B"]);
    assert.equal(scene.mgr.moving, true);
    assert.equal(j(env.api.state()).job.target, "B");
    env.clock.tick(500);
    assert.equal(j(env.api.state()).job.index, 0, "still waiting for the camera");
    scene.finishMove();
    env.clock.tick(100);
    const s = j(env.api.state());
    assert.equal(s.job, null);
    assert.equal(s.current, "B");
    assert.deepEqual(s.stack, ["A", "B"]);
    assert.ok(env.logs.warn.length === 0, env.logs.warn.join("\n"));
});

test("jump: multi hop sequences one hop per camera:moveComplete", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    const r = j(env.api.jumpTo("C"));
    assert.deepEqual(r.plan.map(p => p.id), ["B", "C"]);
    assert.deepEqual(scene.log.requested, ["poi_B"], "only the first hop so far");
    env.clock.tick(1000);
    assert.deepEqual(scene.log.requested, ["poi_B"], "second hop must wait for moveComplete");
    scene.finishMove();
    assert.deepEqual(scene.log.requested, ["poi_B"], "and is deferred a few ms after it");
    env.clock.tick(100);
    assert.deepEqual(scene.log.requested, ["poi_B", "poi_C"]);
    scene.finishMove();
    env.clock.tick(100);
    const s = j(env.api.state());
    assert.equal(s.current, "C");
    assert.equal(s.job, null);
    assert.deepEqual(scene.mgr.warnings, []);
});

test("jump: back then forward runs cameraPoi:backButtonClicked then the forward click", () => {
    const scene = buildScene({ deadEndC: true, dEnabled: true });
    const env = loadScript(scene);
    const backs = [];
    scene.app.on("cameraPoi:backButtonClicked", () => backs.push("back"));
    env.api.jumpTo("C");
    scene.finishMove(); env.clock.tick(100);
    scene.finishMove(); env.clock.tick(100);
    assert.equal(j(env.api.state()).current, "C");
    assert.deepEqual(j(env.api.state()).stack, ["A", "B", "C"]);
    scene.log.requested.length = 0;
    const r = j(env.api.jumpTo("D"));
    assert.deepEqual(r.plan, [{ kind: "back", id: "B" }, { kind: "forward", id: "D" }]);
    assert.deepEqual(backs, ["back"]);
    assert.deepEqual(scene.log.requested, ["poi_B"]);
    scene.finishMove(); env.clock.tick(100);
    assert.deepEqual(scene.log.requested, ["poi_B", "poi_D"]);
    scene.finishMove(); env.clock.tick(100);
    const s = j(env.api.state());
    assert.equal(s.current, "D");
    assert.deepEqual(s.stack, ["A", "B", "D"]);
    assert.deepEqual(scene.mgr.warnings, []);
});

test("jump: refuses locked, unknown, same POI and gated states without touching the game", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    const fireSpy = [];
    scene.app.on("cameraPoi:clicked", () => fireSpy.push("clicked"));
    assert.equal(env.api.jumpTo("D").ok, false);
    assert.match(env.api.jumpTo("D").reason, /no enabled route/);
    assert.match(env.api.jumpTo("nope").reason, /unknown POI/);
    assert.match(env.api.jumpTo("A").reason, /already at/);
    // moving
    scene.mgr.moving = true;
    assert.match(env.api.jumpTo("B").reason, /camera is moving/);
    scene.mgr.moving = false;
    // item focused
    scene.focusEnt.script.focusItemManager.focusedOnItem = true;
    assert.match(env.api.jumpTo("B").reason, /item is focused/);
    scene.focusEnt.script.focusItemManager.focusedOnItem = false;
    // interactions disabled by the game
    scene.app.fire("interactables:enabled", false);
    assert.match(env.api.jumpTo("B").reason, /interactions are disabled/);
    scene.app.fire("interactables:enabled", true);
    assert.deepEqual(fireSpy, []);
    assert.equal(env.api.jumpTo("B").ok, true);
    assert.deepEqual(fireSpy, ["clicked"]);
    // a second request while one runs is refused
    assert.match(env.api.jumpTo("C").reason, /already running/);
});

test("jump: times out after 10 s without camera:moveComplete", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    env.api.jumpTo("C");
    env.clock.tick(9900);
    assert.notEqual(j(env.api.state()).job, null, "still within the 10 s hop budget");
    env.clock.tick(200);
    assert.equal(j(env.api.state()).job, null);
    assert.equal(env.logs.warn.length, 1);
    assert.match(env.logs.warn[0], /timed out waiting for camera:moveComplete/);
    scene.finishMove(); env.clock.tick(200);
    assert.deepEqual(scene.log.requested, ["poi_B"], "no further hops after the abort");
});

test("jump: cancel by clicking the minimap again and by Escape", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    env.clickPoi("C");
    assert.deepEqual(scene.log.requested, ["poi_B"]);
    assert.notEqual(j(env.api.state()).job, null);
    env.panel.send("click", { clientX: 3, clientY: 3 });
    assert.equal(j(env.api.state()).job, null);
    scene.finishMove(); env.clock.tick(200);
    assert.deepEqual(scene.log.requested, ["poi_B"], "cancelled jump does not continue");
    assert.equal(j(env.api.state()).current, "B");
    // Escape, with an idle Escape being ignored
    env.key("Escape");
    env.clickPoi("C");
    assert.notEqual(j(env.api.state()).job, null);
    env.key("a");
    assert.notEqual(j(env.api.state()).job, null);
    env.key("Escape");
    assert.equal(j(env.api.state()).job, null);
    scene.finishMove(); env.clock.tick(200);
    assert.deepEqual(scene.log.requested, ["poi_B", "poi_C"]);
});

test("jump: click handling honours locks and ignores empty space", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    env.clickPoi("D");
    assert.deepEqual(scene.log.requested, [], "locked POI ignores clicks");
    assert.equal(j(env.api.state()).job, null);
    env.panel.send("click", { clientX: 2, clientY: 2 });
    assert.deepEqual(scene.log.requested, []);
    env.clickPoi("A");
    assert.deepEqual(scene.log.requested, [], "clicking the current POI does nothing");
    env.clickPoi("B");
    assert.deepEqual(scene.log.requested, ["poi_B"]);
    env.panel.send("click", { clientX: 2, clientY: 2 }); // cancel
    // while moving, a click on a reachable POI is refused by the gate
    scene.mgr.moving = true;
    env.clickPoi("A");
    assert.deepEqual(scene.log.requested, ["poi_B"]);
    scene.mgr.moving = false;
});

test("jump: aborts when the game rejects the hop", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    scene.app.off("cameraPoi:clicked", scene.mgr.onPoiClicked);
    scene.app._l["cameraPoi:clicked"] = [];
    env.api.jumpTo("B");
    assert.equal(j(env.api.state()).job, null);
    assert.match(env.logs.warn.at(-1), /game rejected the hop/);
});

test("jump: aborts when the camera is moved by something else or stays busy", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    env.api.jumpTo("C");
    scene.app.fire("camera:moveRequested", { metadata: { poiName: "other" } });
    assert.equal(j(env.api.state()).job, null);
    assert.match(env.logs.warn.at(-1), /moved by something else/);

    const scene2 = buildScene();
    const env2 = loadScript(scene2);
    env2.api.jumpTo("C");
    scene2.finishMove();
    scene2.mgr.moving = true; // somebody started another move before the next hop
    env2.clock.tick(2500);
    assert.equal(j(env2.api.state()).job, null);
    assert.match(env2.logs.warn.at(-1), /still blocked: the camera is moving/);
    assert.deepEqual(scene2.log.requested, ["poi_B"]);

    const scene3 = buildScene();
    const env3 = loadScript(scene3);
    env3.api.jumpTo("C");
    scene3.finishMove();
    scene3.pois.C.cp.poiEnabled = false; // a puzzle locked the target meanwhile
    env3.clock.tick(200);
    assert.equal(j(env3.api.state()).job, null);
    assert.match(env3.logs.warn.at(-1), /route changed/);
    assert.deepEqual(scene3.log.requested, ["poi_B"], "never fires a hop the game would have to reject");
});

test("jump: never forges clicks or writes POI data", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    const snapshot = JSON.stringify(Object.values(scene.pois).map(p => [p.cp.poiEnabled, p.cp.connectedPois.map(c => c.poiEntity.name)]));
    const events = [];
    const origFire = scene.app.fire.bind(scene.app);
    scene.app.fire = (name, ...a) => { events.push(name); return origFire(name, ...a); };
    env.api.jumpTo("C");
    scene.finishMove(); env.clock.tick(100);
    scene.finishMove(); env.clock.tick(100);
    assert.equal(snapshot, JSON.stringify(Object.values(scene.pois).map(p => [p.cp.poiEnabled, p.cp.connectedPois.map(c => c.poiEntity.name)])));
    // the only app events the script fired itself are none; the game fired the rest through the entity click
    assert.ok(!events.includes("cameraPoi:backButtonClicked"));
    assert.ok(env.src.indexOf("fire(\"cameraPoi:clicked\"") < 0, "script never fires cameraPoi:clicked");
});

test("destroy removes the panel and listeners", () => {
    const scene = buildScene();
    const env = loadScript(scene);
    const n = scene.app.count("camera:moveComplete");
    env.api.destroy();
    assert.equal(env.document.body.children.length, 0);
    assert.equal(scene.app.count("camera:moveComplete"), n - 1);
});
