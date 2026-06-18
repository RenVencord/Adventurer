import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, UserStore, React, RestAPI } from "@webpack/common";
import { findStoreLazy, findByProps } from "@webpack";
import { Toasts, Button } from "@webpack/common";
import { showNotification } from "@api/Notifications";

const QuestStore = findStoreLazy("QuestStore");

let running = false;
const queue: any[] = [];
const seen = new Set<string>();

const _knownQuestIds = new Set<string>();
let _questIdsInitialized = false;

let _heartbeatIntervalHandle: any = null;
let _serverOnline = false;

const _barState = {
    activeQuestName: null as string | null,
    error: null as string | null,
    forceKillVisible: false,
};
let _barUpdate: (() => void) | null = null;

function updateBar(patch: Partial<typeof _barState>) {
    Object.assign(_barState, patch);
    _barUpdate?.();
}

const LOGO_URL = "https://raw.githubusercontent.com/RenVencord/Adventurer/refs/heads/main/assets/logo.png";

const SERVER_DEFAULT_PORT = 5000;

function getServer() {
    const port = settings.store.serverPort ?? SERVER_DEFAULT_PORT;
    return `http://127.0.0.1:${port}`;
}

export const enum VideoSelectorMode {
    TestId = "testid",
    QuestId = "questid",
    Duration = "duration",
    Permissive = "permissive"
}

const settings = definePluginSettings({
    autoClaimRewards: {
        type: OptionType.BOOLEAN,
        description: "Automatically attempt to claim quest rewards upon completion",
        default: true
    },
    enableVideoTabOut: {
        type: OptionType.BOOLEAN,
        description: "Prevent quest videos from pausing when you tab out of Discord",
        default: true,
        onChange(value: boolean) {
            if (value) {
                startVideoObserver();
                tryPatchNow();
            } else {
                stopVideoObserver();
                unpatchQuestVideo();
            }
        }
    },
    videoSelectorMode: {
        type: OptionType.SELECT,
        description: "How Adventurer identifies the quest video to keep playing",
        hidden: () => !settings.store.enableVideoTabOut,
        options: [
            {
                label: "Precise - target Discord's video player element directly (recommended)",
                value: VideoSelectorMode.TestId,
                default: true
            },
            {
                label: "Quest ID Match - find the open quest in the DOM, look it up in the store",
                value: VideoSelectorMode.QuestId
            },
            {
                label: "Duration Match - match video length against enrolled quest targets",
                value: VideoSelectorMode.Duration
            },
            {
                label: "Permissive - any long unmuted video (may affect non-quest videos)",
                value: VideoSelectorMode.Permissive
            }
        ]
    },
    enableGameTracking: {
        type: OptionType.BOOLEAN,
        description: "Automatically track and complete game quests",
        default: true
    },
    gameTrackingMode: {
        type: OptionType.SELECT,
        description: "How Adventurer spoofs game activity for quest tracking",
        hidden: () => !settings.store.enableGameTracking,
        options: [
            {
                label: "Risky - use Discord's internal mechanism",
                value: "debug"
            },
            {
                label: "Safe - use the local Python server",
                value: "server",
                default: true
            }
        ],
        async onChange(newMode: string) {
            const wasDebug = newMode === "server";
            if (wasDebug) {
                stopGameDebug();
            } else {
                try {
                    await fetch(`${getServer()}/stop`, { method: "POST", body: JSON.stringify({ userId: getCurrentUserId() }), headers: { "Content-Type": "application/json" } });
                } catch (e) {
                    console.warn("[Adventurer] Failed to send stop command to server during mode switch:", e);
                }
            }
            queue.length = 0;
            seen.clear();
            running = false;
            processQuests();
        }
    },
    questStartDelayMin: {
        type: OptionType.NUMBER,
        description: "Minimum delay in seconds before starting or stopping a game quest",
        hidden: () => !settings.store.enableGameTracking || settings.store.gameTrackingMode !== "debug",
        default: 15
    },
    questStartDelayMax: {
        type: OptionType.NUMBER,
        description: "Maximum delay in seconds before starting or stopping a game quest",
        hidden: () => !settings.store.enableGameTracking || settings.store.gameTrackingMode !== "debug",
        default: 180
    },
    serverPort: {
        type: OptionType.NUMBER,
        description: "Port for the local game server (used for heartbeat and server mode)",
        default: SERVER_DEFAULT_PORT
    },
    notifyNewQuests: {
        type: OptionType.BOOLEAN,
        description: "Show a rich notification when new quests become available",
        default: true
    },
    notifyOrbsOnly: {
        type: OptionType.BOOLEAN,
        description: "Only notify for new quests that have orb rewards",
        hidden: () => !settings.store.notifyNewQuests,
        default: true
    },
    notifyMinOrbs: {
        type: OptionType.NUMBER,
        description: "Minimum orb reward to trigger a new-quest notification",
        hidden: () => !settings.store.notifyNewQuests,
        default: 0
    },
    notifyVideoQuests: {
        type: OptionType.BOOLEAN,
        description: "Include video quests in new-quest notifications",
        hidden: () => !settings.store.notifyNewQuests,
        default: true
    },
    skippedQuestsData: {
        type: OptionType.STRING,
        description: "Internal storage for skipped quests",
        default: "[]",
        hidden: () => true
    },
    barHidden: {
        type: OptionType.BOOLEAN,
        description: "Internal state for if the bar is hidden",
        default: false,
        hidden: () => true
    }
});

function getCurrentUserId(): string {
    return UserStore?.getCurrentUser?.()?.id ?? "unknown";
}

function getCurrentUsername(): string {
    const user = UserStore?.getCurrentUser?.();
    if (!user) return "Unknown";
    return user.username ?? user.globalName ?? "Unknown";
}

function getCurrentAvatarUrl(): string | null {
    const user = UserStore?.getCurrentUser?.();
    if (!user) return null;
    return user.getAvatarURL(undefined, 64, false) ?? null;
}

let _lastHeartbeatQuestIds: string = "";
let _heartbeatFailureCount = 0;
const SERVER_OFFLINE_ERROR = "Failed to find server — is it running?";

function getAllQuests(): any[] {
    const quests: Map<string, any> = QuestStore?.quests;
    if (!quests) return [];
    return [...quests.values()];
}

function getAcceptedQuests(): any[] {
    return getAllQuests().filter(q =>
        q?.userStatus !== null &&
        !q?.userStatus?.completedAt &&
        !isQuestExpired(q)
    );
}

function getSkippedQuests(): string[] {
    try {
        return JSON.parse(settings.store.skippedQuestsData || "[]");
    } catch {
        return [];
    }
}

function toggleSkipQuest(questId: string) {
    let skipped = getSkippedQuests();
    if (skipped.includes(questId)) {
        skipped = skipped.filter(id => id !== questId);
    } else {
        skipped.push(questId);
    }
    settings.store.skippedQuestsData = JSON.stringify(skipped);

    if (queue.some(q => q.quest.id === questId)) {
        const idx = queue.findIndex(q => q.quest.id === questId);
        queue.splice(idx, 1);
    }

    const activeQuest = getAcceptedQuests().find(q => (q?.config?.messages?.questName ?? q?.id) === _barState.activeQuestName);
    if (activeQuest && activeQuest.id === questId) {
        stopGame();
    }
}

