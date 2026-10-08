/*
 * Adventurer - experiences/volume.tsx
 *
 * Volume control for quest activities. Two halves:
 *  - buildVolumeScript(): plain JS injected into the activity iframe (through native.ts, like the overlay). It scales
 *    PlayCanvas' sound manager and every HTMLMediaElement by a master volume, and listens for postMessage updates
 *    from Discord's window.
 *  - VolumeControl: the small speaker + slider placed in Discord's quest activity header (the bar with the quest
 *    progress), inserted by a patch in index.tsx.
 */

import { React } from "@webpack/common";

export const VOLUME_MSG_TAG = "__adventurerOverlay";

export interface VolumeSettings {
    store: { experiencesVolume: number; experiencesMuted: boolean; };
    use<K extends string>(keys: K[]): any;
}

const clampPercent = (v: number) => Math.min(100, Math.max(0, Math.round(Number.isFinite(v) ? v : 100)));

/** Source injected into the activity frame. Idempotent: a second injection only updates the state. */
export function buildVolumeScript(volumePercent: number, muted: boolean): string {
    const volume = clampPercent(volumePercent) / 100;
    return `(function () {
    var TAG = ${JSON.stringify(VOLUME_MSG_TAG)};
    var initial = { volume: ${volume}, muted: ${!!muted} };

    if (window.__adventurerVolume) {
        window.__adventurerVolume.set(initial.volume, initial.muted);
        return;
    }

    var state = { volume: initial.volume, muted: initial.muted };
    var factor = function () { return state.muted ? 0 : state.volume; };

    // ---- HTMLMediaElement: videos and audio tags (cutscenes, trailers) -----------------------------------------
    // The page keeps setting its own volume, so remember what it asked for and scale that.
    var mediaDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
    var wanted = new WeakMap();
    function applyMedia(el) {
        if (!wanted.has(el)) wanted.set(el, mediaDesc.get.call(el));
        mediaDesc.set.call(el, Math.min(1, Math.max(0, wanted.get(el) * factor())));
    }
    if (mediaDesc && mediaDesc.get && mediaDesc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, "volume", {
            configurable: true,
            enumerable: mediaDesc.enumerable,
            get: function () { return wanted.has(this) ? wanted.get(this) : mediaDesc.get.call(this); },
            set: function (v) {
                wanted.set(this, Math.min(1, Math.max(0, Number(v))));
                mediaDesc.set.call(this, Math.min(1, Math.max(0, Number(v) * factor())));
            }
        });
    }

    // ---- PlayCanvas sound manager -------------------------------------------------------------------------------
    // SoundInstance gain = instance volume * soundManager.volume, so scaling the manager scales every game sound.
    var sm = null, smDesc = null, smWanted = 1;
    function hookSoundManager() {
        var app = (window.pc && window.pc.app) || window.app;
        var manager = app && app.soundManager;
        if (!manager || sm === manager) return !!sm;
        var protoDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(manager), "volume");
        if (!protoDesc || !protoDesc.get || !protoDesc.set) return false;
        sm = manager;
        smDesc = protoDesc;
        smWanted = protoDesc.get.call(manager);
        Object.defineProperty(manager, "volume", {
            configurable: true,
            enumerable: true,
            // Instances read this to compute their gain, so it has to return the scaled value.
            get: function () { return smWanted * factor(); },
            set: function (v) { smWanted = Math.min(1, Math.max(0, Number(v))); smDesc.set.call(manager, smWanted); }
        });
        smDesc.set.call(manager, smWanted);   // fires volumechange so running sounds re-read the scaled value
        return true;
    }

    function applyAll() {
        document.querySelectorAll("video,audio").forEach(applyMedia);
        if (sm) smDesc.set.call(sm, smWanted);
    }

    // The game may create its sound manager and media after injection.
    var tries = 0;
    var timer = setInterval(function () {
        tries++;
        hookSoundManager();
        applyAll();
        if (tries > 240) clearInterval(timer);   // about a minute of retries, then rely on the setters
    }, 250);
    hookSoundManager();
    applyAll();

    window.addEventListener("message", function (e) {
        var d = e.data;
        if (e.source !== window.parent || !d || !d[TAG] || d.type !== "volume") return;
        state.volume = Math.min(1, Math.max(0, Number(d.volume)));
        state.muted = !!d.muted;
        applyAll();
    });

    window.__adventurerVolume = {
        set: function (v, m) { state.volume = v; state.muted = !!m; applyAll(); },
        state: function () { return { volume: state.volume, muted: state.muted, soundManager: !!sm }; }
    };
})();`;
}

/** Sends the current volume to every activity iframe in this window. */
export function pushVolume(volumePercent: number, muted: boolean) {
    const message = { [VOLUME_MSG_TAG]: true, type: "volume", volume: clampPercent(volumePercent) / 100, muted: !!muted };
    document.querySelectorAll("iframe").forEach(frame => {
        try {
            if (!/(^|\.)discordsays\.com$/i.test(new URL((frame as HTMLIFrameElement).src).hostname)) return;
            (frame as HTMLIFrameElement).contentWindow?.postMessage(message, "*");
        } catch {
            // Not a URL we can parse or a frame that is gone: nothing to update.
        }
    });
}

function SpeakerIcon({ level, muted }: { level: number; muted: boolean; }) {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3.5 7 8H3.5v8H7l5 4.5v-17Z" fill="currentColor" />
            {muted || level === 0
                ? <path d="m16 9.5 5 5m0-5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                : <>
                    <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    {level > 50 && <path d="M18 7a7 7 0 0 1 0 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
                </>}
        </svg>
    );
}

/**
 * Speaker button (mute toggle) and slider. Reads and writes the plugin settings so the level survives restarts,
 * and pushes every change into the running activity.
 */
export function VolumeControl({ settings, onChange }: { settings: VolumeSettings; onChange: (volume: number, muted: boolean) => void; }) {
    const { experiencesVolume, experiencesMuted } = settings.use(["experiencesVolume", "experiencesMuted"]);
    const volume = clampPercent(experiencesVolume);
    const muted = !!experiencesMuted;

    const setVolume = (v: number) => {
        const next = clampPercent(v);
        settings.store.experiencesVolume = next;
        // Dragging the slider up from zero un-mutes, as every volume slider does.
        if (muted && next > 0) settings.store.experiencesMuted = false;
        onChange(next, muted && next === 0);
    };
    const toggleMute = () => {
        settings.store.experiencesMuted = !muted;
        onChange(volume, !muted);
    };

    const shown = muted ? 0 : volume;
    return (
        <div
            title={muted ? "Activity volume (muted)" : `Activity volume ${volume}%`}
            style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}
        >
            <button
                type="button"
                aria-label={muted ? "Unmute activity" : "Mute activity"}
                onClick={toggleMute}
                style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: "28px", height: "28px", padding: 0, border: "none", borderRadius: "4px",
                    background: "transparent", cursor: "pointer",
                    color: muted ? "var(--status-danger, #f23f43)" : "var(--interactive-normal, #b5bac1)"
                }}
            >
                <SpeakerIcon level={shown} muted={muted} />
            </button>
            <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={shown}
                aria-label="Activity volume"
                onChange={e => setVolume(Number(e.currentTarget.value))}
                style={{ width: "84px", accentColor: "var(--brand-500, #5865f2)", cursor: "pointer" }}
            />
        </div>
    );
}
