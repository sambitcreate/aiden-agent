import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { BOT_SIDEBAR_PREFERENCES_KEY } from "../../lib/bot-sidebar-preferences";

type HookModule = typeof import("./use-bot-sidebar-preferences");

// The hook keeps module-level state, so each test loads its own copy.
let loads = 0;
async function loadModule(): Promise<HookModule> {
  const specifier = `./use-bot-sidebar-preferences?fresh=${++loads}`;
  return (await import(specifier)) as HookModule;
}

async function loadHook(): Promise<HookModule["useBotSidebarPreferences"]> {
  return (await loadModule()).useBotSidebarPreferences;
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
  act(() => result.current.togglePin("b1"));
  assert.equal(result.current.preferences.pinnedBotId, "b1");
  assert.equal(stub.data.has(BOT_SIDEBAR_PREFERENCES_KEY), false);
  act(() => result.current.togglePin("b1"));
  assert.equal(result.current.preferences.pinnedBotId, null, "toggling the pinned Bot unpins it");
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
  act(() => first.result.current.forget("b1"));
  act(() => first.result.current.prune(new Set(["b1"])));
  assert.equal(stub.writes, 1, "forgetting and pruning a Bot with nothing stored write nothing");
  first.unmount();
  renderHook(() => useBotSidebarPreferences());
  assert.equal(stub.writes, 1, "a later mount finds the stored record");
  assert.equal(stored().since, since);
});

test("pruning with no live Bots keeps the pin, and pruning with live Bots drops a deleted one", async () => {
  const useBotSidebarPreferences = await loadHook();
  const { result } = renderHook(() => useBotSidebarPreferences());
  act(() => result.current.togglePin("b1"));
  act(() => result.current.prune(new Set()));
  assert.equal(result.current.preferences.pinnedBotId, "b1");
  act(() => result.current.prune(new Set(["b2"])));
  assert.equal(result.current.preferences.pinnedBotId, null);
  assert.equal(stored().pinnedBotId, null);
});

test("the gated preferences read and write nothing until enabled, then follow every change", async () => {
  const { useBotSidebarPreferencesWhen, botSidebarPreferenceActions } = await loadModule();
  let renders = 0;
  const { result, rerender } = renderHook(({ enabled }) => {
    renders += 1;
    return useBotSidebarPreferencesWhen(enabled);
  }, { initialProps: { enabled: false } });
  assert.equal(result.current === null, true, "a disabled caller reads nothing");
  assert.equal(stub.writes, 0, "a person who never enables it gets no stored record");
  const before = renders;
  act(() => botSidebarPreferenceActions.markViewed("b1", 5));
  assert.equal(renders, before, "a Bot visit doesn't re-render a disabled caller");

  rerender({ enabled: true });
  assert.equal(result.current?.lastViewed.b1 !== undefined, true, "enabling reads the current record");
  act(() => botSidebarPreferenceActions.markReplySeen("b2", 40));
  assert.equal(result.current?.seenReplyAt.b2, 40);
  assert.equal(result.current?.lastViewed.b2, undefined, "marking a reply read is not a view");
});
