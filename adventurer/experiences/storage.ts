/*
 * Adventurer: experiences/storage.ts
 *
 * Local filesystem persistence engine for .advrecipe files.
 * Strictly avoids DataStore to prevent renderer heap bloat and UI stutter.
 * Operates as a Universal Bridge (Electron IPC in Discord client, direct Node.js in tests).
 *
 * Rules:
 *  - Only erasable TypeScript syntax (so node can import it directly).
 *  - Self-contained, genuine logic, zero hardcoded outcomes.
 */

import type { AdvRecipeFile } from "./recipe";

export function slug(text: string): string {
    if (!text || typeof text !== "string") return "unknown";
    const cleaned = text
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/\.{2,}/g, "_")
        .replace(/^[._]+|[._]+$/g, "");
    return cleaned || "unknown";
}

export function recipeFileName(applicationId: string, scene: string = ""): string {
    return `${slug(applicationId)}__${slug(scene)}.advrecipe`;
}

function getNativeBridge(): any {
    if (typeof (globalThis as any).VencordNative !== "undefined" && (globalThis as any).VencordNative?.pluginHelpers?.Adventurer) {
        return (globalThis as any).VencordNative.pluginHelpers.Adventurer;
    }
    return null;
}

function getNodeDeps() {
    if (typeof process !== "undefined" && process.versions?.node && typeof (globalThis as any).window === "undefined") {
        try {
            const getMod = (process as any).getBuiltinModule;
            if (typeof getMod === "function") {
                const fs = getMod("fs");
                const os = getMod("os");
                const path = getMod("path");
                if (fs && os && path) {
                    return { fs, os, path };
                }
            }
        } catch {}
    }
    return null;
}

export function getAdventurerRecipeDir(): string {
    const node = getNodeDeps();
    if (node) {
        return node.path.join(node.os.homedir(), ".adventurer", "recipes");
    }
    return "~/.adventurer/recipes";
}

export function getWorkbenchProfileDir(): string {
    const node = getNodeDeps();
    if (node) {
        return node.path.join(node.os.homedir(), ".vencord_workbench", "profiles");
    }
    return "~/.vencord_workbench/profiles";
}

export function isSafePath(baseDir: string, targetPath: string): boolean {
    const node = getNodeDeps();
    if (!node) return true;
    if (!baseDir || !targetPath || typeof baseDir !== "string" || typeof targetPath !== "string") {
        return false;
    }
    const resolvedBase = node.path.resolve(baseDir);
    const resolvedTarget = node.path.resolve(targetPath);
    const rel = node.path.relative(resolvedBase, resolvedTarget);
    return (
        rel !== "" &&
        rel !== ".." &&
        !rel.startsWith(".." + node.path.sep) &&
        !rel.startsWith("../") &&
        !rel.startsWith("..\\") &&
        !node.path.isAbsolute(rel)
    );
}

