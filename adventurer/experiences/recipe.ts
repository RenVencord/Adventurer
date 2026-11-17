/*
 * Adventurer: .advrecipe data model, schema validation, and argument sanitization.
 * Compatible with Vencord Workbench experience_recipe.py and DiscordAdventurer completion runner.
 *
 * Rules:
 *  - Only erasable TypeScript syntax (so node can import it directly).
 *  - Self-contained, genuine logic, zero hardcoded outcomes.
 */

export const RECIPE_VERSION = 1;
export const RECIPE_FORMAT = "advrecipe";
export const RECIPE_FILE_EXTENSION = ".advrecipe";
export const MAX_KEEP_STRING = 40;
export const MAX_ARGS_CHARS = 20000;
export const MAX_DELAY_MS = 10000;
export const ENTITY_PREFIX = "@entity:";
export const ALWAYS_SUPPRESS = ["leaderboard"];

export const COMMUNITY_GUILD_ID = "1561961025446617128";
export const COMMUNITY_CHANNEL_ID = "1562024068838854726";
export const COMMUNITY_INVITE_CODE = "2XhF3r4Avg";

const DROP_SYMBOL = Symbol("DROP");

const TAG_RE = /^\[[A-Za-z0-9_$ ]{1,40}(\(\d+\))?\]$/;
const SENSITIVE_KEY_RE = /^(access_?token|refresh_?token|id_?token|token|password|passwd|secret|api_?key|authorization|cookie|session_?id|jwt|bearer)$/i;
const SNOWFLAKE_RE = /(?<!\d)\d{15,}(?!\d)/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const HEX_RE = /[0-9a-f]{16,}/i;
const JWT_RE = /eyJ[\w-]{5,}\.[\w-]{5,}/;
const TOKENISH_RE = /^[A-Za-z0-9+/_=.-]{24,}$/;
const URL_RE = /https?:\/\//i;

export type RecipeSource = "recorded" | "guessed" | "edited" | "bundled" | "inferred" | string;
export type RecipeScope = "app" | "entity";

export interface RecipeEntry {
    name: string;
    scope?: RecipeScope;
    entity?: string | null;
    guid?: string | null;
    args?: unknown[];
    delay_ms?: number;
    repeat_for?: string | null;
    source?: RecipeSource;
}

export interface CompletionRecipe {
    version: 1;
    goal: string;
    triggers: string[];
    entries: RecipeEntry[];
    suppress: string[];
    delay_ms?: number;
    entry_delay_ms?: number;
    repeat_for?: string | null;
    notes?: string;
    source?: RecipeSource;
}

export interface AdvRecipeFile {
    format: "advrecipe";
    version: 1;
    application_id: string;
    scene: string;
    name: string;
    created: string;
    verifiedCompletion: boolean;
    completion: CompletionRecipe;
    notes?: string;
    optional_events?: string[];
}

export type AdvRecipe = AdvRecipeFile;

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

export interface SanitizeStatsData {
    removed: number;
    uncaptured: number;
    truncated: number;
}

export class SanitizeStats implements SanitizeStatsData {
    removed: number = 0;
    uncaptured: number = 0;
    truncated: number = 0;

    notes(): string[] {
        const out: string[] = [];
        if (this.removed > 0) {
            out.push(`${this.removed} value(s) removed (id, token, email or long string)`);
        }
        if (this.uncaptured > 0) {
            out.push(`${this.uncaptured} value(s) could not be captured (class instance, function or too deep)`);
        }
        if (this.truncated > 0) {
            out.push(`${this.truncated} container(s) were cut at the recorder's size limit`);
        }
        return out;
    }
}

export interface SanitizeResult {
    sanitized: unknown[];
    stats: SanitizeStats;
    removedCount: number;
}

export interface ParseArgsResult {
    value: unknown[] | null;
    problem: string;
}

// ---------------------------------------------------------------------------
// Predicates & Helpers
// ---------------------------------------------------------------------------

export function isLeaderboard(name: unknown): boolean {
    return typeof name === "string" && name.toLowerCase().includes("leaderboard");
}

export function isArise(name: unknown): boolean {
    return typeof name === "string" && name.toLowerCase().startsWith("arise:");
}

export function slug(text: unknown): string {
    if (typeof text !== "string") return "unknown";
    const cleaned = text
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/\.{2,}/g, "_")
        .replace(/^[._]+|[._]+$/g, "");
    return cleaned || "unknown";
}

