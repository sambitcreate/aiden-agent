import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { WorkspaceArtifactsChangedEvent } from "../../../renderer/shared/workspace-artifacts.js";
import { WorkspaceArtifactStore } from "./store.js";
import {
  createWorkspaceArtifactTool,
  WORKSPACE_ARTIFACT_TOOL_NAME,
  workspaceArtifactCallApproval,
  type WorkspaceArtifactToolOptions,
} from "./tool.js";

const PAGE = `<Visual title="Open PRs" state={{filter: "all"}}>
  <Text>{len($pulls)} open</Text>
  <Button action={run("merge", 12)}>Merge</Button>
  <Button action={compose("Review PR 12")}>Ask</Button>
</Visual>`;

const PULLS = { name: "pulls", kind: "shell", command: "gh pr list --json number,title", parse: "json" };
const MERGE = { name: "merge", label: "Merge pull request", command: "gh pr merge {{number}}", params: [{ name: "number", type: "number" }] };

async function harness(t: test.TestContext, overrides: Partial<WorkspaceArtifactToolOptions> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-artifact-tool-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let ids = 0;
  const store = new WorkspaceArtifactStore({ root: () => dir, newId: () => `art${++ids}` });
  const events: WorkspaceArtifactsChangedEvent[] = [];
  const approvedCalls = new Set<string>();
  const options: WorkspaceArtifactToolOptions = {
    workspaceId: "ws1",
    chatId: "chat-1",
    permission: "ask",
    hasFolder: true,
    store,
    wasApproved: (id) => approvedCalls.delete(id),
    onChanged: (event) => events.push(event),
    ...overrides,
  };
  const tool = createWorkspaceArtifactTool(options);
  const call = async (id: string, args: Record<string, unknown>) => {
    const result = await tool.execute(id, args as never, undefined);
    return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  };
  return { store, tool, events, approvedCalls, options, call };
}

test("create saves a page the Artifacts tab can show and tells that chat's window", async (t) => {
  const { tool, store, events, call, approvedCalls } = await harness(t);
  assert.equal(tool.name, WORKSPACE_ARTIFACT_TOOL_NAME);
  approvedCalls.add("call-1");
  const text = await call("call-1", { operation: "create", title: "Open PRs", markup: PAGE, sources: [PULLS], actions: [MERGE] });
  assert.match(text, /Created the artifact "Open PRs" \(id art1, revision 1\)/u);
  const [view] = await store.list("ws1");
  assert.equal(view!.artifact.visual.title, "Open PRs");
  assert.deepEqual(view!.artifact.visual.state, { filter: "all" });
  assert.equal(view!.artifact.approvedDigest, view!.digest);
  assert.deepEqual(events, [{ workspaceId: "ws1", artifactId: "art1", reason: "created", chatId: "chat-1" }]);
});

test("update keeps what the call leaves out and bumps the revision", async (t) => {
  const { store, call } = await harness(t, { permission: "full" });
  await call("c1", { operation: "create", title: "Open PRs", markup: PAGE, sources: [PULLS] });
  await call("c2", { operation: "update", id: "art1", description: "PRs waiting on review", layout: "wide" });
  const artifact = (await store.get("ws1", "art1"))!.artifact;
  assert.equal(artifact.revision, 2);
  assert.equal(artifact.description, "PRs waiting on review");
  assert.equal(artifact.visual.layout, "wide");
  assert.deepEqual(artifact.sources.map((source) => source.name), ["pulls"]);
  assert.match(JSON.stringify(artifact.visual.tree), /"act":"run"/u);
});

test("list shows the model what exists so it can update instead of duplicating", async (t) => {
  const { call } = await harness(t, { permission: "full" });
  assert.equal(await call("c0", { operation: "list" }), "This workspace has no artifacts yet.");
  await call("c1", { operation: "create", title: "Open PRs", markup: PAGE, sources: [PULLS], actions: [MERGE] });
  const listed = JSON.parse(await call("c2", { operation: "list" })) as { id: string; sources: { command: string }[]; actions: { name: string }[] }[];
  assert.equal(listed[0]!.id, "art1");
  assert.equal(listed[0]!.sources[0]!.command, PULLS.command);
  assert.equal(listed[0]!.actions[0]!.name, "merge");
});

