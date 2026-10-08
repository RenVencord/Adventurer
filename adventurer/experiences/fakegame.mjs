// Test helper (not a test): a small fake PlayCanvas game whose script types are real code, shaped like the VALORANT Aces
// activity. Used by source.test.mjs and completion.test.mjs for end to end checks of the script source analysis and the
// guessed-recipe fallback: the analysis reads the very function texts below and the game then really runs them when the
// runner fires events.
//
// The chain (the same as the verified Aces chain of completion.test.mjs, written as script methods):
//   select:play  -> experienceSelect._onPlay     fires transition:play and shot:restart
//   shot:fire    -> shotScore._onFire            fires shot:hit
//   shot:complete-> shotScore._onComplete        fires run:complete (payload built from the shot payload)
//   run:complete -> runHistory._onComplete -> record: remembers the level as completed, fires run:recorded and
//                   leaderboard:submit
//   run:recorded -> ariseRewards._onRecord       a thin wrapper around a closure the source cannot show; the closure runs
//                   _onRun, which fires arise:questComplete only when runHistory._levels[level].completed is set (read
//                   through the lookup helper _history()) and the quest was not announced yet
//   leaderboard:submit -> ariseLeaderboard._onSubmit  posts to the arise bridge
//   ariseRewards.update reports a queued quest through the bridge
export const ACES_SCRIPTS = {
    experienceSelect: {
        initialize: "function(){this.app.on('select:play',this._onPlay,this)}",
        _onPlay: "function(t){this.app.fire('transition:play'),this.app.fire('shot:restart')}"
    },
    shotScore: {
        initialize: "function(){this._tally=0,this.app.on('shot:fire',this._onFire,this),this.app.on('shot:complete',this._onComplete,this)}",
        _onFire: "function(t){t&&t.hit&&(this._tally+=1,this.app.fire('shot:hit',{zone:t.zone}))}",
        _onComplete: "function(t){var e=this._build(t);this.app.fire('run:complete',e)}",
        _build: "function(t){return{total:Number(t&&t.total)||0,kills:Number(t&&t.kills)||0,ace:!!(t&&t.ace)}}"
    },
    runHistory: {
        initialize: "function(){this._levels={},this.active=!0,this.app.on('run:complete',this._onComplete,this)}",
        _onComplete: "function(t){this.active&&t&&this.record(t)}",
        record: "function(t){var e=this._toRecord(t);if(!e)return null;return this._remember(e.levelId,e.total,!0),"
            + "this.app.fire('run:recorded',e),this.app.fire('leaderboard:submit',e),e}",
        _toRecord: "function(t){var e=Number(t.total);return isFinite(e)?{levelId:String(t.levelId||'ace:03'),total:Math.round(e),"
            + "ace:!!t.ace,kills:Number(t.kills)||0}:null}",
        _remember: "function(t,e,s){return this._levels[t]={played:!0,completed:!!s,best:e},!0}"
    },
    ariseRewards: {
        initialize: "function(){this._done=!1,this._due=!1,this.app.on('run:recorded',this._onRecord,this)}",
        _onRecord: "function(){if(canUseAccount(this))return s.apply(this,arguments)}",
        _onRun: "function(e){var h=this._history();h&&h._levels&&h._levels[e.levelId]&&!0===h._levels[e.levelId].completed&&!this._done&&this._queueQuestCompletion(e)}",
        _history: "function(){return this.entity.script.runHistory}",
        _queueQuestCompletion: "function(e){this._complete(e)}",
        _complete: "function(e){this._done=!0,this._due=!0,this.app.fire('arise:questComplete',{runs:1,levelId:e.levelId})}",
        update: "function(t){if(this._due){this._due=!1,window.arise.postMessage({type:'quest:report'})}}"
    },
    ariseLeaderboard: {
        initialize: "function(){this.app.on('leaderboard:submit',this._onSubmit,this)}",
        _onSubmit: "function(e){window.arise.postMessage({type:'leaderboard:submit',record:e})}"
    }
};

// The same chain without any state of another script: ariseRewards fires the goal on run:recorded unconditionally, so the
// analysis has nothing to verify and every entry is usable (closest to the goal first).
export const NO_GUARD_SCRIPTS = {
    experienceSelect: {
        initialize: "function(){this.app.on('select:play',this._onPlay,this)}",
        _onPlay: "function(t){this.app.fire('shot:restart')}"
    },
    runHistory: {
        initialize: "function(){this.app.on('run:complete',this._onComplete,this)}",
        _onComplete: "function(t){t&&this.app.fire('run:recorded',{levelId:String(t.levelId||'')})}"
    },
    ariseRewards: {
        initialize: "function(){this.app.on('run:recorded',this._onRecord,this)}",
        _onRecord: "function(e){this.app.fire('arise:questComplete',{id:e.levelId})}",
        update: "function(){window.arise.postMessage({})}"
    }
};

