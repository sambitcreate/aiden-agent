import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { compileAum } from "../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_CATALOG_VERSION } from "../../renderer/shared/aiden-ui/types.js";
import type { WorkspaceArtifactsChangedEvent, WorkspaceArtifactView } from "../../renderer/shared/workspace-artifacts.js";
import { WorkspaceArtifactStore } from "../services/workspace-artifacts/store.js";
import { registerWorkspaceArtifactHandlers, WORKSPACE_ARTIFACT_CHANNELS } from "./workspace-artifacts.js";

async function setup(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-artifact-ipc-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new WorkspaceArtifactStore({ root: () => dir, newId: () => "art1" });
  const events: WorkspaceArtifactsChangedEvent[] = [];
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ran: unknown[][] = [];
  registerWorkspaceArtifactHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    store,
    workspaceExists: async (id) => id === "ws1",
    notify: (event) => events.push(event),
    runner: {
      refresh: async (...args) => {
        ran.push(["refresh", ...args.slice(0, 3)]);
        return {};
      },
      runAction: async (...args) => {
        ran.push(["run", ...args.slice(0, 5), args[6]]);
        return { ok: true, output: "" };
      },
    },
    // The real binding resolves the folder for the calling window.
    runInWorkspace: (_event, _workspaceId, operation) =>
      operation({ folderPath: "/work/ws1", permission: "full" }, new AbortController().signal),
  });
  const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!({}, ...args));
  const compiled = compileAum('<Visual title="PRs"><Text>{len($pulls)}</Text></Visual>');
  await store.create("ws1", {
    title: "PRs",
    visual: { version: 1, kind: "ui", id: "x", title: "PRs", catalogVersion: AIDEN_UI_CATALOG_VERSION, tree: compiled.tree!, fallbackText: "" },
    sources: [{ name: "pulls", kind: "shell", command: "gh pr list --json number", parse: "json" }],
    actions: [],
    refresh: { onOpen: true },
  });
  return { store, events, invoke, handlers, ran };
}

test("every channel the renderer calls is registered", async (t) => {
  const { handlers } = await setup(t);
  assert.deepEqual([...handlers.keys()].sort(), Object.values(WORKSPACE_ARTIFACT_CHANNELS).sort());
});

test("requests for a missing workspace or a malformed id are refused", async (t) => {
  const { invoke } = await setup(t);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.list, "ws-gone"), /no longer exists/u);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.list, "../ws1"), /workspace identifier/u);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.delete, "ws1", "../art1"), /artifact identifier/u);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.rename, "ws1", "art1", ""), /title/u);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.approve, "ws1", "art1", "not-a-digest"), /approval/u);
});

test("approving needs the digest of the commands the person saw, and tells every window", async (t) => {
  const { invoke, events } = await setup(t);
  const [view] = (await invoke(WORKSPACE_ARTIFACT_CHANNELS.list, "ws1")) as WorkspaceArtifactView[];
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.approve, "ws1", "art1", "0".repeat(64)), /changed after you looked/u);
  assert.equal(events.length, 0);
  await invoke(WORKSPACE_ARTIFACT_CHANNELS.approve, "ws1", "art1", view!.digest);
  const [approved] = (await invoke(WORKSPACE_ARTIFACT_CHANNELS.list, "ws1")) as WorkspaceArtifactView[];
  assert.equal(approved!.artifact.approvedDigest, view!.digest);
  assert.deepEqual(events, [{ workspaceId: "ws1", artifactId: "art1", reason: "updated" }]);
});

test("rename and delete announce the change; page state saves quietly", async (t) => {
  const { invoke, events } = await setup(t);
  await invoke(WORKSPACE_ARTIFACT_CHANNELS.saveState, "ws1", "art1", { tab: "mine" });
  assert.equal(events.length, 0);
  await invoke(WORKSPACE_ARTIFACT_CHANNELS.rename, "ws1", "art1", "Open PRs");
  const [renamed] = (await invoke(WORKSPACE_ARTIFACT_CHANNELS.list, "ws1")) as WorkspaceArtifactView[];
  assert.equal(renamed!.artifact.visual.title, "Open PRs");
  assert.deepEqual(renamed!.artifact.visual.state, { tab: "mine" });
  assert.deepEqual(await invoke(WORKSPACE_ARTIFACT_CHANNELS.delete, "ws1", "art1"), { removed: true });
  assert.deepEqual(await invoke(WORKSPACE_ARTIFACT_CHANNELS.delete, "ws1", "art1"), { removed: false });
  assert.deepEqual(events.map((event) => event.reason), ["updated", "deleted"]);
});

const DIGEST = "c".repeat(64);

test("refresh and buttons run in the resolved workspace folder, and only with well-formed input", async (t) => {
  const { invoke, ran } = await setup(t);
  await invoke(WORKSPACE_ARTIFACT_CHANNELS.refresh, "ws1", "art1");
  await invoke(WORKSPACE_ARTIFACT_CHANNELS.run, "ws1", "art1", "merge", [12], DIGEST);
  const context = { folderPath: "/work/ws1", permission: "full" };
  assert.deepEqual(ran, [
    ["refresh", "ws1", "art1", context],
    ["run", "ws1", "art1", "merge", [12], context, DIGEST],
  ]);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.run, "ws1", "art1", "rm -rf", [], DIGEST), /Invalid button/u);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.run, "ws1", "art1", "merge", "12", DIGEST), /values/u);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.run, "ws1", "art1", "merge", Array(9).fill(1), DIGEST), /values/u);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.run, "ws1", "art1", "merge", [12]), /request/u);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.refresh, "ws-gone", "art1"), /no longer exists/u);
  assert.equal(ran.length, 2);
});
