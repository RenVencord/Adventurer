import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { buildMenuScript, buildMenuMessage, LOGO_DATA_URI } from "./menu.ts";

test("generated string parses (new Function and node --check)", () => {
    const src = buildMenuScript({ esp: true, minimap: true, autoComplete: true });
    assert.doesNotThrow(() => new Function(src));
    execFileSync(process.execPath, ["--check"], { input: src, encoding: "utf8" });
});

test("buildMenuMessage matches protocol", () => {
    const msg = buildMenuMessage({ esp: false, minimap: true });
    assert.equal(msg.__adventurerOverlay, true);
    assert.equal(msg.type, "menu_state");
    assert.equal(msg.esp, false);
    assert.equal(msg.minimap, true);
});

test("logo data URI is valid, complete base64 PNG (Issue 1 fix)", () => {
    assert.ok(LOGO_DATA_URI.startsWith("data:image/png;base64,"));
    const b64 = LOGO_DATA_URI.slice("data:image/png;base64,".length);
    const buf = Buffer.from(b64, "base64");
    assert.equal(buf.length, 24189);
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50);
    assert.equal(buf[2], 0x4e);
    assert.equal(buf[3], 0x47);
});

function makeMockWindow(hostname = "1557799582732124221.discordsays.com", width = 1280, height = 720) {
    const posted = [];
    const listeners = {};
    const elements = new Map();

    const createElement = (tag) => {
        const el = {
            tagName: tag.toUpperCase(),
            id: "",
            className: "",
            style: {
                _props: {},
                setProperty(k, v) { this._props[k] = v; },
                removeProperty(k) { delete this._props[k]; },
                get display() { return this._props["display"] || ""; },
                set display(v) { this._props["display"] = v; }
            },
            children: [],
            appendChild(child) {
                this.children.push(child);
                child.parentNode = this;
                if (child.id) elements.set(child.id, child);
                return child;
            },
            removeChild(child) {
                this.children = this.children.filter(c => c !== child);
                child.parentNode = null;
                if (child.id) elements.delete(child.id);
                return child;
            },
            contains(other) {
                let cur = other;
                while (cur) {
                    if (cur === this) return true;
                    cur = cur.parentNode;
                }
                return false;
            },
            setAttribute(k, v) { this[k] = v; },
            getAttribute(k) { return this[k]; },
            innerHTML: "",
            textContent: ""
        };
        return el;
    };

    const doc = {
        createElement,
        getElementById(id) { return elements.get(id) || null; },
        querySelector(sel) { return null; },
        querySelectorAll(sel) { return []; },
        addEventListener(evt, fn) { (listeners[evt] ||= []).push(fn); },
        removeEventListener(evt, fn) { if (listeners[evt]) listeners[evt] = listeners[evt].filter(f => f !== fn); },
        head: createElement("head"),
        body: createElement("body"),
        documentElement: createElement("html")
    };

    const win = {
        location: { hostname },
        innerWidth: width,
        innerHeight: height,
        document: doc,
        postMessage(msg) { posted.push(msg); },
        addEventListener(evt, fn) { (listeners[evt] ||= []).push(fn); },
        removeEventListener(evt, fn) { if (listeners[evt]) listeners[evt] = listeners[evt].filter(f => f !== fn); },
        _dispatch(evt, data) {
            for (const fn of (listeners[evt] || [])) fn({ data });
        },
        _posted: posted,
        _elements: elements,
        setTimeout: () => {},
        setInterval: () => 123,
        clearInterval: () => {}
    };
    win.window = win;
    return win;
}

