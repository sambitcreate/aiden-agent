import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { BOT_SIDEBAR_PREFERENCES_KEY } from "../../lib/bot-sidebar-preferences";

type HookModule = typeof import("./use-bot-sidebar-preferences");

// The hook keeps module-level state, so each test loads its own copy.
let loads = 0;
async function loadHook(): Promise<HookModule["useBotSidebarPreferences"]> {
  const specifier = `./use-bot-sidebar-preferences?fresh=${++loads}`;
  const loaded = (await import(specifier)) as HookModule;
  return loaded.useBotSidebarPreferences;
}

interface StubStorage {
  data: Map<string, string>;
  writes: number;
  failWrites: boolean;
}

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let stub: StubStorage;

beforeEach(() => {
  stub = { data: new Map(), writes: 0, failWrites: false };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stub.data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (stub.failWrites) throw new Error("quota");
        stub.writes += 1;
        stub.data.set(key, value);
      },
    },
  });
});

afterEach(() => {
  cleanup();
  if (originalDescriptor) Object.defineProperty(globalThis, "localStorage", originalDescriptor);
});

const stored = () => JSON.parse(stub.data.get(BOT_SIDEBAR_PREFERENCES_KEY) ?? "null");

test("a storage that refuses writes still updates the preferences for this session", async () => {
  const useBotSidebarPreferences = await loadHook();
  stub.failWrites = true;
  const { result } = renderHook(() => useBotSidebarPreferences());
  act(() => result.current.pin("b1"));
  assert.equal(result.current.preferences.pinnedBotId, "b1");
  assert.equal(stub.data.has(BOT_SIDEBAR_PREFERENCES_KEY), false);
});

test("a record written by another window is picked up on the storage event", async () => {
  const useBotSidebarPreferences = await loadHook();
  const { result } = renderHook(() => useBotSidebarPreferences());
  assert.equal(result.current.preferences.pinnedBotId, null);
  stub.data.set(
    BOT_SIDEBAR_PREFERENCES_KEY,
    JSON.stringify({ version: 1, since: 5, pinnedBotId: "b9", lastViewed: { b9: 10 } }),
  );
  act(() => {
    window.dispatchEvent(new window.StorageEvent("storage", { key: BOT_SIDEBAR_PREFERENCES_KEY }));
  });
  assert.equal(result.current.preferences.pinnedBotId, "b9");
  assert.equal(result.current.preferences.lastViewed.b9, 10);
});

test("the start time is written once on mount and not rewritten by actions that change nothing", async () => {
  const useBotSidebarPreferences = await loadHook();
  const first = renderHook(() => useBotSidebarPreferences());
  assert.equal(stub.writes, 1);
  const since = stored().since;
  assert.equal(typeof since, "number");
  act(() => first.result.current.unpin());
  act(() => first.result.current.prune(new Set(["b1"])));
  assert.equal(stub.writes, 1, "unpinning nothing and pruning nothing write nothing");
  first.unmount();
  renderHook(() => useBotSidebarPreferences());
  assert.equal(stub.writes, 1, "a later mount finds the stored record");
  assert.equal(stored().since, since);
});

test("pruning with no live Bots keeps the pin, and pruning with live Bots drops a deleted one", async () => {
  const useBotSidebarPreferences = await loadHook();
  const { result } = renderHook(() => useBotSidebarPreferences());
  act(() => result.current.pin("b1"));
  act(() => result.current.prune(new Set()));
  assert.equal(result.current.preferences.pinnedBotId, "b1");
  act(() => result.current.prune(new Set(["b2"])));
  assert.equal(result.current.preferences.pinnedBotId, null);
  assert.equal(stored().pinnedBotId, null);
});
