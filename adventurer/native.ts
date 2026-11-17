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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import http from "http";
import https from "https";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

const QUEST_FRAME_HOST = /(^|\.)discordsays\.com$/i;

// Experience profiles written by Vencord Workbench (Experience tab). One JSON file per application and scene, named
// <application id>__<scene>.json. They are re-read every time a script is injected into a frame (frame load, or the
// renderer re-injecting after a setting or quest change), so editing one only needs a quest reload. The quest
// completion runner (experiences/completion.ts) reads the `completion` recipe of each profile and ignores profiles
// without one. Its injected script contains the placeholder token below exactly once.
const ADVENTURER_RECIPES_DIR = join(homedir(), ".adventurer", "recipes");
const PROFILE_DIR = join(homedir(), ".vencord_workbench", "profiles");
const PROFILE_PLACEHOLDER = "__ADVENTURER_PROFILES__";

function slug(text: string): string {
    if (!text || typeof text !== "string") return "unknown";
    const cleaned = text
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/\.{2,}/g, "_")
        .replace(/^[._]+|[._]+$/g, "");
    return cleaned || "unknown";
}

function isSafePath(baseDir: string, targetPath: string): boolean {
    if (!baseDir || !targetPath) return false;
    const resolvedBase = resolve(baseDir);
    const resolvedTarget = resolve(targetPath);
    const rel = relative(resolvedBase, resolvedTarget);
    return (
        rel !== "" &&
        rel !== ".." &&
        !rel.startsWith(`..${sep}`) &&
        !rel.startsWith("../") &&
        !rel.startsWith("..\\") &&
        !isAbsolute(rel)
    );
}

