import assert from "node:assert/strict";
import test from "node:test";
import {
  PENDING_DRAFT_WORKSPACE_MENU_MS,
  chatIdFromPath,
  draftWorkspaceMenu,
  registerDraftWorkspaceMenu,
  requestDraftWorkspaceMenu,
  type DraftWorkspaceMenuView,
} from "./draft-workspace-menu";

function recorder() {
  const opened: DraftWorkspaceMenuView[] = [];
  return {
    opened,
    handle: { openFolder: async () => undefined, openMenu: (view: DraftWorkspaceMenuView) => opened.push(view) },
  };
}

test("a mounted draft opens its menu at once; a draft that mounts soon after takes the request once", () => {
  const mounted = recorder();
  const release = registerDraftWorkspaceMenu("mounted", mounted.handle);
  requestDraftWorkspaceMenu("mounted", "clone");
  assert.deepEqual(mounted.opened, ["clone"]);
  assert.equal(draftWorkspaceMenu("mounted"), mounted.handle);
  release();
  assert.equal(draftWorkspaceMenu("mounted"), undefined);

  const later = recorder();
  requestDraftWorkspaceMenu("later", "clone", 1_000);
  const releaseLater = registerDraftWorkspaceMenu("later", later.handle, 1_500);
  assert.deepEqual(later.opened, ["clone"]);
  releaseLater();
  // Remounting the same draft does not replay it.
  const again = recorder();
  registerDraftWorkspaceMenu("later", again.handle, 1_600)();
  assert.deepEqual(again.opened, []);
});

test("a request for a pane that never mounts expires and is replaced by newer ones", () => {
  requestDraftWorkspaceMenu("never", "clone", 10_000);
  const stale = recorder();
  registerDraftWorkspaceMenu("never", stale.handle, 10_000 + PENDING_DRAFT_WORKSPACE_MENU_MS + 1)();
  assert.deepEqual(stale.opened, [], "an expired request is dropped");

  requestDraftWorkspaceMenu("first", "clone", 20_000);
  requestDraftWorkspaceMenu("second", "list", 20_001);
  const first = recorder();
  const second = recorder();
  registerDraftWorkspaceMenu("first", first.handle, 20_002)();
  registerDraftWorkspaceMenu("second", second.handle, 20_003)();
  assert.deepEqual([first.opened, second.opened], [[], ["list"]]);
});

test("only /chat/<id> paths name a chat", () => {
  assert.deepEqual(
    ["/chat/abc", "/chat/a%20b/", "/chat/abc/extra", "/settings", "/chat/%E0%A4"].map(chatIdFromPath),
    ["abc", "a b", undefined, undefined, undefined],
  );
});