function showFallbackModal(appId: string, fallbackExe: string): Promise<"try" | "skip" | "cancel"> {
    return new Promise(resolve => {
        const overlay = document.createElement("div");

        const themeNode = document.querySelector("[class*='theme-dark']") || document.querySelector("[class*='theme-light']");
        overlay.className = themeNode ? themeNode.className : (document.documentElement.className || "theme-dark");
        if (document.documentElement.hasAttribute("data-theme")) {
            overlay.setAttribute("data-theme", document.documentElement.getAttribute("data-theme")!);
        }

        overlay.style.cssText = "position: fixed; inset: 0; background: var(--black-500, rgba(0,0,0,0.5)); z-index: 999999; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px);";

        const modal = document.createElement("div");

        modal.style.cssText = "background: var(--bg-overlay-dialog, var(--background-gradient-high, var(--background-floating, #313338))); border-radius: 8px; padding: 24px; width: 440px; max-width: 90%; box-shadow: var(--elevation-high, 0 8px 16px rgba(0,0,0,0.24)); border: 1px solid var(--border-subtle, rgba(255,255,255,0.05)); display: flex; flex-direction: column; gap: 16px;";

        modal.innerHTML = `
            <div style="font-size: 20px; font-weight: 700; color: var(--header-primary, #f2f3f5);">Executable Not Found</div>
            <div style="font-size: 14px; color: var(--text-normal, #dbdee1); line-height: 1.4;">
                Unable to find an executable path for ID <strong style="color: var(--text-normal, #f2f3f5);">${appId}</strong> in the detectable list.
                <br><br>
                Would you like to try <strong style="color: var(--text-normal, #f2f3f5);">${fallbackExe}</strong> or skip this quest?
            </div>
            <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px;">
                <button id="adventurer-modal-cancel" style="padding: 8px 16px; border-radius: 4px; border: none; cursor: pointer; font-weight: 600; background: transparent; color: var(--text-normal, #dbdee1);">Cancel</button>
                <button id="adventurer-modal-skip" style="padding: 8px 16px; border-radius: 4px; border: none; cursor: pointer; font-weight: 600; background: var(--button-danger-background, #da373c); color: #fff;">Skip Quest</button>
                <button id="adventurer-modal-try" style="padding: 8px 16px; border-radius: 4px; border: none; cursor: pointer; font-weight: 600; background: var(--button-positive-background, #23a55a); color: #fff;">Try ${fallbackExe}</button>
            </div>
        `;

        overlay.appendChild(modal);

        const injectTarget = document.querySelector("div[class^='app_']")
                          || document.querySelector("div[class^='layerContainer_']")
                          || document.getElementById("app-mount")
                          || document.body;

        injectTarget.appendChild(overlay);

        const close = (result: "try" | "skip" | "cancel") => {
            overlay.remove();
            resolve(result);
        };

        const bindHover = (id: string, normalBg: string, hoverBg: string) => {
            const btn = overlay.querySelector(id) as HTMLElement;
            if (!btn) return;
            btn.addEventListener("mouseenter", () => btn.style.background = hoverBg);
            btn.addEventListener("mouseleave", () => btn.style.background = normalBg);
        };

        bindHover("#adventurer-modal-cancel", "transparent", "var(--background-modifier-hover, rgba(255,255,255,0.05))");
        bindHover("#adventurer-modal-skip", "var(--button-danger-background, #da373c)", "var(--button-danger-background-hover, #a12828)");
        bindHover("#adventurer-modal-try", "var(--button-positive-background, #23a55a)", "var(--button-positive-background-hover, #1b8045)");

        overlay.querySelector("#adventurer-modal-cancel")!.addEventListener("click", () => close("cancel"));
        overlay.querySelector("#adventurer-modal-skip")!.addEventListener("click", () => close("skip"));
        overlay.querySelector("#adventurer-modal-try")!.addEventListener("click", () => close("try"));
    });
}

function applySkipVisuals(node: Element) {
    const tile = node as HTMLElement;
    const questId = tile.id.replace("quest-tile-", "");
    const isSkipped = getSkippedQuests().includes(questId);

    const parentScrollTarget = tile.closest("div[data-scroll-target]");
    const targetToGrey = (parentScrollTarget instanceof HTMLElement ? parentScrollTarget : tile);

    if (isSkipped) {
        targetToGrey.classList.add("adventurer-skipped");

        const topRow = targetToGrey.querySelector("div[class*='topRow_']");
        if (topRow && !topRow.querySelector(".adventurer-skipped-pill")) {
            const existingPills = topRow.querySelector("div[class*='pills_']");
            if (existingPills) (existingPills as HTMLElement).style.display = "none";

            const pillWrapper = document.createElement("div");
            pillWrapper.className = existingPills?.className || "stack_dbd263 pills_b5b7aa";
            pillWrapper.classList.add("adventurer-skipped-pill");
            pillWrapper.style.cssText = "gap: var(--space-8); padding: var(--space-0); display: flex;";

            pillWrapper.innerHTML = `<div class="defaultColor__4bd52 eyebrow_cf4812 badge_c2b88c expressive_c2b88c" data-text-variant="eyebrow" style="background: var(--bg-mod-faint); color: var(--text-muted); border: 1px solid var(--border-subtle); padding: 2px 6px; border-radius: var(--radius-round);">SKIPPED</div>`;

            topRow.insertBefore(pillWrapper, topRow.firstChild);
        }
    } else {
        targetToGrey.classList.remove("adventurer-skipped");

        const topRow = targetToGrey.querySelector("div[class*='topRow_']");
        if (topRow) {
            const pill = topRow.querySelector(".adventurer-skipped-pill");
            if (pill) pill.remove();

            const existingPills = topRow.querySelector("div[class*='pills_']:not(.adventurer-skipped-pill)");
            if (existingPills) (existingPills as HTMLElement).style.display = "";
        }
    }
}

function injectSkipStyles() {
    if (document.getElementById("adventurer-skip-styles")) return;
    const style = document.createElement("style");
    style.id = "adventurer-skip-styles";
    style.innerHTML = `
        /* Dynamically target ALL children of a skipped tile EXCEPT the top row */
        article.adventurer-skipped > div:not([class*='topRow_']),
        article.adventurer-skipped > svg {
            opacity: 0.3 !important;
            filter: grayscale(100%) !important;
            transition: filter 0.5s ease, opacity 0.5s ease !important;
            pointer-events: none !important;
        }

        /* Forcefully strip Discord's native background change and zoom effect on skipped tiles */
        article.adventurer-skipped:hover {
            background-color: transparent !important;
            transform: none !important;
        }
        article.adventurer-skipped:hover > div:not([class*='topRow_']) {
            transform: none !important;
        }
        article.adventurer-skipped::before,
        article.adventurer-skipped::after {
            display: none !important;
        }
        
        /* 3-dot popout background overlay for Adventurer tab */
        .adventurer-popout-bg {
            position: relative;
            z-index: 1;
            overflow: hidden;
            border-radius: 8px;
            backdrop-filter: blur(16px);
            border: 1px solid var(--border-subtle, rgba(255,255,255,0.05));
            box-shadow: var(--elevation-high, 0 8px 16px rgba(0,0,0,0.24));
        }
        .adventurer-popout-bg::before {
            content: "";
            position: absolute;
            inset: 0;
            background: var(--background-gradient-high, var(--bg-overlay-chat, var(--background-floating, #313338)));
            opacity: 0.7;
            z-index: -1;
        }
    `;
    document.head.appendChild(style);
}

function removeSkipStyles() {
    const style = document.getElementById("adventurer-skip-styles");
    if (style) style.remove();
}