export function triggerProblem(name: unknown): string {
    if (typeof name !== "string" || !name.trim()) {
        return "Enter an event name.";
    }
    if (isLeaderboard(name)) {
        return `${name} is a leaderboard event. Leaderboard events can never be triggers.`;
    }
    return "";
}

export function entryProblem(name: unknown, goal?: string): string {
    if (typeof name !== "string" || !name.trim()) {
        return "Enter an event name.";
    }
    if (isLeaderboard(name)) {
        return `${name} is a leaderboard event. Leaderboard events can never be entries.`;
    }
    if (typeof goal === "string" && goal && name.toLowerCase() === goal.toLowerCase()) {
        return `${name} is the goal event. The goal can never be an entry.`;
    }
    if (isArise(name)) {
        return `${name} is one of the game's own reports to Discord. arise:* events can never be entries.`;
    }
    return "";
}

export function clampDelay(ms: unknown, maxMs: number = MAX_DELAY_MS): number {
    const num = Number(ms);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.min(num, maxMs);
}

export function sensitiveReason(text: string): string {
    if (text.length > MAX_KEEP_STRING) {
        return "long";
    }
    if (SNOWFLAKE_RE.test(text)) return "discord id";
    if (UUID_RE.test(text)) return "uuid";
    if (EMAIL_RE.test(text)) return "email";
    if (HEX_RE.test(text)) return "hex";
    if (JWT_RE.test(text)) return "token";
    if (URL_RE.test(text)) return "url";
    if (TOKENISH_RE.test(text)) return "token";
    return "";
}

export function canShareRecipe(recipe: unknown): boolean {
    if (!recipe || typeof recipe !== "object") return false;
    const r = recipe as Record<string, unknown>;
    return r.format === RECIPE_FORMAT && r.version === RECIPE_VERSION && r.verifiedCompletion === true;
}

