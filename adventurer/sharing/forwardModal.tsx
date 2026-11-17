/*
 * Adventurer: Native Forward Dialog Patching & Community Checkbox Integration
 *
 * Implements:
 * - Integration with Discord native Forward Modal (findByProps("fO", "aU"))
 * - "Share with the community" footer checkbox and recipe preview chip
 * - Module state store (useCommunityShareState, setCommunityShare, resetForwardModalState)
 * - Submission interception with double-lock gating and in-flight locking
 * - Dual-path recipient and community distribution
 *
 * Rules:
 * - STRICT ASCII ONLY: No unicode em-dash or en-dash characters.
 * - Compatible with Node.js test runner and Vencord runtime.
 */

import { React } from "@webpack/common";
// @ts-ignore
import { canShareRecipe, type AdvRecipeFile } from "../experiences/recipe.ts";
// @ts-ignore
import { COMMUNITY_CHANNEL_ID, getUtf8ByteLength, shareRecipeWithCommunity, dispatchToRecipients, resolveActivityName, normalizeRecipeForSharing } from "./community.ts";

export interface ForwardModalState {
    shareWithCommunity: boolean;
    activeRecipe: AdvRecipeFile | null;
    isSubmitting: boolean;
    error: string | null;
}

const _state: ForwardModalState = {
    shareWithCommunity: false,
    activeRecipe: null,
    isSubmitting: false,
    error: null
};

const _listeners = new Set<() => void>();

function notifyListeners(): void {
    _listeners.forEach(fn => {
        try {
            fn();
        } catch {
            // Ignore subscriber errors
        }
    });
}

export function subscribeForwardModalState(listener: () => void): () => void {
    _listeners.add(listener);
    return () => {
        _listeners.delete(listener);
    };
}

export function getForwardModalState(): ForwardModalState {
    return _state;
}

export function setCommunityShare(checked: boolean): void {
    _state.shareWithCommunity = Boolean(checked);
    notifyListeners();
}

export function resetForwardModalState(): void {
    _state.shareWithCommunity = false;
    _state.activeRecipe = null;
    _state.isSubmitting = false;
    _state.error = null;
    notifyListeners();
}

/**
 * React hook to bind community checkbox state to modal components.
 */
export function useCommunityShareState(): [boolean, (checked: boolean) => void] {
    const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);

    // @ts-ignore
    React.useEffect(() => {
        return subscribeForwardModalState(() => forceUpdate());
    }, []);

    return [_state.shareWithCommunity, setCommunityShare];
}

/**
 * Chip component previewing the .advrecipe filename inside the forward dialog.
 */
export function RecipePreviewChip({ filename }: { filename: string }) {
    return (
        <div
            className="adventurer-recipe-chip"
            data-testid="adventurer-recipe-chip"
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "3px 8px",
                borderRadius: "4px",
                background: "var(--background-secondary-alt, #2b2d31)",
                color: "var(--text-normal, #dbdee1)",
                fontSize: "12px",
                fontWeight: 500,
                border: "1px solid var(--border-subtle, rgba(255,255,255,0.08))"
            }}
        >
            <span role="img" aria-label="recipe" style={{ fontSize: "14px" }}>
                [RECIPE]
            </span>
            <span>{filename}</span>
        </div>
    );
}

/**
 * Checkbox component injected into Discord's Forward Dialog footer.
 */
