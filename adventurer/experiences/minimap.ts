/*
 * Adventurer: top-down minimap overlay for PlayCanvas "camera POI" activities.
 *
 * buildMinimapScript() returns plain JS source that is injected into the
 * activity iframe (same transport as the existing game overlay). The page code
 * lives in two String.raw constants below so that:
 *   - there is exactly one copy of the logic (the exported pure helpers are
 *     compiled from the very same HELPERS_SRC text that is injected),
 *   - esbuild/minifiers cannot rename anything inside it,
 *   - the node test (minimap.test.mjs) exercises the exact injected string.
 *
 * Rules for editing the two source constants: no backticks, no dollar-brace
 * sequences, no em-dashes. Backslashes are literal (String.raw).
 *
 * This file only uses erasable TypeScript syntax so node can import it
 * directly for the tests.
 */

export type MinimapPosition = "tl" | "tr" | "bl" | "br";

export interface MinimapOptions {
    enabled: boolean;
    /** Square panel size in CSS pixels (clamped to 120..640 in page). */
    size: number;
    position: MinimapPosition;
    /** Map zoom: 1 fits the whole scene, larger values zoom in around the current POI (clamped 1..8). */
    scale?: number;
}

export interface MinimapGraphNode {
    enabled: boolean;
    /** false when the POI has useBackButton disabled (back steps out of it are refused). */
    useBack?: boolean;
    /** Ids of POIs reachable in one hop (directed). */
    out: string[];
}

export interface MinimapGraph {
    nodes: Record<string, MinimapGraphNode>;
    /** "stack" (default) allows back steps through the stack, "fixed" disables them in planning. */
    backMode?: "stack" | "fixed";
}

export interface JumpStep {
    kind: "forward" | "back";
    id: string;
}

export interface MinimapBox {
    name?: string;
    w: number;
    h: number;
    d: number;
    cy: number;
}

export type MinimapBoxKind = "floor" | "wall" | "ceiling" | "furniture";