function hasNonFiniteNumber(value: unknown, seen = new Set<unknown>()): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === "number") {
        return !Number.isFinite(value);
    }
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            if (hasNonFiniteNumber(item, seen)) return true;
        }
    } else {
        for (const key of Object.keys(value)) {
            if (hasNonFiniteNumber((value as Record<string, unknown>)[key], seen)) return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Validation Suite
// ---------------------------------------------------------------------------

export function validateCompletionRecipe(recipe: unknown): ValidationResult {
    const errors: string[] = [];
    if (typeof recipe !== "object" || recipe === null || Array.isArray(recipe)) {
        return { valid: false, errors: ["The recipe is not an object."] };
    }

    const r = recipe as Record<string, unknown>;

    // 1. Version check
    const version = r.version !== undefined ? r.version : RECIPE_VERSION;
    if (version !== RECIPE_VERSION) {
        errors.push(`Unsupported recipe version ${JSON.stringify(r.version)}.`);
    }

    // 2. Goal check
    let goal = "";
    if (typeof r.goal !== "string" || !r.goal.trim()) {
        errors.push("The recipe has no goal.");
    } else if (isLeaderboard(r.goal)) {
        errors.push("The goal cannot be a leaderboard event.");
        goal = r.goal;
    } else {
        goal = r.goal;
    }

    // 3. Triggers check
    if (!Array.isArray(r.triggers) || r.triggers.length === 0) {
        errors.push("The recipe needs at least one trigger (an app event the player causes).");
    } else {
        for (const t of r.triggers) {
            const prob = triggerProblem(t);
            if (prob) errors.push(prob);
        }
    }

    // 4. Entries check
    if (!Array.isArray(r.entries) || r.entries.length === 0) {
        errors.push("The recipe needs at least one entry (an event to fire).");
    } else {
        for (const e of r.entries) {
            if (typeof e !== "object" || e === null || Array.isArray(e)) {
                errors.push("An entry is not an object.");
                continue;
            }
            const entry = e as Record<string, unknown>;
            const entryName = typeof entry.name === "string" ? entry.name : "";
            const prob = entryProblem(entry.name, goal);
            if (prob) errors.push(prob);

            const scope = entry.scope === undefined || entry.scope === null ? "app" : entry.scope;
            if (scope !== "app" && scope !== "entity") {
                errors.push(`Entry ${entryName}: unknown scope ${JSON.stringify(scope)}.`);
            } else if (scope === "entity") {
                const entity = typeof entry.entity === "string" ? entry.entity.trim() : "";
                const guid = typeof entry.guid === "string" ? entry.guid.trim() : "";
                const repeatFor = typeof entry.repeat_for === "string" ? entry.repeat_for.trim() : "";
                if (!entity && !guid && !repeatFor) {
                    errors.push(`Entry ${entryName}: an entity entry needs the entity name or guid.`);
                }
            }

            // 5. Args check
            if (entry.args !== undefined && entry.args !== null) {
                if (!Array.isArray(entry.args)) {
                    errors.push(`Entry ${entryName}: args must be a list.`);
                } else {
                    try {
                        const text = JSON.stringify(entry.args);
                        if (text.length > MAX_ARGS_CHARS) {
                            errors.push(`Entry ${entryName}: args are longer than ${MAX_ARGS_CHARS} characters.`);
                        }
                        if (hasNonFiniteNumber(entry.args)) {
                            errors.push(`Entry ${entryName}: NaN and Infinity are not valid JSON numbers.`);
                        }
                    } catch {
                        errors.push(`Entry ${entryName}: args are not valid JSON.`);
                    }
                }
            }

            // Entry delay_ms
            if (entry.delay_ms !== undefined && entry.delay_ms !== null) {
                if (typeof entry.delay_ms !== "number" || !Number.isFinite(entry.delay_ms) || entry.delay_ms < 0) {
                    errors.push(`Entry ${entryName}: delay_ms must be a number of milliseconds, 0 or more.`);
                }
            }

            // Entry repeat_for
            if (entry.repeat_for !== undefined && entry.repeat_for !== null && typeof entry.repeat_for !== "string") {
                errors.push(`Entry ${entryName}: repeat_for must be a string pattern.`);
            }
        }
    }

    // 6. Suppress list check
    if (!Array.isArray(r.suppress) || !r.suppress.some(s => typeof s === "string" && s.toLowerCase().includes("leaderboard"))) {
        errors.push('"suppress" must contain "leaderboard".');
    }

    // 7. Delays and pacing
    const delay = r.delay_ms;
    if (delay !== undefined && delay !== null) {
        if (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0) {
            errors.push("delay_ms must be a number of milliseconds, 0 or more.");
        }
    }

    const entryDelay = r.entry_delay_ms;
    if (entryDelay !== undefined && entryDelay !== null) {
        if (typeof entryDelay !== "number" || !Number.isFinite(entryDelay) || entryDelay < 0) {
            errors.push("entry_delay_ms must be a number of milliseconds, 0 or more.");
        }
    }

    const repeatFor = r.repeat_for;
    if (repeatFor !== undefined && repeatFor !== null && typeof repeatFor !== "string") {
        errors.push("repeat_for must be a string pattern.");
    }

    return { valid: errors.length === 0, errors };
}

export function validateAdvRecipeFile(file: unknown): ValidationResult {
    const errors: string[] = [];
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
        return { valid: false, errors: ["The recipe is not an object."] };
    }

    const f = file as Record<string, unknown>;

    if (f.format !== RECIPE_FORMAT) {
        errors.push(`Invalid format: expected '${RECIPE_FORMAT}'.`);
    }

    if (f.version !== RECIPE_VERSION) {
        errors.push(`Unsupported recipe version ${JSON.stringify(f.version)}.`);
    }

    if (typeof f.application_id !== "string" || !f.application_id.trim()) {
        errors.push("The recipe has no application_id.");
    }

    if (typeof f.scene !== "string" || !f.scene.trim()) {
        errors.push("The recipe has no scene.");
    }

    if (typeof f.name !== "string" || !f.name.trim()) {
        errors.push("The recipe has no name.");
    }

    if (typeof f.created !== "string" || isNaN(Date.parse(f.created))) {
        errors.push("Invalid created timestamp.");
    }

    if (typeof f.verifiedCompletion !== "boolean") {
        errors.push("verifiedCompletion must be a boolean.");
    }

    if (!f.completion || typeof f.completion !== "object") {
        errors.push("Missing completion recipe.");
    } else {
        const sub = validateCompletionRecipe(f.completion);
        errors.push(...sub.errors);
    }

    return { valid: errors.length === 0, errors };
}

export function validateRecipe(recipe: unknown): ValidationResult {
    if (typeof recipe !== "object" || recipe === null || Array.isArray(recipe)) {
        return { valid: false, errors: ["The recipe is not an object."] };
    }

    const r = recipe as Record<string, unknown>;
    if (r.format === RECIPE_FORMAT || r.completion !== undefined) {
        return validateAdvRecipeFile(recipe);
    }
    return validateCompletionRecipe(recipe);
}

// ---------------------------------------------------------------------------
// Argument Sanitization Engine
// ---------------------------------------------------------------------------

function cleanValue(
    value: unknown,
    stats: SanitizeStats,
    key: string | null = null,
    active: Set<object> = new Set()
): unknown {
    if (key !== null && SENSITIVE_KEY_RE.test(key)) {
        stats.removed += 1;
        return DROP_SYMBOL;
    }
    if (value === null || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        if (Number.isFinite(value)) {
            return value;
        }
        stats.removed += 1;
        return DROP_SYMBOL;
    }
    if (typeof value === "string") {
        if (value.startsWith(ENTITY_PREFIX)) {
            return value.length > ENTITY_PREFIX.length && value.length <= 120 ? value : DROP_SYMBOL;
        }
        if (TAG_RE.test(value)) {
            stats.uncaptured += 1;
            return DROP_SYMBOL;
        }
        if (sensitiveReason(value)) {
            stats.removed += 1;
            return DROP_SYMBOL;
        }
        return value;
    }
    if (typeof value === "object") {
        if (active.has(value)) {
            stats.uncaptured += 1;
            return DROP_SYMBOL;
        }
        active.add(value);
        try {
            if (Array.isArray(value)) {
                const out: unknown[] = [];
                for (const item of value) {
                    if (typeof item === "string" && item.startsWith("@truncated")) {
                        stats.truncated += 1;
                        continue;
                    }
                    const cleaned = cleanValue(item, stats, null, active);
                    out.push(cleaned === DROP_SYMBOL ? null : cleaned);
                }
                return out;
            }

            const out: Record<string, unknown> = {};
            for (const k of Object.keys(value as Record<string, unknown>)) {
                if (k === "@truncated") {
                    stats.truncated += 1;
                    continue;
                }
                if (k === "__proto__" || k === "constructor" || k === "prototype") {
                    continue;
                }
                const propVal = (value as Record<string, unknown>)[k];
                const cleaned = cleanValue(propVal, stats, k, active);
                if (cleaned !== DROP_SYMBOL) {
                    out[k] = cleaned;
                }
            }
            return out;
        } finally {
            active.delete(value);
        }
    }

    stats.uncaptured += 1;
    return DROP_SYMBOL;
}

export function sanitizeArgs(args: unknown[]): SanitizeResult {
    const stats = new SanitizeStats();
    if (!Array.isArray(args)) {
        return { sanitized: [], stats, removedCount: 0 };
    }

    try {
        const serialized = JSON.stringify(args);
        if (serialized && serialized.length > MAX_ARGS_CHARS) {
            throw new Error(`The args are longer than ${MAX_ARGS_CHARS} characters.`);
        }
    } catch (e: any) {
        if (e?.message?.includes("longer than")) {
            throw e;
        }
    }

    const out: unknown[] = [];
    const removedFlags: boolean[] = [];

    for (const item of args) {
        const cleaned = cleanValue(item, stats);
        out.push(cleaned === DROP_SYMBOL ? null : cleaned);
        removedFlags.push(cleaned === DROP_SYMBOL);
    }

    while (out.length > 0 && removedFlags[removedFlags.length - 1]) {
        out.pop();
        removedFlags.pop();
    }

    return {
        sanitized: out,
        stats,
        removedCount: stats.removed
    };
}

export function parseArgs(text: string): ParseArgsResult {
    if (typeof text !== "string") {
        return { value: null, problem: "The args must be a string." };
    }
    if (text.length > MAX_ARGS_CHARS) {
        return { value: null, problem: `The args are longer than ${MAX_ARGS_CHARS} characters.` };
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (e: any) {
        return { value: null, problem: `Not valid JSON: ${e?.message || e}` };
    }
    if (!Array.isArray(value)) {
        return { value: null, problem: 'The args must be a JSON list, for example [] or [{"total": 0}].' };
    }
    if (hasNonFiniteNumber(value)) {
        return { value: null, problem: "NaN and Infinity are not valid JSON numbers." };
    }
    return { value, problem: "" };
}

export function argsProblem(text: string): string {
    return parseArgs(text).problem;
}
