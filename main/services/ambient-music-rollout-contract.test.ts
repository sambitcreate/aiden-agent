import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("the Ambient Music rollback gate hides every entry and avoids constructing the helper owner", () => {
  const handlers = source("../handlers/index.ts");
  const main = source("../index.ts");
  const serviceFactory = source("./ambient-music.ts");
  const settings = source("../../renderer/main/settings-view.tsx");
  const palette = source("../../renderer/components/command-palette.tsx");
  const onboarding = source("../../renderer/components/onboarding-flow.tsx");
  const llmClient = source("./llm-client.ts");

  assert.match(handlers, /if \(ambientMusicEnabled\(\)\) registerAmbientMusicHandlers\(\)/u);
  assert.match(main, /ambientMusicEnabled\(\) \? getAmbientMusicManager\(\) : undefined/u);
  assert.match(serviceFactory, /let manager: AmbientMusicManager \| undefined/u);
  assert.match(
    serviceFactory,
    /if \(!ambientMusicEnabled\(\)\)[\s\S]*?disabled by the local rollout policy/u,
  );
  assert.doesNotMatch(serviceFactory, /^const ambientMusicManager\b/mu);
  assert.match(settings, /NAV\.filter\(\(item\) => item\.id !== "ambientMusic"\)/u);
  assert.match(
    settings,
    /initialSection === "ambientMusic" && !ambientMusic[\s\S]*?\? "providers"/u,
  );
  assert.match(onboarding, /feature\.id !== "ambientMusic"/u);
  assert.match(palette, /settingsDestinationsForCapabilities\(\{ ambientMusic \}\)/u);
  assert.match(
    llmClient,
    /settingsSectionsForCapabilities\(\{[\s\S]*?ambientMusic: ambientMusicEnabled\(\)/u,
  );
});

test("rollback leaves future-tolerant prompt settings and downloaded model storage untouched", () => {
  const config = source("./config-store-core.ts");
  const factory = source("./ambient-music.ts");
  assert.match(
    config,
    /ambientMusic: \{ \.\.\.config\.settings\.ambientMusic, \.\.\.patch\.ambientMusic \}/u,
  );
  assert.match(factory, /app\.getPath\("userData"\), "Ambient Music"/u);
  assert.doesNotMatch(source("./ambient-music-feature-flag.ts"), /\brmSync\b|\brm\(/u);
});