function injectSkipButton(menu: HTMLElement, questId: string) {
    if (menu.querySelector(".adventurer-skip-btn")) return;

    const quest = getAllQuests().find(q => q.id === questId);
    if (!quest) return;

    const isSkipped = getSkippedQuests().includes(questId);

    const group = menu.querySelector("div[role='group']");
    if (!group) return;

    const existingItem = group.querySelector("div[role='menuitem']");
    if (!existingItem) return;

    // Dynamically extract Discord's active hover class (e.g., focused_c1e9c4) to spoof it flawlessly
    const focusMatch = existingItem.className.match(/focused_[a-zA-Z0-9]+/);
    const focusClass = focusMatch ? focusMatch[0] : "focused_c1e9c4";
    const baseClass = existingItem.className.replace(new RegExp(`\\b${focusClass}\\b`, 'g'), '').trim();

    const item = document.createElement("div");
    item.setAttribute("role", "menuitem");
    item.setAttribute("tabindex", "-1");
    item.className = baseClass + " adventurer-skip-btn";

    item.innerHTML = `
        <div class="label_c1e9c4" style="color: var(--text-normal)">${isSkipped ? "Unskip quest" : "Skip quest"}</div>
        <div class="iconContainer_c1e9c4" style="color: var(--text-normal)">
            <svg class="icon_c1e9c4" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24">
                <path fill="currentColor" d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-2a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm3.54-10.12L10.12 4.46a1 1 0 0 0-1.41 1.41l5.41 5.42-5.41 5.41a1 1 0 0 0 1.41 1.42l5.42-5.42a1 1 0 0 0 0-1.42Z"></path>
            </svg>
        </div>
    `;

    const exLabel = existingItem.querySelector("div[class^='label_']");
    const exIcon = existingItem.querySelector("div[class^='iconContainer_']");
    if (exLabel) item.querySelector("div")!.className = exLabel.className;
    if (exIcon) item.querySelector("div:nth-child(2)")!.className = exIcon.className;

    item.addEventListener("mouseenter", () => {
        // Forcefully strip Discord's native hover class from sibling items to prevent double-highlights
        group.querySelectorAll("div[role='menuitem']").forEach(sib => {
            if (sib !== item) sib.classList.remove(focusClass);
        });
        item.classList.add(focusClass);
        item.querySelector("div")!.style.color = "var(--interactive-active)";
        item.querySelector("div:nth-child(2)")!.style.color = "var(--interactive-active)";
    });

    item.addEventListener("mouseleave", () => {
        item.classList.remove(focusClass);
        item.querySelector("div")!.style.color = "var(--text-normal)";
        item.querySelector("div:nth-child(2)")!.style.color = "var(--text-normal)";
    });

    item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleSkipQuest(questId);

        document.querySelectorAll("article[id^='quest-tile-']").forEach(applySkipVisuals);

        // Target the overlay backdrop to force Discord's native React popout to unmount
        const backdrop = document.querySelector("div[class*='backdrop_']");
        if (backdrop) {
            backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            backdrop.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        }
    });

    group.appendChild(item);
}


let uiObserver: MutationObserver | null = null;
let _lastClickedQuestId: string | null = null;

function startUIObserver() {
    if (uiObserver) return;

    injectSkipStyles();

    document.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (!target || !target.closest) return;
        const tile = target.closest("article[id^='quest-tile-']");
        if (tile) {
            _lastClickedQuestId = tile.id.replace("quest-tile-", "");
        }

        setTimeout(() => {
            if (location.pathname.includes("/quest-home") && settings.store.barHidden) {
                settings.store.barHidden = false;
                try { findStoreLazy("QuestStore")?.emitChange?.(); } catch (e) {}
                FluxDispatcher.dispatch({ type: "QUEST_UPDATE" });
            }
        }, 50);

    }, true);

    uiObserver = new MutationObserver((mutations) => {
        for (const mut of mutations) {
            for (const node of mut.addedNodes) {
                if (node instanceof HTMLElement) {
                    const menu = node.querySelector("#quests-entry") || (node.id === "quests-entry" ? node : null);
                    if (menu && _lastClickedQuestId) {
                        injectSkipButton(menu as HTMLElement, _lastClickedQuestId);
                    }

                    if (node.tagName === "ARTICLE" && node.id.startsWith("quest-tile-")) {
                        applySkipVisuals(node);
                    } else if (node.querySelectorAll) {
                        node.querySelectorAll("article[id^='quest-tile-']").forEach(applySkipVisuals);
                    }
                }
            }
        }
    });

    uiObserver.observe(document.body, { childList: true, subtree: true });

    document.querySelectorAll("article[id^='quest-tile-']").forEach(applySkipVisuals);
}

function stopUIObserver() {
    if (!uiObserver) return;
    uiObserver.disconnect();
    uiObserver = null;
    removeSkipStyles();
}

async function reportActiveStatus(questId: string | null, quest: any | null, statusData: { type: string; endsAt: number } | null) {
    try {
        await fetch(`${getServer()}/active`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                questId,
                quest,
                statusData,
                userId: getCurrentUserId()
            })
        });
    } catch {}
}

async function sendHeartbeat(force = false) {
    const all = getAllQuests().filter(q => q?.userStatus !== null && !isQuestExpired(q));

    const fingerprint = all.map(q => {
        const progress = q?.userStatus?.progress ?? {};
        const progressStr = Object.entries(progress)
            .map(([k, v]: [string, any]) => `${k}:${v?.value ?? 0}`)
            .join("|");
        return `${q.id}@${progressStr}`;
    }).sort().join(",");

    if (!force && fingerprint === _lastHeartbeatQuestIds) {
        return _serverOnline;
    }
    _lastHeartbeatQuestIds = fingerprint;

    const url = `${getServer()}/heartbeat`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                quests: all,
                userId: getCurrentUserId(),
                username: getCurrentUsername(),
                avatar: getCurrentAvatarUrl()
            })
        });

        if (res.ok) {
            _serverOnline = true;
            _heartbeatFailureCount = 0;
            updateBar({ error: null });
            return true;
        } else {
            _serverOnline = false;
            _heartbeatFailureCount++;
            if (_heartbeatFailureCount >= 2) {
                try {
                    const data = await res.json();
                    updateBar({ error: `${res.status} — ${data.error || "Server Error"}` });
                } catch {
                    updateBar({ error: `${res.status} — Server Error` });
                }
            }
            return false;
        }
    } catch (e) {
        _serverOnline = false;
        _heartbeatFailureCount++;
        if (_heartbeatFailureCount >= 2) {
            updateBar({ error: SERVER_OFFLINE_ERROR });
        }
        return false;
    }
}

function initKnownQuests() {
    if (_questIdsInitialized) return;
    for (const q of getAllQuests()) {
        if (q?.id) _knownQuestIds.add(q.id);
    }
    _questIdsInitialized = true;
}

function getOrbQuantity(quest: any): number {
    const rewards = quest?.config?.rewardsConfig?.rewards ?? [];
    for (const r of rewards) {
        if (r?.orbQuantity) return r.orbQuantity;
    }
    return 0;
}

let patchedVideo: HTMLVideoElement | null = null;
let originalPause: (() => void) | null = null;
let videoObserver: MutationObserver | null = null;

function getVideoQuestDurations(): Array<{ min: number; max: number }> {
    return getAcceptedQuests()
        .filter(q => q?.config?.taskConfigV2?.tasks?.["WATCH_VIDEO"])
        .map(q => {
            const target = q.config.taskConfigV2.tasks["WATCH_VIDEO"].target ?? 0;
            return { min: Math.max(0, target - 2), max: target + 2 };
        });
}

function findByTestId(): HTMLVideoElement | null {
    const el = document.querySelector("[data-testid='discord-web-video-player-video']");
    return el instanceof HTMLVideoElement ? el : null;
}

function findByQuestId(): HTMLVideoElement | null {
    const questIdEl = document.querySelector("[data-quest-id]");
    if (!questIdEl) return null;
    const questId = (questIdEl as HTMLElement).dataset.questId;
    if (!questId) return null;

    const quest = getAcceptedQuests().find(q => q.id === questId);
    if (!quest) return null;

    const target = quest?.config?.taskConfigV2?.tasks?.["WATCH_VIDEO"]?.target;
    if (!target) return null;

    const min = Math.max(0, target - 2);
    const max = target + 2;

    return [...document.querySelectorAll("video")].find(
        (v): v is HTMLVideoElement =>
            v instanceof HTMLVideoElement &&
            v.currentSrc.startsWith("blob:") &&
            v.duration >= min && v.duration <= max
    ) ?? null;
}

function findByDuration(): HTMLVideoElement | null {
    const ranges = getVideoQuestDurations();
    if (ranges.length === 0) return null;

    return [...document.querySelectorAll("video")].find(
        (v): v is HTMLVideoElement =>
            v instanceof HTMLVideoElement &&
            v.currentSrc.startsWith("blob:") &&
            ranges.some(r => v.duration >= r.min && v.duration <= r.max)
    ) ?? null;
}

function findPermissive(): HTMLVideoElement | null {
    return [...document.querySelectorAll("video")].find(
        (v): v is HTMLVideoElement =>
            v instanceof HTMLVideoElement &&
            !v.muted &&
            v.duration > 10
    ) ?? null;
}

