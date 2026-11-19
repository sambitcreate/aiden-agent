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
import { runArgvPlan, type ArgvPlanOptions } from "./argv-runner.js";
import { readWorkspaceArtifactFile, artifactFileAllowed, WorkspaceArtifactFileUnsafeError } from "./file-policy.js";
import { createWorkspaceArtifactRunner, workspaceArtifactFolderKey } from "./runner.js";
import { WorkspaceArtifactStore, workspaceArtifactDigest } from "./store.js";

const SHELL: WorkspaceArtifactSourceV1 = { name: "pulls", kind: "shell", command: `printf '[{"number":12}]'`, parse: "json" };
const FILE: WorkspaceArtifactSourceV1 = { name: "todo", kind: "file", file: "TODO.md", parse: "lines" };
const ECHO: WorkspaceArtifactActionV1 = { name: "note", label: "Write note", command: "printf '%s' {{text}}", params: [{ name: "text", type: "string" }] };

async function setup(
  t: test.TestContext,
  options: {
    sources?: WorkspaceArtifactSourceV1[];
    approved?: boolean;
    readDelayMs?: number;
    /** Runs between the file check and the read, as another program might. */
    beforeRead?: () => Promise<void>;
    /** Edits the saved page file before the runner opens it, as an older Aiden might have left it. */
    persisted?: (document: string) => string;
  } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-artifact-runner-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const folder = path.join(dir, "workspace");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "TODO.md"), "ship it\n\nreview #12\n");
  const openStore = () => new WorkspaceArtifactStore({ root: () => path.join(dir, "store"), newId: () => "art1" });
  let store = openStore();
  const events: WorkspaceArtifactsChangedEvent[] = [];
  const commands: string[] = [];
  const buttonRuns: ArgvPlanOptions["steps"][] = [];
  const compiled = compileAum('<Visual title="PRs"><Text>{len($pulls)}</Text></Visual>');
  const sources = options.sources ?? [SHELL, FILE];
  await store.create(
    "ws1",
    {
      title: "PRs",
      visual: { version: 1, kind: "ui", id: "x", title: "PRs", catalogVersion: AIDEN_UI_CATALOG_VERSION, tree: compiled.tree!, fallbackText: "" },
      sources,
      actions: [ECHO],
      refresh: { onOpen: true },
    },
    options.approved ? { approvedDigest: workspaceArtifactDigest(sources, [ECHO]) } : {},
  );
  if (options.persisted) {
    const file = path.join(dir, "store", "ws1.json");
    await fs.writeFile(file, options.persisted(await fs.readFile(file, "utf8")));
    store = openStore();
  }
  const runner = createWorkspaceArtifactRunner({
    runShell: (shell: BoundedShellCommandOptions) => {
      commands.push(shell.command);
      return runBoundedShellCommand(shell);
    },
    runArgv: (plan: ArgvPlanOptions) => {
      buttonRuns.push(plan.steps);
      return runArgvPlan(plan);
    },
    readFile: async (root, file, signal) => {
      if (options.readDelayMs) await new Promise((resolve) => setTimeout(resolve, options.readDelayMs));
      return readWorkspaceArtifactFile(root, file, signal, { beforeRead: options.beforeRead });
    },
    env: () => process.env,
    store,
    notify: (event) => events.push(event),
  });
  const context = (permission: WorkspaceArtifactPermission) => ({ folderPath: folder, permission });
  // What the tab sends with a button press: the page's digest as it was shown.
  const digest = async () => (await store.get("ws1", "art1"))!.digest;
  return { folder, store, events, commands, buttonRuns, runner, context, digest };
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