export function atomicWriteFileSync(targetPath: string, content: string): void {
    const node = getNodeDeps();
    if (!node) throw new Error("Node.js filesystem unavailable");

    node.fs.mkdirSync(node.path.dirname(targetPath), { recursive: true });
    const dir = node.path.dirname(targetPath);
    const base = node.path.basename(targetPath);
    const tmpPath = node.path.join(dir, `${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);

    try {
        node.fs.writeFileSync(tmpPath, content, "utf-8");
        node.fs.renameSync(tmpPath, targetPath);
    } catch (err) {
        try {
            if (node.fs.existsSync(tmpPath)) {
                node.fs.unlinkSync(tmpPath);
            }
        } catch {}
        throw err;
    }
}

export function atomicSaveRecipe(
    recipe: unknown,
    customDir?: string
): { ok: boolean; path?: string; error?: string } {
    const node = getNodeDeps();
    if (!node) return { ok: false, error: "Node.js filesystem unavailable" };

    try {
        if (!recipe || typeof recipe !== "object") {
            return { ok: false, error: "Recipe must be an object" };
        }
        const r = recipe as Record<string, unknown>;
        const appId = String(r.application_id || "unknown").trim();
        const scene = String(r.scene || "").trim();

        const baseDir = customDir || getAdventurerRecipeDir();
        const fileName = recipeFileName(appId, scene);
        const targetPath = node.path.join(baseDir, fileName);

        if (!isSafePath(baseDir, targetPath)) {
            return { ok: false, error: "Access denied: target path escapes allowed directory" };
        }

        atomicWriteFileSync(targetPath, JSON.stringify(recipe, null, 2));
        return { ok: true, path: targetPath };
    } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
    }
}

export async function saveRecipeDisk(
    recipe: AdvRecipeFile,
    optionsOrDir?: string | { customDir?: string }
): Promise<{ ok: boolean; path?: string; error?: string }> {
    const customDir = typeof optionsOrDir === "string" ? optionsOrDir : optionsOrDir?.customDir;
    const native = getNativeBridge();
    if (native?.saveRecipe && !customDir) {
        return await native.saveRecipe(recipe);
    }

    return atomicSaveRecipe(recipe, customDir);
}

export function loadRecipeDiskSync(
    filePathOrId: string,
    optionsOrDir?: string | { customDir?: string }
): AdvRecipeFile | null {
    const node = getNodeDeps();
    if (!node || !filePathOrId || typeof filePathOrId !== "string" || !filePathOrId.trim()) return null;

    try {
        const customDir = typeof optionsOrDir === "string" ? optionsOrDir : optionsOrDir?.customDir;
        const baseDir = customDir || getAdventurerRecipeDir();
        let targetPath = filePathOrId;

        if (!node.path.isAbsolute(targetPath)) {
            const fileName = targetPath.endsWith(".advrecipe") ? targetPath : `${targetPath}.advrecipe`;
            targetPath = node.path.join(baseDir, fileName);
        }

        const safeBase = customDir || getAdventurerRecipeDir();
        const safeWb = customDir ? null : getWorkbenchProfileDir();

        // Enforce boundary safety: target must reside within safeBase, or safeWb if customDir is omitted
        if (!isSafePath(safeBase, targetPath) && (!safeWb || !isSafePath(safeWb, targetPath))) {
            return null;
        }

        if (!node.fs.existsSync(targetPath)) {
            // Fallback: check .json in Workbench profile dir if not found in Adventurer recipes dir
            if (!customDir && !filePathOrId.endsWith(".advrecipe")) {
                const wbFileName = filePathOrId.endsWith(".json") ? filePathOrId : `${filePathOrId}.json`;
                const wbPath = node.path.join(getWorkbenchProfileDir(), wbFileName);
                if (isSafePath(getWorkbenchProfileDir(), wbPath) && node.fs.existsSync(wbPath)) {
                    targetPath = wbPath;
                } else {
                    return null;
                }
            } else {
                return null;
            }
        }

        if (node.fs.statSync(targetPath).isDirectory()) {
            return null;
        }

        const content = node.fs.readFileSync(targetPath, "utf-8");
        return JSON.parse(content) as AdvRecipeFile;
    } catch {
        return null;
    }
}

export async function loadRecipeDisk(
    filePathOrId: string,
    optionsOrDir?: string | { customDir?: string }
): Promise<AdvRecipeFile | null> {
    const customDir = typeof optionsOrDir === "string" ? optionsOrDir : optionsOrDir?.customDir;
    const native = getNativeBridge();
    if (native?.loadRecipe && !customDir) {
        const res = await native.loadRecipe(filePathOrId);
        return res?.ok ? (res.recipe as AdvRecipeFile) : null;
    }

    return loadRecipeDiskSync(filePathOrId, optionsOrDir);
}

export function listLocalRecipesSync(
    appIdOrDir?: string,
    optionsOrAppId?: string | { customDir?: string }
): AdvRecipeFile[] {
    const node = getNodeDeps();
    if (!node) return [];

    try {
        let dir: string | undefined;
        let appId: string | undefined;

        if (typeof optionsOrAppId === "string") {
            dir = appIdOrDir;
            appId = optionsOrAppId;
        } else if (typeof optionsOrAppId === "object" && optionsOrAppId?.customDir) {
            dir = optionsOrAppId.customDir;
            appId = appIdOrDir;
        } else if (appIdOrDir) {
            if (appIdOrDir.includes("/") || appIdOrDir.includes("\\") || (node.fs.existsSync(appIdOrDir) && node.fs.statSync(appIdOrDir).isDirectory())) {
                dir = appIdOrDir;
            } else {
                appId = appIdOrDir;
            }
        }

        const dirsToScan: string[] = [];
        if (dir) {
            dirsToScan.push(dir);
        } else {
            dirsToScan.push(getAdventurerRecipeDir());
            dirsToScan.push(getWorkbenchProfileDir());
        }

        const results: AdvRecipeFile[] = [];
        const seen = new Set<string>();

        for (const targetDir of dirsToScan) {
            if (!node.fs.existsSync(targetDir)) continue;

            const files = node.fs.readdirSync(targetDir);
            for (const file of files) {
                if (!file.endsWith(".advrecipe") && !file.endsWith(".json")) continue;
                if (appId && !file.startsWith(`${appId}__`) && !file.startsWith(`${slug(appId)}__`)) {
                    continue;
                }

                const baseKey = file.replace(/\.(advrecipe|json)$/, "");
                if (seen.has(baseKey)) continue;

                const fullPath = node.path.join(targetDir, file);
                try {
                    const raw = node.fs.readFileSync(fullPath, "utf-8");
                    const data = JSON.parse(raw);
                    if (data && typeof data === "object") {
                        seen.add(baseKey);
                        results.push(data as AdvRecipeFile);
                    }
                } catch {
                    // skip corrupted / truncated file
                }
            }
        }

        return results.sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")));
    } catch {
        return [];
    }
}

export async function listLocalRecipes(
    appIdOrDir?: string,
    optionsOrAppId?: string | { customDir?: string }
): Promise<AdvRecipeFile[]> {
    const customDir = typeof optionsOrAppId === "string"
        ? appIdOrDir
        : (typeof optionsOrAppId === "object" ? optionsOrAppId?.customDir : (appIdOrDir?.includes("/") || appIdOrDir?.includes("\\") ? appIdOrDir : undefined));

    const native = getNativeBridge();
    if (native?.listRecipes && !customDir) {
        const appId = typeof optionsOrAppId === "string" ? optionsOrAppId : (customDir ? undefined : appIdOrDir);
        const res = await native.listRecipes(appId);
        return Array.isArray(res) ? (res as AdvRecipeFile[]) : [];
    }

    return listLocalRecipesSync(appIdOrDir, optionsOrAppId);
}

export function deleteRecipeDiskSync(
    filePathOrId: string,
    optionsOrDir?: string | { customDir?: string }
): boolean {
    const node = getNodeDeps();
    if (!node || !filePathOrId || typeof filePathOrId !== "string" || !filePathOrId.trim()) return false;

    try {
        const customDir = typeof optionsOrDir === "string" ? optionsOrDir : optionsOrDir?.customDir;
        const baseDir = customDir || getAdventurerRecipeDir();
        let targetPath = filePathOrId;

        if (!node.path.isAbsolute(targetPath)) {
            const fileName = targetPath.endsWith(".advrecipe") ? targetPath : `${targetPath}.advrecipe`;
            targetPath = node.path.join(baseDir, fileName);
        }

        // Deletion is strictly confined to baseDir (customDir or ~/.adventurer/recipes/)
        // Deletion in ~/.vencord_workbench/profiles/ is NEVER permitted
        if (!isSafePath(baseDir, targetPath)) {
            return false;
        }

        if (!node.fs.existsSync(targetPath)) {
            return false;
        }

        if (node.fs.statSync(targetPath).isDirectory()) {
            return false;
        }

        node.fs.unlinkSync(targetPath);
        return true;
    } catch {
        return false;
    }
}

export async function deleteRecipeDisk(
    filePathOrId: string,
    optionsOrDir?: string | { customDir?: string }
): Promise<boolean> {
    const customDir = typeof optionsOrDir === "string" ? optionsOrDir : optionsOrDir?.customDir;
    const native = getNativeBridge();
    if (native?.deleteRecipe && !customDir) {
        const res = await native.deleteRecipe(filePathOrId);
        return !!res?.ok;
    }

    return deleteRecipeDiskSync(filePathOrId, optionsOrDir);
}