test("a workspace without folder access only takes pages with their own data", async (t) => {
  const { call, store } = await harness(t, { permission: "none" });
  await assert.rejects(call("c1", { operation: "create", title: "Open PRs", markup: PAGE, sources: [PULLS] }), /no folder access/u);
  await call("c2", { operation: "create", title: "Notes", markup: '<Visual title="Notes"><Data name="rows">[1,2]</Data><Text>{len($rows)}</Text></Visual>' });
  assert.equal((await store.list("ws1")).length, 1);
});

test("bad input fails with a reason the model can act on", async (t) => {
  const { call } = await harness(t);
  await assert.rejects(call("c1", { operation: "create", markup: PAGE }), /title/u);
  await assert.rejects(call("c2", { operation: "create", title: "X" }), /markup is required/u);
  await assert.rejects(call("c3", { operation: "update", id: "missing" }), /No artifact/u);
  await assert.rejects(call("c4", { operation: "create", title: "X", markup: PAGE, sources: [{ ...PULLS, name: "bad name" }] }), /identifier/u);
});

test("the approval card lists every command, once per new set, and deleting always asks", async (t) => {
  const { store, call, approvedCalls, options } = await harness(t);
  const create = { operation: "create", title: "Open PRs", markup: PAGE, sources: [PULLS], actions: [MERGE] };
  const first = await workspaceArtifactCallApproval(create, options);
  assert.equal(first.required, true);
  assert.match(first.summary!, /gh pr list --json number,title/u);
  assert.match(first.summary!, /Merge pull request \(button\): gh pr merge \{\{number\}\}/u);

  approvedCalls.add("c1");
  await call("c1", create);
  // Same commands again: nothing new to approve.
  assert.equal((await workspaceArtifactCallApproval({ operation: "update", id: "art1", markup: PAGE }, options)).required, false);
  // A different command asks again.
  const changed = await workspaceArtifactCallApproval(
    { operation: "update", id: "art1", sources: [{ ...PULLS, command: "gh pr list --state all" }] },
    options,
  );
  assert.equal(changed.required, true);
  // Pages that run nothing never ask; Full access never asks.
  assert.equal((await workspaceArtifactCallApproval({ operation: "create", title: "N", markup: PAGE }, options)).required, false);
  assert.equal((await workspaceArtifactCallApproval(create, { ...options, permission: "full" })).required, false);

  const deletion = await workspaceArtifactCallApproval({ operation: "delete", id: "art1" }, { ...options, permission: "full" });
  assert.equal(deletion.required, true);
  assert.match(deletion.summary!, /Delete the artifact "Open PRs"/u);
  assert.equal((await store.list("ws1")).length, 1);
});

test("an unapproved save under Ask records no approval for its commands", async (t) => {
  const { store, call } = await harness(t);
  await call("c1", { operation: "create", title: "Open PRs", markup: PAGE, sources: [PULLS] });
  assert.equal((await store.get("ws1", "art1"))!.artifact.approvedDigest, undefined);
});

test("delete removes the artifact and reports it", async (t) => {
  const { call, store, events } = await harness(t, { permission: "full" });
  await call("c1", { operation: "create", title: "Open PRs", markup: PAGE });
  assert.equal(await call("c2", { operation: "delete", id: "art1" }), 'Deleted the artifact "Open PRs".');
  assert.deepEqual(await store.list("ws1"), []);
  assert.equal(events.at(-1)!.reason, "deleted");
});

test("the first refresh's results go back to the model", async (t) => {
  const { call } = await harness(t, {
    permission: "full",
    refresh: async () => ({ pulls: { status: "error", at: 1, error: "gh: not logged in" } }),
  });
  const text = await call("c1", { operation: "create", title: "Open PRs", markup: PAGE, sources: [PULLS] });
  assert.match(text, /First refresh:\n- pulls: failed: gh: not logged in/u);
});