export function CommunityShareCheckbox() {
    const [checked, setChecked] = useCommunityShareState();
    const state = getForwardModalState();
    const recipeName = state.activeRecipe?.name || "Recipe";
    const filename = `${state.activeRecipe?.application_id || "quest"}.advrecipe`;

    return (
        <div
            className="adventurer-community-share-container"
            data-testid="adventurer-community-share-container"
            style={{
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                padding: "8px 12px",
                marginTop: "8px",
                marginBottom: "8px",
                borderRadius: "8px",
                background: "var(--background-secondary, #2b2d31)",
                border: "1px solid var(--background-modifier-accent, rgba(255,255,255,0.06))"
            }}
        >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <label
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        cursor: "pointer",
                        userSelect: "none"
                    }}
                >
                    <input
                        type="checkbox"
                        checked={checked}
                        onChange={e => setChecked(e.target.checked)}
                        style={{ cursor: "pointer", width: "16px", height: "16px" }}
                    />
                    <span
                        style={{
                            fontSize: "13px",
                            fontWeight: 600,
                            color: "var(--header-primary, #ffffff)"
                        }}
                    >
                        Share with the community
                    </span>
                </label>
                {state.activeRecipe && <RecipePreviewChip filename={filename} />}
            </div>
            <div
                style={{
                    fontSize: "11px",
                    color: "var(--text-muted, #949ba4)",
                    paddingLeft: "24px",
                    lineHeight: "1.3"
                }}
            >
                Post recipe automatically to #community-recipes in the Adventurer server.
            </div>
        </div>
    );
}

/**
 * Synthetic Discord message payload required by Discord's fO launcher.
 */
export function createRecipeMessage(recipe: AdvRecipeFile): any {
    const filename = `${recipe.application_id || "quest"}.advrecipe`;
    const jsonStr = JSON.stringify(recipe, null, 2);
    const size = getUtf8ByteLength(jsonStr);

    let wp: any = null;
    try {
        wp = (globalThis as any).Vencord?.Webpack;
    } catch { }

    const currentUser = wp?.Common?.UserStore?.getCurrentUser?.() ?? {
        id: "0",
        username: "Adventurer",
        avatar: null
    };
    const momentFn = wp?.Common?.moment;
    const timestamp = momentFn ? momentFn() : new Date().toISOString();

    const displayName = resolveActivityName(recipe);
    const base = {
        id: `adv-recipe-${Date.now()}`,
        type: 0,
        channel_id: "0",
        content: `Adventurer Quest Recipe: **${displayName}**`,
        author: currentUser,
        attachments: [
            {
                id: "0",
                filename,
                size,
                content_type: "application/json",
                url: `https://cdn.discordapp.com/attachments/0/0/${filename}`,
                proxy_url: `https://media.discordapp.net/attachments/0/0/${filename}`
            }
        ],
        embeds: [],
        reactions: [],
        mentions: [],
        mentionRoles: [],
        mentionChannels: [],
        components: [],
        stickerItems: [],
        flags: 0,
        timestamp
    };

    try {
        const MessageCtor = wp?.find?.(
            (m: any) => typeof m === "function" && m.prototype && typeof m.prototype.isEdited === "function"
        );
        if (MessageCtor) {
            return new MessageCtor(base);
        }
    } catch { }

    return base;
}

/**
 * Intercepts Discord's Forward Dialog submission:
 * - Lock 1 & Lock 2 double-check recipe.verifiedCompletion === true.
 * - In-flight lock blocks duplicate submissions on rapid clicks.
 * - Dispatches to selected individual recipient channels.
 * - Dispatches to community channel 1562024068838854726 if checkbox is checked.
 * - Resets modal state upon completion.
 */
function showForwardToast(message: string, isError: boolean = false): void {
    try {
        const Toasts = (globalThis as any).Vencord?.Webpack?.Common?.Toasts;
        if (Toasts?.show) {
            Toasts.show({
                message,
                type: isError ? (Toasts.Type?.FAILURE ?? 2) : (Toasts.Type?.SUCCESS ?? 1),
                id: Toasts.genId ? Toasts.genId() : String(Date.now()),
                options: { duration: 4000 }
            });
        }
    } catch { }
}