function findQuestVideo(): HTMLVideoElement | null {
    const mode = settings.store.videoSelectorMode as VideoSelectorMode;

    if (mode === VideoSelectorMode.TestId) {
        return findByTestId() ?? findByQuestId() ?? findByDuration() ?? null;
    }
    if (mode === VideoSelectorMode.QuestId) {
        return findByQuestId() ?? findByDuration() ?? null;
    }
    if (mode === VideoSelectorMode.Duration) {
        return findByDuration() ?? null;
    }
    return findPermissive();
}

function patchQuestVideo(video: HTMLVideoElement) {
    if (patchedVideo === video) return;
    unpatchQuestVideo();

    originalPause = video.pause.bind(video);
    video.pause = () => {
        console.log("[Adventurer] pause() blocked on quest video");
    };
    patchedVideo = video;
}

function unpatchQuestVideo() {
    if (!patchedVideo || !originalPause) return;
    patchedVideo.pause = originalPause;
    patchedVideo = null;
    originalPause = null;
}

function tryPatchNow() {
    if (!settings.store.enableVideoTabOut) return;
    const video = findQuestVideo();
    if (video) patchQuestVideo(video);
}

const DISCORD_OVERLAY_TEXT = "We paused the video while you are away. Resume to continue progress.";
const ADVENTURER_OVERLAY_TEXT = "Adventurer kept this quest playing while you're tabbed out!";

function patchOverlayMessage() {
    document.querySelectorAll("div[data-text-variant='text-sm/normal']").forEach(el => {
        if (el.textContent === DISCORD_OVERLAY_TEXT) {
            el.textContent = ADVENTURER_OVERLAY_TEXT;
        }
    });
}

function startVideoObserver() {
    if (videoObserver) return;

    videoObserver = new MutationObserver(() => {
        if (patchedVideo && !patchedVideo.isConnected) {
            unpatchQuestVideo();
        }
        if (!patchedVideo) {
            tryPatchNow();
        }
        patchOverlayMessage();
    });

    videoObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
}

function stopVideoObserver() {
    if (!videoObserver) return;
    videoObserver.disconnect();
    videoObserver = null;
}

(window as any).__adventurerFetchAndProcess = fetchAndProcess;

function sleep(ms: number) {
    return new Promise(res => setTimeout(res, ms));
}

let _debugGameQuestId: string | null = null;

function stopGameDebug() {
    if (!_debugGameQuestId) return;
    FluxDispatcher.dispatch({ type: "RUNNING_GAME_SET_DEBUG_GAME", game: null });
    _debugGameQuestId = null;
}

async function launchGameDebug(quest: any, forceExe?: string): Promise<boolean> {
    const appId = quest?.config?.application?.id;
    const appName = quest?.config?.application?.name ?? appId;

    let exeName = `${appName}.exe`;
    let needsPrompt = false;

    if (forceExe) {
        exeName = forceExe;
    } else {
        try {
            const res = await fetch(`https://discord.com/api/v10/applications/public?application_ids=${appId}`);
            const data = await res.json();
            const appData = data?.[0];
            const exe = appData?.executables?.find((e: any) => e.os === "win32");
            if (exe?.name) {
                exeName = exe.name.replace(">", "");
            } else {
                if (appData?.executables?.[0]?.name) {
                    exeName = appData.executables[0].name.replace(">", "");
                }
                needsPrompt = true;
            }
        } catch (e) {
            needsPrompt = true;
        }
    }

    if (needsPrompt && !forceExe) {
        const choice = await showFallbackModal(appId, exeName);
        if (choice === "try") {
            return await launchGameDebug(quest, exeName);
        } else if (choice === "skip") {
            toggleSkipQuest(quest.id);
            document.querySelectorAll("article[id^='quest-tile-']").forEach(applySkipVisuals);
            return false;
        } else {
            return false;
        }
    }

    const minMs = (settings.store.questStartDelayMin ?? 15) * 1000;
    const maxMs = (settings.store.questStartDelayMax ?? 180) * 1000;
    const range = Math.max(0, maxMs - minMs);
    const startDelay = minMs + Math.random() * range;

    const endsAt = Date.now() + startDelay;
    await reportActiveStatus(quest.id, quest, { type: "waiting", endsAt });

    Toasts.show({
        message: `Starting "${appName}" in ${Math.round(startDelay / 1000)}s...`,
        type: Toasts.Type.MESSAGE,
        id: Toasts.genId(),
        options: { duration: Math.min(startDelay, 5000) }
    });

    await sleep(startDelay);

    const pid = Math.floor(Math.random() * 30000) + 1000;
    const fakeGame = {
        id: appId,
        name: appName,
        exeName,
        exePath: `C:\\Users\\User\\AppData\\Local\\${appName}\\${exeName}`,
        pid,
        start: Date.now()
    };

    FluxDispatcher.dispatch({ type: "RUNNING_GAME_SET_DEBUG_GAME", game: fakeGame });
    _debugGameQuestId = quest.id;

    await reportActiveStatus(quest.id, quest, { type: "running", endsAt: 0 });
    return true;
}

async function stopGame(questName?: string) {
    if (settings.store.gameTrackingMode === "debug") {
        if (!_debugGameQuestId) return;

        const minMs = (settings.store.questStartDelayMin ?? 15) * 1000;
        const maxMs = (settings.store.questStartDelayMax ?? 180) * 1000;
        const range = Math.max(0, maxMs - minMs);
        const stopDelay = minMs + Math.random() * range;

        if (questName) {
            Toasts.show({
                message: `Stopping "${questName}" in ${Math.round(stopDelay / 1000)}s...`,
                type: Toasts.Type.MESSAGE,
                id: Toasts.genId(),
                options: { duration: Math.min(stopDelay, 5000) }
            });
        }

        const currentQuest = getAllQuests().find(q => q.id === _debugGameQuestId);
        if (currentQuest) {
            const endsAt = Date.now() + stopDelay;
            await reportActiveStatus(_debugGameQuestId, currentQuest, { type: "stopping", endsAt });
        }

        await sleep(stopDelay);
        stopGameDebug();
        await reportActiveStatus(null, null, null);
    } else {
        try {
            await fetch(`${getServer()}/stop`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: getCurrentUserId() })
            });
        } catch (e) {
            console.error("[Adventurer] Failed to send stop command to game server:", e);
        }
    }
}

async function handleForceKill() {
    await stopGame();
    running = false;
    queue.length = 0;
    updateBar({ activeQuestName: null, forceKillVisible: false });
    Toasts.show({
        message: "Force killed active quest processes.",
        type: Toasts.Type.FAILURE,
        id: Toasts.genId()
    });
}

async function launchGame(appId: string, quest: any, forceExe?: string): Promise<boolean> {
    if (settings.store.gameTrackingMode === "debug") {
        return await launchGameDebug(quest, forceExe);
    } else {
        try {
            const body: any = { id: appId, quest, userId: getCurrentUserId() };
            if (forceExe) body.forceExe = forceExe;

            const res = await fetch(`${getServer()}/run`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                let data: any;
                try { data = await res.json(); } catch {}

                if (data?.requires_confirmation && data.fallback_exe) {
                    const choice = await showFallbackModal(appId, data.fallback_exe);
                    if (choice === "try") {
                        return await launchGame(appId, quest, data.fallback_exe);
                    } else if (choice === "skip") {
                        toggleSkipQuest(quest.id);
                        document.querySelectorAll("article[id^='quest-tile-']").forEach(applySkipVisuals);
                        return false;
                    } else {
                        return false;
                    }
                }

                updateBar({ error: `${res.status} — ${data?.error || "Server Error"}` });
                return false;
            }
            return true;
        } catch (e) {
            updateBar({ error: SERVER_OFFLINE_ERROR });
            return false;
        }
    }
}

