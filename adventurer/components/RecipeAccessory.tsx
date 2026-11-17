/*
 * DiscordAdventurer: Custom Message Accessory for .advrecipe Attachments
 *
 * Implements:
 * - Attachment detection and extraction for .advrecipe files
 * - Interactive accessory card conforming to Discord native #message-accessories-<id> hierarchy
 * - 4px accent border (green verified, blurple normal, amber unverified, red error)
 * - 100% ASCII inline SVG icons (Adventurer logo, checkmark, disk, lightning, alert, target)
 * - One-click "Import Recipe" to disk persistence (~/.adventurer/recipes/) without DataStore
 * - One-click "Execute Recipe" client injection via cross-origin postMessage
 * - Defensive error cards for oversized (>10MB), empty 0-byte, corrupted JSON, network failures
 * - Strictly 100% ASCII only & Vencord ban-imports compliance
 */

import { React, showToast } from "@webpack/common";
import { Button } from "@components/Button";
// @ts-ignore
import { validateRecipe, type AdvRecipeFile } from "../experiences/recipe.ts";
// @ts-ignore
import { saveRecipeDisk, atomicSaveRecipe, listLocalRecipes } from "../experiences/storage.ts";
// @ts-ignore
import { buildExecuteRecipeMessage, COMPLETION_MESSAGE_TAG, ADVENTURER_EXECUTE_RECIPE_TYPE } from "../experiences/completion.ts";

export interface MessageAttachment {
    filename: string;
    id?: string;
    proxy_url?: string;
    size?: number;
    url?: string;
    content?: string;
    content_type?: string;
    [key: string]: any;
}

export type AttachmentLoadStatus = "loading" | "ready" | "corrupted" | "invalid_schema" | "oversized" | "network_error";
export type ImportStatus = "idle" | "importing" | "imported" | "error";
export type ExecuteStatus = "idle" | "running" | "executed" | "error";

export function isRecipeAttachment(attachment: any): boolean {
    if (!attachment || typeof attachment !== "object") return false;
    const name = String(attachment.filename || "");
    return name.toLowerCase().endsWith(".advrecipe");
}

export function getRecipeAttachments(message: any): MessageAttachment[] {
    if (!message || !Array.isArray(message.attachments)) return [];
    return message.attachments.filter(isRecipeAttachment);
}

export function getCardHeader(recipe: AdvRecipeFile): { title: string; appId: string; verifiedBadge: string } {
    return {
        title: recipe?.name || "Quest Recipe",
        appId: recipe?.application_id || "",
        verifiedBadge: recipe?.verifiedCompletion ? "Verified Quest" : "Unverified"
    };
}

export function renderAccessoryDom(att: MessageAttachment, messageId: string = "mock"): { containerId: string; className: string; fileName: string } {
    return {
        containerId: `#message-accessories-${messageId}`,
        className: "adventurer-recipe-card",
        fileName: att ? att.filename : ""
    };
}

export function parseRecipeContent(content: string): AdvRecipeFile {
    if (!content || !content.trim()) {
        throw new Error("Empty attachment file");
    }
    let parsed: any;
    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error("Corrupted recipe file");
    }
    if (parsed && typeof parsed === "object") {
        if (typeof parsed.scene !== "string" || !parsed.scene.trim()) {
            parsed.scene = "*";
        }
        if (typeof parsed.name !== "string" || !parsed.name.trim()) {
            parsed.name = parsed.application_id ? `Experience ${parsed.application_id}` : "Quest Recipe";
        }
    }
    const val = validateRecipe(parsed);
    if (!val.valid) {
        throw new Error("Invalid recipe schema: " + (val.errors?.join(", ") || "validation failed"));
    }
    return parsed as AdvRecipeFile;
}

export const parseRecipeAttachment = parseRecipeContent;

