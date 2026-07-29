import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APPEARANCE_STORAGE_KEY } from "./appearance-runtime";
import {
  parsePillAppearanceStorageValue,
  startPillAppearanceSync,
  type PillAppearanceSyncEnvironment,
} from "./pill-appearance";
import {
  createDefaultAppearanceConfig,
  getPresetVariant,
  type AppearanceConfig,
} from "../shared/appearance";

class FakeMediaQuery {
  matches = false;
  readonly listeners = new Set<(event: MediaQueryListEvent) => void>();

  addEventListener(
    _type: "change",
    listener: (event: MediaQueryListEvent) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "change",
    listener: (event: MediaQueryListEvent) => void,
  ): void {
    this.listeners.delete(listener);
  }

  change(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) {
      listener({ matches } as MediaQueryListEvent);
    }
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function customAppearance(
  mode: AppearanceConfig["mode"] = "system",
): AppearanceConfig {
  const config = createDefaultAppearanceConfig();
  config.mode = mode;
  config.light = {
    ...getPresetVariant("berry", "light"),
    preset: "custom",
    accent: "#A12B6B",
  };
  config.dark = getPresetVariant("slate", "dark");
  return config;
}

function harness(options: {
  cached?: AppearanceConfig | null;
  persisted?: unknown | Promise<unknown>;
} = {}) {
  let cached = options.cached === undefined
    ? createDefaultAppearanceConfig()
    : options.cached;
  let persisted: unknown = options.persisted ?? null;
  const darkScheme = new FakeMediaQuery();
  const highContrast = new FakeMediaQuery();
  const reducedMotion = new FakeMediaQuery();
  const storageListeners = new Set<
    (event: { key: string | null; newValue: string | null }) => void
  >();
  const appearanceListeners = new Set<(value: unknown) => void>();
  const visibilityListeners = new Set<() => void>();
  const applied: Array<{
    config: AppearanceConfig;
    dark: boolean;
    highContrast: boolean;
  }> = [];
  const environment: PillAppearanceSyncEnvironment = {
    readCachedAppearance: () => cached,
    readAuthoritativeAppearance: () => Promise.resolve(persisted),
    applyAppearance: (config, dark, systemHighContrast) => {
      applied.push({ config, dark, highContrast: systemHighContrast });
    },
    darkScheme,
    highContrast,
    reducedMotion,
    subscribeStorage: (listener) => {
      storageListeners.add(listener);
      return () => storageListeners.delete(listener);
    },
    subscribeAppearance: (listener) => {
      appearanceListeners.add(listener);
      return () => appearanceListeners.delete(listener);
    },
    subscribeVisibility: (listener) => {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
  };
  return {
    environment,
    applied,
    darkScheme,
    highContrast,
    reducedMotion,
    setCached(next: AppearanceConfig | null) {
      cached = next;
    },
    setPersisted(next: unknown | Promise<unknown>) {
      persisted = next;
    },
    emitStorage(value: string | null, key = APPEARANCE_STORAGE_KEY) {
      for (const listener of storageListeners) listener({ key, newValue: value });
    },
    emitAppearance(value: unknown) {
      for (const listener of appearanceListeners) listener(value);
    },
    emitVisibility() {
      for (const listener of visibilityListeners) listener();
    },
    listenerCounts() {
      return {
        storage: storageListeners.size,
        appearance: appearanceListeners.size,
        visibility: visibilityListeners.size,
        media:
          darkScheme.listeners.size
          + highContrast.listeners.size
          + reducedMotion.listeners.size,
      };
    },
  };
}

function lastApplied(
  applied: Array<{
    config: AppearanceConfig;
    dark: boolean;
    highContrast: boolean;
  }>,
) {
  return applied[applied.length - 1];
}

test("strict pill cache parsing rejects missing, partial, and malformed values", () => {
  const valid = customAppearance("dark");
  assert.deepEqual(
    parsePillAppearanceStorageValue(JSON.stringify(valid)),
    valid,
  );
  assert.equal(parsePillAppearanceStorageValue(null), null);
  assert.equal(parsePillAppearanceStorageValue("{"), null);
  assert.equal(parsePillAppearanceStorageValue("{}"), null);
});

test("the same pill reacts to scheme, contrast, motion, and palette changes", () => {
  const setup = harness();
  const sync = startPillAppearanceSync(setup.environment);
  assert.equal(setup.applied.length, 1);

  setup.darkScheme.change(true);
  assert.equal(lastApplied(setup.applied)?.dark, true);
  setup.highContrast.change(true);
  assert.equal(lastApplied(setup.applied)?.highContrast, true);
  const beforeMotion = setup.applied.length;
  setup.reducedMotion.change(true);
  assert.equal(setup.applied.length, beforeMotion + 1);

  const next = customAppearance("light");
  setup.emitStorage(JSON.stringify(next));
  assert.equal(lastApplied(setup.applied)?.config.light.preset, "custom");
  assert.equal(lastApplied(setup.applied)?.config.light.accent, "#A12B6B");

  const beforeUnrelated = setup.applied.length;
  setup.emitStorage(JSON.stringify(createDefaultAppearanceConfig()), "other-key");
  assert.equal(setup.applied.length, beforeUnrelated);
  sync.stop();
});

test("missing cache hydrates settings without clobbering a newer storage event", async () => {
  const persisted = deferred<unknown>();
  const setup = harness({ cached: null, persisted: persisted.promise });
  const sync = startPillAppearanceSync(setup.environment);
  assert.equal(setup.applied.length, 0);

  const newer = customAppearance("dark");
  setup.emitStorage(JSON.stringify(newer));
  assert.equal(lastApplied(setup.applied)?.config.mode, "dark");

  const stale = createDefaultAppearanceConfig();
  stale.mode = "light";
  persisted.resolve(stale);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lastApplied(setup.applied)?.config.mode, "dark");
  sync.stop();
});

test("corrupt cache falls back to validated persisted appearance", async () => {
  const recovered = customAppearance("system");
  const setup = harness({ cached: null, persisted: recovered });
  const sync = startPillAppearanceSync(setup.environment);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(lastApplied(setup.applied)?.config, recovered);
  sync.stop();
});

test("entrypoint default cache is reconciled with persisted appearance", async () => {
  const recovered = customAppearance("dark");
  const setup = harness({
    cached: createDefaultAppearanceConfig(),
    persisted: recovered,
  });
  const sync = startPillAppearanceSync(setup.environment);
  assert.equal(setup.applied.length, 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(lastApplied(setup.applied)?.config, recovered);
  sync.stop();
});

test("appearance broadcasts update a hidden pill before it becomes visible", async () => {
  const stale = createDefaultAppearanceConfig();
  const setup = harness({ cached: stale, persisted: stale });
  const sync = startPillAppearanceSync(setup.environment);
  await sync.ready;

  const newer = customAppearance("dark");
  setup.setPersisted(newer);
  setup.emitAppearance(newer);
  assert.deepEqual(lastApplied(setup.applied)?.config, newer);
  setup.emitVisibility();
  await Promise.resolve();
  assert.deepEqual(lastApplied(setup.applied)?.config, newer);
  sync.stop();
});

test("visibility refreshes authoritative state and cleanup removes every listener", async () => {
  const setup = harness();
  const sync = startPillAppearanceSync(setup.environment);
  await sync.ready;
  const next = customAppearance("dark");
  setup.setPersisted(next);
  setup.emitVisibility();
  await Promise.resolve();
  assert.deepEqual(lastApplied(setup.applied)?.config, next);
  assert.deepEqual(setup.listenerCounts(), {
    storage: 1,
    appearance: 1,
    visibility: 1,
    media: 3,
  });

  const appliedBeforeStop = setup.applied.length;
  sync.stop();
  assert.deepEqual(setup.listenerCounts(), {
    storage: 0,
    appearance: 0,
    visibility: 0,
    media: 0,
  });
  setup.darkScheme.change(true);
  setup.emitStorage(JSON.stringify(createDefaultAppearanceConfig()));
  setup.emitVisibility();
  assert.equal(setup.applied.length, appliedBeforeStop);
});

test("dictation readiness waits for initial authoritative appearance hydration", () => {
  const source = readFileSync(
    new URL("../pill/pill-app.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /appearanceReadyRef\.current\.then\(\(\) => \{[\s\S]*?dictationApi\.ready\(\)/u,
  );
});