async function resolveDestinationChannelIds(destinations: any[]): Promise<string[]> {
    const ids: string[] = [];
    let privateChannelActions: any = null;
    try {
        const wp = (globalThis as any).Vencord?.Webpack;
        privateChannelActions = wp?.findByProps?.("openPrivateChannel", "ensurePrivateChannel")
            || wp?.findByProps?.("getOrEnsurePrivateChannel");
    } catch { }

    for (const dest of destinations || []) {
        if (!dest) continue;
        if (typeof dest === "string") {
            ids.push(dest);
            continue;
        }
        if (dest.type === "user" && dest.id) {
            try {
                if (typeof privateChannelActions?.getOrEnsurePrivateChannel === "function") {
                    const chId = await privateChannelActions.getOrEnsurePrivateChannel(dest.id);
                    if (chId) { ids.push(String(chId)); continue; }
                } else if (typeof privateChannelActions?.ensurePrivateChannel === "function") {
                    const chId = await privateChannelActions.ensurePrivateChannel(dest.id);
                    if (chId) { ids.push(String(chId)); continue; }
                } else if (typeof privateChannelActions?.openPrivateChannel === "function") {
                    const chId = await privateChannelActions.openPrivateChannel(dest.id);
                    if (chId) { ids.push(String(chId)); continue; }
                }
            } catch (e) {
                console.error("[Adventurer] Failed resolving DM channel for user", dest.id, e);
            }
        }
        const raw = dest.channel_id || dest.id || "";
        if (raw) ids.push(String(raw));
    }
    return [...new Set(ids)];
}

export async function customSendHandler(
    destinations: any[],
    commentOrOptions?: string | { withMessage?: string }
): Promise<void> {
    if (_state.isSubmitting) {
        return;
    }
    _state.isSubmitting = true;
    notifyListeners();

    const commentText = typeof commentOrOptions === "string"
        ? commentOrOptions
        : commentOrOptions?.withMessage;

    try {
        const recipe = _state.activeRecipe;

        // Lock 2 double-check
        if (!recipe || recipe.verifiedCompletion !== true || !canShareRecipe(recipe)) {
            _state.error = "Share blocked: quest incomplete.";
            throw new Error("Share blocked: quest incomplete.");
        }

        const targetIds = await resolveDestinationChannelIds(destinations || []);
        const errors: string[] = [];
        let anySuccess = false;

        // Path A: Forward to selected individual recipients
        if (targetIds.length > 0) {
            const res = await dispatchToRecipients(targetIds, recipe, {
                messageContent: commentText
            });
            if (res.successful.length > 0) anySuccess = true;
            for (const f of res.failed) {
                errors.push(f.error || `Failed sending to ${f.channelId}`);
            }
        }

        // Path B: Share with community channel if opt-in checkbox is checked
        if (_state.shareWithCommunity) {
            const commRes = await shareRecipeWithCommunity(recipe, {
                messageContent: commentText
            });
            if (commRes.ok) {
                anySuccess = true;
            } else {
                errors.push(commRes.error || "Community share failed");
            }
        }

        if (errors.length > 0) {
            console.error("[Adventurer] Recipe share error(s):", errors);
            showForwardToast(`Failed to share recipe: ${errors[0]}`, true);
        } else if (anySuccess) {
            showForwardToast("Recipe shared!");
        }
    } finally {
        closeForwardModal();
        resetForwardModalState();
    }
}

export const handleForwardSubmit = customSendHandler;

/**
 * Safely resolves Discord's native Forward Dialog module ({ fO, aU, Be }) from @webpack.
 */
function getForwardModalModule(): any {
    try {
        const webpack = require("@webpack");
        if (typeof webpack?.findByProps === "function") {
            const mod = webpack.findByProps("fO", "aU");
            if (mod) return mod;
        }
        if (typeof webpack?.find === "function") {
            const mod = webpack.find((m: any) => m?.fO && m?.aU);
            if (mod) return mod;
        }
    } catch {
        // Fallback when @webpack is unavailable
    }

    try {
        const wp = (globalThis as any).Vencord?.Webpack;
        if (typeof wp?.findByProps === "function") {
            const mod = wp.findByProps("fO", "aU");
            if (mod) return mod;
        }
        if (typeof wp?.find === "function") {
            const mod = wp.find((m: any) => m?.fO && m?.aU);
            if (mod) return mod;
        }
    } catch { }

    return null;
}