// The goal path reads state of runHistory (_levels[].completed) that no event writes: nothing can be verified, so no
// entry may be used by the completion runner (the full guess is still reported).
export const UNVERIFIABLE_SCRIPTS = {
    experienceSelect: {
        initialize: "function(){this.app.on('select:play',this._onPlay,this)}",
        _onPlay: "function(){this.app.fire('shot:restart')}"
    },
    runHistory: {
        initialize: "function(){this._levels={},this.app.on('run:complete',this._onComplete,this)}",
        _onComplete: "function(t){this.app.fire('run:recorded',{levelId:'a'})}"
    },
    ariseRewards: {
        initialize: "function(){this.app.on('run:recorded',this._onRecord,this)}",
        _onRecord: "function(e){var h=this._history();h&&h._levels&&h._levels[e.levelId]&&!0===h._levels[e.levelId].completed&&this.app.fire('arise:questComplete')}",
        _history: "function(){return this.entity.script.runHistory}",
        update: "function(){window.arise.postMessage({})}"
    }
};

// A PlayCanvas style event handler: listeners live in _callbacks (Map: name -> [{callback, scope}]).
class EventHandler {
    constructor() { this._callbacks = new Map(); }
    on(name, callback, scope = this) {
        if (!this._callbacks.has(name)) this._callbacks.set(name, []);
        this._callbacks.get(name).push({ callback, scope, name });
        return this;
    }
    fire(name, ...args) {
        for (const h of (this._callbacks.get(name) || []).slice()) h.callback.call(h.scope, ...args);
        return this;
    }
}

class GameApp extends EventHandler {
    constructor(trace) { super(); this._trace = trace; }
    fire(name, ...args) {
        this._trace.push(name);
        return super.fire(name, ...args);
    }
}

class Entity extends EventHandler {
    constructor(name, guid) {
        super();
        this.name = name;
        this._guid = guid;
        this.children = [];
        this.enabled = true;
        this.script = { scripts: [] };
        this.tags = { list: () => [] };
    }
    getGuid() { return this._guid; }
}

const ScriptTypeProto = { initScriptType() { }, initEventHandler() { } };

/**
 * opts: { accountOk (default true), scripts (replacement ACES_SCRIPTS), scene, arise (replacement bridge) }. The sources
 * reach the bridge through window.arise, which is game.arise. Returns the game with counters and helpers.
 */
export function makeAcesGame(opts = {}) {
    const trace = [];
    const app = new GameApp(trace);
    const root = new Entity("Root", "g-root");
    const director = new Entity("Shot Director", "g-director");
    root.children.push(director);
    app.root = root;
    app.scene = { name: opts.scene ?? "GlobalAces_MASTER" };
    const game = {
        app, root, director, trace, bridge: [], calls: [], types: {}, instances: {},
        count: name => trace.filter(n => n === name).length,
        play: () => app.fire("select:play", { cardInfo: {} }),
        shoot: () => app.fire("shot:fire", { hit: true, zone: "head" }),
        // the update loop of ariseRewards reports a queued quest through the bridge
        tick() { for (const inst of director.script.scripts) if (typeof inst.update === "function") inst.update(0.016); }
    };
    const win = { arise: opts.arise ?? { postMessage(m) { game.bridge.push(m); } } };
    game.arise = win.arise;
    const scripts = opts.scripts ?? ACES_SCRIPTS;
    const canUseAccount = () => opts.accountOk !== false;
    // a script type with its methods compiled from source; the hidden closure behind ariseRewards._onRecord calls _onRun
    const defineType = (name, methods) => {
        const ctor = function () { };
        ctor.__name = name;
        ctor.prototype = Object.create(ScriptTypeProto);
        const s = function (...args) { return this._onRun(...args); };
        for (const [m, src] of Object.entries(methods)) {
            const fn = new Function("s", "canUseAccount", "window", "return (" + src + ")")(s, canUseAccount, win);
            Object.defineProperty(ctor.prototype, m, { value: fn, writable: true, configurable: true, enumerable: true });
        }
        game.types[name] = ctor;
        return ctor;
    };
    // an instance of a type on the director, reachable as entity.script.<name> like in PlayCanvas
    const instantiate = name => {
        const ctor = game.types[name];
        const inst = Object.create(ctor.prototype);
        inst.__scriptType = ctor;
        inst.__attributes = {};
        inst._enabled = true;
        inst.app = app;
        inst.entity = director;
        director.script[name] = inst;
        director.script.scripts.push(inst);
        game.instances[name] = inst;
        return inst;
    };
    // a script type that appears later (a lazily loaded part of the game): defined, instantiated and initialized
    game.addScript = (name, methods) => {
        defineType(name, methods);
        const inst = instantiate(name);
        if (typeof inst.initialize === "function") inst.initialize();
        return inst;
    };
    for (const [name, methods] of Object.entries(scripts)) defineType(name, methods);
    for (const name of Object.keys(scripts)) instantiate(name);
    for (const name of Object.keys(scripts)) {
        if (typeof game.instances[name].initialize === "function") game.instances[name].initialize();
    }
    return game;
}

