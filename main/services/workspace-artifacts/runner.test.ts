import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { compileAum } from "../../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_CATALOG_VERSION } from "../../../renderer/shared/aiden-ui/types.js";
import type {
  WorkspaceArtifactActionV1,
  WorkspaceArtifactPermission,
  WorkspaceArtifactsChangedEvent,
  WorkspaceArtifactSourceV1,
} from "../../../renderer/shared/workspace-artifacts.js";
import { runBoundedShellCommand, type BoundedShellCommandOptions } from "../bounded-shell-command.js";
import { readWorkspaceFile } from "../workspace-files.js";
import { createWorkspaceArtifactRunner } from "./runner.js";
import { WorkspaceArtifactStore } from "./store.js";

const SHELL: WorkspaceArtifactSourceV1 = { name: "pulls", kind: "shell", command: `printf '[{"number":12}]'`, parse: "json" };
const FILE: WorkspaceArtifactSourceV1 = { name: "todo", kind: "file", file: "TODO.md", parse: "lines" };
const ECHO: WorkspaceArtifactActionV1 = { name: "note", label: "Write note", command: "printf '%s' {{text}} > note.txt", params: [{ name: "text", type: "string" }] };

async function setup(t: test.TestContext, options: { sources?: WorkspaceArtifactSourceV1[]; approved?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-artifact-runner-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const folder = path.join(dir, "workspace");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "TODO.md"), "ship it\n\nreview #12\n");
  const store = new WorkspaceArtifactStore({ root: () => path.join(dir, "store"), newId: () => "art1" });
  const events: WorkspaceArtifactsChangedEvent[] = [];
  const commands: string[] = [];
  const runner = createWorkspaceArtifactRunner({
    runShell: (shell: BoundedShellCommandOptions) => {
      commands.push(shell.command);
      return runBoundedShellCommand(shell);
    },
    readFile: async (root, file, signal) => (await readWorkspaceFile(root, file, signal)).content,
    env: () => process.env,
    store,
    notify: (event) => events.push(event),
  });
  const compiled = compileAum('<Visual title="PRs"><Text>{len($pulls)}</Text></Visual>');
  await store.create(
    "ws1",
    {
      title: "PRs",
      visual: { version: 1, kind: "ui", id: "x", title: "PRs", catalogVersion: AIDEN_UI_CATALOG_VERSION, tree: compiled.tree!, fallbackText: "" },
      sources: options.sources ?? [SHELL, FILE],
      actions: [ECHO],
      refresh: { onOpen: true },
    },
    { approved: options.approved ?? false },
  );
  const context = (permission: WorkspaceArtifactPermission) => ({ folderPath: folder, permission });
  return { folder, store, events, commands, runner, context };
}

test("a refresh runs commands in the workspace folder, reads files, and saves what it found", async (t) => {
  const { runner, store, events, context } = await setup(t);
  const results = await runner.refresh("ws1", "art1", context("full"));
  assert.deepEqual(
    Object.fromEntries(Object.entries(results).map(([name, result]) => [name, [result.status, result.dataJson]])),
    { pulls: ["ok", '[{"number":12}]'], todo: ["ok", '["ship it","review #12"]'] },
  );
  const saved = (await store.get("ws1", "art1"))!.snapshot!;
  assert.equal(saved.sources.pulls!.dataJson, '[{"number":12}]');
  assert.deepEqual(events, [{ workspaceId: "ws1", artifactId: "art1", reason: "refreshed" }]);
});

test("under Ask, commands wait for approval while workspace files still load", async (t) => {
  const { runner, commands, context } = await setup(t);
  const results = await runner.refresh("ws1", "art1", context("ask"));
  assert.equal(results.pulls!.status, "blocked");
  assert.match(results.pulls!.error!, /allow/u);
  assert.equal(results.todo!.status, "ok");
  assert.deepEqual(commands, []);
});

test("an approved page runs under Ask; no access runs nothing", async (t) => {
  const { runner, commands, context } = await setup(t, { approved: true });
  assert.equal((await runner.refresh("ws1", "art1", context("ask"))).pulls!.status, "ok");
  const none = await runner.refresh("ws1", "art1", context("none"));
  assert.deepEqual([none.pulls!.status, none.todo!.status], ["blocked", "blocked"]);
  assert.equal(commands.length, 1);
});

test("a failing source reports why and keeps the data it had", async (t) => {
  const { runner, store, context } = await setup(t, { sources: [SHELL] });
  await runner.refresh("ws1", "art1", context("full"));
  const artifact = (await store.get("ws1", "art1"))!.artifact;
  await store.replace("ws1", "art1", {
    title: "PRs",
    visual: artifact.visual,
    sources: [{ ...SHELL, command: "echo 'gh: not logged in' >&2; exit 4" }],
    actions: [],
    refresh: artifact.refresh,
  });
  const results = await runner.refresh("ws1", "art1", context("full"));
  assert.match(results.pulls!.error!, /code 4.*not logged in/su);
  const saved = (await store.get("ws1", "art1"))!.snapshot!;
  assert.equal(saved.sources.pulls!.status, "error");
  assert.equal(saved.sources.pulls!.dataJson, '[{"number":12}]');
});

test("a file source cannot follow a link out of the workspace", async (t) => {
  const { runner, folder, context } = await setup(t, { sources: [{ ...FILE, file: "escape.md" }] });
  const outside = path.join(path.dirname(folder), "secret.md");
  await fs.writeFile(outside, "secret\n");
  await fs.symlink(outside, path.join(folder, "escape.md"));
  const results = await runner.refresh("ws1", "art1", context("full"));
  assert.equal(results.todo!.status, "error");
  assert.equal(results.todo!.dataJson, undefined);
});

test("refreshes of the same page at once share one run", async (t) => {
  const { runner, commands, context } = await setup(t, { sources: [SHELL] });
  await Promise.all([runner.refresh("ws1", "art1", context("full")), runner.refresh("ws1", "art1", context("full"))]);
  assert.equal(commands.length, 1);
});

test("a button runs its saved command with the page's value as one literal argument", async (t) => {
  const { runner, folder, context } = await setup(t);
  const value = "$(touch hacked); `id` 'quoted'";
  const result = await runner.runAction("ws1", "art1", "note", [value], context("full"));
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(folder, "note.txt"), "utf8"), value);
  await assert.rejects(fs.stat(path.join(folder, "hacked")));
});

test("buttons follow the workspace's access and only exist if the page declared them", async (t) => {
  const { runner, context } = await setup(t);
  await assert.rejects(runner.runAction("ws1", "art1", "note", ["x"], context("ask")), /Allow this page/u);
  await assert.rejects(runner.runAction("ws1", "art1", "note", ["x"], context("none")), /access is off/u);
  await assert.rejects(runner.runAction("ws1", "art1", "rm", [], context("full")), /no button named "rm"/u);
  const failed = await runner.runAction("ws1", "art1", "note", ["-rf"], context("full")).catch((error: Error) => error);
  assert.match(String(failed), /cannot start with "-"/u);
});