async function waitForCompletion(quest: any, taskKey: string, target: number, questName: string): Promise<boolean> {
    if (settings.store.gameTrackingMode === "debug") {
        await new Promise<void>(resolve => {
            const onHeartbeat = (_event: any) => {
                const updated = getAllQuests().find(q => q.id === quest.id);
                if (!updated) {
                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
                    resolve();
                    return;
                }

                const progress = updated?.userStatus?.progress?.[taskKey]?.value ?? 0;
                const isCompleted = !!updated?.userStatus?.completedAt;

                sendHeartbeat();

                if (progress >= target || isCompleted) {
                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
                    resolve();
                }
            };
            FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
        });

        const forceKillTimer = setTimeout(() => {
            updateBar({ forceKillVisible: true });
        }, 5000);

        await stopGame(questName);

        const buffer = 20 + Math.floor(Math.random() * 41);

        Toasts.show({
            message: `"${questName}" complete - waiting ${buffer}s buffer`,
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId(),
            options: { duration: 4000 }
        });

        const currentQuest = getAllQuests().find(q => q.id === quest.id);
        if (currentQuest) {
            const endsAt = Date.now() + (buffer * 1000);
            await reportActiveStatus(quest.id, currentQuest, { type: "cleanup", endsAt });
        }

        await sleep(buffer * 1000);
        clearTimeout(forceKillTimer);
        updateBar({ forceKillVisible: false });
        await reportActiveStatus(null, null, null);
        return true;
    }

    while (true) {
        await sleep(15000);

        if (!running) return false;

        const updated = getAllQuests().find(q => q.id === quest.id);
        if (!updated) {
            await stopGame(questName);
            return false;
        }

        const progress = updated?.userStatus?.progress?.[taskKey]?.value ?? 0;
        const isCompleted = !!updated?.userStatus?.completedAt;

        updateBar({});

        const isOnline = await sendHeartbeat();

        if (progress >= target || isCompleted) {
            const forceKillTimer = setTimeout(() => {
                updateBar({ forceKillVisible: true });
            }, 5000);

            await stopGame(questName);

            const buffer = 20 + Math.floor(Math.random() * 41);
            Toasts.show({
                message: `"${questName}" complete - waiting ${buffer}s buffer`,
                type: Toasts.Type.SUCCESS,
                id: Toasts.genId(),
                options: { duration: 4000 }
            });
            await sleep(buffer * 1000);
            clearTimeout(forceKillTimer);
            updateBar({ forceKillVisible: false });
            return true;
        }

        if (!isOnline && _heartbeatFailureCount >= 2) {
            return false;
        }
    }
}

async function runQueue() {
    if (running) return;
    running = true;

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) continue;

        const { quest, appId, questName, task } = current;

        updateBar({ activeQuestName: questName, error: null, forceKillVisible: false });

        if (task.isVideo) {
            tryPatchNow();

            if (!patchedVideo) {
                Toasts.show({
                    message: `"${questName}": open the quest panel and start the video first`,
                    type: Toasts.Type.FAILURE,
                    id: Toasts.genId(),
                    options: { duration: 5000 }
                });
                seen.delete(quest.id);
                continue;
            }

            Toasts.show({
                message: `Watching "${questName}" - tab away freely`,
                type: Toasts.Type.MESSAGE,
                id: Toasts.genId(),
                options: { duration: 4000 }
            });

            const completed = await waitForCompletion(quest, task.key, task.target, questName);
            if (!completed) {
                seen.delete(quest.id);
                break;
            }

        } else {
            if (!settings.store.enableGameTracking) continue;

            await stopGame();

            const ok = await launchGame(appId, quest);
            if (!ok) {
                seen.delete(quest.id);
                break;
            }

            Toasts.show({
                message: `Running "${questName}"...`,
                type: Toasts.Type.MESSAGE,
                id: Toasts.genId(),
                options: { duration: 3000 }
            });

            const completed = await waitForCompletion(quest, task.key, task.target, questName);
            if (!completed) {
                seen.delete(quest.id);
                break;
            }
        }

        Toasts.show({
            message: `Finished "${questName}"`,
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId(),
            options: { duration: 3000 }
        });
    }

    running = false;
    updateBar({ activeQuestName: null, forceKillVisible: false });
}

function isQuestExpired(quest: any): boolean {
    const expiresAt = quest?.config?.expiresAt;
    if (!expiresAt) return false;
    return Date.now() > new Date(expiresAt).getTime();
}

function isQuestComplete(quest: any): boolean {
    return !!quest?.userStatus?.completedAt;
}

function getQuestTask(quest: any): { key: string; target: number; isVideo: boolean } | null {
    const tasks = quest?.config?.taskConfigV2?.tasks;
    if (!tasks) return null;

    if (tasks["WATCH_VIDEO"]) {
        return { key: "WATCH_VIDEO", target: tasks["WATCH_VIDEO"].target ?? 0, isVideo: true };
    }
    if (tasks["PLAY_ON_DESKTOP"]) {
        return { key: "PLAY_ON_DESKTOP", target: tasks["PLAY_ON_DESKTOP"].target ?? 0, isVideo: false };
    }
    return null;
}

function checkForNewQuests() {
    if (!settings.store.notifyNewQuests) return;
    if (!_questIdsInitialized) return;

    const all = getAllQuests();
    const newQuests: any[] = [];

    for (const q of all) {
        if (!q?.id) continue;
        if (_knownQuestIds.has(q.id)) continue;
        _knownQuestIds.add(q.id);

        if (q?.userStatus !== null && q?.userStatus !== undefined) continue;
        if (q?.userStatus?.completedAt) continue;
        if (q?.userStatus?.claimedAt) continue;
        if (isQuestExpired(q)) continue;

        newQuests.push(q);
    }

    const filtered = newQuests.filter(quest => {
        const orbs = getOrbQuantity(quest);
        const isVideo = !!quest?.config?.taskConfigV2?.tasks?.["WATCH_VIDEO"];
        if (settings.store.notifyOrbsOnly && orbs === 0) return false;
        if (orbs < (settings.store.notifyMinOrbs ?? 0)) return false;
        if (isVideo && !settings.store.notifyVideoQuests) return false;
        return true;
    });

    if (filtered.length === 0) return;

    if (filtered.length === 1) {
        const quest = filtered[0];
        const orbs = getOrbQuantity(quest);
        const isVideo = !!quest?.config?.taskConfigV2?.tasks?.["WATCH_VIDEO"];
        const name = quest?.config?.messages?.questName ?? quest?.config?.messages?.gameTitle ?? quest?.id;
        const orbStr = orbs ? ` - ◇ ${orbs.toLocaleString()} orbs` : "";
        const kind = isVideo ? "Video quest" : "Game quest";

        const assets = quest?.config?.assets ?? {};
        let iconUrl: string | null = null;
        const tile = assets.gameTileDark ?? assets.gameTile;
        if (tile) {
            const tilePath = tile.startsWith("quests/") ? tile : `quests/${quest.config.id}/${tile}`;
            iconUrl = `https://cdn.discordapp.com/${tilePath}`;
        } else {
            iconUrl = "/assets/39556a7eb79145be.svg";
        }

        showNotification({
            title: "New Quest Available!",
            body: `${name}${orbStr}\n${kind}`,
            icon: iconUrl ?? undefined,
            onClick() { FluxDispatcher.dispatch({ type: "LAYER_POP_ALL" }); }
        });
    } else {
        const totalOrbs = filtered.reduce((sum, q) => sum + getOrbQuantity(q), 0);
        const orbStr = totalOrbs ? ` - ◇ ${totalOrbs.toLocaleString()} orbs total` : "";
        showNotification({
            title: `${filtered.length} New Quests Available!`,
            body: `${filtered.map(q => q?.config?.messages?.questName ?? q?.config?.messages?.gameTitle ?? q?.id).join(", ")}${orbStr}`,
            icon: "/assets/39556a7eb79145be.svg",
            onClick() { FluxDispatcher.dispatch({ type: "LAYER_POP_ALL" }); }
        });
    }
}