test("a refresh after a save keeps a fresh read of a source the save left unchanged and runs the ones it changed", async (t) => {
  const counted: WorkspaceArtifactSourceV1 = { name: "count", kind: "shell", command: "printf '[1,2]'", parse: "json" };
  const { runner, store, commands, context } = await setup(t, { sources: [SHELL, counted] });
  await runner.refresh("ws1", "art1", context("full"));
  assert.equal(commands.length, 2);
  const first = (await store.get("ws1", "art1"))!;
  const save = (sources: WorkspaceArtifactSourceV1[], title: string) =>
    store.replace("ws1", "art1", { title, visual: { ...first.artifact.visual, title }, sources, actions: [ECHO], refresh: first.artifact.refresh });

  // Only the page's text changed: neither command runs again, and the reads keep their time.
  const renamed = await save([SHELL, counted], "Open PRs");
  const kept = await runner.refresh("ws1", "art1", context("full"), undefined, { reuseFrom: first.artifact });
  assert.equal(commands.length, 2);
  assert.equal(kept.pulls!.at, first.snapshot!.sources.pulls!.at);
  assert.equal(kept.count!.dataJson, "[1,2]");
  assert.equal((await store.get("ws1", "art1"))!.snapshot!.revision, renamed.revision);

  // One command changed: only that one runs.
  const changed = { ...counted, command: "printf '[3]'" };
  await save([SHELL, changed], "Open PRs again");
  const mixed = await runner.refresh("ws1", "art1", context("full"), undefined, { reuseFrom: renamed });
  assert.deepEqual(commands.slice(2), [changed.command]);
  assert.equal(mixed.count!.dataJson, "[3]");

  // A refresh the tab asks for reads everything again.
  await runner.refresh("ws1", "art1", context("full"));
  assert.equal(commands.length, 5);
});

test("a refresh after a save runs a source again once its last read is older than the page's refresh interval", async (t) => {
  const { runner, store, commands, context, folder } = await setup(t, { sources: [SHELL] });
  const before = (await store.get("ws1", "art1"))!.artifact;
  const content = { title: "PRs", visual: before.visual, sources: [SHELL], actions: [ECHO] };
  // Read 90 seconds ago: fresh for a page that refreshes every two minutes, stale for one without an interval.
  const readAt = Date.now() - 90_000;
  const read = { status: "ok", at: readAt, dataJson: "[]", folder: workspaceArtifactFolderKey(await fs.realpath(folder)) } as const;
  await store.saveSnapshot("ws1", before, { pulls: read });
  const slow = await store.replace("ws1", "art1", { ...content, refresh: { onOpen: true, intervalSeconds: 120 } });
  assert.equal((await runner.refresh("ws1", "art1", context("full"), undefined, { reuseFrom: before })).pulls!.at, readAt);
  assert.equal(commands.length, 0);
  await store.saveSnapshot("ws1", slow, { pulls: read });
  await store.replace("ws1", "art1", { ...content, title: "PRs now", refresh: { onOpen: true } });
  const reread = await runner.refresh("ws1", "art1", context("full"), undefined, { reuseFrom: slow });
  assert.equal(commands.length, 1);
  assert.equal(reread.pulls!.dataJson, '[{"number":12}]');
});

test("a refresh after a save runs a source again when the page is refreshed in another folder than the one it was read in", async (t) => {
  const { runner, store, commands, context, folder } = await setup(t, { sources: [SHELL] });
  await runner.refresh("ws1", "art1", context("full"));
  const before = (await store.get("ws1", "art1"))!.artifact;
  const save = (title: string) =>
    store.replace("ws1", "art1", { title, visual: { ...before.visual, title }, sources: [SHELL], actions: [ECHO], refresh: before.refresh });
  const renamed = await save("Open PRs");
  // The workspace now points at another checkout: its read describes the other folder's files.
  const other = `${folder}-other`;
  await fs.mkdir(other);
  const moved = await runner.refresh("ws1", "art1", { folderPath: other, permission: "full" }, undefined, { reuseFrom: before });
  assert.equal(commands.length, 2);
  assert.equal(moved.pulls!.status, "ok");
  // Back in that folder, the read just taken there is kept across the next save.
  await save("Open PRs again");
  await runner.refresh("ws1", "art1", { folderPath: other, permission: "full" }, undefined, { reuseFrom: renamed });
  assert.equal(commands.length, 2);
  // A read saved before Aiden noted its folder is not handed back as fresh either.
  const current = (await store.get("ws1", "art1"))!.artifact;
  await store.saveSnapshot("ws1", current, { pulls: { status: "ok", at: Date.now(), dataJson: "[]" } });
  await save("Open PRs once more");
  await runner.refresh("ws1", "art1", context("full"), undefined, { reuseFrom: current });
  assert.equal(commands.length, 3);
});