export async function fetchRecipeAttachment(attachment: MessageAttachment | string): Promise<AdvRecipeFile> {
    let att: MessageAttachment;
    if (typeof attachment === "string") {
        att = { filename: "quest.advrecipe", id: "str", size: 1, url: attachment };
    } else {
        att = attachment;
    }

    if (!att || typeof att !== "object") {
        throw new Error("Invalid attachment object");
    }

    if (att.content !== undefined) {
        return parseRecipeContent(att.content);
    }

    if (att.size === 0) {
        throw new Error("Empty attachment file");
    }

    if (typeof att.size === "number" && att.size > 10 * 1024 * 1024) {
        throw new Error("Recipe file exceeds 10MB limit");
    }

    const urls = [att.url, att.proxy_url].filter((u): u is string => typeof u === "string" && u.length > 0);
    if (urls.length === 0) {
        throw new Error("Attachment URL is missing");
    }

    let text: string | null = null;
    let lastError: string = "fetch failed";

    const nativeHelper = typeof globalThis !== "undefined"
        ? (globalThis as any).VencordNative?.pluginHelpers?.Adventurer
        : null;

    if (nativeHelper && typeof nativeHelper.fetchAttachmentText === "function") {
        for (const u of urls) {
            try {
                const nRes = await nativeHelper.fetchAttachmentText(u);
                if (nRes?.ok && typeof nRes.text === "string") {
                    text = nRes.text;
                    break;
                }
                if (nRes?.error) lastError = nRes.error;
            } catch (err: any) {
                lastError = err?.message || "native fetch failed";
            }
        }
    }

    if (text === null) {
        const targetUrl = urls[0];
        let res: Response;
        try {
            res = await fetch(targetUrl);
        } catch (err: any) {
            throw new Error("Network timeout: " + (err?.message || lastError));
        }

        if (!res.ok) {
            throw new Error("Failed to download attachment: " + (res.statusText || String(res.status)));
        }

        text = await res.text();
    }

    if (text.length === 0) {
        throw new Error("Empty attachment file");
    }
    if (text.length > 10 * 1024 * 1024) {
        throw new Error("Recipe file exceeds 10MB limit");
    }

    return parseRecipeContent(text);
}

export async function importRecipe(
    recipe: AdvRecipeFile,
    customDir?: string
): Promise<{ ok: boolean; path?: string; error?: string }> {
    return await saveRecipeDisk(recipe, customDir);
}

export const importRecipeFromAccessory = importRecipe;

export function executeRecipe(
    recipe: AdvRecipeFile,
    options?: { customDir?: string; broadcastWindow?: boolean }
): { type: string; recipe: AdvRecipeFile; execute: boolean } {
    const payload = {
        type: "completion_inject",
        recipe,
        execute: true
    };
    const executeMsg = buildExecuteRecipeMessage(recipe);

    if (typeof document !== "undefined") {
        try {
            document.querySelectorAll("iframe").forEach(frame => {
                try {
                    const src = (frame as HTMLIFrameElement).src;
                    if (!src) return;
                    if (!/(^|\.)discordsays\.com$/i.test(new URL(src).hostname)) return;
                    (frame as HTMLIFrameElement).contentWindow?.postMessage(payload, "*");
                    (frame as HTMLIFrameElement).contentWindow?.postMessage(executeMsg, "*");
                } catch {}
            });
        } catch {}
    }

    if (typeof window !== "undefined" && options?.broadcastWindow !== false) {
        try {
            window.postMessage(payload, "*");
            window.postMessage(executeMsg, "*");
        } catch {}
    }

    return payload;
}

export const injectAndExecuteRecipe = executeRecipe;

function notify(text: string, variant?: "success" | "critical") {
    try {
        if (typeof showToast === "function") {
            showToast({
                text,
                ...(variant ? { variant } : {})
            });
        }
    } catch {}
}

/* --- Inline ASCII SVG Icons --- */

function AdventurerIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5865f2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
        </svg>
    );
}

function VerifiedCheckIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#23a55a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}

function DiskIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
        </svg>
    );
}

function LightningIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
    );
}

function AlertIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f23f43" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
    );
}

function TargetIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="6" />
            <circle cx="12" cy="12" r="2" />
        </svg>
    );
}