async function processQuests(): Promise<void> {
    if (running) return;

    await sendHeartbeat();
    checkForNewQuests();

    const accepted = getAcceptedQuests().sort((a, b) => {
        const getPct = (q: any) => {
            const tasks = q?.config?.taskConfigV2?.tasks ?? {};
            const progress = q?.userStatus?.progress ?? {};
            const key = Object.keys(tasks)[0];
            if (!key) return 0;
            const cur = progress[key]?.value ?? 0;
            const total = tasks[key]?.target ?? 1;
            return cur / total;
        };
        const pctDiff = getPct(b) - getPct(a);
        if (Math.abs(pctDiff) > 0.0001) return pctDiff;
        const getExpiry = (q: any) => {
            const expiresAt = q?.config?.expiresAt;
            return expiresAt ? new Date(expiresAt).getTime() : Infinity;
        };
        return getExpiry(a) - getExpiry(b);
    });

    const skippedIds = getSkippedQuests();

    for (const quest of accepted) {
        const appId = quest?.config?.application?.id;
        const questName = quest?.config?.messages?.questName ?? quest?.id;

        if (!appId) continue;
        if (isQuestComplete(quest)) continue;
        if (seen.has(quest.id)) continue;
        if (skippedIds.includes(quest.id)) continue;

        const task = getQuestTask(quest);
        if (!task) continue;

        if (task.isVideo === false && !settings.store.enableGameTracking) continue;

        queue.push({ quest, appId, questName, task });
        seen.add(quest.id);
    }

    if (queue.length > 0) runQueue();
}

async function fetchAndProcess() {
    seen.clear();
    running = false;
    queue.length = 0;
    const all = getAllQuests();

    if (all.length === 0) {
        Toasts.show({ message: "No quests found.", type: Toasts.Type.MESSAGE, id: Toasts.genId(), options: { duration: 3000 } });
        return;
    }

    const skippedIds = getSkippedQuests();

    const claimable = all.filter(isQuestClaimable);
    if (claimable.length > 0) {
        Toasts.show({ message: `Claiming ${claimable.length} reward(s)...`, type: Toasts.Type.MESSAGE, id: Toasts.genId(), options: { duration: 3000 } });
        for (const q of claimable) {
            try {
                await RestAPI.post({
                    url: `/quests/${q.id}/claim-reward`,
                    body: { platform: 0, location: 11 }
                });
            } catch (e: any) {
                if (e?.status === 404 || (e?.status === 400 && !e?.body?.captcha_key)) {
                    await RestAPI.post({
                        url: `/quests/${q.id}/reward-code`,
                        body: { platform: 0, location: 11 }
                    }).catch(() => {});
                }
            }
            await sleep(800);
        }
    }

    const unenrolled = all.filter(q =>
        (q?.userStatus === null || q?.userStatus === undefined) &&
        !isQuestExpired(q) &&
        !skippedIds.includes(q.id) &&
        (q?.config?.taskConfigV2?.tasks?.["PLAY_ON_DESKTOP"] || q?.config?.taskConfigV2?.tasks?.["WATCH_VIDEO"])
    );

    if (unenrolled.length > 0) {
        Toasts.show({ message: `Auto-enrolling in ${unenrolled.length} new quest(s)...`, type: Toasts.Type.MESSAGE, id: Toasts.genId(), options: { duration: 3000 } });
        for (const q of unenrolled) {
            try {
                await RestAPI.post({
                    url: `/quests/${q.id}/enroll`,
                    body: { location: 11 }
                });
                await sleep(500);
            } catch (e) {
                console.error("[Adventurer] Failed to auto-enroll:", q.id, e);
            }
        }
        await sleep(1000);
    }

    const updatedAll = getAllQuests();
    const incomplete = updatedAll.filter(q =>
        q?.userStatus !== null &&
        q?.userStatus !== undefined &&
        !q?.userStatus?.completedAt &&
        !isQuestExpired(q) &&
        !skippedIds.includes(q.id)
    );

    if (incomplete.length === 0) {
        if (claimable.length === 0) {
            Toasts.show({ message: "No incomplete quests found.", type: Toasts.Type.MESSAGE, id: Toasts.genId(), options: { duration: 3000 } });
        }
        return;
    }

    Toasts.show({
        message: `Found ${incomplete.length} quest${incomplete.length === 1 ? "" : "s"} to run...`,
        type: Toasts.Type.MESSAGE,
        id: Toasts.genId(),
        options: { duration: 3000 }
    });

    await processQuests();
}

function isQuestClaimable(quest: any): boolean {
    return !!quest?.userStatus?.completedAt && !quest?.userStatus?.claimedAt;
}

function AutoCompleteButton({ onClick, disabled }: { onClick: () => void; disabled: boolean; }) {
    const [hovered, setHovered] = React.useState(false);
    const isForceKill = _barState.forceKillVisible;

    let text = "Auto Complete";
    if (isForceKill) text = "Force kill";
    else if (disabled) text = "Running...";

    let bg = "var(--control-secondary-background-default)";
    let border = "var(--control-secondary-border-default)";
    let color = "var(--control-secondary-text-default)";

    if (isForceKill) {
        bg = hovered ? "var(--button-danger-background-hover)" : "var(--button-danger-background)";
        border = "transparent";
        color = "#fff";
    } else if (hovered && !disabled) {
        bg = "var(--control-secondary-background-active)";
        border = "var(--control-secondary-border-active)";
    }

    return (
        <button
            onClick={isForceKill ? handleForceKill : onClick}
            disabled={disabled && !isForceKill}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                width: "100%",
                padding: "4px 0",
                fontSize: "14px",
                fontWeight: 500,
                borderRadius: "8px",
                cursor: (disabled && !isForceKill) ? "not-allowed" : "pointer",
                border: `1px solid ${border}`,
                backgroundColor: bg,
                color: color,
                opacity: (disabled && !isForceKill) ? 0.5 : 1,
                transition: "background-color 0.1s, border-color 0.1s",
            }}
        >
            {text}
        </button>
    );
}

function ClaimRewardButton({ onClick, claimState }: { onClick: () => void; claimState: string; }) {
    const [hovered, setHovered] = React.useState(false);

    let bg = "var(--control-primary-background-default)";
    let transitionTime = "0.1s";

    if (claimState === "claiming") {
        bg = "var(--control-connected-background-default)";
        transitionTime = "0.5s";
    } else if (claimState === "reverting") {
        bg = "var(--control-primary-background-default)";
        transitionTime = "0.25s";
    } else if (hovered) {
        bg = "var(--control-primary-background-hover)";
    }

    return (
        <button
            onClick={onClick}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                width: "100%",
                padding: "4px 0",
                fontSize: "14px",
                fontWeight: 500,
                borderRadius: "8px",
                cursor: "pointer",
                border: "none",
                backgroundColor: bg,
                color: "#fff",
                transition: `background-color ${transitionTime} ease`,
            }}
        >
            Claim Reward
        </button>
    );
}

function DropdownItem({ label, onClick, danger }: { label: string, onClick: () => void, danger?: boolean }) {
    const [hovered, setHovered] = React.useState(false);
    return (
        <div
            role="menuitem"
            tabIndex={-1}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={onClick}
            style={{
                padding: "6px 8px",
                margin: "2px 0",
                borderRadius: "4px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                fontSize: "14px",
                fontWeight: 500,
                color: danger
                    ? (hovered ? "var(--white-500, #fff)" : "var(--text-danger, #da373c)")
                    : (hovered ? "var(--interactive-text-active, var(--interactive-active, #fff))" : "var(--interactive-text-default, var(--interactive-normal, #b5bac1))"),
                backgroundColor: hovered ? (danger ? "var(--button-danger-background, #da373c)" : "var(--background-modifier-hover)") : "transparent",
                transition: "background-color 0.1s, color 0.1s"
            }}
        >
            {label}
        </div>
    );
}