function atomicWriteFileSync(targetPath: string, content: string): void {
    mkdirSync(dirname(targetPath), { recursive: true });
    const dir = dirname(targetPath);
    const base = targetPath.split(/[/\\]/).pop() || "recipe";
    const tmpPath = join(dir, `${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    try {
        writeFileSync(tmpPath, content, "utf-8");
        renameSync(tmpPath, targetPath);
    } catch (err) {
        try {
            if (existsSync(tmpPath)) unlinkSync(tmpPath);
        } catch {}
        throw err;
    }
}

function listRecipesDirect(applicationId?: string | null): unknown[] {
    const dirs = [ADVENTURER_RECIPES_DIR, PROFILE_DIR];
    const results: { created: string; data: unknown }[] = [];
    const seen = new Set<string>();

    for (const dir of dirs) {
        try {
            if (!existsSync(dir)) continue;
            const files = readdirSync(dir);
            for (const name of files) {
                if (!name.endsWith(".advrecipe") && !name.endsWith(".json")) continue;
                if (applicationId && !name.startsWith(`${applicationId}__`) && !name.startsWith(`${slug(applicationId)}__`)) {
                    continue;
                }

                const baseKey = name.replace(/\.(advrecipe|json)$/, "");
                if (seen.has(baseKey)) continue;

                try {
                    const raw = readFileSync(join(dir, name), "utf-8");
                    const data = JSON.parse(raw);
                    if (data && typeof data === "object") {
                        seen.add(baseKey);
                        results.push({
                            created: String(data.created ?? ""),
                            data
                        });
                    }
                } catch {
                    // skip corrupted / unreadable files
                }
            }
        } catch {
            // folder inaccessible
        }
    }

    return results
        .sort((a, b) => b.created.localeCompare(a.created))
        .map(p => p.data);
}

function applicationIdOf(frame: WebFrameMain): string | null {
    try {
        const label = new URL(frame.url).hostname.split(".")[0];
        return /^\d+$/.test(label) ? label : null;
    } catch {
        return null;
    }
}

/** Every readable profile for an application id, newest first. Discovers .advrecipe in ~/.adventurer/recipes/ and .json in ~/.vencord_workbench/profiles/. */
function profilesFor(applicationId: string | null): unknown[] {
    if (!applicationId) return [];
    return listRecipesDirect(applicationId);
}

/** Fills the profile placeholder of an overlay script for the frame it is about to run in. */
function withProfiles(script: string, frame: WebFrameMain): string {
    if (!script.includes(PROFILE_PLACEHOLDER)) return script;
    return script.split(PROFILE_PLACEHOLDER).join(JSON.stringify(profilesFor(applicationIdOf(frame))));
}

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
    frame.executeJavaScript(withProfiles(script, frame)).catch(e => {
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

/**
 * Sends an HTTP request from Electron's main process (Node.js).
 * Because this runs in Node rather than Chromium's renderer network stack,
 * failed connections (e.g. ECONNREFUSED when the local Python server is offline)
 * do NOT trigger Chromium's "Failed to load resource: net::ERR_CONNECTION_REFUSED"
 * console error spam in DevTools.
 */
export async function sendServerRequest(
    _event: IpcMainInvokeEvent,
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string; timeout?: number } = {}
): Promise<{ ok: boolean; status: number; text?: string; error?: string }> {
    return new Promise(resolve => {
        try {
            const u = new URL(url);
            const bodyStr = options.body ?? "";
            const headers: Record<string, string> = {
                ...(options.headers || {})
            };
            if (bodyStr && !headers["Content-Length"] && !headers["content-length"]) {
                headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
            }

            const req = http.request({
                hostname: u.hostname,
                port: u.port || 80,
                path: u.pathname + u.search,
                method: options.method || "GET",
                headers,
                timeout: options.timeout ?? 3000
            }, res => {
                let data = "";
                res.on("data", chunk => { data += chunk; });
                res.on("end", () => {
                    resolve({
                        ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
                        status: res.statusCode ?? 0,
                        text: data
                    });
                });
            });

            req.on("error", err => {
                resolve({ ok: false, status: 0, error: err.message });
            });

            req.on("timeout", () => {
                req.destroy();
                resolve({ ok: false, status: 0, error: "timeout" });
            });

            if (bodyStr) {
                req.write(bodyStr);
            }
            req.end();
        } catch (e: any) {
            resolve({ ok: false, status: 0, error: e?.message ?? String(e) });
        }
    });
}

const ALLOWED_ATTACHMENT_HOSTS = /^(cdn\.discordapp\.com|media\.discordapp\.net)$/i;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Fetches a Discord CDN attachment (.advrecipe) from Electron's main process to bypass
 * Chromium's renderer CORS restriction on cdn.discordapp.com/attachments/*.
 */
export async function fetchAttachmentText(
    _event: IpcMainInvokeEvent,
    url: string,
    redirectsLeft: number = 2
): Promise<{ ok: boolean; status: number; text?: string; error?: string }> {
    return new Promise(resolve => {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:" || !ALLOWED_ATTACHMENT_HOSTS.test(parsed.hostname)) {
                resolve({ ok: false, status: 0, error: "Disallowed attachment host" });
                return;
            }

            const req = https.get(parsed.toString(), { timeout: 10000 }, res => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
                    res.resume();
                    const nextUrl = new URL(res.headers.location, parsed).toString();
                    fetchAttachmentText(_event, nextUrl, redirectsLeft - 1).then(resolve);
                    return;
                }

                let totalBytes = 0;
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => {
                    totalBytes += chunk.length;
                    if (totalBytes > MAX_ATTACHMENT_BYTES) {
                        req.destroy();
                        resolve({ ok: false, status, error: "Recipe file exceeds 10MB limit" });
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf-8");
                    resolve({
                        ok: status >= 200 && status < 300,
                        status,
                        text,
                        ...(status >= 200 && status < 300 ? {} : { error: `HTTP ${status}` })
                    });
                });
            });

            req.on("error", err => {
                resolve({ ok: false, status: 0, error: err.message });
            });
            req.on("timeout", () => {
                req.destroy();
                resolve({ ok: false, status: 0, error: "Request timed out" });
            });
        } catch (e: any) {
            resolve({ ok: false, status: 0, error: e?.message ?? String(e) });
        }
    });
}

/**
 * Saves a recipe to ~/.adventurer/recipes/<appId>__<scene>.advrecipe atomically.
 */
export async function saveRecipe(
    _event: IpcMainInvokeEvent,
    recipe: unknown
): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
        const data = typeof recipe === "string" ? JSON.parse(recipe) : recipe;
        if (!data || typeof data !== "object") {
            return { ok: false, error: "Recipe must be an object" };
        }
        const appId = String((data as any).application_id || "").trim();
        const scene = String((data as any).scene || "").trim();
        if (!appId) {
            return { ok: false, error: "Recipe missing application_id" };
        }

        const fileName = `${slug(appId)}__${slug(scene)}.advrecipe`;
        const targetPath = join(ADVENTURER_RECIPES_DIR, fileName);
        const jsonText = JSON.stringify(data, null, 2);

        atomicWriteFileSync(targetPath, jsonText);
        return { ok: true, path: targetPath };
    } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
    }
}

/**
 * Loads a recipe from disk given an absolute path or an appId__scene identifier.
 */
export async function loadRecipe(
    _event: IpcMainInvokeEvent,
    identifierOrPath: string
): Promise<{ ok: boolean; recipe?: unknown; error?: string }> {
    try {
        let filePath = identifierOrPath;
        if (!isAbsolute(filePath)) {
            const fileName = filePath.endsWith(".advrecipe") ? filePath : `${filePath}.advrecipe`;
            const advPath = join(ADVENTURER_RECIPES_DIR, fileName);
            const wbPath = join(PROFILE_DIR, filePath.endsWith(".json") ? filePath : `${filePath}.json`);
            if (existsSync(advPath)) filePath = advPath;
            else if (existsSync(wbPath)) filePath = wbPath;
            else return { ok: false, error: `Recipe not found: ${identifierOrPath}` };
        }

        if (!isSafePath(ADVENTURER_RECIPES_DIR, filePath) && !isSafePath(PROFILE_DIR, filePath)) {
            return { ok: false, error: "Access denied: path outside allowed recipe directories" };
        }

        if (!existsSync(filePath)) {
            return { ok: false, error: `File not found: ${filePath}` };
        }

        const content = readFileSync(filePath, "utf-8");
        const recipe = JSON.parse(content);
        return { ok: true, recipe };
    } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
    }
}

/**
 * Lists all valid recipes, newest-first, optionally filtered by application ID.
 */
export async function listRecipes(
    _event: IpcMainInvokeEvent,
    applicationId?: string
): Promise<unknown[]> {
    return listRecipesDirect(applicationId);
}

/**
 * Deletes a recipe file from ~/.adventurer/recipes/.
 */
export async function deleteRecipe(
    _event: IpcMainInvokeEvent,
    identifierOrPath: string
): Promise<{ ok: boolean; error?: string }> {
    try {
        let filePath = identifierOrPath;
        if (!isAbsolute(filePath)) {
            const fileName = filePath.endsWith(".advrecipe") ? filePath : `${filePath}.advrecipe`;
            filePath = join(ADVENTURER_RECIPES_DIR, fileName);
        }

        if (!isSafePath(ADVENTURER_RECIPES_DIR, filePath)) {
            return { ok: false, error: "Access denied: deletion restricted to ~/.adventurer/recipes/" };
        }

        if (!existsSync(filePath)) {
            return { ok: false, error: "File not found" };
        }

        unlinkSync(filePath);
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
    }
}