function OrbsIcon({ size = 18 }: { size?: number }) {
    return (
        <svg aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="none" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
            <path d="M11.75 7.57a5.12 5.12 0 0 1-3.86 3.87.42.42 0 0 0 0 .82 5.1 5.1 0 0 1 3.86 3.86.42.42 0 0 0 .81 0 5.12 5.12 0 0 1 3.87-3.86.42.42 0 0 0 0-.82 5.15 5.15 0 0 1-3.87-3.86.42.42 0 0 0-.81-.01Z" fill="currentColor" />
            <path fillRule="evenodd" d="M11.64.22c.3-.12.62-.12.91 0l7.49 3.1c.29.12.52.35.64.64l3.1 7.49c.12.29.12.62 0 .9l-3.1 7.5c-.12.28-.35.51-.64.63l-7.49 3.1c-.29.13-.62.13-.9 0l-7.5-3.1c-.28-.12-.52-.35-.64-.64l-3.1-7.48c-.12-.3-.12-.62 0-.91l3.1-7.49c.12-.29.36-.52.65-.64l7.48-3.1ZM20.6 11.5 12.5 3.4a.56.56 0 0 0-.8 0l-8.1 8.1a.56.56 0 0 0 0 .8l8.1 8.1c.22.22.57.22.8 0l8.1-8.1a.56.56 0 0 0 0-.8Zm-8.85-3.94a5.12 5.12 0 0 1-3.86 3.87.42.42 0 0 0 0 .82 5.1 5.1 0 0 1 3.86 3.86.42.42 0 0 0 .81 0 5.12 5.12 0 0 1 3.87-3.86.42.42 0 0 0 0-.82 5.15 5.15 0 0 1-3.87-3.86.42.42 0 0 0-.81-.01Z" clipRule="evenodd" fill="currentColor" />
        </svg>
    );
}

interface QuestDisplayInfo {
    title: string;
    bannerUrl: string | null;
    orbsEarned: number | null;
}

function resolveQuestDisplayInfo(recipe: AdvRecipeFile | null, attachment?: MessageAttachment): QuestDisplayInfo {
    let appId = String(recipe?.application_id || "").trim();
    if (!appId && attachment?.filename) {
        const m = String(attachment.filename).match(/^(\d+)__/);
        if (m) appId = m[1];
    }

    let title = (recipe?.name && !/^Experience \d+$/.test(recipe.name)) ? recipe.name : "";
    let bannerUrl: string | null = null;
    let orbsEarned: number | null = null;

    if (appId && typeof globalThis !== "undefined") {
        try {
            const wp = (globalThis as any).Vencord?.Webpack;
            const QuestStore = wp?.findStore?.("QuestStore");
            if (QuestStore?.quests) {
                for (const q of QuestStore.quests.values()) {
                    const qAppId = q?.config?.application?.id;
                    const matchesApp = qAppId && String(qAppId) === appId;
                    const matchesTask = Object.values<any>(q?.config?.taskConfigV2?.tasks ?? {}).some(
                        (t: any) => (t?.applications ?? []).some((a: any) => String(a?.id) === appId)
                    );
                    if (matchesApp || matchesTask) {
                        if (!title) {
                            title = String(q?.config?.messages?.questName || q?.config?.application?.name || "").trim();
                        }
                        const hero = q?.config?.assets?.hero || q?.config?.assets?.questBarHero;
                        if (hero && typeof hero === "string" && hero !== "PLACEHOLDER") {
                            bannerUrl = hero.startsWith("http") ? hero : `https://cdn.discordapp.com/${hero.replace(/^\/+/, "")}`;
                        }
                        const rewards = q?.config?.rewardsConfig?.rewards;
                        if (Array.isArray(rewards)) {
                            for (const r of rewards) {
                                if (typeof r?.orbQuantity === "number" && r.orbQuantity > 0) {
                                    orbsEarned = r.orbQuantity;
                                    break;
                                }
                            }
                        }
                        if (bannerUrl && title) break;
                    }
                }
            }
            if (!title) {
                const AppStore = wp?.Common?.ApplicationStore || wp?.findStore?.("ApplicationStore");
                const app = AppStore?.getApplication?.(appId);
                if (app?.name) title = String(app.name).trim();
            }
        } catch { }
    }

    if (!title) {
        title = recipe?.name || (appId ? `Experience ${appId}` : "Quest Recipe");
    }

    return { title, bannerUrl, orbsEarned };
}

