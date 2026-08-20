import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./remote-access-settings.tsx", import.meta.url), "utf8");

test("Remote Access settings use the existing semantic form and confirmation primitives", () => {
  for (const primitive of ["FieldSet", "Field", "Switch", "Select", "Callout", "Dialog", "AlertDialog"]) {
    assert.match(source, new RegExp(`<${primitive}`, "u"));
  }
  assert.match(source, /onValueChange=/u);
  assert.match(source, /aria-label="Enable Aiden Remote Access"/u);
  assert.match(source, /max-\[540px\]/u);
});

test("pairing renders only the versioned QR envelope and labels its short value as visual verification", () => {
  assert.match(source, /QRCode\.toDataURL\(pairing\.qrPayload/u);
  assert.doesNotMatch(source, /\{pairing\.secret\}/u);
  assert.match(source, /This is a visual check, not a manual pairing password\./u);
  assert.match(source, /expires after five minutes/u);
});

test("Tailscale and folder controls explain their bounded ownership", () => {
  assert.match(source, /never enables Funnel, and never resets unrelated routes/u);
  assert.match(source, /Paired devices can explore only these roots/u);
  assert.match(source, /Existing Aiden workspaces are unchanged/u);
});
