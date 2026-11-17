/*
 * Adventurer: in-activity quest event recording and causal classification (recorder.ts)
 *
 * Rules:
 *  - Only erasable TypeScript syntax (Node can import directly).
 *  - Self-contained, genuine logic, zero hardcoded outcomes.
 *  - No em-dash or en-dash characters in string literals or comments.
 */

import type {
    AdvRecipeFile,
    CompletionRecipe,
    RecipeEntry
} from "./recipe.ts";
import {
    isLeaderboard,
    isArise,
    sanitizeArgs,
    validateRecipe
} from "./recipe.ts";

export type RecorderState = "idle" | "recording" | "completed" | "stopped";

export interface RecordedEvent {
    id: number;
    parentId: number | null;
    timestamp: number;
    scope: "app" | "entity" | "arise";
    name: string;
    args: unknown[];
    isProgress?: boolean;
    isGoal?: boolean;
}

export interface RecorderOptions {
    appId?: string;
    scene?: string;
    name?: string;
    maxEvents?: number;
    onComplete?: (recipe: AdvRecipeFile) => void;
    onStateChange?: (state: RecorderState) => void;
}

export const ENGINE_NOISE_EVENTS: ReadonlySet<string> = new Set([
    "update", "postupdate", "frameupdate", "frame:update", "app:tick", "tick",
    "render", "prerender", "postrender", "prerender:frame", "postrender:frame", "framerender", "frameend",
    "physics:update", "physics:postupdate", "collisionstart", "collisionend", "contact",
    "mouse:move", "mousemove", "touch:move", "touchmove", "pointermove",
    "mouse:wheel", "wheel", "pointerhover",
    "sound:update", "audio:tick", "sfx", "asset:load", "asset:progress", "loader:progress",
    "camera:prerender", "camera:postrender", "camera:move", "camera:pan"
]);

export const EXTRANEOUS_RE = /^(cosmetic|skin|inspect|camera|cam:|set:dim|glass:|console:lamp|pause|resume|settings|audio|volume|preview|side|optional)/i;

export class QuestEventRecorder {
    public appId: string;
    public scene: string;
    public name: string;
    public state: RecorderState = "idle";
    public events: RecordedEvent[] = [];
    public eventIdSeq: number = 0;
    public maxEvents: number;
    public verifiedCompletion: boolean = false;
    public onComplete: ((recipe: AdvRecipeFile) => void) | null = null;
    public onStateChange: ((state: RecorderState) => void) | null = null;

    private _callStack: number[] = [];

    constructor(options: RecorderOptions = {}) {
        this.appId = options.appId || "unknown";
        this.scene = options.scene || "";
        this.name = options.name || "";
        this.maxEvents = options.maxEvents || 5000;
        this.onComplete = options.onComplete || null;
        this.onStateChange = options.onStateChange || null;
    }

    public start(): void {
        if (this.state === "recording") return;
        this.state = "recording";
        this.events = [];
        this.eventIdSeq = 0;
        this._callStack = [];
        this.verifiedCompletion = false;
        this.notifyState();
    }

    public stop(): void {
        if (this.state === "recording") {
            this.state = "stopped";
            this.verifiedCompletion = false;
            this.notifyState();
        }
    }

    public reset(): void {
        this.state = "idle";
        this.events = [];
        this.eventIdSeq = 0;
        this._callStack = [];
        this.verifiedCompletion = false;
        this.notifyState();
    }

    private notifyState(): void {
        if (this.onStateChange) {
            try { this.onStateChange(this.state); } catch {}
        }
    }

    public isNoise(name: string): boolean {
        if (!name || typeof name !== "string") return true;
        return ENGINE_NOISE_EVENTS.has(name.toLowerCase());
    }

    public recordAppFire(name: string, ...args: unknown[]): void {
        try {
            if (this.state !== "recording") return;
            if (this.isNoise(name)) return;

            if (this.events.length >= this.maxEvents) {
                this.events.shift();
            }

            const id = ++this.eventIdSeq;
            const parentId = this._callStack.length > 0
                ? this._callStack[this._callStack.length - 1]
                : (this.events.length > 0 ? this.events[this.events.length - 1].id : null);

            const record: RecordedEvent = {
                id,
                parentId,
                timestamp: Date.now(),
                scope: "app",
                name,
                args: args || []
            };

            this.events.push(record);

            const lower = name.toLowerCase();
            if (lower === "arise:questcomplete" || lower === "quest:completed" || lower.endsWith(":questcomplete")) {
                record.isGoal = true;
                this.handleCompletion(name);
            }
        } catch {
            // Swallow internal recorder exceptions without crashing game (T2_F4_02)
        }
    }