function ThreeDotMenu({ open, setOpen }: { open: boolean, setOpen: (v: boolean) => void }) {
    const [hovered, setHovered] = React.useState(false);
    const buttonRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (!open) return;
        const close = () => setOpen(false);
        document.addEventListener("click", close);
        return () => document.removeEventListener("click", close);
    }, [open, setOpen]);

    return (
        <>
            <div
                ref={buttonRef}
                role="button"
                tabIndex={0}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen(!open);
                }}
                style={{
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "20px",
                    height: "20px",
                    color: hovered || open ? "var(--interactive-text-active, var(--interactive-active))" : "var(--interactive-text-default, var(--interactive-normal))",
                    transition: "color 0.1s"
                }}
            >
                <svg width="20" height="20" fill="none" viewBox="0 0 24 24">
                    <path fill="currentColor" fillRule="evenodd" d="M4 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10-2a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" clipRule="evenodd"></path>
                </svg>
            </div>

            {open && buttonRef.current && (
                <div
                    className="adventurer-popout-bg"
                    style={{
                        position: "fixed",
                        left: buttonRef.current.getBoundingClientRect().right + 12,
                        top: buttonRef.current.getBoundingClientRect().top - 8,
                        padding: "6px 8px",
                        minWidth: "188px",
                        cursor: "default",
                        pointerEvents: "auto"
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <DropdownItem
                        label={settings.store.gameTrackingMode === "server" ? "Switch to Risky Tracking" : "Switch to Safe Tracking"}
                        onClick={() => {
                            settings.store.gameTrackingMode = settings.store.gameTrackingMode === "server" ? "debug" : "server";
                            Toasts.show({ message: `Switched to ${settings.store.gameTrackingMode} tracking mode`, type: Toasts.Type.SUCCESS, id: Toasts.genId() });
                            setOpen(false);
                        }}
                    />
                    {running && (
                        <>
                            <div style={{ height: "1px", backgroundColor: "var(--background-modifier-accent)", margin: "4px 0" }}></div>
                            <DropdownItem
                                label="Kill game stub"
                                danger={true}
                                onClick={() => {
                                    handleForceKill();
                                    setOpen(false);
                                }}
                            />
                        </>
                    )}
                    <div role="separator" className="separator_c1e9c4" style={{ "--custom-menu-separator-margin": "8px" } as any}></div>
                    <DropdownItem
                        label="Hide This"
                        onClick={() => {
                            settings.store.barHidden = true;
                            setOpen(false);
                            if (_barUpdate) _barUpdate();
                            try { findStoreLazy("QuestStore")?.emitChange?.(); } catch (e) {}
                            FluxDispatcher.dispatch({ type: "QUEST_UPDATE" });
                        }}
                    />
                </div>
            )}
        </>
    );
}

