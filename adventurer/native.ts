/*
 * Adventurer — native.ts
 *
 * Runs in Electron's main process (Node.js), not the browser/renderer. The
 * quest mini-games Discord embeds load from a `*.discordsays.com` iframe,
 * which is cross-origin relative to discord.com/canary.discord.com. That
 * means the renderer can't touch contentDocument/contentWindow.document on
 * that frame — the browser blocks it with a SecurityError, full stop.
 *
 * webFrameMain doesn't have that restriction: it lets the privileged main
 * process run script directly inside any frame under our own BrowserWindow,
 * regardless of that frame's origin, because the instruction comes from the
 * app itself rather than from one page reaching into another.
 */

import { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";

const QUEST_FRAME_HOST = /(^|\.)discordsays\.com$/i;

// Tracks which WebContents (i.e. which Discord window) already has a
// did-frame-finish-load listener registered, so we don't double-subscribe.
const watchedContents = new WeakSet<WebContents>();

// The most recently requested overlay script per WebContents. Re-applied
// automatically whenever a matching frame (re)loads, e.g. opening a new
// quest or restarting one.
const currentScripts = new WeakMap<WebContents, string>();

function isQuestFrame(frame: WebFrameMain | null | undefined): boolean {
    if (!frame) return false;
    try {
        return QUEST_FRAME_HOST.test(new URL(frame.url).hostname);
    } catch {
        return false;
    }
}

function findQuestFrames(contents: WebContents): WebFrameMain[] {
    try {
        return contents.mainFrame.framesInSubtree.filter(isQuestFrame);
    } catch {
        return [];
    }
}

function runInFrame(frame: WebFrameMain, script: string) {
    frame.executeJavaScript(script).catch(e => {
        console.error("[Adventurer/native] Failed executing overlay script in quest frame:", e);
    });
}

function ensureWatching(contents: WebContents) {
    if (watchedContents.has(contents)) return;
    watchedContents.add(contents);

    // Fires for every frame (main + sub) whenever it finishes loading.
    // We only care about subframes that land on discordsays.com.
    contents.on("did-frame-finish-load", (_event, isMainFrame, frameProcessId, frameRoutingId) => {
        if (isMainFrame) return;

        const script = currentScripts.get(contents);
        if (!script) return;

        const frame = contents.mainFrame.framesInSubtree.find(
            f => f.processId === frameProcessId && f.routingId === frameRoutingId
        );
        if (frame && isQuestFrame(frame)) {
            runInFrame(frame, script);
        }
    });

    contents.once("destroyed", () => {
        currentScripts.delete(contents);
    });
}

/**
 * Stores `script` as the overlay payload for this window and immediately
 * injects it into any quest frame that's already loaded. Future quest-frame
 * loads (new quest opened, frame reloaded, etc.) get it automatically too.
 */
export function setOverlayScript(event: IpcMainInvokeEvent, script: string): boolean {
    const contents = event.sender;
    currentScripts.set(contents, script);
    ensureWatching(contents);

    const frames = findQuestFrames(contents);
    frames.forEach(frame => runInFrame(frame, script));
    return frames.length > 0;
}

/**
 * Stops auto-reinjecting on future frame loads. Does not (and can't, short
 * of reloading the frame) remove an already-running overlay instance — use
 * the renderer-side postMessage toggle for that instead.
 */
export function clearOverlayScript(event: IpcMainInvokeEvent): void {
    currentScripts.delete(event.sender);
}
