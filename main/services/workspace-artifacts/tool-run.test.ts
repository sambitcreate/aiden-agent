import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { WorkspaceArtifactActionV1, WorkspaceArtifactPermission } from "../../../renderer/shared/workspace-artifacts.js";
import { runBoundedShellCommand, type BoundedShellCommandOptions } from "../bounded-shell-command.js";
import { readWorkspaceFile } from "../workspace-files.js";
import { createWorkspaceArtifactRunner } from "./runner.js";
import { WorkspaceArtifactStore } from "./store.js";
import { createWorkspaceArtifactTool, workspaceArtifactCallApproval, type WorkspaceArtifactToolOptions } from "./tool.js";

const PAGE = `<Visual title="Notes"><Text>{len($notes)} notes</Text><Button action={run("note", "hello")}>Note</Button></Visual>`;
const NOTES = { name: "notes", kind: "file", file: "notes.txt", parse: "lines" };
const NOTE: WorkspaceArtifactActionV1 = {
  name: "note",
  label: "Add a note",
  command: "printf '%s\\n' {{text}} >> notes.txt",
  params: [{ name: "text", type: "string" }],
};

/**
 * A real store and runner over a temporary workspace folder: the tool's run
 * goes through the same `runner.runAction` the Artifacts tab's buttons use.
 */
async function setup(t: test.TestContext, permission: WorkspaceArtifactPermission) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-artifact-run-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const folder = path.join(dir, "workspace");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "notes.txt"), "first\n");
  const store = new WorkspaceArtifactStore({ root: () => path.join(dir, "store"), newId: () => "art1" });
  const commands: string[] = [];
  const runner = createWorkspaceArtifactRunner({
    runShell: (shell: BoundedShellCommandOptions) => {
      commands.push(shell.command);
      return runBoundedShellCommand(shell);
    },
    readFile: async (root, file, signal) => (await readWorkspaceFile(root, file, signal)).content,
    env: () => process.env,
    store,
    notify: () => undefined,
  });
  const approvedCalls = new Map<string, string>();
  const context = { folderPath: folder, permission };
  const options: WorkspaceArtifactToolOptions = {
    workspaceId: "ws1",
    chatId: "chat-1",
    permission,
    hasFolder: true,
    store,
    takeApprovedDigest: (id) => {
      const digest = approvedCalls.get(id);
      approvedCalls.delete(id);
      return digest;
    },
    refresh: (artifact, signal) => runner.refresh("ws1", artifact.id, context, signal),
    runAction: (artifactId, name, args, digest, signal) => runner.runAction("ws1", artifactId, name, args, context, signal, digest),
    onChanged: () => undefined,
  };
  /** Calls the tool as a chat with these settings would; the page is the same one. */
  const callWith = (overrides: Partial<WorkspaceArtifactToolOptions>) => {
    const tool = createWorkspaceArtifactTool({ ...options, ...overrides });
    return async (id: string, args: Record<string, unknown>) => {
      const result = await tool.execute(id, args as never, undefined);
      return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    };
  };
  const call = callWith({});
  /** The chat's card for this call; allowing it hands the tool the digest it showed. */
  const card = (args: Record<string, unknown>, overrides: Partial<WorkspaceArtifactToolOptions> = {}) =>
    workspaceArtifactCallApproval(args, { ...options, ...overrides });
  const allow = async (id: string, args: Record<string, unknown>) => {
    const shown = await card(args);
    assert.ok(shown.digest, "the call should have asked");
    approvedCalls.set(id, shown.digest);
    return shown;
  };
  const create = { operation: "create", title: "Notes", markup: PAGE, sources: [NOTES], actions: [NOTE] };
  if (permission === "ask") await allow("c-create", create);
  await call("c-create", create);
  const notes = () => fs.readFile(path.join(folder, "notes.txt"), "utf8");
  /** What the tab would run for a press of the page's button with these values. */
  const pressButton = async (args: unknown[]) => {
    const view = (await store.get("ws1", "art1"))!;
    return runner.runAction("ws1", "art1", "note", args, context, undefined, view.digest);
  };
  return { store, commands, call, callWith, card, allow, approvedCalls, notes, pressButton };
}

const RUN = { operation: "run", id: "art1", action: "note", args: ["from the agent"] };

