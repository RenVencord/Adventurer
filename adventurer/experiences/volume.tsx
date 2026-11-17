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
        if (typeof smWanted !== "number" || smWanted <= 0) smWanted = 1;
        Object.defineProperty(manager, "volume", {
            configurable: true,
            enumerable: true,
            // Instances read this to compute their gain, so it has to return the scaled value.
            get: function () { return smWanted * factor(); },
            set: function (v) {
                var num = Number(v);
                if (Number.isFinite(num) && num > 0) smWanted = Math.min(1, Math.max(0, num));
                smDesc.set.call(manager, smWanted * factor());
            }
        });
        smDesc.set.call(manager, smWanted * factor());   // fires volumechange so running sounds re-read the scaled value
        return true;
    }

    function applyAll() {
        document.querySelectorAll("video,audio").forEach(applyMedia);
        if (sm) smDesc.set.call(sm, smWanted * factor());
    }

    // The game may create its sound manager and media after injection.
    var tries = 0;
    var timer = setInterval(function () {
        tries++;
        hookSoundManager();
        applyAll();
        setupHeaderSlider();
        if (tries > 240) clearInterval(timer);   // about a minute of retries, then rely on the setters
    }, 250);
    hookSoundManager();
    applyAll();

    // ---- In-Experience Floating Header Bar Volume Slider (Outer Frame) -------------------------------------------
    var sliderEl = null;
    var rangeInput = null;
    var pctLabel = null;
    var targetBtn = null;
    var isDragging = false;
    var closeTimer = null;

    function updateHeaderSliderUI() {
        var isMuted = state.muted || state.volume === 0;
        var pct = Math.round(state.volume * 100);

        if (rangeInput) {
            rangeInput.value = isMuted ? 0 : pct;
        }
        if (pctLabel) {
            pctLabel.textContent = isMuted ? "MUTED" : (pct + "%");
            pctLabel.style.color = isMuted ? "#f23f43" : "#dbdee1";
        }
    }

    function notifyVolumeChange() {
        try {
            var iframes = document.querySelectorAll("iframe");
            for (var i = 0; i < iframes.length; i++) {
                if (iframes[i] && iframes[i].contentWindow) {
                    iframes[i].contentWindow.postMessage({
                        [TAG]: true,
                        type: "volume",
                        volume: state.volume,
                        muted: state.muted
                    }, "*");
                }
            }
        } catch (e) {}

        try {
            if (window.top && window.top !== window) {
                window.top.postMessage({
                    __adventurerExperienceVolume: true,
                    volume: Math.round(state.volume * 100),
                    muted: state.muted
                }, "*");
            }
        } catch (e) {}
    }

    function openHeaderSlider() {
        if (!sliderEl) return;
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        sliderEl.style.width = "175px";
        sliderEl.style.opacity = "1";
        sliderEl.style.pointerEvents = "auto";
        sliderEl.style.transform = "translateX(0)";
    }

    function closeHeaderSlider() {
        if (!sliderEl || isDragging) return;
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = setTimeout(function () {
            if (sliderEl && !isDragging) {
                sliderEl.style.width = "0";
                sliderEl.style.opacity = "0";
                sliderEl.style.pointerEvents = "none";
                sliderEl.style.transform = "translateX(10px)";
            }
        }, 350);
    }

    function onSoundButtonClick() {
        setTimeout(function () {
            if (!targetBtn) return;
            var label = (targetBtn.getAttribute("aria-label") || "").toLowerCase();
            state.muted = label.indexOf("unmute") !== -1;
            if (!state.muted && state.volume === 0) {
                state.volume = 1;
            }
            applyAll();
            updateHeaderSliderUI();
            notifyVolumeChange();
        }, 50);
    }

    function onRangeInput(e) {
        var val = Number(e.target.value);
        state.volume = Math.min(1, Math.max(0, val / 100));
        if (state.volume > 0 && state.muted) {
            state.muted = false;
        } else if (state.volume === 0) {
            state.muted = true;
        }
        applyAll();
        updateHeaderSliderUI();
        notifyVolumeChange();
    }

    function onPointerDown() {
        isDragging = true;
    }

    function onPointerUp() {
        if (isDragging) {
            isDragging = false;
            closeHeaderSlider();
        }
    }

    function findSoundButton() {
        var bar = document.querySelector(".UAFalW_FloatingHeaderBar.UAFalW_isExpanded");
        if (!bar) return null;
        var container = bar.querySelector(".UAFalW_buttonsContainer");
        if (container && container.children && container.children.length >= 3) {
            var b3 = container.children[2];
            if (b3 && b3.tagName === "BUTTON") return b3;
        }
        var btns = bar.querySelectorAll("button");
        for (var i = 0; i < btns.length; i++) {
            var label = (btns[i].getAttribute("aria-label") || "").toLowerCase();
            if (label.indexOf("mute") !== -1) return btns[i];
        }
        return null;
    }

    function setupHeaderSlider() {
        var host = document.querySelector(".iF1WSW_contentWrapper") || document.body;
        if (!host) return;

        targetBtn = findSoundButton();
        if (!targetBtn) return;

        if (!sliderEl) {
            sliderEl = document.createElement("div");
            sliderEl.id = "adventurer-header-volume-slider";
            sliderEl.style.cssText = "position: absolute; height: 42px; display: flex; align-items: center; gap: 10px; background: rgba(30, 31, 34, 0.96); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 21px; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5); padding: 0 14px; box-sizing: border-box; z-index: 1000; width: 0; opacity: 0; pointer-events: none; transform: translateX(10px); overflow: hidden; transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease, transform 0.25s cubic-bezier(0.4, 0, 0.2, 1); user-select: none;";

            rangeInput = document.createElement("input");
            rangeInput.type = "range";
            rangeInput.min = "0";
            rangeInput.max = "100";
            rangeInput.step = "1";
            rangeInput.setAttribute("aria-label", "Activity volume percentage");
            rangeInput.style.cssText = "width: 95px; height: 5px; accent-color: #5865f2; cursor: pointer; margin: 0;";
            rangeInput.addEventListener("input", onRangeInput);
            rangeInput.addEventListener("pointerdown", onPointerDown);
            rangeInput.addEventListener("mousedown", onPointerDown);

            pctLabel = document.createElement("span");
            pctLabel.style.cssText = "min-width: 44px; text-align: right; font-size: 11px; font-weight: 700; color: #dbdee1; font-family: 'gg sans', 'Noto Sans', sans-serif; font-variant-numeric: tabular-nums;";

            sliderEl.appendChild(rangeInput);
            sliderEl.appendChild(pctLabel);

            sliderEl.addEventListener("mouseenter", openHeaderSlider);
            sliderEl.addEventListener("mouseleave", closeHeaderSlider);

            window.addEventListener("pointerup", onPointerUp);
            window.addEventListener("mouseup", onPointerUp);
        }

        var rect = targetBtn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            sliderEl.style.top = (rect.top + (rect.height - 42) / 2) + "px";
            sliderEl.style.right = (window.innerWidth - rect.left + 8) + "px";
        }

        if (sliderEl.parentElement !== host) {
            host.appendChild(sliderEl);
        }

        if (!targetBtn._adventurerHooked) {
            targetBtn._adventurerHooked = true;
            targetBtn.addEventListener("mouseenter", openHeaderSlider);
            targetBtn.addEventListener("mouseleave", closeHeaderSlider);
            targetBtn.addEventListener("click", onSoundButtonClick);
        }

        updateHeaderSliderUI();
    }

    function checkUI() {
        var bar = document.querySelector(".UAFalW_FloatingHeaderBar");
        var isExpanded = !!(bar && bar.classList.contains("UAFalW_isExpanded"));
        if (sliderEl) {
            sliderEl.style.display = isExpanded ? "flex" : "none";
            if (!isExpanded) {
                sliderEl.style.width = "0";
                sliderEl.style.opacity = "0";
                sliderEl.style.pointerEvents = "none";
                sliderEl.style.transform = "translateX(10px)";
            }
        }
        if (isExpanded) {
            setupHeaderSlider();
        }
    }

    var tries = 0;
    var timer = setInterval(function () {
        tries++;
        hookSoundManager();
        applyAll();
        checkUI();
        if (tries > 240) clearInterval(timer);
    }, 250);
    hookSoundManager();
    applyAll();
    checkUI();

    window.addEventListener("message", function (e) {
        var d = e && e.data;
        if (!d || !d[TAG] || d.type !== "volume") return;
        state.volume = Math.min(1, Math.max(0, Number(d.volume)));
        state.muted = !!d.muted;
        applyAll();
        updateHeaderSliderUI();

        // Forward down to child iframes if this is an outer container frame
        try {
            var iframes = document.querySelectorAll("iframe");
            for (var i = 0; i < iframes.length; i++) {
                if (iframes[i] && iframes[i].contentWindow && iframes[i].contentWindow !== e.source) {
                    iframes[i].contentWindow.postMessage(d, "*");
                }
            }
        } catch (err) {}
    });

    window.__adventurerVolume = {
        set: function (v, m) {
            state.volume = Math.min(1, Math.max(0, Number(v)));
            state.muted = !!m;
            applyAll();
            updateHeaderSliderUI();
        },
        state: function () {
            return { volume: state.volume, muted: state.muted, soundManager: !!sm, hasSlider: !!sliderEl };
        }
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
