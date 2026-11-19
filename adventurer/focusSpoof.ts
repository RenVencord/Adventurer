import { FluxDispatcher } from "@webpack/common";

// Discord derives its entire notion of window focus from DOM primitives:
// document.hasFocus() is the value sent as is_foregrounded with quest/ad
// telemetry and gates the 5-minute ad/quest heartbeat scheduler; window
// blur/focus events feed the WINDOW_FOCUS / WINDOW_INIT flux actions; and
// visibilitychange handlers all re-check visibilityState === "hidden" before
// acting. While installed, every one of those reads reports "focused and
// visible", so watch time, heartbeats and foreground telemetry never
// contradict each other when the user tabs out during a video quest.

let originalHasFocus: ((this: Document) => boolean) | null = null;
let originalVisibilityState: PropertyDescriptor | null = null;
let originalHidden: PropertyDescriptor | null = null;
let originalAddEventListener: typeof EventTarget.prototype.addEventListener | null = null;
let originalDispatch: ((this: any, action: any) => any) | null = null;

const SUPPRESSED_EVENT_TYPES = new Set(["blur", "visibilitychange", "webkitvisibilitychange"]);

function normalizeAction(action: any): any {
    switch (action?.type) {
        case "WINDOW_FOCUS":
            return action.focused === false ? { ...action, focused: true } : action;
        case "WINDOW_INIT":
            return action.focused === false || action.visible === false
                ? { ...action, focused: true, visible: true }
                : action;
        case "GAME_MODE_DISCORD_FOCUS_CHANGE":
            return action.focused === false ? { ...action, focused: true } : action;
        default:
            return action;
    }
}

export function installFocusSpoof() {
    if (originalHasFocus) return;

    originalHasFocus = Document.prototype.hasFocus;
    Document.prototype.hasFocus = function () {
        return true;
    };

    originalVisibilityState = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState") ?? null;
    Object.defineProperty(Document.prototype, "visibilityState", {
        get: () => "visible",
        configurable: true
    });

    originalHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden") ?? null;
    Object.defineProperty(Document.prototype, "hidden", {
        get: () => false,
        configurable: true
    });

    // Element-level blur handlers (inputs, menus) must keep working; only the
    // window/document-level ones report "the window lost focus", so drop those.
    // Handlers already registered before install re-check hasFocus/visibilityState
    // at event time, which now reads focused/visible, so they neutralize themselves.
    originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
    ) {
        const isRoot = this === window || this === document;
        if (isRoot && SUPPRESSED_EVENT_TYPES.has(String(type).toLowerCase())) return;
        return originalAddEventListener!.call(this, type, listener, options);
    };

    // Backstop for anything that reaches the store layer without going through
    // the DOM (e.g. IPC from the Electron main process).
    originalDispatch = FluxDispatcher.dispatch as any;
    (FluxDispatcher.dispatch as any) = function (this: any, action: any) {
        return originalDispatch!.call(this, normalizeAction(action));
    };
}

export function uninstallFocusSpoof() {
    if (!originalHasFocus) return;

    Document.prototype.hasFocus = originalHasFocus;
    if (originalVisibilityState) Object.defineProperty(Document.prototype, "visibilityState", originalVisibilityState);
    if (originalHidden) Object.defineProperty(Document.prototype, "hidden", originalHidden);
    if (originalAddEventListener) EventTarget.prototype.addEventListener = originalAddEventListener;
    if (originalDispatch) (FluxDispatcher.dispatch as any) = originalDispatch;

    originalHasFocus = null;
    originalVisibilityState = null;
    originalHidden = null;
    originalAddEventListener = null;
    originalDispatch = null;
}

export function isFocusSpoofInstalled() {
    return originalHasFocus !== null;
}