test("under Ask, a run shows the exact command and runs what a button press would", async (t) => {
  const { call, allow, notes, commands, pressButton } = await setup(t, "ask");
  const shown = await allow("c1", RUN);
  assert.equal(shown.required, true);
  assert.equal(shown.summary, 'Run "Add a note" from the artifact "Notes".');
  assert.deepEqual(shown.preview, { kind: "command", command: "printf '%s\\n' 'from the agent' >> notes.txt" });

  const before = commands.length;
  const text = await call("c1", RUN);
  assert.match(text, /^Ran "Add a note"\./u);
  assert.match(text, /Refresh after the run:\n- notes: ok/u);
  assert.equal(await notes(), "first\nfrom the agent\n");
  const toolCommand = commands[before];

  await pressButton(["from the agent"]);
  assert.equal(commands[commands.length - 1], toolCommand, "the button runs the same command the tool ran");
});

test("under Ask, a run nobody confirmed does not run", async (t) => {
  const { call, notes } = await setup(t, "ask");
  await assert.rejects(call("c1", RUN), /did not confirm/u);
  assert.equal(await notes(), "first\n");
});

test("a page changed after the person confirmed does not run", async (t) => {
  const { call, allow, notes } = await setup(t, "ask");
  await allow("c1", RUN);
  // The action's command changes (and is allowed) between the card and the run.
  const changed = { operation: "update", id: "art1", actions: [{ ...NOTE, command: "printf '%s\\n' {{text}} >> other.txt" }] };
  await allow("c2", changed);
  await call("c2", changed);
  await assert.rejects(call("c1", RUN), /changed after the person confirmed/u);
  assert.equal(await notes(), "first\n");
});

test("under Ask, a page whose commands were never allowed asks nothing and refuses", async (t) => {
  const { call, card, notes, store } = await setup(t, "ask");
  // New commands saved without the person allowing them.
  const view = (await store.get("ws1", "art1"))!;
  await store.replace("ws1", "art1", { ...view.artifact, title: view.artifact.visual.title, actions: [{ ...NOTE, label: "Add" }] }, { approved: false });
  assert.deepEqual(await card(RUN), { required: false });
  await assert.rejects(call("c1", RUN), /not allowed this page's commands/u);
  assert.equal(await notes(), "first\n");
});

test("under Full, a run goes straight through", async (t) => {
  const { call, card, notes } = await setup(t, "full");
  assert.deepEqual(await card(RUN), { required: false });
  assert.match(await call("c1", RUN), /^Ran "Add a note"\./u);
  assert.equal(await notes(), "first\nfrom the agent\n");
});

test("a run that names no action or passes values that do not fit fails with the reason", async (t) => {
  const { call, card, notes } = await setup(t, "full");
  await assert.rejects(call("c1", { ...RUN, action: "erase" }), /no action named "erase" \(its actions: note\)/u);
  await assert.rejects(call("c2", { ...RUN, args: ["a", "b"] }), /takes 1 value/u);
  await assert.rejects(call("c3", { ...RUN, args: ["--force"] }), /cannot start with "-"/u);
  assert.deepEqual(await card({ ...RUN, action: "erase" }), { required: false });
  assert.equal(await notes(), "first\n");
});

test("a card allowed for one run does not cover a run with other values", async (t) => {
  const { call, allow, approvedCalls, notes } = await setup(t, "ask");
  const shown = await allow("c1", RUN);
  approvedCalls.set("c2", shown.digest!);
  await assert.rejects(call("c2", { ...RUN, args: ["something else"] }), /changed after the person confirmed/u);
  assert.equal(await notes(), "first\n");
});

test("the digest a save card recorded does not authorize a run", async (t) => {
  const { call, store, approvedCalls, notes } = await setup(t, "ask");
  const view = (await store.get("ws1", "art1"))!;
  assert.equal(view.artifact.approvedDigest, view.digest, "the setup allowed the page's commands");
  approvedCalls.set("c1", view.digest);
  await assert.rejects(call("c1", RUN), /changed after the person confirmed/u);
  assert.equal(await notes(), "first\n");
});

test("a failed action fails the call with its output", async (t) => {
  const { call } = await setup(t, "full");
  const failing: WorkspaceArtifactActionV1 = { name: "fail", label: "Fail", command: "echo nope >&2; exit 3", params: [] };
  await call("u1", { operation: "update", id: "art1", actions: [NOTE, failing] });
  await assert.rejects(call("c1", { operation: "run", id: "art1", action: "fail" }), /^Error: "Fail" failed\.\nOutput:\n.*nope/su);
});

test("without a folder or with workspace access off, a run asks nothing and refuses", async (t) => {
  const { callWith, card, notes } = await setup(t, "ask");
  assert.deepEqual(await card(RUN, { hasFolder: false }), { required: false });
  await assert.rejects(callWith({ hasFolder: false })("c1", RUN), /has no folder/u);
  assert.deepEqual(await card(RUN, { permission: "none" }), { required: false });
  await assert.rejects(callWith({ permission: "none" })("c2", RUN), /Workspace access is off/u);
  assert.equal(await notes(), "first\n");
});
