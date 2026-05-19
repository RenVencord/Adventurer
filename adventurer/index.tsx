import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, UserStore } from "@webpack/common";
import { findStoreLazy } from "@webpack";
import { Toasts, Button } from "@webpack/common";
import { showNotification } from "@api/Notifications";

const QuestStore = findStoreLazy("QuestStore");

let running = false;
const queue: any[] = [];
const seen = new Set<string>();

// Tracks quest IDs seen at plugin start - used to detect truly new quests
const _knownQuestIds = new Set<string>();
let _questIdsInitialized = false;

// Background interval handler for periodic keep-alive heartbeats
let _heartbeatIntervalHandle: any = null;

// --- Settings ---

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
                label: "Internal - use Discord's internal RUNNING_GAME_SET_DEBUG_GAME mechanism (recommended)",
                value: "debug",
                default: true
            },
            {
                label: "Server - use the local Python server (legacy)",
                value: "server"
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
    }
});

// --- User identity ---

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

// --- Heartbeat ---

let _lastHeartbeatQuestIds: string = "";

function getAllQuests(): any[] {
    const quests: Map<string, any> = QuestStore?.quests;
    if (!quests) return [];
    return [...quests.values()];
}

function getAcceptedQuests(): any[] {
    return getAllQuests().filter(q => q?.userStatus !== null && !q?.userStatus?.completedAt);
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
    // Only send quests that are accepted by the user and have not expired
    const all = getAllQuests().filter(q => q?.userStatus !== null && !isQuestExpired(q));

    const fingerprint = all.map(q => {
        const progress = q?.userStatus?.progress ?? {};
        const progressStr = Object.entries(progress)
            .map(([k, v]: [string, any]) => `${k}:${v?.value ?? 0}`)
            .join("|");
        return `${q.id}@${progressStr}`;
    }).sort().join(",");

    if (!force && fingerprint === _lastHeartbeatQuestIds) {
        return;
    }
    _lastHeartbeatQuestIds = fingerprint;

    const url = `${getServer()}/heartbeat`;
    try {
        console.log(`[Adventurer] Sending heartbeat to ${url}...`);
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
            const data = await res.json();
            console.log("[Adventurer] Heartbeat successfully received by server:", data);
        } else {
            console.error(`[Adventurer] Server rejected heartbeat with status ${res.status}: ${res.statusText}`);
        }
    } catch (e) {
        console.error("[Adventurer] Heartbeat connection completely failed. Is your Python server running?", e);
    }
}

// --- New quest detection (client-side) ---

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

// --- Quest video patching ---

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
    console.log("[Adventurer] Quest video patched - pause() blocked");
}

function unpatchQuestVideo() {
    if (!patchedVideo || !originalPause) return;
    patchedVideo.pause = originalPause;
    console.log("[Adventurer] Quest video unpatched - pause() restored");
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

    console.log("[Adventurer] Video observer started");
}

function stopVideoObserver() {
    if (!videoObserver) return;
    videoObserver.disconnect();
    videoObserver = null;
    console.log("[Adventurer] Video observer stopped");
}

// --- Helpers ---

function sleep(ms: number) {
    return new Promise(res => setTimeout(res, ms));
}

// --- Debug game spoof ---

let _debugGameQuestId: string | null = null;

function stopGameDebug() {
    if (!_debugGameQuestId) return;
    FluxDispatcher.dispatch({ type: "RUNNING_GAME_SET_DEBUG_GAME", game: null });
    _debugGameQuestId = null;
    console.log("[Adventurer] Debug game cleared");
}

async function launchGameDebug(quest: any): Promise<boolean> {
    const appId = quest?.config?.application?.id;
    const appName = quest?.config?.application?.name ?? appId;

    let exeName = `${appName}.exe`;
    try {
        const res = await fetch(`https://discord.com/api/v10/applications/public?application_ids=${appId}`);
        const data = await res.json();
        const appData = data?.[0];
        const exe = appData?.executables?.find((e: any) => e.os === "win32");
        if (exe?.name) exeName = exe.name.replace(">", "");
    } catch (e) {
        console.warn("[Adventurer] Could not fetch exe name, using fallback:", exeName, e);
    }

    const minMs = (settings.store.questStartDelayMin ?? 15) * 1000;
    const maxMs = (settings.store.questStartDelayMax ?? 180) * 1000;
    const range = Math.max(0, maxMs - minMs);
    const startDelay = minMs + Math.random() * range;
    
    // Compute exact end timestamp once and sync it over
    const endsAt = Date.now() + startDelay;
    await reportActiveStatus(quest.id, quest, { type: "waiting", endsAt });
    
    console.log(`[Adventurer] Waiting ${Math.round(startDelay / 1000)}s before spoofing ${appName}...`);
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
    console.log(`[Adventurer] Debug game set: ${appName} (${exeName}, pid ${pid})`);
    return true;
}