/**
 * Launches Discord's native Forward Dialog populated with the recipe attachment.
 * Enforces Lock 2: verifiedCompletion must be true.
 */
export function openRecipeForwardModal(
    recipe: AdvRecipeFile,
    options?: {
        source?: string;
        initialSelectedDestinations?: any[];
        defaultShareWithCommunity?: boolean;
    }
): void {
    // Lock 2 Pre-flight gate check
    if (!recipe || recipe.verifiedCompletion !== true || !canShareRecipe(recipe)) {
        throw new Error("Share blocked: quest incomplete.");
    }

    const normalizedRecipe = normalizeRecipeForSharing(recipe);
    _state.activeRecipe = normalizedRecipe;
    _state.shareWithCommunity = Boolean(options?.defaultShareWithCommunity ?? false);
    _state.isSubmitting = false;
    _state.error = null;
    notifyListeners();

    const forwardModule = getForwardModalModule();
    if (forwardModule && typeof forwardModule.fO === "function") {
        const msg = createRecipeMessage(normalizedRecipe);
        forwardModule.fO({
            message: msg,
            source: options?.source || "adventurer",
            initialSelectedDestinations: options?.initialSelectedDestinations || [],
            customSendHandler: (dests: any[], comment?: any) => customSendHandler(dests, comment)
        });
    }

    installForwardModalDOMObserver();
    if (typeof setTimeout === "function") {
        setTimeout(() => tryInjectCommunityCheckbox(), 50);
    }
}

/**
 * Closes Discord's Forward Dialog and resets state.
 */
export function closeForwardModal(): void {
    const forwardModule = getForwardModalModule();
    if (forwardModule && typeof forwardModule.Be === "function") {
        try {
            forwardModule.Be();
        } catch {
            // Ignore modal close errors
        }
    }

    resetForwardModalState();
}