test("experience settings gated to quest experiences only (Issue 2 fix)", () => {
    const questScript = buildMenuScript({
        esp: true,
        minimap: true,
        autoComplete: true,
        questAppIds: ["1557799582732124221"]
    });

    // In a quest application frame
    const winQuest = makeMockWindow("1557799582732124221.discordsays.com");
    vm.runInNewContext(questScript, winQuest);
    assert.ok(winQuest.document.getElementById("adventurer-experience-bar"), "Bar should be mounted for quest app");

    // In a non-quest application frame (e.g. YouTube Together)
    const winNonQuest = makeMockWindow("880218394199220274.discordsays.com");
    vm.runInNewContext(questScript, winNonQuest);
    assert.equal(winNonQuest.document.getElementById("adventurer-experience-bar"), null, "Bar must NOT be mounted for non-quest app");
});

test("experience menu hides in PiP mode (Issue 3 fix)", () => {
    const questScript = buildMenuScript({
        esp: true,
        minimap: true,
        autoComplete: true,
        questAppIds: ["1557799582732124221"]
    });

    // 1. Initial render in PiP resolution (<= 520x380)
    const winPip = makeMockWindow("1557799582732124221.discordsays.com", 320, 180);
    vm.runInNewContext(questScript, winPip);
    const barPip = winPip.document.getElementById("adventurer-experience-bar");
    assert.ok(barPip);
    assert.equal(barPip.style.display, "none", "Bar should be hidden when initialized in PiP dimensions");

    // 2. Initial render in normal resolution, then pip_state received
    const winNormal = makeMockWindow("1557799582732124221.discordsays.com", 1280, 720);
    vm.runInNewContext(questScript, winNormal);
    const barNormal = winNormal.document.getElementById("adventurer-experience-bar");
    assert.equal(barNormal.style.display, "");

    winNormal._dispatch("message", { type: "pip_state", isPip: true });
    assert.equal(barNormal.style.display, "none", "Bar should be hidden upon pip_state isPip: true");

    winNormal._dispatch("message", { type: "pip_state", isPip: false });
    assert.equal(barNormal.style.display, "", "Bar should be restored when PiP ends");
});

test("recipe auto-saves on completion, preserves elapsed duration, and shares (Issue 4 fix)", () => {
    const questScript = buildMenuScript({
        esp: true,
        minimap: true,
        autoComplete: true,
        questAppIds: ["1557799582732124221"]
    });

    const win = makeMockWindow("1557799582732124221.discordsays.com");
    vm.runInNewContext(questScript, win);
    win.window.__adventurerMenu.startRecording();
    assert.equal(win.window.__adventurerMenu.state().recordingState, "recording");

    const fakeRecipe = {
        format: "advrecipe",
        version: 1,
        application_id: "1557799582732124221",
        scene: "Exoplanet",
        name: "Audible Quest",
        created: new Date().toISOString(),
        verifiedCompletion: true,
        completion: {
            version: 1,
            goal: "quest-completed",
            triggers: ["start"],
            entries: [{ name: "action:click", scope: "app", args: [] }]
        }
    };

    win._dispatch("message", {
        type: "RECIPE_RECORDING_COMPLETED",
        recipe: fakeRecipe
    });

    assert.equal(win.window.__adventurerMenu.state().recordingState, "completed");

    // Verify automatic save to disk dispatch
    const saveMsg = win._posted.find(m => m.type === "SAVE_RECIPE" && m.__adventurerSaveRecipe === true);
    assert.ok(saveMsg, "Must automatically broadcast SAVE_RECIPE upon quest completion");
    assert.equal(saveMsg.recipe, fakeRecipe);

    // Verify share button click broadcasts SHARE_RECIPE
    const shareBtn = win.document.getElementById("adventurer-btn-share");
    assert.ok(shareBtn);
    assert.equal(shareBtn.disabled, false);
    shareBtn.onclick({ stopPropagation: () => {} });

    const shareMsg = win._posted.find(m => m.type === "SHARE_RECIPE" && m.__adventurerShareRecipe === true);
    assert.ok(shareMsg, "Clicking share button must broadcast SHARE_RECIPE");
    assert.equal(shareMsg.recipe, fakeRecipe);
});
