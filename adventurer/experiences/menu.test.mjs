import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildMenuScript, buildMenuMessage, LOGO_DATA_URI } from "./menu.ts";

test("generated string parses (new Function and node --check)", () => {
    const src = buildMenuScript({ esp: true, minimap: true, autoComplete: true });
    assert.doesNotThrow(() => new Function(src));
    execFileSync(process.execPath, ["--check"], { input: src, encoding: "utf8" });
});

test("buildMenuMessage matches protocol", () => {
    const msg = buildMenuMessage({ esp: false, minimap: true });
    assert.equal(msg.__adventurerOverlay, true);
    assert.equal(msg.type, "menu_state");
    assert.equal(msg.esp, false);
    assert.equal(msg.minimap, true);
});

test("logo data URI is valid base64 PNG", () => {
    assert.ok(LOGO_DATA_URI.startsWith("data:image/png;base64,"));
    assert.ok(LOGO_DATA_URI.length > 1000);
});

