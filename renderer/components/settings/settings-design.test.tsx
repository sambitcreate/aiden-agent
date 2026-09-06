import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("every settings destination uses the shared page and grouped row system", () => {
  const view = read("../../main/settings-view.tsx");
  assert.match(view, /<SettingsPage[\s\S]*<ActiveSection \/>[\s\S]*<\/SettingsPage>/u);
  for (const page of ["appearance", "providers", "mcp", "skills", "shortcut", "web-search"]) {
    assert.match(read(`./${page}-settings.tsx`), /settings-page-heading/u);
  }
  assert.match(
    read("./web-search-settings.tsx"),
    /<header className="settings-page-heading flex[\s\S]*?Web Search[\s\S]*?Allow Web Search/u,
  );
  const ui = read("../ui.tsx");
  assert.match(ui, /settings-group-card/u);
  assert.match(ui, /settings-field-control/u);
  const css = read("../../styles.css");
  assert.match(css, /--settings-card-fill:/u);
  assert.match(
    css,
    /settings-field-horizontal:has\(> \.settings-field-control > \[role="switch"\]\)/u,
  );
  assert.match(css, /outline: 2px solid var\(--focus-ring\)/u);
});

test("Memory uses an SD-card silhouette and settings/onboarding use no brain icons", () => {
  assert.match(read("../../main/settings-view.tsx"), /memory: <MemoryCardIcon/u);
  for (const path of [
    "../../main/settings-view.tsx",
    "../onboarding-flow.tsx",
    "./gemini-voice-setup-dialog.tsx",
  ]) {
    assert.doesNotMatch(read(path), /\bBrain(?:Circuit|Cog)?\b/u);
  }
});

test("Telegram switches have explicit accessible names and setup uses the real workspace entry", () => {
  const telegram = read("./telegram-settings.tsx");
  for (const label of ["Enable Telegram bridge", "Live answer drafts", "Private-chat threads"]) {
    assert.ok(telegram.includes(`aria-label="${label}"`));
  }
  assert.doesNotMatch(telegram, /Settings → Workspaces/u);
});