// ---------------------------------------------------------------------------------------------------------------
// A big synthetic game for load tests: script types with many methods of minified looking code (registrations, events,
// state reads and writes, foreign reads, closures). Seeded, so every run reads the same sources. Returns a spec in the
// format of makeWorld in source.test.mjs: { scene, scripts, entities, listeners }.
// ---------------------------------------------------------------------------------------------------------------
export function makeBigSpec({ types = 92, methods = 18, length = 500, huge = 0, hugeLength = 60000, instances = 1, seed = 12345 } = {}) {
    let state = seed >>> 0;
    const rnd = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const pick = a => a[Math.floor(rnd() * a.length)];
    const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const letters = "tesnrioabcdl";
    const names = ["score", "kills", "total", "zone", "hit", "id", "pos", "alpha", "level", "name", "state", "queue", "items", "cache", "timer"];
    const typeNames = Array.from({ length: types }, (_, i) => "type" + i);
    const statement = () => {
        const n = pick(names), o = pick(names), t = pick(typeNames);
        switch (ri(0, 17)) {
            case 0: return "this.app.on('ev:" + ri(0, 400) + "',this._m" + ri(0, 25) + ",this)";
            case 1: return "this.app.fire('e:" + ri(0, 400) + "',{" + n + ":t." + o + "," + o + ":!!t." + n + "})";
            case 2: return "this." + n + "=t." + o + "||0";
            case 3: return "this._" + n + ".push(t." + o + ")";
            case 4: return "this._" + n + "[t.id]={" + n + ":!0," + o + ":Number(t." + n + ")}";
            case 5: return "var " + letters[ri(0, 11)] + "=Math.max(0,Math.min(1,(t." + n + "-this.lo)/(this.hi-this.lo)))";
            case 6: return "if(/^\\d+$/.test(String(t." + n + ")))this._m" + ri(0, 25) + "(t)";
            case 7: return "for(var i=0;i<this._" + n + ".length;i++){var r=this._" + n + "[i];r&&r." + o + "&&(r." + o + "+=t." + n + ")}";
            case 8: return "this.count+=1,this." + n + "=this." + n + "?this." + n + ":'" + n + "'";
            case 9: return "var s=this.entity.script." + t + ";s&&s._" + n + "&&s._" + n + "[t." + o + "]&&s.go(t)";
            case 10: return "this.entity.fire('x:" + ri(0, 99) + "',t)";
            case 11: return "this._" + n + "=function(e){return e." + o + "*2+(e." + n + "||0)}";
            case 12: return "this." + n + "=this._m" + ri(0, 25) + ".bind(this)";
            case 13: return "'number'==typeof t." + n + "&&(this." + o + "=t." + n + ")";
            case 14: return "var u=this.app,c=this.entity;u.fire('q:" + ri(0, 50) + "'),c.fire('r:" + ri(0, 50) + "')";
            case 15: return "this._" + n + "?this._" + n + ".forEach(function(e){e." + o + "&&e." + o + "()}):null";
            case 16: return "document.querySelector('.cls-" + ri(0, 99) + "')&&(this." + n + "=1)";
            default: return "this._m" + ri(0, 25) + "(t,'" + n + "')";
        }
    };
    const method = len => {
        const parts = [];
        for (let size = 0; size < len;) { const s = statement(); parts.push(s); size += s.length + 1; }
        return "function(t,e){" + parts.join(";") + "}";
    };
    const scripts = {}, entities = [];
    for (let i = 0; i < types; i++) {
        const body = {};
        const count = ri(Math.max(2, methods - 12), methods + 12);
        for (let m = 0; m < count; m++) body["_m" + m] = method(ri(Math.floor(length / 3), length * 2));
        body.initialize = method(i < huge ? hugeLength : length * 2);
        body.update = "function(t){this._m0(t)}";
        scripts[typeNames[i]] = { methods: body };
        for (let k = 0; k < instances; k++) entities.push({ name: "E" + i + "_" + k, guid: "g" + i + "_" + k, scripts: [{ name: typeNames[i], attrs: {} }] });
    }
    return { scene: "Big", scripts, entities, listeners: [] };
}
