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

async function setup(t: test.TestContext, options: { sources?: WorkspaceArtifactSourceV1[]; approved?: boolean; readDelayMs?: number } = {}) {
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
    readFile: async (root, file, signal) => {
      if (options.readDelayMs) await new Promise((resolve) => setTimeout(resolve, options.readDelayMs));
      return (await readWorkspaceFile(root, file, signal)).content;
    },
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

test("a button cancelled before its command starts runs nothing", async (t) => {
  const { runner, folder, context } = await setup(t);
  // Access changed while the press was still being checked.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runner.runAction("ws1", "art1", "note", ["x"], context("full"), controller.signal), /Cancelled/u);
  await assert.rejects(fs.stat(path.join(folder, "note.txt")));
});

test("buttons follow the workspace's access and only exist if the page declared them", async (t) => {
  const { runner, context } = await setup(t);
  await assert.rejects(runner.runAction("ws1", "art1", "note", ["x"], context("ask")), /Allow this page/u);
  await assert.rejects(runner.runAction("ws1", "art1", "note", ["x"], context("none")), /access is off/u);
  await assert.rejects(runner.runAction("ws1", "art1", "rm", [], context("full")), /no button named "rm"/u);
  const failed = await runner.runAction("ws1", "art1", "note", ["-rf"], context("full")).catch((error: Error) => error);
  assert.match(String(failed), /cannot start with "-"/u);
});

test("a button pressed on an older version of the page does not run the newer command", async (t) => {
  const { runner, store, commands, context } = await setup(t);
  const before = (await store.get("ws1", "art1"))!;
  await store.replace("ws1", "art1", {
    title: "PRs",
    visual: before.artifact.visual,
    sources: before.artifact.sources,
    actions: [{ ...ECHO, command: "printf '%s' {{text}} > other.txt" }],
    refresh: before.artifact.refresh,
  });
  await assert.rejects(runner.runAction("ws1", "art1", "note", ["x"], context("full"), undefined, before.digest), /changed/u);
  assert.deepEqual(commands, []);
});

async function until(check: () => boolean) {
  for (let tries = 0; !check(); tries += 1) {
    if (tries > 200) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a refresh asked for after the page's commands changed reads the new commands, and the old run saves nothing", async (t) => {
  const slow: WorkspaceArtifactSourceV1 = { name: "v", kind: "shell", command: `sleep 0.3; printf '"OLD"'`, parse: "json" };
  const { runner, store, commands, context } = await setup(t, { sources: [slow] });
  const old = runner.refresh("ws1", "art1", context("full"));
  await until(() => commands.length === 1);
  const artifact = (await store.get("ws1", "art1"))!.artifact;
  await store.replace("ws1", "art1", { title: "PRs", visual: artifact.visual, sources: [{ ...slow, command: `printf '"NEW"'` }], actions: [ECHO], refresh: artifact.refresh });
  const fresh = await runner.refresh("ws1", "art1", context("full"));
  assert.equal(fresh.v!.dataJson, '"NEW"');
  assert.equal((await old).v!.dataJson, '"OLD"');
  assert.equal((await store.get("ws1", "art1"))!.snapshot!.sources.v!.dataJson, '"NEW"');
});

test("one caller cancelling leaves a shared refresh running for the others; the last one out stops it", async (t) => {
  const slow: WorkspaceArtifactSourceV1 = { name: "v", kind: "shell", command: "sleep 0.3; printf 1", parse: "json" };
  const { runner, store, commands, context } = await setup(t, { sources: [slow] });
  const turn = new AbortController();
  const fromTurn = runner.refresh("ws1", "art1", context("full"), turn.signal);
  const fromTab = runner.refresh("ws1", "art1", context("full"));
  await until(() => commands.length === 1);
  turn.abort();
  assert.equal((await fromTurn).v!.error, "Cancelled.");
  assert.equal((await fromTab).v!.dataJson, "1");
  assert.equal((await store.get("ws1", "art1"))!.snapshot!.sources.v!.dataJson, "1");
  assert.equal(commands.length, 1);

  const alone = new AbortController();
  const started = Date.now();
  const cancelled = runner.refresh("ws1", "art1", context("full"), alone.signal);
  await until(() => commands.length === 2);
  alone.abort();
  assert.equal((await cancelled).v!.error, "Cancelled.");
  // The abandoned run is stopped rather than left to finish and save.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await store.get("ws1", "art1"))!.snapshot!.sources.v!.at < started, true);
});

test("a folder that is gone runs nothing and says so", async (t) => {
  const { runner, folder, commands, context } = await setup(t);
  await fs.rm(folder, { recursive: true });
  const results = await runner.refresh("ws1", "art1", context("full"));
  assert.deepEqual([results.pulls!.error, results.todo!.error], ["The workspace folder is unavailable.", "The workspace folder is unavailable."]);
  await assert.rejects(runner.runAction("ws1", "art1", "note", ["x"], context("full")), /unavailable/u);
  assert.deepEqual(commands, []);
});

test("file sources explain problems in terms of the page, within the source size limit", async (t) => {
  const { runner, folder, context } = await setup(t, {
    sources: [
      { name: "missing", kind: "file", file: "nope.md", parse: "text" },
      { name: "big", kind: "file", file: "big.txt", parse: "text" },
    ],
  });
  await fs.writeFile(path.join(folder, "big.txt"), "x".repeat(300 * 1024));
  const results = await runner.refresh("ws1", "art1", context("full"));
  assert.equal(results.missing!.error, "There is no file at nope.md.");
  assert.equal(results.big!.error, "big.txt is larger than an artifact can read.");
});

test("allowing a page while a refresh is running starts a fresh read rather than joining the blocked one", async (t) => {
  const { runner, store, commands, context } = await setup(t, { readDelayMs: 200 });
  const before = runner.refresh("ws1", "art1", context("ask"));
  const view = (await store.get("ws1", "art1"))!;
  await store.approve("ws1", "art1", view.digest);
  const after = await runner.refresh("ws1", "art1", context("ask"));
  assert.equal(after.pulls!.status, "ok");
  assert.equal((await before).pulls!.status, "blocked");
  assert.equal((await store.get("ws1", "art1"))!.snapshot!.sources.pulls!.status, "ok");
  assert.equal(commands.length, 1);
});

test("a run that started with more access never overwrites what a later, narrower refresh saved", async (t) => {
  const slow: WorkspaceArtifactSourceV1 = { name: "v", kind: "shell", command: "sleep 0.3; printf 1", parse: "json" };
  const { runner, store, commands, context } = await setup(t, { sources: [slow] });
  const full = runner.refresh("ws1", "art1", context("full"));
  await until(() => commands.length === 1);
  assert.equal((await runner.refresh("ws1", "art1", context("none"))).v!.status, "blocked");
  assert.equal((await full).v!.dataJson, "1");
  const saved = (await store.get("ws1", "art1"))!.snapshot!.sources.v!;
  assert.deepEqual([saved.status, saved.dataJson], ["blocked", undefined]);
});

test("a newer refresh that is cancelled leaves the earlier one to save", async (t) => {
  const slow: WorkspaceArtifactSourceV1 = { name: "v", kind: "shell", command: "sleep 0.3; printf 1", parse: "json" };
  const { runner, store, commands, context } = await setup(t, { sources: [slow], approved: true });
  const fromTab = runner.refresh("ws1", "art1", context("full"));
  await until(() => commands.length === 1);
  const turn = new AbortController();
  const fromTurn = runner.refresh("ws1", "art1", context("ask"), turn.signal);
  await until(() => commands.length === 2);
  turn.abort();
  assert.equal((await fromTurn).v!.error, "Cancelled.");
  assert.equal((await fromTab).v!.dataJson, "1");
  assert.equal((await store.get("ws1", "art1"))!.snapshot?.sources.v?.dataJson, "1");
});

test("the same folder reached through a link shares one refresh", async (t) => {
  const { runner, folder, commands, context } = await setup(t, { sources: [SHELL] });
  const link = `${folder}-link`;
  await fs.symlink(folder, link);
  t.after(() => fs.rm(link, { force: true }));
  await Promise.all([
    runner.refresh("ws1", "art1", context("full")),
    runner.refresh("ws1", "art1", { folderPath: link, permission: "full" }),
  ]);
  assert.equal(commands.length, 1);
});
