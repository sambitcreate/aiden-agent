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
  return { store, events, invoke, ran };
}

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

test("earlier versions are listed newest first and a restore from the renderer never approves commands", async (t) => {
  const { invoke, events, store } = await setup(t);
  const current = (await store.get("ws1", "art1"))!.artifact;
  const wider = [{ name: "pulls", kind: "shell" as const, command: "gh pr list --state all --json number", parse: "json" as const }];
  await store.replace("ws1", "art1", { title: "PRs", visual: current.visual, sources: wider, actions: [], refresh: current.refresh }, { approved: true });

  const history = (await invoke(WORKSPACE_ARTIFACT_CHANNELS.history, "ws1", "art1")) as { revision: number; commandsChanged: boolean }[];
  assert.deepEqual(history.map((entry) => [entry.revision, entry.commandsChanged]), [[1, true]]);

  for (const revision of [0, -1, 1.5, "1", undefined, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.restore, "ws1", "art1", revision), /Invalid revision/u);
  }
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.restore, "ws1", "art1", 7), /no longer kept/u);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.history, "ws-gone", "art1"), /no longer exists/u);
  assert.equal(events.length, 0);

  // Extra arguments cannot smuggle in an approval.
  const restored = (await invoke(WORKSPACE_ARTIFACT_CHANNELS.restore, "ws1", "art1", 1, { approved: true })) as { revision: number; approvedDigest?: string };
  assert.equal(restored.revision, 3);
  assert.equal(restored.approvedDigest, undefined);
  assert.deepEqual(events, [{ workspaceId: "ws1", artifactId: "art1", reason: "updated" }]);
  const [view] = (await invoke(WORKSPACE_ARTIFACT_CHANNELS.list, "ws1")) as WorkspaceArtifactView[];
  assert.deepEqual(view!.artifact.sources, current.sources);
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