    public recordArisePostMessage(payload: unknown): void {
        try {
            if (this.state !== "recording") return;

            let type = "";
            if (typeof payload === "string") {
                type = payload;
                try {
                    if (payload.startsWith("{")) {
                        const parsed = JSON.parse(payload);
                        type = parsed.type || parsed.event || parsed.cmd || type;
                    }
                } catch {}
            } else if (payload && typeof payload === "object") {
                const p = payload as Record<string, unknown>;
                type = String(p.type || p.event || p.cmd || "");
            }

            if (type === "quest-completed") {
                this.handleCompletion("quest-completed");
            } else if (type === "quest-progress") {
                if (this.events.length >= this.maxEvents) {
                    this.events.shift();
                }
                const id = ++this.eventIdSeq;
                this.events.push({
                    id,
                    parentId: this.events.length > 0 ? this.events[this.events.length - 1].id : null,
                    timestamp: Date.now(),
                    scope: "arise",
                    name: "quest-progress",
                    args: [payload],
                    isProgress: true
                });
            }
        } catch {
            // Swallow internal recorder exceptions without crashing game
        }
    }

    public handleCompletion(goalEvent: string): void {
        if (this.state === "completed") return; // Idempotent (T2_F6_05)
        this.state = "completed";
        this.verifiedCompletion = true;
        this.notifyState();

        const recipe = this.deriveAdvRecipe(goalEvent);
        if (this.onComplete) {
            try { this.onComplete(recipe); } catch {}
        }

        // Notify frames
        if (typeof window !== "undefined") {
            try {
                window.postMessage({ type: "RECIPE_RECORDING_COMPLETED", recipe }, "*");
                if (window.top && window.top !== window) {
                    window.top.postMessage({ type: "RECIPE_RECORDING_COMPLETED", recipe }, "*");
                }
            } catch {}
        }
    }

    public deriveAdvRecipe(goalName: string = "arise:questComplete"): AdvRecipeFile {
        const requiredIds = new Set<number>();
        const optionalNames = new Set<string>();

        // 1. Identify goal and progress anchors
        for (const ev of this.events) {
            const lower = ev.name.toLowerCase();
            if (lower === goalName.toLowerCase() || lower === "quest-completed" || ev.isProgress || ev.isGoal) {
                requiredIds.add(ev.id);
                if (ev.parentId !== null) requiredIds.add(ev.parentId);
            }
        }

        // 2. Back-trace parents
        for (let i = this.events.length - 1; i >= 0; i--) {
            const ev = this.events[i];
            if (requiredIds.has(ev.id) && ev.parentId !== null) {
                requiredIds.add(ev.parentId);
            }
        }

        // 3. Classify required vs optional entries
        const hasRequired = requiredIds.size > 0;
        const requiredEvents: RecordedEvent[] = [];
        for (const ev of this.events) {
            const lower = ev.name.toLowerCase();
            if (lower === goalName.toLowerCase() || lower === "quest-completed") continue;
            if (ev.scope === "arise" || isLeaderboard(ev.name) || isArise(ev.name)) continue;

            const isExtraneous = EXTRANEOUS_RE.test(ev.name);
            if ((requiredIds.has(ev.id) || !hasRequired) && !isExtraneous) {
                requiredEvents.push(ev);
            } else {
                optionalNames.add(ev.name);
            }
        }

        // 4. Determine trigger
        let trigger = "select:play";
        const playEv = this.events.find(e => e.name.toLowerCase().includes("play") && !isLeaderboard(e.name));
        if (playEv) {
            trigger = playEv.name;
        } else if (requiredEvents.length > 0) {
            trigger = requiredEvents[0].name;
        }

        // 5. Build sanitized entries
        const entries: RecipeEntry[] = requiredEvents.map(e => {
            const { sanitized } = sanitizeArgs(e.args || []);
            return {
                name: e.name,
                scope: e.scope === "entity" ? "entity" : "app",
                args: sanitized,
                source: "recorded"
            };
        });

        const completion: CompletionRecipe = {
            version: 1,
            goal: goalName,
            triggers: [trigger],
            entries,
            suppress: ["leaderboard"],
            delay_ms: 0,
            source: "recorded"
        };

        return {
            format: "advrecipe",
            version: 1,
            application_id: this.appId,
            scene: this.scene || "*",
            name: this.name || (this.appId && this.appId !== "unknown" ? ("Experience " + this.appId) : "Quest Recipe"),
            created: new Date().toISOString(),
            verifiedCompletion: this.verifiedCompletion,
            completion,
            optional_events: Array.from(optionalNames)
        };
    }
}