export interface MinimapBounds {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

export interface MinimapTransform {
    s: number;
    ox: number;
    oz: number;
}

/** Message tag shared with the existing Adventurer game overlay. */
export const MINIMAP_MESSAGE_TAG = "__adventurerOverlay";

/** postMessage payload that reconfigures an already injected minimap. */
export function buildMinimapMessage(opts: Partial<MinimapOptions> & { enabled: boolean; }) {
    return { [MINIMAP_MESSAGE_TAG]: true, type: "minimap" as const, ...opts };
}

// ---------------------------------------------------------------------------
// HELPERS_SRC: pure functions (no DOM, no pc). Injected verbatim and also
// compiled for the exported helpers below.
// ---------------------------------------------------------------------------
export const HELPERS_SRC: string = String.raw`
var MM_FLOOR_RE = /floor|ground|carpet/i;
var MM_WALL_RE = /wall|room (upper|lower)/i;
var MM_CEIL_RE = /ceil|roof/i;

function mmHas(obj, key) {
    return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

// b = { name, w, h, d, cy } (full extents, not half extents). eyeY is optional:
// when given, flat pieces above it are ceilings instead of floors.
function classifyBox(b, eyeY) {
    var name = b.name || "";
    var w = b.w, h = b.h, d = b.d;
    var mn = Math.min(w, d), mx = Math.max(w, d);
    var flatLimit = Math.max(0.6, 0.5 * mn);
    if (MM_CEIL_RE.test(name) && h < flatLimit) return "ceiling";
    if (MM_FLOOR_RE.test(name) && h < flatLimit) return "floor";
    if (MM_WALL_RE.test(name) && h > 0.8) return "wall";
    var isFlat = h < 0.3 * mn || (h < 0.4 && w * d > 4);
    if (isFlat) return (eyeY != null && b.cy > eyeY) ? "ceiling" : "floor";
    if (h > 1.5 && mn < 0.4 * mx) return "wall";
    return "furniture";
}

// graph = { nodes: { id: { enabled, useBack, out: [id] } }, backMode }.
// stack = ids from bottom to top (top is the current POI).
// Returns [{ kind: "forward" | "back", id }] (empty when already there) or null.
function planJump(graph, stack, currentId, targetId) {
    var nodes = graph && graph.nodes;
    if (!nodes || !mmHas(nodes, currentId) || !mmHas(nodes, targetId)) return null;
    if (currentId === targetId) return [];

    function bfs(startId) {
        if (startId === targetId) return [];
        var prev = {};
        prev[startId] = null;
        var queue = [startId];
        for (var qi = 0; qi < queue.length; qi++) {
            var id = queue[qi];
            var outs = nodes[id].out || [];
            for (var oi = 0; oi < outs.length; oi++) {
                var nx = outs[oi];
                if (!mmHas(nodes, nx) || mmHas(prev, nx) || !nodes[nx].enabled) continue;
                prev[nx] = id;
                if (nx === targetId) {
                    var path = [];
                    for (var cur = nx; cur !== startId; cur = prev[cur]) path.push({ kind: "forward", id: cur });
                    path.reverse();
                    return path;
                }
                queue.push(nx);
            }
        }
        return null;
    }

    var chain = (stack && stack.length && stack[stack.length - 1] === currentId) ? stack : [currentId];
    var top = chain.length - 1;
    var canBack = !graph.backMode || graph.backMode === "stack";
    var best = null;
    for (var k = 0; k <= top; k++) {
        var backs = [];
        if (k > 0) {
            if (!canBack) break;
            var valid = true;
            for (var j = 1; j <= k; j++) {
                var leaving = chain[top - j + 1];
                var landing = chain[top - j];
                if (!mmHas(nodes, leaving) || !mmHas(nodes, landing)) { valid = false; break; }
                var L = nodes[landing], V = nodes[leaving];
                // The game needs: previous POI enabled, a reverse edge landing -> leaving.
                if (!L.enabled || V.useBack === false || (L.out || []).indexOf(leaving) < 0) { valid = false; break; }
                backs.push({ kind: "back", id: landing });
            }
            if (!valid) break;
        }
        var fwd = bfs(chain[top - k]);
        if (fwd === null) continue;
        var plan = backs.concat(fwd);
        if (best === null || plan.length < best.length) best = plan;
    }
    return best;
}

// "" when a click would be accepted (ignoring transient game busy states).
function explainLock(graph, stack, currentId, targetId) {
    var nodes = graph && graph.nodes;
    if (!nodes || !mmHas(nodes, targetId)) return "unknown POI";
    if (targetId === currentId) return "you are here";
    if (!nodes[targetId].enabled) return "disabled";
    if (planJump(graph, stack, currentId, targetId) === null) return "no enabled route from here";
    return "";
}

// rects = [{ x0, z0, x1, z1 }]. Returns padded bounds or null.
function fitBounds(rects, padFrac) {
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (!isFinite(r.x0) || !isFinite(r.x1) || !isFinite(r.z0) || !isFinite(r.z1)) continue;
        if (r.x0 < minX) minX = r.x0;
        if (r.x1 > maxX) maxX = r.x1;
        if (r.z0 < minZ) minZ = r.z0;
        if (r.z1 > maxZ) maxZ = r.z1;
    }
    if (!isFinite(minX) || !isFinite(minZ)) return null;
    if (maxX - minX < 2) { var cx = (minX + maxX) / 2; minX = cx - 1; maxX = cx + 1; }
    if (maxZ - minZ < 2) { var cz = (minZ + maxZ) / 2; minZ = cz - 1; maxZ = cz + 1; }
    var pad = Math.max(maxX - minX, maxZ - minZ) * (padFrac == null ? 0.06 : padFrac);
    return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
}

// Uniform world -> panel transform: px = x * s + ox, py = z * s + oz.
// zoom > 1 zooms in around center ({ x, z }), clamped to stay inside bounds.
function makeTransform(bounds, px, zoom, center, margin) {
    var m = margin == null ? 8 : margin;
    var spanX = bounds.maxX - bounds.minX;
    var spanZ = bounds.maxZ - bounds.minZ;
    var inner = Math.max(1, px - 2 * m);
    var z = zoom > 1 ? zoom : 1;
    var s = (inner / Math.max(spanX, spanZ)) * z;
    var cx = (bounds.minX + bounds.maxX) / 2;
    var cz = (bounds.minZ + bounds.maxZ) / 2;
    if (z > 1 && center) {
        var half = inner / 2 / s;
        if (half < spanX / 2) cx = Math.min(bounds.maxX - half, Math.max(bounds.minX + half, center.x));
        if (half < spanZ / 2) cz = Math.min(bounds.maxZ - half, Math.max(bounds.minZ + half, center.z));
    }
    return { s: s, ox: px / 2 - cx * s, oz: px / 2 - cz * s };
}

// pts = [{ x, z }] in world space. Returns index of the closest point within r px or -1.
function pickPoi(pts, t, mx, my, r) {
    var best = -1, bestD = r * r;
    for (var i = 0; i < pts.length; i++) {
        var dx = pts[i].x * t.s + t.ox - mx;
        var dy = pts[i].z * t.s + t.oz - my;
        var dd = dx * dx + dy * dy;
        if (dd <= bestD) { bestD = dd; best = i; }
    }
    return best;
}

// Drops huge backdrops (cyclorama, skydome): any box whose footprint is more
// than 3x the larger of the POI span and 6 world units. boxes need w and d.
function dropBackdrops(boxes, poiRects) {
    var fb = fitBounds(poiRects, 0);
    var span = fb ? Math.max(fb.maxX - fb.minX, fb.maxZ - fb.minZ) : 0;
    var limit = 3 * Math.max(span, 6);
    return boxes.filter(function (b) { return Math.max(b.w, b.d) <= limit; });
}

function yawFromDelta(dx, dz) {
    return Math.atan2(-dx, -dz);
}

function dirFromYaw(yaw) {
    return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

// Wall segment extraction for single huge meshes. pos = flat xyz array, idx =
// index array (empty or null for non-indexed), m = 16 numbers column-major
// world matrix. Faces with |normal.y| < 0.3 whose y range overlaps [yLo, yHi]
// become XZ segments pushed to out as x0, z0, x1, z1. Processes triangles
// [triStart, triEnd) and returns the end index actually reached.
function extractWallSegments(pos, idx, m, yLo, yHi, out, triStart, triEnd) {
    var indexed = !!(idx && idx.length);
    var n = indexed ? idx.length : Math.floor(pos.length / 3);
    var triCount = Math.floor(n / 3);
    if (triEnd > triCount) triEnd = triCount;
    var P = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (var t = triStart; t < triEnd; t++) {
        for (var v = 0; v < 3; v++) {
            var vi = indexed ? idx[t * 3 + v] : t * 3 + v;
            var x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2];
            P[v * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
            P[v * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
            P[v * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        var e1x = P[3] - P[0], e1y = P[4] - P[1], e1z = P[5] - P[2];
        var e2x = P[6] - P[0], e2y = P[7] - P[1], e2z = P[8] - P[2];
        var nx = e1y * e2z - e1z * e2y;
        var ny = e1z * e2x - e1x * e2z;
        var nz = e1x * e2y - e1y * e2x;
        var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (!(len > 1e-9)) continue;
        if (Math.abs(ny) / len >= 0.3) continue;
        var yMin = Math.min(P[1], P[4], P[7]);
        var yMax = Math.max(P[1], P[4], P[7]);
        if (yMax < yLo || yMin > yHi) continue;
        var dab = (P[0] - P[3]) * (P[0] - P[3]) + (P[2] - P[5]) * (P[2] - P[5]);
        var dbc = (P[3] - P[6]) * (P[3] - P[6]) + (P[5] - P[8]) * (P[5] - P[8]);
        var dca = (P[6] - P[0]) * (P[6] - P[0]) + (P[8] - P[2]) * (P[8] - P[2]);
        var best = Math.max(dab, dbc, dca);
        if (best < 4e-4) continue;
        if (best === dab) out.push(P[0], P[2], P[3], P[5]);
        else if (best === dbc) out.push(P[3], P[5], P[6], P[8]);
        else out.push(P[6], P[8], P[0], P[2]);
    }
    return triEnd;
}
`;

// ---------------------------------------------------------------------------
// GLUE_SRC: DOM, pc, events, jump state machine. __OPTS__ is replaced with the
// JSON of the options.
// ---------------------------------------------------------------------------
export const GLUE_SRC: string = String.raw`
var OPTS = __OPTS__;
var TAG = "__adventurerOverlay";
var LOG = "[Adventurer] Minimap: ";
var MIN_SIZE = 120, MAX_SIZE = 640;

var cfg = {
    enabled: !!OPTS.enabled,
    size: 220,
    position: "tr",
    scale: 1,
    hopTimeoutMs: 10000
};
var inst = null;

function clampNum(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function applyCfg(d) {
    if (!d) return;
    if (d.enabled !== undefined) cfg.enabled = !!d.enabled;
    var sz = Number(d.size);
    if (d.size != null && isFinite(sz) && sz > 0) cfg.size = clampNum(Math.round(sz), MIN_SIZE, MAX_SIZE);
    if (d.position === "tl" || d.position === "tr" || d.position === "bl" || d.position === "br") cfg.position = d.position;
    var sc = Number(d.scale);
    if (d.scale != null && isFinite(sc) && sc > 0) cfg.scale = clampNum(sc, 1, 8);
    if (inst) inst.onCfg();
}

applyCfg(OPTS);

window.addEventListener("message", function (e) {
    try {
        var d = e && e.data;
        if (!d || !d[TAG] || d.type !== "minimap") return;
        applyCfg(d);
    } catch (err) {
        console.warn(LOG + "message handler failed", err);
    }
});

if (globalThis.__ADVENTURER_TEST__) {
    window.__adventurerMinimapTest = {
        planJump: planJump,
        classifyBox: classifyBox,
        explainLock: explainLock,
        fitBounds: fitBounds,
        makeTransform: makeTransform,
        pickPoi: pickPoi,
        dropBackdrops: dropBackdrops,
        extractWallSegments: extractWallSegments,
        yawFromDelta: yawFromDelta,
        dirFromYaw: dirFromYaw,
        cfg: cfg,
        instance: function () { return inst; }
    };
}

function findManager(app) {
    var found = app.root.find(function (e) {
        return e.script && e.script.cameraPoiManager;
    });
    if (!found || !found.length) return null;
    var mgr = found[0].script.cameraPoiManager;
    if (!mgr || !mgr.pois || !mgr.pois.length) return null;
    return mgr;
}

var bootTries = 0;
function boot() {
    var app = null, mgr = null;
    try {
        app = (window.pc && window.pc.app) || window.app;
        if (app && app.root && document.querySelector("canvas")) mgr = findManager(app);
    } catch (err) {
        mgr = null;
    }
    if (!mgr) {
        bootTries++;
        if (bootTries > 240) {
            console.info(LOG + "no PlayCanvas app with a cameraPoiManager found after ~60s, minimap not installed.");
            return;
        }
        setTimeout(boot, 250);
        return;
    }
    try {
        inst = start(app, mgr);
    } catch (err) {
        console.warn(LOG + "failed to start", err);
    }
}

function start(app, manager) {
    var dpr = window.devicePixelRatio || 1;
    var st = {
        pois: [],
        byKey: Object.create(null),
        idKey: Object.create(null),
        entKey: new Map(),
        graph: { nodes: Object.create(null), backMode: "stack" },
        cur: null,
        stack: [],
        moving: false,
        interactEnabled: true,
        bounds: null,
        t: null,
        floors: [],
        walls: [],
        furn: [],
        triBoxes: [],
        geoVer: 0,
        staticKey: "",
        staticCanvas: null,
        panel: null,
        ctx: null,
        hover: -1,
        mouseX: 0,
        mouseY: 0,
        mouseIn: false,
        dirty: true,
        liveSig: "",
        camSig: "",
        status: "",
        statusTicks: 0,
        structSig: "",
        tick: 0,
        focusEnt: null,
        scanned: false,
        errors: 0
    };
    var job = null;
    var triToken = 0;
    var listeners = [];

    function later(fn, ms) {
        var id = setTimeout(fn, ms);
        return id;
    }

    function setStatus(text, ticks) {
        st.status = text || "";
        st.statusTicks = ticks == null ? 30 : ticks;
        st.dirty = true;
    }

    // ---- POI discovery ---------------------------------------------------
    function entityPoiList() {
        var out = [];
        var seen = new Set();
        function add(e) {
            if (e && !seen.has(e) && e.script && e.script.cameraPoi) { seen.add(e); out.push(e); }
        }
        var src = manager.pois;
        if (src && src.length) for (var i = 0; i < src.length; i++) add(src[i]);
        if (!out.length) {
            var all = app.root.find(function (e) { return e.script && e.script.cameraPoi; });
            for (var j = 0; j < all.length; j++) add(all[j]);
        }
        return out;
    }

    function readId(cp, ent) {
        var id = cp.id;
        if ((id == null || id === "") && cp.core) id = cp.core.id;
        if (id == null || id === "") id = ent.name;
        return String(id);
    }

    function scanPois() {
        var ents = entityPoiList();
        var recs = [];
        var used = Object.create(null);
        st.byKey = Object.create(null);
        st.idKey = Object.create(null);
        st.entKey = new Map();
        for (var i = 0; i < ents.length; i++) {
            var ent = ents[i];
            var cp = ent.script.cameraPoi;
            var base = readId(cp, ent);
            var key = base;
            var n = 1;
            while (used[key]) { n++; key = base + "#" + n; }
            used[key] = true;
            var tgt = cp.camTargetEntity || (cp.camera && cp.camera.camTargetEntity) || ent;
            var look = cp.camLookAtEntity || (cp.camera && cp.camera.camLookAtEntity) || null;
            var p = tgt.getPosition();
            var yaw = null;
            if (look) {
                var l = look.getPosition();
                var dx = l.x - p.x, dz = l.z - p.z;
                if (dx * dx + dz * dz > 1e-8) yaw = yawFromDelta(dx, dz);
            }
            var rec = { key: key, id: base, ent: ent, cp: cp, x: p.x, y: p.y, z: p.z, yaw: yaw, enabled: true, useBack: true, out: [], locked: false, reason: "", isCur: false };
            recs.push(rec);
            st.byKey[key] = rec;
            if (!st.idKey[base]) st.idKey[base] = key;
            st.entKey.set(ent, key);
        }
        st.pois = recs;
    }

    function countNodes(root) {
        var n = 0;
        var stackN = [root];
        while (stackN.length) {
            var node = stackN.pop();
            n++;
            var ch = node.children;
            if (ch) for (var i = 0; i < ch.length; i++) stackN.push(ch[i]);
        }
        return n;
    }

    function structSignature() {
        var listed = manager.pois ? manager.pois.length : 0;
        return listed + ":" + countNodes(app.root);
    }

    function findFocusEnt() {
        try {
            var f = app.root.find(function (e) { return e.script && e.script.focusItemManager; });
            st.focusEnt = f && f.length ? f[0] : null;
        } catch (err) {
            st.focusEnt = null;
        }
    }

    // ---- live state ------------------------------------------------------
    function keyOfItem(item) {
        if (!item) return undefined;
        var k = item.entity ? st.entKey.get(item.entity) : undefined;
        if (k === undefined && item.poiEntity) k = st.entKey.get(item.poiEntity);
        if (k === undefined && item.id != null) k = st.idKey[String(item.id)];
        return k;
    }

    function readLive() {
        var nodes = Object.create(null);
        var bits = [];
        for (var i = 0; i < st.pois.length; i++) {
            var rec = st.pois[i];
            var cp = rec.cp;
            var en = cp.poiEnabled;
            if (en === undefined && cp.core) en = cp.core.poiEnabled;
            rec.enabled = en !== false;
            var ub = cp.useBackButton;
            if (ub === undefined && cp.backButton) ub = cp.backButton.useBackButton;
            rec.useBack = ub !== false;
            var out = [];
            var cps = cp.connectedPois;
            if (cps) {
                for (var j = 0; j < cps.length; j++) {
                    var c = cps[j];
                    var k = c && c.poiEntity ? st.entKey.get(c.poiEntity) : undefined;
                    if (k !== undefined) out.push(k);
                }
            }
            rec.out = out;
            nodes[rec.key] = { enabled: rec.enabled, useBack: rec.useBack, out: out };
            bits.push(rec.key + (rec.enabled ? "+" : "-") + (rec.useBack ? "b" : "") + ">" + out.join(","));
        }
        var cur = null;
        var ent = null;
        try { ent = typeof manager.getCurrentPoiEntity === "function" ? manager.getCurrentPoiEntity() : null; } catch (err) { ent = null; }
        var cpoi = manager.currentPoi;
        if (ent) cur = st.entKey.get(ent);
        if ((cur === undefined || cur === null) && cpoi) cur = keyOfItem(cpoi);
        if (cur === undefined) cur = null;
        var stack = [];
        var raw = manager.poiStack;
        var ok = true;
        if (raw && raw.length) {
            for (var s = 0; s < raw.length; s++) {
                var sk = keyOfItem(raw[s]);
                if (sk === undefined) { ok = false; break; }
                stack.push(sk);
            }
        }
        if (!ok) stack = cur !== null ? [cur] : [];
        var backMode = manager.backButtonMode === "fixed" ? "fixed" : "stack";
        st.graph = { nodes: nodes, backMode: backMode };
        st.cur = cur;
        st.stack = stack;
        st.moving = !!manager.moving;
        var sig = [cur, stack.join(","), st.moving ? 1 : 0, st.interactEnabled ? 1 : 0, backMode, bits.join(";")].join("|");
        var changed = sig !== st.liveSig;
        st.liveSig = sig;
        if (changed) {
            for (var r = 0; r < st.pois.length; r++) {
                var q = st.pois[r];
                q.isCur = q.key === cur;
                var reason = cur === null ? "current POI unknown" : explainLock(st.graph, stack, cur, q.key);
                q.reason = reason;
                q.locked = reason !== "" && reason !== "you are here";
            }
            st.dirty = true;
        }
        return changed;
    }

    function focusBusy() {
        var f = st.focusEnt && st.focusEnt.script && st.focusEnt.script.focusItemManager;
        return !!(f && (f.focusedOnItem || f.transitioning));
    }

    function gateReason() {
        if (manager.moving) return "the camera is moving";
        if (focusBusy()) return "an item is focused";
        if (st.interactEnabled === false) return "interactions are disabled";
        return "";
    }

    // ---- geometry --------------------------------------------------------
    function entName(ent) {
        var n = ent.name || "";
        if (ent.parent && ent.parent.name) n += " " + ent.parent.name;
        return n;
    }

    function scanGeometry() {
        var boxes = [];
        var comps = [];
        ["render", "model"].forEach(function (type) {
            try {
                var f = app.root.findComponents(type);
                if (f && f.length) for (var i = 0; i < f.length; i++) comps.push(f[i]);
            } catch (err) { /* component system absent in this build */ }
        });
        for (var ci = 0; ci < comps.length; ci++) {
            var comp = comps[ci];
            var ent = comp.entity;
            if (!ent || comp.enabled === false || ent.enabled === false) continue;
            var mis = comp.meshInstances;
            if (!mis && comp.model) mis = comp.model.meshInstances;
            if (!mis) continue;
            for (var mi = 0; mi < mis.length; mi++) {
                var inst2 = mis[mi];
                if (!inst2 || inst2.visible === false || inst2.skinInstance) continue;
                var bb = inst2.aabb;
                if (!bb || !bb.center || !bb.halfExtents) continue;
                var c = bb.center, he = bb.halfExtents;
                var w = 2 * he.x, h = 2 * he.y, d = 2 * he.z;
                if (!isFinite(w) || !isFinite(h) || !isFinite(d) || (w <= 0 && d <= 0)) continue;
                boxes.push({
                    name: entName(ent), w: w, h: h, d: d, cy: c.y,
                    x0: c.x - he.x, x1: c.x + he.x, z0: c.z - he.z, z1: c.z + he.z,
                    y0: c.y - he.y, y1: c.y + he.y, mi: inst2, kind: "", segs: null, triDone: false
                });
            }
        }
        var poiRects = st.pois.map(function (p) { return { x0: p.x, x1: p.x, z0: p.z, z1: p.z }; });
        boxes = dropBackdrops(boxes, poiRects);
        var eyeMin = Infinity, eyeMax = -Infinity, eyeSum = 0;
        st.pois.forEach(function (p) {
            if (p.y < eyeMin) eyeMin = p.y;
            if (p.y > eyeMax) eyeMax = p.y;
            eyeSum += p.y;
        });
        var eyeY = st.pois.length ? eyeSum / st.pois.length : 1.6;
        if (!isFinite(eyeMin)) { eyeMin = eyeY; eyeMax = eyeY; }
        st.eyeMin = eyeMin;
        st.eyeMax = eyeMax;
        var floors = [], walls = [], furn = [], tri = [];
        boxes.forEach(function (b) {
            b.kind = classifyBox(b, eyeY);
            if (b.kind === "floor") {
                if (b.y1 <= eyeMax + 0.1 && b.y1 >= eyeMin - 6) floors.push(b);
            } else if (b.kind === "wall") {
                if (b.y0 <= eyeMax + 0.3 && b.y1 >= eyeMin - 0.3) {
                    walls.push(b);
                    if (Math.min(b.w, b.d) >= 0.4 * Math.max(b.w, b.d)) tri.push(b);
                }
            } else if (b.kind === "furniture") {
                if (Math.max(b.w, b.d) >= 0.2 && b.y0 <= eyeMax && b.y1 >= eyeMin - 1.5) {
                    furn.push(b);
                    if (b.h > 1.5 && b.w > 3 && b.d > 3) tri.push(b);
                }
            }
        });
        furn.sort(function (a, b) { return b.w * b.d - a.w * a.d; });
        if (furn.length > 4000) furn.length = 4000;
        st.floors = floors;
        st.walls = walls;
        st.furn = furn;
        st.triBoxes = tri;
        st.geoVer++;
        recomputeBounds();
        startTrianglePass();
    }

    function recomputeBounds() {
        var rects = st.pois.map(function (p) { return { x0: p.x, x1: p.x, z0: p.z, z1: p.z }; });
        st.floors.concat(st.walls, st.triBoxes).forEach(function (b) {
            rects.push({ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1 });
        });
        st.bounds = fitBounds(rects, 0.08);
        st.dirty = true;
    }

    // Optional triangle pass: wall segments for room-sized single meshes.
    function startTrianglePass() {
        triToken++;
        var token = triToken;
        var queue = st.triBoxes.slice().sort(function (a, b) { return b.w * b.d - a.w * a.d; });
        var budget = 200000;
        var yLo = st.eyeMin - 0.3, yHi = st.eyeMax + 0.3;
        var work = null;

        function nextMesh() {
            while (queue.length) {
                var b = queue.shift();
                try {
                    var mesh = b.mi.mesh;
                    var node = b.mi.node;
                    if (!mesh || !node || typeof mesh.getPositions !== "function") continue;
                    var pos = [];
                    mesh.getPositions(pos);
                    var idx = [];
                    if (typeof mesh.getIndices === "function") mesh.getIndices(idx);
                    var tris = Math.floor((idx.length ? idx.length : pos.length / 3) / 3);
                    if (!tris || tris > budget) continue;
                    var wt = node.getWorldTransform();
                    var m = wt && wt.data ? wt.data : null;
                    if (!m || m.length < 16) continue;
                    budget -= tris;
                    return { box: b, pos: pos, idx: idx, m: m, tris: tris, at: 0, out: [] };
                } catch (err) {
                    // Vertex readback can be unavailable (GPU only buffers); keep the AABB drawing.
                    if (st.errors < 3) { st.errors++; console.info(LOG + "triangle pass unavailable for a mesh", err && err.message); }
                }
            }
            return null;
        }

        function step() {
            if (token !== triToken) return;
            try {
                if (!work) work = nextMesh();
                if (!work) return;
                var end = Math.min(work.tris, work.at + 20000);
                work.at = extractWallSegments(work.pos, work.idx, work.m, yLo, yHi, work.out, work.at, end);
                if (work.at >= work.tris) {
                    if (work.out.length) {
                        work.box.segs = work.out;
                        work.box.triDone = true;
                        st.geoVer++;
                        st.dirty = true;
                    }
                    work = null;
                }
            } catch (err) {
                work = null;
                if (st.errors < 3) { st.errors++; console.info(LOG + "triangle pass failed", err && err.message); }
            }
            later(step, 0);
        }
        later(step, 0);
    }

    function rescan() {
        scanPois();
        findFocusEnt();
        scanGeometry();
        st.structSig = structSignature();
        st.scanned = true;
        readLive();
    }

    // ---- panel -----------------------------------------------------------
    function ensurePanel() {
        if (st.panel) return;
        var c = document.createElement("canvas");
        c.id = "adventurer-minimap";
        c.style.position = "fixed";
        c.style.zIndex = "2147483647";
        c.style.pointerEvents = "auto";
        c.style.borderRadius = "8px";
        c.style.touchAction = "none";
        c.style.userSelect = "none";
        c.style.display = "none";
        st.panel = c;
        st.ctx = c.getContext("2d");
        st.staticCanvas = document.createElement("canvas");
        var stop = function (e) { e.stopPropagation(); };
        ["mousedown", "mouseup", "mouseover", "dblclick", "contextmenu", "wheel", "pointerdown", "pointerup", "pointermove", "touchstart", "touchmove", "touchend"].forEach(function (n) {
            c.addEventListener(n, stop);
        });
        c.addEventListener("click", function (e) {
            e.stopPropagation();
            var p = localPoint(e);
            onPanelClick(p.x, p.y);
        });
        c.addEventListener("mousemove", function (e) {
            e.stopPropagation();
            var p = localPoint(e);
            st.mouseX = p.x;
            st.mouseY = p.y;
            st.mouseIn = true;
            var tt = layoutTransform();
            var h = tt ? pickPoi(st.pois, tt, p.x, p.y, hitRadius()) : -1;
            if (h !== st.hover) { st.hover = h; c.style.cursor = h >= 0 && !st.pois[h].locked && !st.pois[h].isCur ? "pointer" : "default"; }
            st.dirty = true;
        });
        c.addEventListener("mouseleave", function () {
            st.mouseIn = false;
            st.hover = -1;
            st.dirty = true;
        });
        (document.body || document.documentElement).appendChild(c);
        layoutPanel();
    }

    function localPoint(e) {
        var r = st.panel.getBoundingClientRect ? st.panel.getBoundingClientRect() : { left: 0, top: 0, width: cfg.size, height: cfg.size };
        var k = r.width ? cfg.size / r.width : 1;
        return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    }

    function hitRadius() {
        return Math.max(9, cfg.size / 28);
    }

    function layoutPanel() {
        if (!st.panel) return;
        var s = st.panel.style;
        var size = cfg.size;
        s.width = size + "px";
        s.height = size + "px";
        s.top = "auto"; s.bottom = "auto"; s.left = "auto"; s.right = "auto";
        var m = "12px";
        if (cfg.position.charAt(0) === "t") s.top = m; else s.bottom = m;
        if (cfg.position.charAt(1) === "l") s.left = m; else s.right = m;
        dpr = window.devicePixelRatio || 1;
        st.panel.width = Math.round(size * dpr);
        st.panel.height = Math.round(size * dpr);
        st.staticCanvas.width = Math.round(size * dpr);
        st.staticCanvas.height = Math.round(size * dpr);
        st.staticKey = "";
        st.dirty = true;
    }

    function onCfg() {
        if (!cfg.enabled) {
            if (job) cancelJob("minimap disabled");
            if (st.panel) st.panel.style.display = "none";
            return;
        }
        if (!st.scanned) rescan();
        ensurePanel();
        st.panel.style.display = "";
        layoutPanel();
    }

    // ---- drawing ---------------------------------------------------------
    var C_BG = "rgba(10,12,18,0.78)";
    var C_FLOOR = "rgba(120,140,175,0.16)";
    var C_FURN = "rgba(170,180,200,0.10)";
    var C_WALL = "rgba(215,225,245,0.78)";
    var C_EDGE = "rgba(150,170,205,0.28)";
    var C_EDGE_LIVE = "rgba(110,230,170,0.65)";
    var C_OK = "#43e0a0";
    var C_LOCK = "#6b7280";
    var C_CUR = "#ffd54a";
    var C_ROUTE = "#ffb020";
    var C_CAM = "#ff6b6b";

    function renderStatic(t) {
        var key = [cfg.size, dpr, cfg.scale, Math.round(t.ox), Math.round(t.oz), t.s.toFixed(4), st.geoVer].join("|");
        if (key === st.staticKey) return;
        st.staticKey = key;
        var g = st.staticCanvas.getContext("2d");
        var size = cfg.size;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, size, size);
        function rect(b) {
            return [b.x0 * t.s + t.ox, b.z0 * t.s + t.oz, (b.x1 - b.x0) * t.s, (b.z1 - b.z0) * t.s];
        }
        g.fillStyle = C_FURN;
        st.furn.forEach(function (b) {
            if (b.triDone) return;
            var r = rect(b);
            g.fillRect(r[0], r[1], r[2], r[3]);
        });
        g.fillStyle = C_FLOOR;
        st.floors.forEach(function (b) {
            var r = rect(b);
            g.fillRect(r[0], r[1], r[2], r[3]);
        });
        g.fillStyle = C_WALL;
        g.strokeStyle = C_WALL;
        g.lineWidth = 1.2;
        st.walls.forEach(function (b) {
            if (b.triDone) return;
            var r = rect(b);
            if (Math.min(b.w, b.d) < 0.6) {
                g.fillRect(r[0], r[1], Math.max(r[2], 1.5), Math.max(r[3], 1.5));
            } else {
                g.strokeRect(r[0], r[1], r[2], r[3]);
            }
        });
        g.lineWidth = 1;
        g.beginPath();
        st.triBoxes.forEach(function (b) {
            if (!b.triDone || !b.segs) return;
            var sg = b.segs;
            for (var i = 0; i + 3 < sg.length; i += 4) {
                g.moveTo(sg[i] * t.s + t.ox, sg[i + 1] * t.s + t.oz);
                g.lineTo(sg[i + 2] * t.s + t.ox, sg[i + 3] * t.s + t.oz);
            }
        });
        g.stroke();
    }

    function sx(t, x) { return x * t.s + t.ox; }
    function sz(t, z) { return z * t.s + t.oz; }

    function camInfo() {
        try {
            var cam = manager.cameraEntity;
            if (!cam || typeof cam.getPosition !== "function") return null;
            var p = cam.getPosition();
            var f = cam.forward;
            var yaw = null;
            if (f && (f.x * f.x + f.z * f.z) > 1e-8) yaw = yawFromDelta(f.x, f.z);
            if (!isFinite(p.x) || !isFinite(p.z)) return null;
            return { x: p.x, z: p.z, yaw: yaw };
        } catch (err) {
            return null;
        }
    }

    function drawArrow(ctx, x, y, yaw, len) {
        var d = dirFromYaw(yaw);
        var ex = x + d.x * len, ey = y + d.z * len;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(ex, ey);
        var hx = -d.z, hy = d.x;
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - d.x * 3 + hx * 2.2, ey - d.z * 3 + hy * 2.2);
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - d.x * 3 - hx * 2.2, ey - d.z * 3 - hy * 2.2);
        ctx.stroke();
    }

    function routePoints(plan) {
        var pts = [];
        var start = st.byKey[st.cur];
        if (start) pts.push(start);
        plan.forEach(function (stp) {
            var r = st.byKey[stp.id];
            if (r) pts.push(r);
        });
        return pts;
    }

    function draw() {
        st.dirty = false;
        var ctx = st.ctx;
        var size = cfg.size;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = C_BG;
        ctx.fillRect(0, 0, size, size);
        var t = layoutTransform();
        st.t = t;
        if (!t) return;
        renderStatic(t);
        ctx.drawImage(st.staticCanvas, 0, 0, size, size);

        var nodes = st.graph.nodes;
        var curRec = st.byKey[st.cur];
        var R = Math.max(3.5, size / 60);

        // edges
        ctx.lineWidth = 1;
        ctx.strokeStyle = C_EDGE;
        ctx.beginPath();
        st.pois.forEach(function (p) {
            if (p === curRec) return;
            p.out.forEach(function (k) {
                var q = st.byKey[k];
                if (!q) return;
                ctx.moveTo(sx(t, p.x), sz(t, p.z));
                ctx.lineTo(sx(t, q.x), sz(t, q.z));
            });
        });
        ctx.stroke();
        if (curRec) {
            ctx.strokeStyle = C_EDGE_LIVE;
            ctx.beginPath();
            curRec.out.forEach(function (k) {
                var q = st.byKey[k];
                if (!q || !nodes[k] || !nodes[k].enabled) return;
                ctx.moveTo(sx(t, curRec.x), sz(t, curRec.z));
                ctx.lineTo(sx(t, q.x), sz(t, q.z));
            });
            ctx.stroke();
        }

        // route (running job, or hover preview)
        var routePlan = null;
        if (job) routePlan = job.plan;
        else if (st.hover >= 0 && st.cur !== null) {
            var hp = st.pois[st.hover];
            if (hp && !hp.isCur && !hp.locked) routePlan = planJump(st.graph, st.stack, st.cur, hp.key);
        }
        if (routePlan && routePlan.length) {
            var rp = routePoints(routePlan);
            ctx.strokeStyle = C_ROUTE;
            ctx.lineWidth = 2;
            if (ctx.setLineDash) ctx.setLineDash([4, 3]);
            ctx.beginPath();
            rp.forEach(function (p, i) {
                if (i === 0) ctx.moveTo(sx(t, p.x), sz(t, p.z)); else ctx.lineTo(sx(t, p.x), sz(t, p.z));
            });
            ctx.stroke();
            if (ctx.setLineDash) ctx.setLineDash([]);
            ctx.lineWidth = 1;
        }

        // POIs
        st.pois.forEach(function (p, i) {
            var x = sx(t, p.x), y = sz(t, p.z);
            if (x < -R || y < -R || x > size + R || y > size + R) return;
            var color = p.isCur ? C_CUR : (p.locked ? C_LOCK : C_OK);
            if (p.yaw !== null) {
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.4;
                drawArrow(ctx, x, y, p.yaw, R * 2.4);
            }
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, i === st.hover ? R * 1.25 : R, 0, Math.PI * 2);
            ctx.fill();
            if (p.isCur) {
                ctx.strokeStyle = "#ffffff";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(x, y, R * 1.9, 0, Math.PI * 2);
                ctx.stroke();
            } else if (i === st.hover) {
                ctx.strokeStyle = "#ffffff";
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(x, y, R * 1.7, 0, Math.PI * 2);
                ctx.stroke();
            }
        });
        ctx.lineWidth = 1;

        // live camera marker
        var cam = camInfo();
        if (cam) {
            var cx = sx(t, cam.x), cy = sz(t, cam.z);
            ctx.fillStyle = C_CAM;
            ctx.strokeStyle = C_CAM;
            ctx.beginPath();
            ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
            ctx.fill();
            if (cam.yaw !== null) { ctx.lineWidth = 1.2; drawArrow(ctx, cx, cy, cam.yaw, 8); ctx.lineWidth = 1; }
        }

        // status line
        var text = "";
        if (job) text = "Jumping " + Math.min(job.i + 1, job.plan.length) + "/" + job.plan.length + " (click or Esc cancels)";
        else if (st.statusTicks > 0) text = st.status;
        if (text) {
            ctx.font = "11px sans-serif";
            ctx.fillStyle = "rgba(0,0,0,0.6)";
            ctx.fillRect(0, size - 18, size, 18);
            ctx.fillStyle = "#ffffff";
            ctx.textBaseline = "middle";
            ctx.fillText(text, 6, size - 9);
        }

        // tooltip
        if (st.mouseIn && st.hover >= 0) {
            var hpoi = st.pois[st.hover];
            if (hpoi) {
                var lines = [hpoi.id];
                if (hpoi.isCur) lines.push("you are here");
                else if (hpoi.locked) lines.push("locked: " + hpoi.reason);
                else {
                    var busy = gateReason();
                    lines.push(busy ? "busy: " + busy : "click to jump");
                }
                ctx.font = "11px sans-serif";
                var wmax = 0;
                lines.forEach(function (l) { wmax = Math.max(wmax, ctx.measureText(l).width); });
                var bw = wmax + 10, bh = lines.length * 14 + 6;
                var bx = Math.min(size - bw - 2, Math.max(2, st.mouseX + 10));
                var by = Math.min(size - bh - 2, Math.max(2, st.mouseY + 12));
                ctx.fillStyle = "rgba(0,0,0,0.85)";
                ctx.fillRect(bx, by, bw, bh);
                ctx.fillStyle = "#ffffff";
                ctx.textBaseline = "top";
                lines.forEach(function (l, i) { ctx.fillText(l, bx + 5, by + 3 + i * 14); });
            }
        }
    }

    function layoutTransform() {
        var b = st.bounds;
        if (!b) return null;
        var cur = st.byKey[st.cur];
        return makeTransform(b, cfg.size, cfg.scale, cur ? { x: cur.x, z: cur.z } : null, 10);
    }

    // ---- input -----------------------------------------------------------
    function onPanelClick(x, y) {
        if (job) { cancelJob("cancelled by click"); return; }
        var tt = layoutTransform();
        if (!tt) return;
        var i = pickPoi(st.pois, tt, x, y, hitRadius());
        if (i < 0) return;
        var p = st.pois[i];
        readLive();
        if (p.isCur) { setStatus("you are already at " + p.id); return; }
        if (p.locked) { setStatus("locked: " + p.reason); return; }
        jumpTo(p.key);
    }

    function onKeyDown(e) {
        if (e && e.key === "Escape" && job) cancelJob("cancelled by Escape");
    }
    window.addEventListener("keydown", onKeyDown);

    // ---- jump state machine ----------------------------------------------
    function resolvePoi(idArg) {
        if (idArg == null) return null;
        var s = String(idArg);
        if (st.byKey[s]) return st.byKey[s];
        if (st.idKey[s]) return st.byKey[st.idKey[s]];
        for (var i = 0; i < st.pois.length; i++) if (st.pois[i].ent && st.pois[i].ent.name === s) return st.pois[i];
        return null;
    }

    function fail(msg) {
        console.info(LOG + msg);
        setStatus(msg);
        return { ok: false, reason: msg };
    }

    function clearJobTimer() {
        if (job && job.timer) { clearTimeout(job.timer); job.timer = null; }
    }

    function cancelJob(why) {
        if (!job) return;
        clearJobTimer();
        job = null;
        console.info(LOG + "jump " + why);
        setStatus("jump " + why);
    }

    function abortJob(why) {
        clearJobTimer();
        job = null;
        console.warn(LOG + "jump aborted: " + why);
        setStatus("jump aborted: " + why, 50);
    }

    function finishJob() {
        clearJobTimer();
        job = null;
        setStatus("arrived", 15);
    }

    function hopValid(step) {
        var g = st.graph, N = g.nodes, cur = st.cur;
        if (cur === null || !N[cur] || !N[step.id]) return false;
        if (step.kind === "forward") return N[cur].out.indexOf(step.id) >= 0 && N[step.id].enabled;
        if (g.backMode !== "stack") return false;
        var s = st.stack;
        if (s.length < 2 || s[s.length - 1] !== cur || s[s.length - 2] !== step.id) return false;
        return N[step.id].enabled && N[step.id].out.indexOf(cur) >= 0 && N[cur].useBack !== false;
    }

    function runNext() {
        var j = job;
        if (!j) return;
        j.timer = null;
        try { readLive(); } catch (err) { return abortJob("could not read POI state: " + (err && err.message)); }
        if (j.i > 0) {
            var want = j.plan[j.i - 1].id;
            if (st.cur !== want) return abortJob("landed on " + st.cur + " instead of " + want);
        }
        if (j.i >= j.plan.length) return finishJob();
        var gate = gateReason();
        if (gate) {
            j.grace++;
            if (j.grace > 40) return abortJob("still blocked: " + gate);
            j.timer = later(runNext, 50);
            return;
        }
        j.grace = 0;
        var step = j.plan[j.i];
        if (!hopValid(step)) return abortJob("route changed, " + step.id + " is no longer reachable");
        j.awaiting = true;
        j.hopSeen = false;
        j.completed = false;
        j.firing = true;
        try {
            if (step.kind === "forward") st.byKey[step.id].ent.fire("interactable:mouseUp");
            else app.fire("cameraPoi:backButtonClicked");
        } catch (err) {
            j.firing = false;
            j.awaiting = false;
            return abortJob("hop threw: " + (err && err.message));
        }
        j.firing = false;
        if (job !== j) return;
        if (!j.hopSeen) {
            j.awaiting = false;
            return abortJob("the game rejected the hop to " + step.id);
        }
        if (!j.completed) {
            j.timer = later(function () {
                if (job !== j) return;
                j.awaiting = false;
                abortJob("timed out waiting for camera:moveComplete (hop to " + step.id + ")");
            }, cfg.hopTimeoutMs);
        }
    }

    function onMoveRequested() {
        st.dirty = true;
        if (!job) return;
        if (job.firing) job.hopSeen = true;
        else abortJob("the camera was moved by something else");
    }

    function onMoveComplete() {
        st.dirty = true;
        var j = job;
        if (!j || !j.awaiting || !j.hopSeen) return;
        j.awaiting = false;
        j.completed = true;
        clearJobTimer();
        j.i++;
        j.timer = later(runNext, 40);
    }

    function jumpTo(idArg) {
        var rec = resolvePoi(idArg);
        if (!rec) return fail("unknown POI: " + idArg);
        if (job) return fail("a jump is already running");
        if (!st.scanned) rescan(); else readLive();
        if (st.cur === null) return fail("current POI is unknown");
        var gate = gateReason();
        if (gate) return fail("busy: " + gate);
        var plan = planJump(st.graph, st.stack, st.cur, rec.key);
        if (plan === null) return fail("no enabled route to " + rec.id);
        if (plan.length === 0) return fail("already at " + rec.id);
        job = { plan: plan, i: 0, target: rec.key, awaiting: false, firing: false, hopSeen: false, completed: false, timer: null, grace: 0 };
        setStatus("jumping to " + rec.id + " (" + plan.length + (plan.length === 1 ? " hop)" : " hops)"), 1000);
        runNext();
        return { ok: true, hops: plan.length, plan: plan.map(function (p) { return { kind: p.kind, id: p.id }; }) };
    }

    // ---- events (observe only) ---------------------------------------------
    function on(name, fn) {
        app.on(name, fn);
        listeners.push([name, fn]);
    }
    function dirtyLive() { st.dirty = true; st.liveSig = ""; }
    on("camera:moveRequested", onMoveRequested);
    on("camera:moveComplete", onMoveComplete);
    on("camera:initialSetup", dirtyLive);
    on("cameraPoiManager:currentPoiUpdated", dirtyLive);
    on("cameraPoi:attributesChanged", dirtyLive);
    on("interactables:enabled", function (v) { st.interactEnabled = v !== false && !!v; st.dirty = true; });

    // ---- tick ------------------------------------------------------------
    function tick() {
        if (!cfg.enabled) return;
        if (typeof document !== "undefined" && document.hidden) return;
        st.tick++;
        if (st.statusTicks > 0 && !job) { st.statusTicks--; if (st.statusTicks === 0) st.dirty = true; }
        if (st.tick % 20 === 0) {
            var sig = structSignature();
            if (sig !== st.structSig) rescan();
        }
        readLive();
        var cam = camInfo();
        var camSig = cam ? cam.x.toFixed(2) + "," + cam.z.toFixed(2) + "," + (cam.yaw === null ? "" : cam.yaw.toFixed(2)) : "";
        if (camSig !== st.camSig) { st.camSig = camSig; st.dirty = true; }
        if (st.dirty && st.panel) draw();
    }

    var tickTimer = setInterval(function () {
        try { tick(); } catch (err) {
            if (st.errors < 5) { st.errors++; console.warn(LOG + "tick failed", err); }
        }
    }, 100);

    function destroy() {
        clearInterval(tickTimer);
        window.removeEventListener("keydown", onKeyDown);
        triToken++;
        if (job) cancelJob("destroyed");
        listeners.forEach(function (l) { try { app.off(l[0], l[1]); } catch (err) { /* app already torn down */ } });
        listeners = [];
        if (st.panel && st.panel.parentNode) st.panel.parentNode.removeChild(st.panel);
        st.panel = null;
    }

    var api = {
        onCfg: onCfg,
        destroy: destroy,
        jumpTo: jumpTo,
        cancel: function () { cancelJob("cancelled"); },
        tick: tick,
        draw: function () { if (st.panel) draw(); },
        rescan: rescan,
        st: st,
        job: function () { return job; }
    };

    window.__adventurerMinimap = {
        setEnabled: function (b) { applyCfg({ enabled: !!b }); },
        jumpTo: function (id) { return jumpTo(id); },
        cancel: function () { cancelJob("cancelled"); },
        destroy: destroy,
        state: function () {
            if (!st.scanned) { try { rescan(); } catch (err) { console.warn(LOG + "scan failed", err); } }
            readLive();
            return {
                installed: true,
                enabled: cfg.enabled,
                size: cfg.size,
                position: cfg.position,
                scale: cfg.scale,
                current: st.cur,
                stack: st.stack.slice(),
                moving: st.moving,
                interactEnabled: st.interactEnabled,
                gate: gateReason(),
                job: job ? { target: job.target, index: job.i, plan: job.plan.map(function (p) { return { kind: p.kind, id: p.id }; }) } : null,
                bounds: st.bounds,
                geometry: {
                    floors: st.floors.length,
                    walls: st.walls.length,
                    furniture: st.furn.length,
                    wallSegments: st.triBoxes.reduce(function (n, b) { return n + (b.segs ? b.segs.length / 4 : 0); }, 0)
                },
                pois: st.pois.map(function (p) {
                    return { id: p.key, x: p.x, y: p.y, z: p.z, yaw: p.yaw, enabled: p.enabled, out: p.out.slice(), locked: p.locked, reason: p.reason, current: p.isCur };
                })
            };
        }
    };

    console.info(LOG + "installed (" + manager.pois.length + " POIs).");
    if (cfg.enabled) onCfg();
    return api;
}

boot();
`;

const HELPER_NAMES = [
    "classifyBox", "planJump", "explainLock", "fitBounds", "makeTransform",
    "pickPoi", "dropBackdrops", "yawFromDelta", "dirFromYaw", "extractWallSegments"
] as const;

interface MinimapHelpers {
    classifyBox(b: MinimapBox, eyeY?: number | null): MinimapBoxKind;
    planJump(graph: MinimapGraph, stack: string[], currentId: string, targetId: string): JumpStep[] | null;
    explainLock(graph: MinimapGraph, stack: string[], currentId: string, targetId: string): string;
    fitBounds(rects: { x0: number; z0: number; x1: number; z1: number; }[], padFrac?: number): MinimapBounds | null;
    makeTransform(bounds: MinimapBounds, px: number, zoom?: number, center?: { x: number; z: number; } | null, margin?: number): MinimapTransform;
    pickPoi(pts: { x: number; z: number; }[], t: MinimapTransform, mx: number, my: number, r: number): number;
    dropBackdrops<T extends { w: number; d: number; }>(boxes: T[], poiRects: { x0: number; z0: number; x1: number; z1: number; }[]): T[];
    yawFromDelta(dx: number, dz: number): number;
    dirFromYaw(yaw: number): { x: number; z: number; };
    extractWallSegments(pos: ArrayLike<number>, idx: ArrayLike<number> | null, m: ArrayLike<number>, yLo: number, yHi: number, out: number[], triStart: number, triEnd: number): number;
}

let helperCache: MinimapHelpers | null = null;

// Compiled lazily from the same text that is injected, so no second copy exists.
// new Function is only reached when a caller actually uses one of the helpers.
function helpers(): MinimapHelpers {
    if (!helperCache) {
        helperCache = new Function(HELPERS_SRC + "\nreturn {" + HELPER_NAMES.join(",") + "};")() as MinimapHelpers;
    }
    return helperCache;
}

export function planJump(graph: MinimapGraph, stack: string[], currentId: string, targetId: string): JumpStep[] | null {
    return helpers().planJump(graph, stack, currentId, targetId);
}

export function classifyBox(b: MinimapBox, eyeY?: number | null): MinimapBoxKind {
    return helpers().classifyBox(b, eyeY);
}

export function explainLock(graph: MinimapGraph, stack: string[], currentId: string, targetId: string): string {
    return helpers().explainLock(graph, stack, currentId, targetId);
}

export function fitBounds(rects: { x0: number; z0: number; x1: number; z1: number; }[], padFrac?: number): MinimapBounds | null {
    return helpers().fitBounds(rects, padFrac);
}

export function makeTransform(bounds: MinimapBounds, px: number, zoom?: number, center?: { x: number; z: number; } | null, margin?: number): MinimapTransform {
    return helpers().makeTransform(bounds, px, zoom, center, margin);
}

export function buildMinimapScript(opts: MinimapOptions): string {
    const safe = {
        enabled: !!opts.enabled,
        size: Number.isFinite(opts.size) ? opts.size : 220,
        position: opts.position,
        scale: opts.scale
    };
    const json = JSON.stringify(safe);
    const glue = GLUE_SRC.replace("__OPTS__", () => json);
    return "(function () {\n"
        + "    if (window.__adventurerMinimapBooting) return;\n"
        + "    window.__adventurerMinimapBooting = true;\n"
        + HELPERS_SRC
        + glue
        + "\n})();";
}