test("a read kept across a save still follows the access the page has now", async (t) => {
  const { runner, store, commands, context } = await setup(t, { sources: [SHELL] });
  await runner.refresh("ws1", "art1", context("full"));
  const before = (await store.get("ws1", "art1"))!.artifact;
  await store.replace("ws1", "art1", { title: "Open PRs", visual: before.visual, sources: [SHELL], actions: [ECHO], refresh: before.refresh });
  // Under Ask the page's commands were never allowed, so its saved read is not handed back as fresh.
  const results = await runner.refresh("ws1", "art1", context("ask"), undefined, { reuseFrom: before });
  assert.equal(results.pulls!.status, "blocked");
  assert.equal(commands.length, 1);
});

test("a file read kept across a save is read again, and refused, once the file has become a link out of the workspace", async (t) => {
  const { runner, store, folder, context } = await setup(t, { sources: [FILE] });
  const first = await runner.refresh("ws1", "art1", context("full"));
  assert.equal(first.todo!.status, "ok");
  const before = (await store.get("ws1", "art1"))!.artifact;
  await store.replace("ws1", "art1", { title: "Open PRs", visual: before.visual, sources: [FILE], actions: [ECHO], refresh: before.refresh });
  // Unchanged, a fresh read is kept rather than read again.
  await fs.writeFile(path.join(folder, "TODO.md"), "edited since\n");
  const kept = await runner.refresh("ws1", "art1", context("full"), undefined, { reuseFrom: before });
  assert.equal(kept.todo!.at, first.todo!.at);
  // Now TODO.md leads outside the folder: the kept read is not handed back.
  const outside = path.join(path.dirname(folder), "secret.md");
  await fs.writeFile(outside, "outside\n");
  await fs.rm(path.join(folder, "TODO.md"));
  await fs.symlink(outside, path.join(folder, "TODO.md"));
  const renamed = (await store.get("ws1", "art1"))!.artifact;
  await store.replace("ws1", "art1", { title: "PRs again", visual: renamed.visual, sources: [FILE], actions: [ECHO], refresh: renamed.refresh });
  const refused = await runner.refresh("ws1", "art1", context("full"), undefined, { reuseFrom: renamed });
  assert.equal(refused.todo!.status, "error");
  assert.equal(refused.todo!.error, "TODO.md is missing or leads outside the workspace folder.");
  assert.equal(refused.todo!.dataJson, undefined, "the earlier data is not kept");
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

test("a file source's error does not tell a file that exists outside the workspace from one that does not", async (t) => {
  const sources: WorkspaceArtifactSourceV1[] = [
    { name: "there", kind: "file", file: "there.md", parse: "text" },
    { name: "gone", kind: "file", file: "gone.md", parse: "text" },
    { name: "beyond", kind: "file", file: "out/secret.md", parse: "text" },
    { name: "beyondGone", kind: "file", file: "out/nothing.md", parse: "text" },
    { name: "inside", kind: "file", file: "nope.md", parse: "text" },
  ];
  const { runner, folder, context } = await setup(t, { sources });
  const outside = path.join(path.dirname(folder), "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.md"), "secret\n");
  await fs.symlink(path.join(outside, "secret.md"), path.join(folder, "there.md"));
  await fs.symlink(path.join(outside, "nothing.md"), path.join(folder, "gone.md"));
  await fs.symlink(outside, path.join(folder, "out"));
  const results = await runner.refresh("ws1", "art1", context("full"));
  // Each read's outcome with its own file name taken out: what a page could compare.
  const seen = (name: string) => {
    const result = results[name]!;
    const file = sources.find((source) => source.name === name)!;
    return [result.status, result.policyDenied ?? false, result.error!.replace(file.kind === "file" ? file.file : "", "FILE")];
  };
  assert.deepEqual(seen("there"), seen("gone"), "a link to a file outside reads like a link to nothing");
  assert.deepEqual(seen("beyond"), seen("beyondGone"), "a file past a linked folder reads like a missing one");
  assert.equal(results.there!.error, "there.md is missing or leads outside the workspace folder.");
  // Inside the folder, with no link on the way, a missing file still says so plainly.
  assert.equal(results.inside!.error, "There is no file at nope.md.");
});

test("refreshes of the same page at once share one run", async (t) => {
  const { runner, commands, context } = await setup(t, { sources: [SHELL] });
  await Promise.all([runner.refresh("ws1", "art1", context("full")), runner.refresh("ws1", "art1", context("full"))]);
  assert.equal(commands.length, 1);
});

test("a button runs its saved command with the page's value as one literal argument, without a shell", async (t) => {
  const { runner, folder, context, digest, buttonRuns, commands } = await setup(t);
  const value = "$(touch hacked); `id` 'quoted'";
  const result = await runner.runAction("ws1", "art1", "note", [value], context("full"), undefined, await digest());
  assert.deepEqual(result, { ok: true, output: value });
  assert.deepEqual(buttonRuns, [[{ connector: ";", pipeline: [{ argv: ["printf", "%s", value], redirects: [] }] }]]);
  assert.deepEqual(commands, [], "nothing went through a shell");
  await assert.rejects(fs.stat(path.join(folder, "hacked")));
});

test("a button cancelled before its command starts runs nothing", async (t) => {
  const { runner, context, digest } = await setup(t);
  // Access changed while the press was still being checked.
  const controller = new AbortController();
  controller.abort();
  // That nothing starts is the executor's to keep; argv-runner.test.ts checks it.
  await assert.rejects(runner.runAction("ws1", "art1", "note", ["x"], context("full"), controller.signal, await digest()), /Cancelled/u);
});

test("buttons follow the workspace's access and only exist if the page declared them", async (t) => {
  const { runner, context, digest } = await setup(t);
  await assert.rejects(runner.runAction("ws1", "art1", "note", ["x"], context("ask"), undefined, await digest()), /Allow this page/u);
  await assert.rejects(runner.runAction("ws1", "art1", "note", ["x"], context("none"), undefined, await digest()), /access is off/u);
  await assert.rejects(runner.runAction("ws1", "art1", "rm", [], context("full"), undefined, await digest()), /no button named "rm"/u);
  const failed = await runner.runAction("ws1", "art1", "note", ["-rf"], context("full"), undefined, await digest()).catch((error: Error) => error);
  assert.match(String(failed), /cannot start with "-"/u);
});

test("a button pressed on an older version of the page does not run the newer command", async (t) => {
  const { runner, store, commands, buttonRuns, context } = await setup(t);
  const before = (await store.get("ws1", "art1"))!;
  await store.replace("ws1", "art1", {
    title: "PRs",
    visual: before.artifact.visual,
    sources: before.artifact.sources,
    actions: [{ ...ECHO, command: "printf '%s!' {{text}}" }],
    refresh: before.artifact.refresh,
  });
  await assert.rejects(runner.runAction("ws1", "art1", "note", ["x"], context("full"), undefined, before.digest), /changed/u);
  assert.deepEqual(commands, []);
  assert.deepEqual(buttonRuns, []);
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
  const slow: WorkspaceArtifactSourceV1 = { name: "v", kind: "shell", command: "sleep 0.6; printf 1", parse: "json" };
  const { runner, store, commands, context } = await setup(t, { sources: [slow] });
  const turn = new AbortController();
  const fromTab = runner.refresh("ws1", "art1", context("full"));
  const fromTurn = runner.refresh("ws1", "art1", context("full"), turn.signal);
  await until(() => commands.length === 1);
  // Both callers have joined well within the command's run before one leaves.
  await new Promise((resolve) => setTimeout(resolve, 150));
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
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal((await store.get("ws1", "art1"))!.snapshot!.sources.v!.at < started, true);
});

test("a folder that is gone runs nothing and says so", async (t) => {
  const { runner, folder, commands, context, digest } = await setup(t);
  await fs.rm(folder, { recursive: true });
  const results = await runner.refresh("ws1", "art1", context("full"));
  assert.deepEqual([results.pulls!.error, results.todo!.error], ["The workspace folder is unavailable.", "The workspace folder is unavailable."]);
  await assert.rejects(runner.runAction("ws1", "art1", "note", ["x"], context("full"), undefined, await digest()), /unavailable/u);
  assert.deepEqual(commands, []);
});

test("file sources explain problems in terms of the page, within the source size limit", async (t) => {
  const { runner, folder, context } = await setup(t, {
    sources: [
      { name: "missing", kind: "file", file: "nope.md", parse: "text" },
      { name: "big", kind: "file", file: "big.txt", parse: "text" },
      // A path through a file: the system's error would name the workspace's full path.
      { name: "through", kind: "file", file: "a.txt/x", parse: "text" },
    ],
  });
  await fs.writeFile(path.join(folder, "big.txt"), "x".repeat(300 * 1024));
  await fs.writeFile(path.join(folder, "a.txt"), "a");
  const results = await runner.refresh("ws1", "art1", context("full"));
  assert.equal(results.missing!.error, "There is no file at nope.md.");
  assert.equal(results.big!.error, "big.txt is larger than the 256 KiB an artifact can read.");
  assert.equal(results.through!.error, "a.txt/x cannot be read.");
});

test("a failing command reports the start and the end of what it printed, and bad JSON says where", async (t) => {
  const { runner, folder, context } = await setup(t, {
    sources: [
      { name: "noisy", kind: "shell", command: "for i in $(seq 1 200); do echo \"line $i of the log\" >&2; done; exit 3", parse: "text" },
      { name: "comma", kind: "shell", command: `printf '{"open": 2,\n "closed": 5,\n}'`, parse: "json" },
      { name: "chatty", kind: "file", file: "report.json", parse: "json" },
      // Long enough to be cut, with the cuts landing between an emoji's two halves.
      { name: "emoji", kind: "shell", command: "printf a >&2; for i in $(seq 1 400); do printf '\\360\\237\\230\\200' >&2; done; exit 3", parse: "text" },
    ],
  });
  await fs.writeFile(path.join(folder, "report.json"), 'Fetching...\n[{"n":1}]');
  const results = await runner.refresh("ws1", "art1", context("full"));
  const noisy = results.noisy!.error!;
  assert.match(noisy, /^Exited with code 3\. line 1 of the log/u);
  assert.match(noisy, /line 200 of the log$/u);
  assert.ok(noisy.length <= 500, "within the stored error's limit");
  assert.match(results.comma!.error!, /not valid JSON: at line 3, column 1, near ".*⟨here⟩\}"/u);
  assert.match(results.chatty!.error!, /not valid JSON: at line 1, column 1, near "⟨here⟩Fetching\.\.\./u);
  // Both the start and the end of the output keep whole emoji.
  assert.match(results.emoji!.error!, /^Exited with code 3\. a😀+ … 😀+$/u);
  assert.doesNotMatch(results.emoji!.error!, /[\uD800-\uDFFF]/u, "no lone surrogate");
});

test("a file replaced while it is read keeps the page's last data, marked as an error, and is not called a credential file", async (t) => {
  let swap = false;
  const { runner, store, folder, context } = await setup(t, {
    sources: [FILE],
    beforeRead: async () => {
      if (!swap) return;
      // Another program writes the file by replacing it, between Aiden's check and its read.
      await fs.rename(path.join(folder, "TODO.md"), path.join(folder, "TODO.old"));
      await fs.writeFile(path.join(folder, "TODO.md"), "rewritten\n");
    },
  });
  assert.equal((await runner.refresh("ws1", "art1", context("full"))).todo!.status, "ok");
  swap = true;
  const result = (await runner.refresh("ws1", "art1", context("full"))).todo!;
  assert.equal(result.status, "error");
  assert.equal(result.policyDenied, undefined);
  assert.match(result.error!, /^TODO\.md changed while Aiden was reading it/u);
  assert.doesNotMatch(result.error!, /credential/iu);
  const saved = (await store.get("ws1", "art1"))!.snapshot!.sources.todo!;
  assert.deepEqual([saved.status, saved.dataJson], ["error", '["ship it","review #12"]']);
  swap = false;
  assert.equal((await runner.refresh("ws1", "art1", context("full"))).todo!.dataJson, '["rewritten"]');
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

test("artifact reads deny canonical credential aliases and inode/path replacement before reading", async (t) => {
  const { folder } = await setup(t);
  await fs.writeFile(path.join(folder, ".env"), "PRIVATE_FIXTURE_VALUE");
  await fs.symlink(".env", path.join(folder, "ordinary.txt"));
  await assert.rejects(readWorkspaceArtifactFile(folder, "ordinary.txt"), /Credential files/u);
  assert.equal(await artifactFileAllowed(folder, "ordinary.txt"), false);
  assert.equal(await readWorkspaceArtifactFile(folder, "TODO.md"), "ship it\n\nreview #12\n");
  await fs.mkdir(path.join(folder, "safe")); await fs.writeFile(path.join(folder, "safe", "data.txt"), "ordinary");
  await fs.mkdir(path.join(folder, ".private")); await fs.writeFile(path.join(folder, ".private", "data.txt"), "PRIVATE_FIXTURE_VALUE");
  await assert.rejects(readWorkspaceArtifactFile(folder, "safe/data.txt", undefined, {
    beforeRead: async () => {
      await fs.rename(path.join(folder, "safe"), path.join(folder, "held"));
      await fs.symlink(".private", path.join(folder, "safe"));
    },
  }), WorkspaceArtifactFileUnsafeError);
});

test("a file read whose workspace folder is not a folder fails with that lasting reason, not as a change the next refresh fixes", async (t) => {
  const { folder } = await setup(t, { sources: [FILE] });
  // The refresh checks the folder first, so this is a folder replaced by a file after that check.
  const notAFolder = path.join(folder, "TODO.md");
  await assert.rejects(readWorkspaceArtifactFile(notAFolder, "TODO.md"), (error: Error) => {
    assert.ok(error instanceof WorkspaceArtifactFileUnsafeError);
    assert.match(error.message, /^Aiden could not safely read TODO\.md: the workspace folder, or a folder on the way to the file, is a link or not a folder/u);
    assert.doesNotMatch(error.message, /changed while|next refresh|unsafe_source/u);
    return true;
  });
  // Not a policy refusal, so a listing keeps the page's cached data and asks again next time.
  await assert.rejects(artifactFileAllowed(notAFolder, "TODO.md"), WorkspaceArtifactFileUnsafeError);
});

test("denied file refreshes erase cached good data instead of preserving it as a transient failure", async (t) => {
  // No save accepts a credential path now, so the page is one an older Aiden saved.
  const source: WorkspaceArtifactSourceV1 = { name: "private", kind: "file", file: "legacy.txt", parse: "text" };
  const { store, runner, context } = await setup(t, {
    sources: [source],
    persisted: (document) => document.replace('"file":"legacy.txt"', '"file":".env"'),
  });
  assert.deepEqual((await store.get("ws1", "art1"))!.artifact.sources, [{ ...source, file: ".env" }], "the older page loads");
  const artifact = (await store.get("ws1", "art1"))!.artifact;
  await store.saveSnapshot("ws1", artifact, { private: { status: "ok", at: 1, dataJson: '"PRIVATE_FIXTURE_VALUE"' } });
  const result = await runner.refresh("ws1", "art1", context("full"));
  assert.equal(result.private!.policyDenied, true);
  assert.equal(JSON.stringify(await store.list("ws1")).includes("PRIVATE_FIXTURE_VALUE"), false);
});

test("a check runs the sources it is given once, under the same access as a refresh, and saves nothing", async (t) => {
  const { runner, store, events, commands, context } = await setup(t);
  const sources: WorkspaceArtifactSourceV1[] = [{ ...SHELL, command: `printf '{"open":2}'` }, FILE];
  const blocked = await runner.check(sources, false, context("ask"));
  assert.deepEqual([blocked.pulls!.status, blocked.todo!.status], ["blocked", "ok"]);
  assert.deepEqual(commands, []);
  const allowed = await runner.check(sources, true, context("ask"));
  assert.equal(allowed.pulls!.dataJson, '{"open":2}');
  assert.equal(commands.length, 1);
  assert.deepEqual((await runner.check(sources, true, context("none"))).pulls!.status, "blocked");
  assert.equal((await store.get("ws1", "art1"))!.snapshot, undefined);
  assert.deepEqual(events, []);
});