export function buildRecorderScript(): string {
    return `(function () {
    if (window.__adventurerRecorder) return;

    var ENGINE_NOISE_EVENTS = {
        "update": 1, "postupdate": 1, "frameupdate": 1, "frame:update": 1, "app:tick": 1, "tick": 1,
        "render": 1, "prerender": 1, "postrender": 1, "prerender:frame": 1, "postrender:frame": 1, "framerender": 1, "frameend": 1,
        "physics:update": 1, "physics:postupdate": 1, "collisionstart": 1, "collisionend": 1, "contact": 1,
        "mouse:move": 1, "mousemove": 1, "touch:move": 1, "touchmove": 1, "pointermove": 1,
        "mouse:wheel": 1, "wheel": 1, "pointerhover": 1,
        "sound:update": 1, "audio:tick": 1, "sfx": 1, "asset:load": 1, "asset:progress": 1, "loader:progress": 1,
        "camera:prerender": 1, "camera:postrender": 1, "camera:move": 1, "camera:pan": 1
    };

    var EXTRANEOUS_RE = /^(cosmetic|skin|inspect|camera|cam:|set:dim|glass:|console:lamp|pause|resume|settings|audio|volume|preview|side|optional)/i;

    function notifyTargets(msg) {
        if (typeof window === "undefined") return;
        try { window.postMessage(msg, "*"); } catch (e) {}
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage(msg, "*");
            }
        } catch (e) {}
        try {
            if (window.top && window.top !== window && window.top !== window.parent) {
                window.top.postMessage(msg, "*");
            }
        } catch (e) {}
    }

    function isLeaderboard(name) {
        return typeof name === "string" && name.toLowerCase().indexOf("leaderboard") >= 0;
    }

    function isArise(name) {
        return typeof name === "string" && name.toLowerCase().indexOf("arise:") === 0;
    }

    function QuestEventRecorder(options) {
        options = options || {};
        this.appId = options.appId || "unknown";
        this.scene = options.scene || "";
        this.name = options.name || "";
        this.state = "idle";
        this.events = [];
        this.eventIdSeq = 0;
        this.maxEvents = options.maxEvents || 5000;
        this.verifiedCompletion = false;
        this.onComplete = options.onComplete || null;
        this.onStateChange = options.onStateChange || null;
        this._callStack = [];
    }

    QuestEventRecorder.prototype.start = function () {
        if (this.state === "recording") return;
        this.state = "recording";
        this.events = [];
        this.eventIdSeq = 0;
        this._callStack = [];
        this.verifiedCompletion = false;
        this.notifyState();
    };

    QuestEventRecorder.prototype.stop = function () {
        if (this.state === "recording") {
            this.state = "stopped";
            this.verifiedCompletion = false;
            this.notifyState();
        }
    };

    QuestEventRecorder.prototype.reset = function () {
        this.state = "idle";
        this.events = [];
        this.eventIdSeq = 0;
        this._callStack = [];
        this.verifiedCompletion = false;
        this.notifyState();
    };

    QuestEventRecorder.prototype.notifyState = function () {
        if (this.onStateChange) {
            try { this.onStateChange(this.state); } catch (e) {}
        }
    };

    QuestEventRecorder.prototype.isNoise = function (name) {
        if (!name || typeof name !== "string") return true;
        return !!ENGINE_NOISE_EVENTS[name.toLowerCase()];
    };

    QuestEventRecorder.prototype.recordAppFire = function (name) {
        try {
            if (this.state !== "recording") return;
            if (this.isNoise(name)) return;

            if (this.events.length >= this.maxEvents) {
                this.events.shift();
            }

            var args = [];
            for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);

            var id = ++this.eventIdSeq;
            var parentId = this._callStack.length > 0
                ? this._callStack[this._callStack.length - 1]
                : (this.events.length > 0 ? this.events[this.events.length - 1].id : null);

            var record = {
                id: id,
                parentId: parentId,
                timestamp: Date.now(),
                scope: "app",
                name: name,
                args: args
            };

            this.events.push(record);

            notifyTargets({ type: "RECIPE_RECORDING_PROGRESS", count: this.events.length });

            var lower = name.toLowerCase();
            var isGoalEvent = (
                lower === "arise:questcomplete" ||
                lower === "quest:completed" ||
                lower.indexOf("questcomplete") >= 0 ||
                lower.indexOf("quest:complete") >= 0 ||
                lower.indexOf("quest_complete") >= 0 ||
                lower.indexOf("quest-complete") >= 0 ||
                lower.indexOf("completequest") >= 0 ||
                lower.indexOf(":questcomplete") >= 0
            );
            if (isGoalEvent) {
                record.isGoal = true;
                this.handleCompletion(name);
            }
        } catch (e) {}
    };

    QuestEventRecorder.prototype.recordArisePostMessage = function (payload) {
        try {
            if (this.state !== "recording") return;

            var type = "";
            if (typeof payload === "string") {
                type = payload;
                try {
                    if (payload.charAt(0) === "{") {
                        var parsed = JSON.parse(payload);
                        type = parsed.type || parsed.event || parsed.cmd || type;
                    }
                } catch (e) {}
            } else if (payload && typeof payload === "object") {
                type = String(payload.type || payload.event || payload.cmd || "");
            }

            var lowerType = type.toLowerCase();
            var isAriseGoal = (
                lowerType === "quest-completed" ||
                lowerType === "quest_completed" ||
                (lowerType.indexOf("quest") >= 0 && lowerType.indexOf("complete") >= 0)
            );

            if (isAriseGoal) {
                this.handleCompletion(type || "quest-completed");
            } else if (lowerType === "quest-progress" || lowerType === "quest_progress") {
                if (this.events.length >= this.maxEvents) {
                    this.events.shift();
                }
                var id = ++this.eventIdSeq;
                this.events.push({
                    id: id,
                    parentId: this.events.length > 0 ? this.events[this.events.length - 1].id : null,
                    timestamp: Date.now(),
                    scope: "arise",
                    name: "quest-progress",
                    args: [payload],
                    isProgress: true
                });
                notifyTargets({ type: "RECIPE_RECORDING_PROGRESS", count: this.events.length });
            }
        } catch (e) {}
    };

    QuestEventRecorder.prototype.handleCompletion = function (goalEvent) {
        if (this.state === "completed") return;
        this.state = "completed";
        this.verifiedCompletion = true;
        this.notifyState();

        var recipe = this.deriveAdvRecipe(goalEvent);
        if (this.onComplete) {
            try { this.onComplete(recipe); } catch (e) {}
        }

        notifyTargets({ type: "RECIPE_RECORDING_COMPLETED", recipe: recipe });
    };

    QuestEventRecorder.prototype.deriveAdvRecipe = function (goalName) {
        goalName = goalName || "arise:questComplete";
        var requiredMap = {};
        var optionalNames = [];
        var optionalSet = {};

        for (var i = 0; i < this.events.length; i++) {
            var ev = this.events[i];
            var lower = ev.name.toLowerCase();
            if (lower === goalName.toLowerCase() || lower === "quest-completed" || ev.isProgress || ev.isGoal) {
                requiredMap[ev.id] = true;
                if (ev.parentId !== null) requiredMap[ev.parentId] = true;
            }
        }

        for (var j = this.events.length - 1; j >= 0; j--) {
            var ev2 = this.events[j];
            if (requiredMap[ev2.id] && ev2.parentId !== null) {
                requiredMap[ev2.parentId] = true;
            }
        }

        var hasRequired = Object.keys(requiredMap).length > 0;
        var requiredEvents = [];

        for (var k = 0; k < this.events.length; k++) {
            var ev3 = this.events[k];
            var lower3 = ev3.name.toLowerCase();
            if (lower3 === goalName.toLowerCase() || lower3 === "quest-completed") continue;
            if (ev3.scope === "arise" || isLeaderboard(ev3.name) || isArise(ev3.name)) continue;

            var isExtraneous = EXTRANEOUS_RE.test(ev3.name);
            if ((requiredMap[ev3.id] || !hasRequired) && !isExtraneous) {
                requiredEvents.push(ev3);
            } else {
                if (!optionalSet[ev3.name]) {
                    optionalSet[ev3.name] = true;
                    optionalNames.push(ev3.name);
                }
            }
        }

        var trigger = "select:play";
        for (var t = 0; t < this.events.length; t++) {
            var evT = this.events[t];
            if (evT.name.toLowerCase().indexOf("play") >= 0 && !isLeaderboard(evT.name)) {
                trigger = evT.name;
                break;
            }
        }
        if (trigger === "select:play" && requiredEvents.length > 0) {
            trigger = requiredEvents[0].name;
        }

        var entries = [];
        for (var e = 0; e < requiredEvents.length; e++) {
            var req = requiredEvents[e];
            entries.push({
                name: req.name,
                scope: req.scope === "entity" ? "entity" : "app",
                args: req.args || [],
                source: "recorded"
            });
        }

        return {
            format: "advrecipe",
            version: 1,
            application_id: this.appId,
            scene: this.scene || "*",
            name: this.name || (this.appId && this.appId !== "unknown" ? ("Experience " + this.appId) : "Quest Recipe"),
            created: new Date().toISOString(),
            verifiedCompletion: this.verifiedCompletion,
            completion: {
                version: 1,
                goal: goalName,
                triggers: [trigger],
                entries: entries,
                suppress: ["leaderboard"],
                delay_ms: 0,
                source: "recorded"
            },
            optional_events: optionalNames
        };
    };

    var recorder = new QuestEventRecorder({
        appId: (function () {
            try {
                var host = window.location.hostname || "";
                var label = host.split(".")[0];
                return /^\\d+$/.test(label) ? label : "unknown";
            } catch (e) { return "unknown"; }
        })(),
        scene: ""
    });

    // PlayCanvas app interception
    var polls = 0;
    function hookApp() {
        var app = (window.pc && window.pc.app) || window.app || null;
        if (app && typeof app.fire === "function") {
            if (app.scene && app.scene.name) recorder.scene = app.scene.name;
            var orig = app.fire;
            app.fire = function (name) {
                try {
                    recorder.recordAppFire.apply(recorder, arguments);
                } catch (e) {}
                return orig.apply(this, arguments);
            };
            return;
        }
        if (++polls < 240) setTimeout(hookApp, 250);
    }
    hookApp();

    // Arise postMessage interception
    function hookArise(arise) {
        if (!arise || typeof arise.postMessage !== "function" || arise._advRecHook) return;
        var orig = arise.postMessage;
        arise.postMessage = function (payload) {
            try { recorder.recordArisePostMessage(payload); } catch (e) {}
            return orig.apply(this, arguments);
        };
        arise._advRecHook = true;
    }
    if (window.arise) hookArise(window.arise);
    else {
        var _a = window.arise;
        Object.defineProperty(window, "arise", {
            configurable: true, enumerable: true,
            get: function () { return _a; },
            set: function (v) { _a = v; hookArise(_a); }
        });
    }

    // Message listener for external controls
    window.addEventListener("message", function (e) {
        var d = e && e.data;
        if (!d) return;
        if (d.type === "START_RECIPE_RECORDING") recorder.start();
        else if (d.type === "STOP_RECIPE_RECORDING") recorder.stop();
        else if (d.type === "RESET_RECIPE_RECORDING") recorder.reset();
        else if (d.type === "DISCORD_QUEST_COMPLETED") {
            if (d.appIds && Array.isArray(d.appIds) && d.appIds.indexOf(recorder.appId) === -1) return;
            var hasGame = !!((window.pc && window.pc.app) || window.app || window.arise || recorder.events.length > 0);
            if (hasGame && recorder.state === "recording") {
                recorder.handleCompletion("discord:questComplete");
            }
            try {
                var iframes = document.querySelectorAll("iframe");
                for (var i = 0; i < iframes.length; i++) {
                    var f = iframes[i];
                    if (f && f.contentWindow && f.contentWindow !== e.source) {
                        f.contentWindow.postMessage(d, "*");
                    }
                }
            } catch (err) {}
        }
    });

    window.__adventurerRecorder = recorder;
})();`;
}