// --- Game launch / stop ---

async function stopGame(questName?: string) {
    if (settings.store.gameTrackingMode === "debug") {
        if (!_debugGameQuestId) return;
        
        const minMs = (settings.store.questStartDelayMin ?? 15) * 1000;
        const maxMs = (settings.store.questStartDelayMax ?? 180) * 1000;
        const range = Math.max(0, maxMs - minMs);
        const stopDelay = minMs + Math.random() * range;

        console.log(`[Adventurer] Waiting ${Math.round(stopDelay / 1000)}s before stopping ${questName ?? "game"}...`);
        Toasts.show({
            message: `Stopping "${questName ?? "game"}" in ${Math.round(stopDelay / 1000)}s...`,
            type: Toasts.Type.MESSAGE,
            id: Toasts.genId(),
            options: { duration: Math.min(stopDelay, 5000) }
        });

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

async function launchGame(appId: string, quest: any): Promise<boolean> {
    if (settings.store.gameTrackingMode === "debug") {
        return await launchGameDebug(quest);
    } else {
        try {
            const res = await fetch(`${getServer()}/run`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: appId, quest, userId: getCurrentUserId() })
            });
            if (!res.ok) {
                Toasts.show({
                    message: "Failed to reach game server - is it running?",
                    type: Toasts.Type.FAILURE,
                    id: Toasts.genId(),
                    options: { duration: 5000 }
                });
                return false;
            }
            return true;
        } catch (e) {
            console.error("[Adventurer] Server launch network error:", e);
            Toasts.show({
                message: "Failed to reach game server - is it running?",
                type: Toasts.Type.FAILURE,
                id: Toasts.genId(),
                options: { duration: 5000 }
            });
            return false;
        }
    }
}

// --- Completion tracking ---

async function waitForCompletion(quest: any, taskKey: string, target: number, questName: string) {
    if (settings.store.gameTrackingMode === "debug") {
        await new Promise<void>(resolve => {
            const onHeartbeat = (_event: any) => {
                const updated = getAcceptedQuests().find(q => q.id === quest.id);
                if (!updated) return;

                const progress = updated?.userStatus?.progress?.[taskKey]?.value ?? 0;
                console.log(`[Adventurer] ${questName}: ${progress}/${target}`);
                sendHeartbeat();

                if (progress >= target) {
                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
                    resolve();
                }
            };
            FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
        });

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
        await reportActiveStatus(null, null, null);
        return;
    }

    while (true) {
        await sleep(15000);

        const updated = getAcceptedQuests().find(q => q.id === quest.id);
        if (!updated) return;

        const progress = updated?.userStatus?.progress?.[taskKey]?.value ?? 0;
        console.log(`[Adventurer] ${questName}: ${progress}/${target}`);
        await sendHeartbeat();

        if (progress >= target) {
            await stopGame(questName);

            const buffer = 20 + Math.floor(Math.random() * 41);
            Toasts.show({
                message: `"${questName}" complete - waiting ${buffer}s buffer`,
                type: Toasts.Type.SUCCESS,
                id: Toasts.genId(),
                options: { duration: 4000 }
            });
            await sleep(buffer * 1000);
            return;
        }
    }
}

// --- Queue runner ---

