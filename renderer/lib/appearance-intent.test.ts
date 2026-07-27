import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  beginAppearanceIntent,
  createNativeAppearanceRevisionTracker,
  readAppearanceIntentRevision,
  rebaseAppearanceIntentAfterFailure,
  reconcileNativeThemeChange,
  reconcileRuntimeAppearanceEvent,
  runAppearanceIntent,
} from "./appearance-runtime";
import { createDefaultAppearanceConfig } from "../shared/appearance";

test("a newer appearance intent invalidates in-flight work and runs after it", async () => {
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstRevision = beginAppearanceIntent();
  let firstStillCurrent = true;
  const first = runAppearanceIntent(firstRevision, async (isCurrent) => {
    markFirstStarted();
    await firstGate;
    firstStillCurrent = isCurrent();
  });
  await firstStarted;

  const secondRevision = beginAppearanceIntent();
  let secondRan = false;
  const second = runAppearanceIntent(secondRevision, async (isCurrent) => {
    secondRan = isCurrent();
  });
  await Promise.resolve();
  assert.equal(secondRan, false, "appearance writers stay serialized");

  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(firstStillCurrent, false);
  assert.equal(secondRan, true);
});

test("appearance hydration rereads native state changed during an IPC read", async () => {
  const tracker = createNativeAppearanceRevisionTracker();
  let releaseOldRead!: () => void;
  const oldReadGate = new Promise<void>((resolve) => {
    releaseOldRead = resolve;
  });
  let reads = 0;

  const stable = tracker.readStable(async () => {
    reads += 1;
    if (reads === 1) {
      await oldReadGate;
      return "old";
    }
    return "new";
  });

  tracker.markChanged();
  releaseOldRead();

  assert.equal(await stable, "new");
  assert.equal(reads, 2);
});

test("a newer runtime event replaces stale Settings hydration and its pending save", () => {
  const stale = {
    ...createDefaultAppearanceConfig(),
    mode: "dark" as const,
    uiFontSize: 14,
  };
  const fromCommandPalette = {
    ...stale,
    mode: "light" as const,
    uiFontSize: 17,
  };

  const reconciled = reconcileRuntimeAppearanceEvent(
    fromCommandPalette,
    4,
    5,
  );
  assert.equal(reconciled.config.mode, "light");
  assert.equal(reconciled.config.uiFontSize, 17);
  assert.equal(reconciled.supersedesPending, true);
  assert.equal(
    reconcileRuntimeAppearanceEvent(fromCommandPalette, 5, 5).supersedesPending,
    false,
  );
});

test("a failed newer intent rebases an older pending save onto current ownership", async () => {
  const pendingRevision = beginAppearanceIntent();
  const failedRevision = beginAppearanceIntent();
  const rebasedRevision = rebaseAppearanceIntentAfterFailure(
    pendingRevision,
    failedRevision,
    readAppearanceIntentRevision(),
  );
  assert.ok(rebasedRevision !== null && rebasedRevision > failedRevision);

  let persisted = false;
  await runAppearanceIntent(rebasedRevision, async (isCurrent) => {
    persisted = isCurrent();
  });
  assert.equal(persisted, true);
  assert.equal(
    rebaseAppearanceIntentAfterFailure(
      rebasedRevision,
      rebasedRevision,
      readAppearanceIntentRevision(),
    ),
    null,
  );
});

test("Command-K, full Settings, and hydration share appearance intent ownership", () => {
  const palette = readFileSync(
    new URL("../components/command-palette.tsx", import.meta.url),
    "utf8",
  );
  const settings = readFileSync(
    new URL("../components/settings/appearance-settings.tsx", import.meta.url),
    "utf8",
  );
  const theme = readFileSync(new URL("./use-theme.ts", import.meta.url), "utf8");

  assert.match(palette, /beginAppearanceIntent\(\)/u);
  assert.match(palette, /runAppearanceIntent\(revision/u);
  assert.match(settings, /beginAppearanceIntent\(\)/u);
  assert.match(settings, /runAppearanceIntent\(revision/u);
  assert.match(settings, /hydrationRevision !== readAppearanceIntentRevision\(\)/u);
  assert.match(theme, /runAppearanceIntent\(hydrationRevision/u);
  assert.match(theme, /nativeRevision\.readStable/u);
  assert.match(settings, /nativeRevision\.readStable/u);
  assert.match(theme, /reconcileNativeThemeChange\(config, info\)/u);
  assert.match(settings, /reconcileNativeThemeChange\(configRef\.current, nativeInfo\)/u);
  assert.match(settings, /window\.addEventListener\(APPEARANCE_CHANGE_EVENT/u);
  assert.match(settings, /reconcileRuntimeAppearanceEvent\(/u);
  assert.match(settings, /APPEARANCE_INTENT_FAILED_EVENT/u);
  assert.match(settings, /scheduleSave\(pending\.config, rebasedRevision\)/u);
});

test("a delayed native theme notification cannot restore an older mode", () => {
  const newerConfig = {
    ...createDefaultAppearanceConfig(),
    mode: "system" as const,
    uiFontSize: 17,
  };

  const reconciled = reconcileNativeThemeChange(newerConfig, {
    shouldUseDarkColors: true,
    shouldUseHighContrastColors: false,
    // Electron's payload may still describe the older programmatic source,
    // but source ownership belongs to the newer config revision.
    themeSource: "dark",
  });

  assert.equal(reconciled, null);

  const matchingSystemChange = reconcileNativeThemeChange(newerConfig, {
    shouldUseDarkColors: true,
    shouldUseHighContrastColors: true,
    themeSource: "system",
  });
  assert.equal(matchingSystemChange?.config.mode, "system");
  assert.equal(matchingSystemChange?.config.uiFontSize, 17);
  assert.equal(matchingSystemChange?.nativeUsesDarkColors, true);
  assert.equal(matchingSystemChange?.systemHighContrast, true);
});
