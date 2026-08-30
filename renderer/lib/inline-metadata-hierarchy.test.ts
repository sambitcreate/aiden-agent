import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("shared inline metadata preserves the approved hierarchy", () => {
  const ui = source("../components/ui.tsx");
  const primitive = ui.slice(
    ui.indexOf("export function InlineMetadata"),
    ui.indexOf("export function Badge"),
  );

  assert.match(primitive, /React\.HTMLAttributes<HTMLSpanElement>/u);
  assert.match(primitive, /text-\[0\.5em\] opacity-30/u);
  assert.doesNotMatch(primitive, /aria-hidden/u);
});

test("secondary menu suffixes use the shared hierarchy primitive", () => {
  const appearance = source("../components/settings/appearance-settings.tsx");
  const providerEditor = source("../components/settings/provider-editor.tsx");
  const telegram = source("../components/settings/telegram-settings.tsx");
  const bots = source("../main/bots-view.tsx");
  const webSearch = source("../components/settings/web-search-settings.tsx");

  assert.equal(
    appearance.match(/<InlineMetadata>· \{font\.preview\}<\/InlineMetadata>/gu)?.length,
    2,
  );
  assert.match(providerEditor, /<InlineMetadata>· Hidden<\/InlineMetadata>/u);
  assert.match(telegram, /<InlineMetadata>· connected<\/InlineMetadata>/u);
  assert.match(telegram, /<InlineMetadata>· Hidden<\/InlineMetadata>/u);
  assert.match(
    bots,
    /<InlineMetadata>[\s\S]*· \{model\.supportsImages \? "Vision" : "Text only"\}[\s\S]*<\/InlineMetadata>/u,
  );
  assert.match(
    webSearch,
    /<InlineMetadata>· \{COST_LABELS\[provider\.costClass\]\}<\/InlineMetadata>/u,
  );
});
