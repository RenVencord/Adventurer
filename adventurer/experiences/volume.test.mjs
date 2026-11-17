import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

// Extract and evaluate buildVolumeScript from volume.tsx without needing a JSX loader
const volumeTsx = fs.readFileSync(new URL("./volume.tsx", import.meta.url), "utf8");
const fnStart = volumeTsx.indexOf("export function buildVolumeScript");
const fnEnd = volumeTsx.indexOf("export function pushVolume");
assert.ok(fnStart !== -1 && fnEnd !== -1, "buildVolumeScript and pushVolume found in volume.tsx");

const fnBody = volumeTsx.slice(volumeTsx.indexOf("{", fnStart) + 1, volumeTsx.lastIndexOf("}", fnEnd));
const buildVolumeScript = new Function("volumePercent", "muted", `
    const VOLUME_MSG_TAG = "__adventurerOverlay";
    const clampPercent = (v) => Math.min(100, Math.max(0, Math.round(Number.isFinite(v) ? v : 100)));
    ${fnBody}
`);

test("generated volume script parses (new Function and node --check)", () => {
    const src = buildVolumeScript(80, false);
    assert.ok(src.includes("__adventurerVolume"));
    assert.ok(src.includes("adventurer-header-volume-slider"));
    assert.doesNotThrow(() => new Function(src));
    execFileSync(process.execPath, ["--check"], { input: src, encoding: "utf8" });
});

test("generated volume script handles muted and volume percent parameters", () => {
    const srcMuted = buildVolumeScript(0, true);
    assert.ok(srcMuted.includes("muted: true"));
    assert.ok(srcMuted.includes("volume: 0"));

    const srcHalf = buildVolumeScript(50, false);
    assert.ok(srcHalf.includes("muted: false"));
    assert.ok(srcHalf.includes("volume: 0.5"));
});