export function RecipeAccessoryCard(props: {
    attachment: MessageAttachment;
    message?: any;
    customDir?: string;
    onImport?: (recipe: AdvRecipeFile) => void;
    onExecute?: (recipe: AdvRecipeFile) => void;
}): JSX.Element {
    const { attachment, message, customDir } = props;

    let initialRecipe: AdvRecipeFile | null = null;
    let initialStatus: AttachmentLoadStatus = "loading";
    let initialError: string | null = null;

    if (attachment?.size === 0) {
        initialStatus = "corrupted";
        initialError = "Empty attachment file";
    } else if (typeof attachment?.size === "number" && attachment.size > 10 * 1024 * 1024) {
        initialStatus = "oversized";
        initialError = "Recipe file exceeds 10MB limit";
    } else if (attachment?.content !== undefined) {
        try {
            initialRecipe = parseRecipeContent(attachment.content);
            initialStatus = "ready";
        } catch (err: any) {
            initialStatus = "corrupted";
            initialError = err?.message || "Corrupted recipe file";
        }
    }

    const [recipe, setRecipe] = React.useState<AdvRecipeFile | null>(initialRecipe);
    const [loadStatus, setLoadStatus] = React.useState<AttachmentLoadStatus>(initialStatus);
    const [loadError, setLoadError] = React.useState<string | null>(initialError);

    const [importStatus, setImportStatus] = React.useState<ImportStatus>("idle");
    const [executeStatus, setExecuteStatus] = React.useState<ExecuteStatus>("idle");
    const [gameWarning, setGameWarning] = React.useState<string | null>(null);

    const loadRemote = React.useCallback(async () => {
        if (!attachment || attachment.content !== undefined) return;
        setLoadStatus("loading");
        setLoadError(null);

        try {
            const loaded = await fetchRecipeAttachment(attachment);
            setRecipe(loaded);
            setLoadStatus("ready");
        } catch (err: any) {
            const msg = err?.message || "Corrupted recipe file";
            setLoadStatus("corrupted");
            setLoadError(msg);
            notify("Download failed: " + msg, "critical");
        }
    }, [attachment?.url, attachment?.proxy_url, attachment?.content]);

    React.useEffect(() => {
        if (attachment?.content === undefined && loadStatus === "loading") {
            loadRemote();
        }
    }, [loadRemote]);

    const handleImport = async () => {
        if (!recipe) return;
        setImportStatus("importing");
        try {
            const res = await importRecipe(recipe, customDir);
            if (res.ok) {
                setImportStatus("imported");
                notify("Recipe imported successfully", "success");
                props.onImport?.(recipe);
            } else {
                setImportStatus("error");
                notify("Failed to import recipe: " + (res.error || "unknown error"), "critical");
            }
        } catch (e: any) {
            setImportStatus("error");
            notify("Failed to import recipe: " + (e?.message || "unknown error"), "critical");
        }
    };

    const handleExecute = async () => {
        if (!recipe) return;
        setExecuteStatus("running");
        setGameWarning(null);

        try {
            await importRecipe(recipe, customDir);
            setImportStatus("imported");
        } catch {}

        let activeFrames = 0;
        if (typeof document !== "undefined") {
            try {
                document.querySelectorAll("iframe").forEach(frame => {
                    const src = (frame as HTMLIFrameElement).src;
                    if (src && /(^|\.)discordsays\.com$/i.test(new URL(src).hostname)) {
                        activeFrames++;
                    }
                });
            } catch {}
        }

        if (activeFrames === 0 && typeof document !== "undefined") {
            setGameWarning("Start the game to execute this recipe");
            notify("Start the game to execute this recipe");
        } else {
            notify("Executing quest recipe: " + recipe.name, "success");
        }

        executeRecipe(recipe, { customDir });
        setExecuteStatus("executed");
        props.onExecute?.(recipe);
    };

    const isVerified = Boolean(recipe?.verifiedCompletion);
    const hasError = loadStatus === "corrupted" || loadStatus === "oversized" || loadStatus === "invalid_schema" || loadStatus === "network_error";
    const questInfo = resolveQuestDisplayInfo(recipe, attachment);
    const stepsCount = recipe?.completion?.entries?.length || 0;

    const badgeText = hasError
        ? "RECIPE ERROR"
        : loadStatus === "loading"
            ? "LOADING RECIPE"
            : isVerified
                ? "VERIFIED RECIPE"
                : "ADVENTURER RECIPE";

    const ActionButton = Button || (({ children, ...btnProps }: any) => <button {...btnProps}>{children}</button>);

    return (
        <div
            className="adventurer-recipe-card"
            data-testid="adventurer-recipe-card"
            style={{
                maxWidth: "432px",
                width: "100%",
                margin: "4px 0"
            }}
        >
        <div
            className="container_Bs1Jwb"
            style={{
                backgroundColor: "var(--background-surface-high, var(--background-secondary, #232428))",
                border: "1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))",
                borderRadius: "8px",
                width: "100%",
                overflow: "hidden",
                boxSizing: "border-box",
                fontFamily: "var(--font-primary, 'gg sans', sans-serif)",
                color: "var(--text-default, #dbdee1)",
                display: "flex",
                flexDirection: "column"
            }}
        >
            {/* Native Shop-style Top Banner */}
            <div
                className="artwork_Bs1Jwb"
                style={{
                    position: "relative",
                    width: "100%",
                    height: "200px",
                    backgroundColor: "var(--background-base-lowest, #141518)",
                    overflow: "hidden"
                }}
            >
                {questInfo.bannerUrl ? (
                    <img
                        src={questInfo.bannerUrl}
                        alt={questInfo.title}
                        style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                            display: "block"
                        }}
                    />
                ) : (
                    <div style={{
                        width: "100%",
                        height: "100%",
                        background: "linear-gradient(135deg, #1e222e 0%, #14161f 100%)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "rgba(255, 255, 255, 0.14)"
                    }}>
                        <OrbsIcon size={64} />
                    </div>
                )}

                <div
                    className="artworkHeader_Bs1Jwb"
                    style={{
                        position: "absolute",
                        top: "12px",
                        left: "12px",
                        right: "12px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        pointerEvents: "none"
                    }}
                >
                    <div className="productCardBadge_Ruy7qb">
                        <div
                            className="defaultColor_MMUIw6 body-xs/semibold_RAOoio badge_4guu7- inverted_4guu7-"
                            data-text-variant="body-xs/semibold"
                            style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                padding: "2px 8px",
                                borderRadius: "12px",
                                backgroundColor: "rgba(255, 255, 255, 0.92)",
                                color: "#111214",
                                fontSize: "11px",
                                fontWeight: 700,
                                letterSpacing: "0.02em",
                                textTransform: "uppercase"
                            }}
                        >
                            {isVerified ? <VerifiedCheckIcon /> : <OrbsIcon size={12} />}
                            <span className="label_4guu7-">{badgeText}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Native Shop-style Details Footer */}
            <div
                className="details_Bs1Jwb"
                style={{
                    padding: "16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px"
                }}
            >
                <div className="info_Bs1Jwb" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <span
                        className="lineClamp1_MMUIw6 heading-sm/medium_RAOoio"
                        data-text-variant="heading-sm/medium"
                        style={{
                            color: "var(--text-strong, #f2f3f5)",
                            fontSize: "16px",
                            fontWeight: 600,
                            lineHeight: "20px"
                        }}
                    >
                        {questInfo.title}
                    </span>

                    {hasError ? (
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#f23f43", fontSize: "13px" }}>
                            <AlertIcon />
                            <span>{loadError || "Unable to load recipe attachment payload."}</span>
                        </div>
                    ) : loadStatus === "loading" ? (
                        <div style={{ fontSize: "13px", color: "var(--text-muted, #949ba4)" }}>
                            Loading recipe attachment...
                        </div>
                    ) : (
                        <div className="priceRow_Bs1Jwb" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <div
                                className="container_IXEn3U"
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "6px",
                                    color: "var(--text-default, #dbdee1)",
                                    fontSize: "14px",
                                    fontWeight: 600
                                }}
                            >
                                {questInfo.orbsEarned ? (
                                    <>
                                        <OrbsIcon size={18} />
                                        <span>{questInfo.orbsEarned} Orbs earned</span>
                                    </>
                                ) : (
                                    <span>{stepsCount} {stepsCount === 1 ? "step" : "steps"}</span>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Action Buttons */}
                {hasError ? (
                    attachment?.url ? (
                        <div className="stack_TWWX0S" style={{ display: "flex", gap: "8px", width: "100%" }}>
                            <ActionButton
                                onClick={loadRemote}
                                className="button_F7qvhY md_F7qvhY secondary_F7qvhY hasText_F7qvhY fullWidth_F7qvhY"
                                type="button"
                                style={{
                                    flex: 1,
                                    height: "38px",
                                    borderRadius: "8px",
                                    backgroundColor: "var(--button-secondary-background, #393a41)",
                                    color: "var(--text-strong, #ffffff)",
                                    fontSize: "14px",
                                    fontWeight: 500,
                                    border: "none",
                                    cursor: "pointer"
                                }}
                            >
                                Retry Download
                            </ActionButton>
                        </div>
                    ) : null
                ) : loadStatus === "ready" && recipe ? (
                    <div className="stack_TWWX0S" style={{ display: "flex", gap: "8px", width: "100%" }}>
                        <ActionButton
                            onClick={handleImport}
                            disabled={importStatus === "importing"}
                            className="button_F7qvhY md_F7qvhY secondary_F7qvhY hasText_F7qvhY fullWidth_F7qvhY"
                            type="button"
                            style={{
                                flex: 1,
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: "6px",
                                height: "38px",
                                borderRadius: "8px",
                                backgroundColor: "var(--button-secondary-background, #393a41)",
                                color: "var(--text-strong, #ffffff)",
                                fontSize: "14px",
                                fontWeight: 500,
                                border: "none",
                                cursor: "pointer"
                            }}
                        >
                            <DiskIcon />
                            <span>{importStatus === "importing" ? "Importing..." : importStatus === "imported" ? "Imported" : "Import Recipe"}</span>
                        </ActionButton>

                        <ActionButton
                            onClick={handleExecute}
                            disabled={executeStatus === "running"}
                            className="button_F7qvhY md_F7qvhY primary_F7qvhY hasText_F7qvhY fullWidth_F7qvhY"
                            type="button"
                            style={{
                                flex: 1,
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: "6px",
                                height: "38px",
                                borderRadius: "8px",
                                backgroundColor: "var(--button-filled-brand-background, #5865f2)",
                                color: "#ffffff",
                                fontSize: "14px",
                                fontWeight: 500,
                                border: "none",
                                cursor: "pointer"
                            }}
                        >
                            <LightningIcon />
                            <span>{executeStatus === "running" ? "Running..." : executeStatus === "executed" ? "Executed" : "Execute Recipe"}</span>
                        </ActionButton>
                    </div>
                ) : null}

                {gameWarning && (
                    <div style={{
                        fontSize: "12px",
                        color: "#f0b232",
                        backgroundColor: "rgba(240, 178, 50, 0.1)",
                        padding: "6px 10px",
                        borderRadius: "6px"
                    }}>
                        {gameWarning}
                    </div>
                )}
            </div>
        </div>
        </div>
    );
}

export function RecipeAccessory(props: { message: any; channel?: any }): JSX.Element | null {
    if (!props || !props.message) return null;
    const attachments = getRecipeAttachments(props.message);
    if (!attachments || attachments.length === 0) return null;

    return (
        <div
            className="adventurer-recipe-accessories-container"
            style={{ display: "flex", flexDirection: "column", gap: "8px", margin: "4px 0" }}
        >
            {attachments.map(att => (
                <RecipeAccessoryCard
                    key={att.id || att.filename}
                    attachment={att}
                    message={props.message}
                />
            ))}
        </div>
    );
}

export function renderRecipeAccessory(props: any): JSX.Element | null {
    if (!props || !props.message) return null;
    return <RecipeAccessory message={props.message} channel={props.channel} />;
}