async function runQueue() {
    if (running) return;
    running = true;

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) continue;

        const { quest, appId, questName, task } = current;

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

            await waitForCompletion(quest, task.key, task.target, questName);

        } else {
            if (!settings.store.enableGameTracking) {
                console.log(`[Adventurer] Game tracking disabled, skipping "${questName}"`);
                continue;
            }

            await stopGame();

            const ok = await launchGame(appId, quest);
            if (!ok) {
                Toasts.show({
                    message: `Failed to launch "${questName}"`,
                    type: Toasts.Type.FAILURE,
                    id: Toasts.genId(),
                    options: { duration: 4000 }
                });
                continue;
            }

            Toasts.show({
                message: `Running "${questName}"...`,
                type: Toasts.Type.MESSAGE,
                id: Toasts.genId(),
                options: { duration: 3000 }
            });

            await waitForCompletion(quest, task.key, task.target, questName);
        }

        Toasts.show({
            message: `Finished "${questName}"`,
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId(),
            options: { duration: 3000 }
        });
    }

    running = false;
}

function isQuestExpired(quest: any): boolean {
    const expiresAt = quest?.config?.expiresAt;
    if (!expiresAt) return false;
    return Date.now() > new Date(expiresAt).getTime();
}

function isQuestComplete(quest: any): boolean {
    const tasks = quest?.config?.taskConfigV2?.tasks;
    const progress = quest?.userStatus?.progress;

    if (!tasks || Object.keys(tasks).length === 0) return true;

    return Object.entries(tasks).every(([key, task]: [string, any]) => {
        const current = progress?.[key]?.value ?? 0;
        return current >= (task?.target ?? Infinity);
    });
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

        if (q?.userStatus?.completedAt) continue;
        if (q?.userStatus?.claimedAt) continue;
        if (isQuestExpired(q)) continue;

        newQuests.push(q);
    }

    for (const quest of newQuests) {
        const orbs = getOrbQuantity(quest);
        const isVideo = !!quest?.config?.taskConfigV2?.tasks?.["WATCH_VIDEO"];

        if (settings.store.notifyOrbsOnly && orbs === 0) continue;
        if (orbs < (settings.store.notifyMinOrbs ?? 0)) continue;
        if (isVideo && !settings.store.notifyVideoQuests) continue;

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
            onClick() {
                FluxDispatcher.dispatch({ type: "LAYER_POP_ALL" });
            }
        });
    }
}

async function processQuests(): Promise<void> {
    if (running) return;

    await sendHeartbeat();
    checkForNewQuests();

    const accepted = getAcceptedQuests();

    for (const quest of accepted) {
        const appId = quest?.config?.application?.id;
        const questName = quest?.config?.messages?.questName ?? quest?.id;

        if (!appId) continue;
        if (isQuestComplete(quest)) continue;
        if (seen.has(quest.id)) continue;

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
    const all = getAllQuests();

    if (all.length === 0) {
        Toasts.show({ message: "No quests found.", type: Toasts.Type.MESSAGE, id: Toasts.genId(), options: { duration: 3000 } });
        return;
    }

    const incomplete = all.filter(q => q?.userStatus !== null && !q?.userStatus?.completedAt && !isQuestComplete(q));

    Toasts.show({
        message: incomplete.length > 0 ? `Found ${incomplete.length} quest${incomplete.length === 1 ? "" : "s"} to run...` : "No incomplete quests found.",
        type: Toasts.Type.MESSAGE,
        id: Toasts.genId(),
        options: { duration: 3000 }
    });

    if (incomplete.length === 0) return;
    await processQuests();
}

export default definePlugin({
    name: "Adventurer",
    description: "Auto-runs Discord quests sequentially with completion tracking.",
    authors: [{ name: "ren", id: 163734654040539136n }],
    settings,

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

        initKnownQuests();

        FluxDispatcher.subscribe("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", processQuests);
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", processQuests);
        FluxDispatcher.subscribe("QUESTS_ENROLL_SUCCESS", processQuests);

        if (settings.store.enableVideoTabOut) {
            startVideoObserver();
            tryPatchNow();
        }

        sendHeartbeat(true);

        // Keep-alive check-in set to a stable 15 seconds
        _heartbeatIntervalHandle = setInterval(() => {
            sendHeartbeat(true);
        }, 15000);

        console.log("[Adventurer] Started");
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

        queue.length = 0;
        seen.clear();
        running = false;
        _lastHeartbeatQuestIds = "";
        _questIdsInitialized = false;
        _knownQuestIds.clear();

        console.log("[Adventurer] Stopped");
    }
});