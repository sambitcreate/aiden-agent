import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react";

type StoreModule = typeof import("./use-sidebar-view");

const KEY = "aiden-agent.sidebar.v1";

// The store keeps module-level state, so each test loads its own copy.
let loads = 0;
async function loadStore(): Promise<StoreModule> {
  return (await import(`./use-sidebar-view?fresh=${++loads}`)) as StoreModule;
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

const stored = () => JSON.parse(stub.data.get(KEY) ?? "null") as Record<string, unknown>;

/** Another window writing the whole record, then its `storage` event arriving here. */
function otherWindowWrites(record: Record<string, unknown>) {
  stub.data.set(KEY, JSON.stringify(record));
  act(() => {
    window.dispatchEvent(new window.StorageEvent("storage", { key: KEY }));
  });
}

test("two consumers of the view stay in step within the window", async () => {
  const { useSidebarView } = await loadStore();
  const menu = renderHook(() => useSidebarView());
  const appearance = renderHook(() => useSidebarView());
  assert.equal(menu.result.current.view, "projects");
  act(() => appearance.result.current.setView("inbox"));
  assert.equal(menu.result.current.view, "inbox");
  assert.equal(stored().view, "inbox");
});

test("another window's view change arrives on its storage event", async () => {
  const { useSidebarView } = await loadStore();
  const { result } = renderHook(() => useSidebarView());
  otherWindowWrites({ view: "recent" });
  assert.equal(result.current.view, "recent");
});

test("a write keeps fields another window changed, even before its storage event lands", async () => {
  const { useSidebarView, useWorkingShelfCollapsed } = await loadStore();
  stub.data.set(KEY, JSON.stringify({ view: "projects", chatSort: "last_activity" }));
  const view = renderHook(() => useSidebarView());
  // Another window changes the chat sort; its event has not arrived yet.
  stub.data.set(KEY, JSON.stringify({ view: "projects", chatSort: "created" }));
  act(() => view.result.current.setView("recent"));
  assert.equal(stored().view, "recent");
  assert.equal(stored().chatSort, "created");

  const shelf = renderHook(() => useWorkingShelfCollapsed());
  act(() => shelf.result.current.setCollapsed(true));
  assert.deepEqual([stored().view, stored().chatSort, stored().workingShelfCollapsed], ["recent", "created", true]);
});

test("the Working shelf state is stored and shared across windows", async () => {
  const { useWorkingShelfCollapsed } = await loadStore();
  const { result } = renderHook(() => useWorkingShelfCollapsed());
  assert.equal(result.current.collapsed, false);
  act(() => result.current.setCollapsed(true));
  assert.equal(result.current.collapsed, true);
  otherWindowWrites({ ...stored(), workingShelfCollapsed: false });
  assert.equal(result.current.collapsed, false);
});

test("a patch prunes removed local workspaces, and a write that changes nothing is skipped", async () => {
  const { readSidebarPreferences, writeSidebarPreferences } = await loadStore();
  stub.data.set(KEY, JSON.stringify({ expandedWorkspaceIds: ["alpha", "gone"], projectOrder: ["local:gone", "studio:p"] }));
  writeSidebarPreferences({}, ["alpha"]);
  assert.deepEqual(stored().expandedWorkspaceIds, ["alpha"]);
  assert.deepEqual(stored().projectOrder, ["studio:p"]);
  const writes = stub.writes;
  writeSidebarPreferences({ chatSort: readSidebarPreferences().chatSort }, ["alpha"]);
  assert.equal(stub.writes, writes);
});

test("a storage that refuses writes still switches the view for this session", async () => {
  const { useSidebarView } = await loadStore();
  stub.failWrites = true;
  const { result } = renderHook(() => useSidebarView());
  act(() => result.current.setView("inbox"));
  assert.equal(result.current.view, "inbox");
  assert.equal(stub.data.has(KEY), false);
});

test("a window's own copies of stored fields hear another window's write, and only that", async () => {
  const { useSidebarPreferencesFromOtherWindows, writeSidebarPreferences } = await loadStore();
  const heard: { projectOrder: string[]; expandedWorkspaceIds: string[]; chatSort: string }[] = [];
  const { unmount } = renderHook(() =>
    useSidebarPreferencesFromOtherWindows(({ projectOrder, expandedWorkspaceIds, chatSort }) =>
      heard.push({ projectOrder, expandedWorkspaceIds, chatSort })),
  );
  // This window's own write raises no storage event here.
  act(() => writeSidebarPreferences({ projectOrder: ["local:alpha"] }));
  assert.equal(heard.length, 0);

  otherWindowWrites({ ...stored(), projectOrder: ["studio:p", "local:alpha"], expandedWorkspaceIds: ["alpha"] });
  assert.deepEqual(heard, [{ projectOrder: ["studio:p", "local:alpha"], expandedWorkspaceIds: ["alpha"], chatSort: "last_activity" }]);

  // Another key's event is not a sidebar write; after unmount nothing is heard.
  act(() => {
    window.dispatchEvent(new window.StorageEvent("storage", { key: "aiden-agent.other" }));
  });
  unmount();
  otherWindowWrites({ ...stored(), chatSort: "created" });
  assert.equal(heard.length, 1);
});