export default definePlugin({
    name: "Adventurer",
    description: "Auto-runs Discord quests sequentially with completion tracking.",
    authors: [{ name: "ren", id: 163734654040539136n }],
    settings,

    shouldShowBar(quest: any) {
        if (settings.store.barHidden) return false;

        const claimable = getAllQuests().some(q => isQuestClaimable(q));
        if (claimable) return true;

        const skippedIds = getSkippedQuests();
        const gameQuestCount = getAllQuests().filter(q =>
            q?.config?.taskConfigV2?.tasks?.["PLAY_ON_DESKTOP"] &&
            !isQuestExpired(q) &&
            !q?.userStatus?.completedAt &&
            !skippedIds.includes(q.id)
        ).length;

        return gameQuestCount > 0;
    },

    patches: [
        {
            find: '"quest bar rendered"',
            replacement: {
                match: /\(0,(\i)\.jsx\)\(\i,\{quest:(\i)\}\)/,
                replace: "(!$self.shouldShowBar($2) ? null : (0,$1.jsx)($self.AdventurerBar,{quest:$2}))"
            }
        },
        {
            find: '"data-testid":"quest-bar-container"',
            replacement: {
                match: /(return\s*\(\s*0\s*,\s*(\i)\.(jsx|jsxs)\s*\)\s*\(\s*\i\.\i\s*,\s*\{\s*questOrQuests\s*:\s*(\i)\s*,\s*questContent\s*:\s*\i\.\i\.QUEST_BAR_V2)/,
                replace: "if(!$self.shouldShowBar($4)) return null;\nreturn (0,$2.$3)($self.AdventurerBar, { quest: $4 });\n$1"
            }
        },
        {
            find: '"Not rendered due to ineligibility"',
            replacement: {
                match: /return ([^;]+?"Not rendered due to ineligibility"[^;]*?,null);/,
                replace: "if(!$self.shouldShowBar(t)) return $1;"
            }
        }
    ],

    AdventurerBar({ quest }: { quest: any; }) {
        const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
        const [menuOpen, setMenuOpen] = React.useState(false);
        const [subtitleHovered, setSubtitleHovered] = React.useState(false);
        const [claimState, setClaimState] = React.useState<"idle" | "claiming" | "reverting">("idle");

        React.useEffect(() => {
            _barUpdate = forceUpdate;

            const handleSync = () => forceUpdate(Math.random());
            FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", handleSync);
            FluxDispatcher.subscribe("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", handleSync);
            FluxDispatcher.subscribe("QUEST_UPDATE", handleSync);

            const syncInterval = setInterval(handleSync, 5000);

            return () => {
                if (_barUpdate === forceUpdate) _barUpdate = null;
                FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", handleSync);
                FluxDispatcher.unsubscribe("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", handleSync);
                FluxDispatcher.unsubscribe("QUEST_UPDATE", handleSync);
                clearInterval(syncInterval);

                if (running) {
                    running = false;
                    queue.length = 0;
                    stopGame();
                    updateBar({ activeQuestName: null, forceKillVisible: false });
                }
            };
        }, []);

        // Hook execution must ALWAYS finish before an early return
        if (settings.store.barHidden) return null;

        let liveQuest = getAllQuests().find(q => q.id === quest?.id) ?? quest;

        if (_barState.activeQuestName) {
            const runningQuest = getAllQuests().find(q =>
                (q?.config?.messages?.questName ?? q?.id) === _barState.activeQuestName
            );
            if (runningQuest) liveQuest = runningQuest;
        } else {
            const claimableQuest = getAllQuests().find(q => isQuestClaimable(q));
            if (claimableQuest) liveQuest = claimableQuest;
        }

        const taskInfo = getQuestTask(liveQuest);
        const taskKey = taskInfo?.key;

        const current = taskKey ? (liveQuest?.userStatus?.progress?.[taskKey]?.value ?? 0) : 0;
        const total = taskInfo?.target ?? 1;

        const claimable = isQuestClaimable(liveQuest);
        const isComplete = isQuestComplete(liveQuest) || claimable;
        const pct = isComplete ? 1 : Math.min(1, total > 0 ? current / total : 0);

        const circumference = 122.52;

        let currentDashoffset = isComplete ? 0 : circumference * (1 - pct);
        let currentHue = isComplete ? 108 : 0;

        let filterTransition = "filter 0.5s ease";
        let circleTransition = "stroke-dashoffset 0.4s ease-in";

        if (claimState === "claiming") {
            currentDashoffset = circumference;
            currentHue = 0;
            circleTransition = "stroke-dashoffset 0.8s ease-in";
            filterTransition = "filter 0.8s ease";
        } else if (claimState === "reverting") {
            currentDashoffset = 0;
            currentHue = 108;
            circleTransition = "stroke-dashoffset 0.4s ease-in";
            filterTransition = "filter 0.25s ease";
        }

        const skippedIds = getSkippedQuests();
        const gameQuestCount = getAllQuests().filter(q =>
            q?.config?.taskConfigV2?.tasks?.["PLAY_ON_DESKTOP"] &&
            !isQuestExpired(q) &&
            !q?.userStatus?.completedAt &&
            !skippedIds.includes(q.id)
        ).length;

        const subtitle = _barState.activeQuestName
            ?? `${gameQuestCount} game quest${gameQuestCount !== 1 ? "s" : ""} available`;

        async function handleAutoComplete() {
            updateBar({ error: null });
            await fetchAndProcess();
        }

        async function handleClaim() {
            setClaimState("claiming");

            let resultSuccess = false;
            let resultError: any = null;

            const claimPromise = (async () => {
                try {
                    await RestAPI.post({
                        url: `/quests/${liveQuest.id}/claim-reward`,
                        body: { platform: 0, location: 11 }
                    });
                    resultSuccess = true;
                } catch (e: any) {
                    const errStr = String(e?.message || e);
                    if (errStr.includes("Captcha") || errStr.includes("cancelled")) {
                        resultError = e;
                        return;
                    }

                    if (e?.status === 404 || (e?.status === 400 && !e?.body?.captcha_key)) {
                        try {
                            await RestAPI.post({
                                url: `/quests/${liveQuest.id}/reward-code`,
                                body: { platform: 0, location: 11 }
                            });
                            resultSuccess = true;
                        } catch (e2: any) {
                            resultError = e2;
                        }
                    } else {
                        resultError = e;
                    }
                }
            })();

            await Promise.all([claimPromise.catch(() => {}), sleep(800)]);

            if (resultSuccess) {
                Toasts.show({
                    message: "Reward claimed!",
                    type: Toasts.Type.SUCCESS,
                    id: Toasts.genId(),
                    options: { duration: 3000 }
                });
                setClaimState("idle");
            } else {
                if (resultError) {
                    const errStr = String(resultError?.message || resultError);
                    if (errStr.includes("Captcha") || errStr.includes("cancelled")) {
                        console.log("[Adventurer] Claim reward fallback captcha cancelled.");
                    } else {
                        console.error("[Adventurer] Failed to claim reward:", resultError);
                        Toasts.show({
                            message: "Failed to claim reward — check console",
                            type: Toasts.Type.FAILURE,
                            id: Toasts.genId(),
                            options: { duration: 4000 }
                        });
                    }
                }
                setClaimState("reverting");
                setTimeout(() => setClaimState("idle"), 400);
            }
        }

        return (
            <div style={{ display: "flex", flexDirection: "column" }}>
                {_barState.error && (
                    <div style={{
                        position: "relative",
                        zIndex: 0,
                        background: "var(--status-danger)",
                        color: "#fff",
                        fontSize: "11px",
                        fontWeight: 600,
                        padding: "4px 8px",
                        textAlign: "center",
                        borderTopLeftRadius: "8px",
                        borderTopRightRadius: "8px",
                        marginBottom: "-6px",
                    }}>
                        {_barState.error}
                    </div>
                )}
                <div style={{
                    display: "flex",
                    flexDirection: "column",
                    padding: "10px 12px",
                    gap: "10px",
                    minHeight: "100px",
                    justifyContent: "center",
                    boxSizing: "border-box",
                    position: "relative",
                    zIndex: 1,
                    background: "var(--background-secondary)",
                }}>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                            <div style={{ position: "relative", width: 36, height: 36, flexShrink: 0 }}>
                                <svg viewBox="0 0 42 42" style={{
                                    width: "100%", height: "100%",
                                    transform: "rotate(-90deg)",
                                    transition: filterTransition,
                                    filter: `hue-rotate(${currentHue}deg)`
                                }}>
                                    <circle strokeWidth="3" fill="transparent" r="19.5" cx="21" cy="21"
                                        stroke="var(--background-mod-strong)" />
                                    <circle strokeWidth="3" fill="transparent" r="19.5" cx="21" cy="21"
                                        stroke={isComplete ? "#23a55a" : "rgba(98, 196, 101, 1)"}
                                        strokeDasharray="122.52 122.52"
                                        strokeDashoffset={currentDashoffset}
                                        strokeLinecap="round"
                                        style={{ transition: circleTransition }}
                                    />
                                </svg>
                                <img
                                    src={LOGO_URL}
                                    style={{
                                        position: "absolute",
                                        top: "50%", left: "50%",
                                        transform: "translate(-50%, -50%)",
                                        width: 20, height: 20,
                                        borderRadius: "50%",
                                        objectFit: "cover",
                                        pointerEvents: "none",
                                        transition: filterTransition,
                                        filter: `hue-rotate(${currentHue}deg)`
                                    }}
                                />
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                                <span style={{
                                    fontSize: "14px", fontWeight: 600,
                                    color: "var(--text-strong, #f2f3f5)",
                                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                }}>
                                    {claimable ? "Quest Complete!" : "Adventurer"}
                                </span>
                                <a
                                    href="/quest-home"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        try {
                                            const router = findByProps("push", "replace", "goBack");
                                            if (router && router.push) {
                                                router.push("/quest-home");
                                            } else {
                                                throw new Error("Router undefined");
                                            }
                                        } catch (err) {
                                            const domNode = document.querySelector('a[href="/quest-home"]') as HTMLElement;
                                            if (domNode) domNode.click();
                                            else window.open("https://discord.com/quest-home", "_blank");
                                        }
                                    }}
                                    style={{
                                        display: "block",
                                        fontSize: "12px",
                                        fontWeight: claimable ? 600 : "normal",
                                        color: "var(--text-subtle, #dbdee1)",
                                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                        cursor: "pointer",
                                        textDecoration: subtitleHovered ? "underline" : "none"
                                    }}
                                    onMouseEnter={() => setSubtitleHovered(true)}
                                    onMouseLeave={() => setSubtitleHovered(false)}
                                >
                                    {claimable ? "Reward ready to collect" : subtitle}
                                </a>
                            </div>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "12px", paddingRight: "4px" }}>
                            {!isComplete && total > 0 && (
                                <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-subtle)" }}>
                                    {Math.floor(pct * 100)}%
                                </span>
                            )}
                            <ThreeDotMenu open={menuOpen} setOpen={setMenuOpen} />
                        </div>
                    </div>

                    {claimable
                        ? <ClaimRewardButton onClick={handleClaim} claimState={claimState} />
                        : <AutoCompleteButton onClick={handleAutoComplete} disabled={running} />
                    }
                </div>
            </div>
        );
    },

    settingsAboutComponent() {
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <Button color={Button.Colors.BRAND} size={Button.Sizes.MEDIUM} onClick={fetchAndProcess}>
                    Fetch & Run Quests
                </Button>
            </div>
        );
    },

    start() {
        fetch(`${getServer()}/reset`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: getCurrentUserId() })
        }).catch((e) => {
            console.warn("[Adventurer] Initial server reset failed (server likely offline):", e);
        });

        queue.length = 0;
        seen.clear();
        running = false;
        _lastHeartbeatQuestIds = "";
        _heartbeatFailureCount = 0;
        updateBar({ forceKillVisible: false });

        initKnownQuests();

        FluxDispatcher.subscribe("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", processQuests);
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", processQuests);
        FluxDispatcher.subscribe("QUESTS_ENROLL_SUCCESS", processQuests);

        if (settings.store.enableVideoTabOut) {
            startVideoObserver();
            tryPatchNow();
        }

        startUIObserver();
        sendHeartbeat(true);

        _heartbeatIntervalHandle = setInterval(async () => {
            if (location.pathname.includes("/quest-home") && settings.store.barHidden) {
                settings.store.barHidden = false;
                try { findStoreLazy("QuestStore")?.emitChange?.(); } catch (e) {}
                FluxDispatcher.dispatch({ type: "QUEST_UPDATE" });
            }

            const wasOnline = _serverOnline;
            const isOnline = await sendHeartbeat(true);
            if (!wasOnline && isOnline && !running && queue.length === 0) {
                processQuests();
            }
        }, 15000);
    },

    stop() {
        FluxDispatcher.unsubscribe("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", processQuests);
        FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", processQuests);
        FluxDispatcher.unsubscribe("QUESTS_ENROLL_SUCCESS", processQuests);

        if (_heartbeatIntervalHandle) {
            clearInterval(_heartbeatIntervalHandle);
            _heartbeatIntervalHandle = null;
        }

        if (_debugGameQuestId) stopGameDebug();
        else {
            fetch(`${getServer()}/stop`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: getCurrentUserId() })
            }).catch((e) => {
                console.error("[Adventurer] Failed to send shutdown stop command to server:", e);
            });
        }

        stopVideoObserver();
        unpatchQuestVideo();
        stopUIObserver();

        queue.length = 0;
        seen.clear();
        running = false;
        _lastHeartbeatQuestIds = "";
        _heartbeatFailureCount = 0;
        _questIdsInitialized = false;
        _knownQuestIds.clear();
        updateBar({ forceKillVisible: false });
    }
});