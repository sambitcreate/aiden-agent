import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queries";
import { subscribeWorkspaceFilesSync } from "./workspace-files-sync";

function harness() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.skillCatalog("ws-1"), []);
  queryClient.setQueryData(queryKeys.skillCatalog("ws-2"), []);
  const handlers = new Map<string, (payload: unknown) => void>();
  subscribeWorkspaceFilesSync(queryClient, (channel, handler) => {
    handlers.set(channel, handler);
    return () => handlers.delete(channel);
  });
  const stale = (workspaceId: string) =>
    queryClient.getQueryState(queryKeys.skillCatalog(workspaceId))?.isInvalidated === true;
  return { emit: (payload: unknown) => handlers.get("workspace:files-touched")?.(payload), stale };
}

test("files the agent touched re-read that workspace's skills for the / menu", () => {
  const h = harness();
  h.emit({ workspaceId: "ws-1" });
  assert.equal(h.stale("ws-1"), true);
  assert.equal(h.stale("ws-2"), false);
});

test("a notice without a workspace changes nothing", () => {
  const h = harness();
  h.emit({});
  h.emit(null);
  assert.equal(h.stale("ws-1"), false);
});