// Webpack AST Patches for chunk 92961 (ForwardModal)
export const forwardModalPatches = [
    {
        find: 'modalKey:"forward-modal"',
        replacement: {
            match: /(\(0,(\i)\.jsx\)\(\i\.\i,\{children:\(0,\i\.jsx\)\(\i\.\i,\{type:"submit")/,
            replace: "(0,$2.jsx)($self.CommunityShareCheckbox,{}),$1"
        }
    }
];

// Fallback DOM Observer to ensure checkbox renders across Discord client variations
let _modalObserver: MutationObserver | null = null;

function tryInjectCommunityCheckbox(): void {
    if (typeof document === "undefined") return;
    const state = getForwardModalState();
    if (!state.activeRecipe) return;

    const modal = document.querySelector('[role="dialog"]');
    if (!modal) return;

    const footer = modal.querySelector('[class*="footer"]');
    if (!footer) return;

    if (footer.querySelector(".adventurer-community-share-container")) {
        return;
    }

    const container = document.createElement("div");
    container.className = "adventurer-community-share-container";
    container.style.cssText = [
        "display: flex",
        "align-items: center",
        "justify-content: space-between",
        "gap: 12px",
        "padding: 10px 12px",
        "margin: 0 0 8px 0",
        "border-radius: 8px",
        "background: var(--background-base-lower, var(--background-secondary, rgba(255, 255, 255, 0.03)))",
        "border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))",
        "font-family: var(--font-primary, 'gg sans', sans-serif)"
    ].join("; ");

    const leftCol = document.createElement("label");
    leftCol.style.cssText = "display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; flex: 1; min-width: 0;";

    // Native Discord-style checkbox (visually hidden input + custom styled box)
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.shareWithCommunity;
    checkbox.style.cssText = "position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none;";

    const box = document.createElement("span");
    box.style.cssText = "display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0; transition: background-color 0.15s ease, border-color 0.15s ease;";

    const checkSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--white, #ffffff)" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

    function syncCheckboxVisual(checked: boolean) {
        if (checked) {
            box.style.background = "var(--brand-500, #5865f2)";
            box.style.border = "1px solid var(--brand-500, #5865f2)";
            box.innerHTML = checkSvg;
        } else {
            box.style.background = "transparent";
            box.style.border = "1px solid var(--checkbox-border-default, rgba(255, 255, 255, 0.35))";
            box.innerHTML = "";
        }
    }
    syncCheckboxVisual(checkbox.checked);

    const textCol = document.createElement("div");
    textCol.style.cssText = "display: flex; flex-direction: column; gap: 2px; min-width: 0;";

    const spanText = document.createElement("span");
    spanText.style.cssText = "font-size: 14px; font-weight: 500; color: var(--text-default, var(--header-primary, #f2f3f5)); line-height: 1.25;";
    spanText.textContent = "Share with the community";

    const subText = document.createElement("span");
    subText.style.cssText = "font-size: 12px; color: var(--text-muted, #949ba4); line-height: 1.25;";
    subText.textContent = "Post recipe to #experience-recipes in the Adventurer server";

    textCol.appendChild(spanText);
    textCol.appendChild(subText);
    leftCol.appendChild(checkbox);
    leftCol.appendChild(box);
    leftCol.appendChild(textCol);

    const postBtn = document.createElement("button");
    postBtn.type = "button";
    postBtn.textContent = "Post";
    postBtn.style.cssText = [
        "display: " + (checkbox.checked ? "inline-flex" : "none"),
        "align-items: center",
        "justify-content: center",
        "height: 32px",
        "padding: 0 14px",
        "border-radius: 8px",
        "border: none",
        "font-family: var(--font-primary, 'gg sans', sans-serif)",
        "font-size: 13px",
        "font-weight: 500",
        "background: var(--button-filled-brand-background, var(--brand-500, #5865f2))",
        "color: var(--button-filled-brand-text, #ffffff)",
        "cursor: pointer",
        "flex-shrink: 0",
        "transition: background-color 0.15s ease"
    ].join("; ");
    postBtn.onmouseenter = () => {
        if (!postBtn.disabled) postBtn.style.background = "var(--button-filled-brand-background-hover, #4752c4)";
    };
    postBtn.onmouseleave = () => {
        if (!postBtn.disabled) postBtn.style.background = "var(--button-filled-brand-background, var(--brand-500, #5865f2))";
    };
    postBtn.onclick = e => {
        e.preventDefault();
        e.stopPropagation();
        postBtn.disabled = true;
        postBtn.style.opacity = "0.6";
        postBtn.textContent = "Posting...";
        const inputEl = modal.querySelector('[role="textbox"], textarea, input[type="text"]') as HTMLElement | null;
        const msgText = (inputEl && ("value" in inputEl ? (inputEl as HTMLInputElement).value : inputEl.textContent))?.trim() || "";
        customSendHandler([], msgText).catch(() => {
            postBtn.disabled = false;
            postBtn.style.opacity = "1";
            postBtn.textContent = "Post";
        });
    };

    checkbox.onchange = () => {
        setCommunityShare(checkbox.checked);
        syncCheckboxVisual(checkbox.checked);
        postBtn.style.display = checkbox.checked ? "inline-flex" : "none";
    };

    container.appendChild(leftCol);
    container.appendChild(postBtn);

    const previewEl = footer.querySelector('[class*="forwardPreview"]');
    if (previewEl && previewEl.nextSibling) {
        footer.insertBefore(container, previewEl.nextSibling);
    } else {
        footer.insertBefore(container, footer.firstChild);
    }
}

export function installForwardModalDOMObserver(): void {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
        return;
    }
    if (_modalObserver) {
        return;
    }

    _modalObserver = new MutationObserver(() => {
        tryInjectCommunityCheckbox();
    });

    _modalObserver.observe(document.body, { childList: true, subtree: true });
}

export function removeForwardModalDOMObserver(): void {
    if (_modalObserver) {
        _modalObserver.disconnect();
        _modalObserver = null;
    }
}

export { canShareRecipe };
