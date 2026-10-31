// Settings → Hooks over IPC, registered and invoked against a real hook
// service in a temporary profile. Commands never run: `run` is a fake.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { HookRunFunction } from "../services/hooks/hook-dispatcher.js";
import { createHookService, type HookChange, type HookService } from "../services/hooks/hook-service.js";
import type { HookListing } from "../services/hooks/hook-types.js";
import type { HooksOverview } from "../../renderer/shared/hooks-settings.js";
import { registerHookHandlers } from "./hooks.js";

async function fixture(t: test.TestContext, options: { started?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-hook-handlers-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "repo");
  await fs.mkdir(path.join(workspace, ".aiden"), { recursive: true });
  const runs: string[] = [];
  const run: HookRunFunction = async (hook) => {
    runs.push(hook.handler.command);
    return { startedAt: 0, durationMs: 4, exitCode: 0, timedOut: false, outputLimitExceeded: false, aborted: false, stdout: "", stderr: "" };
  };
  let service: HookService | undefined;
  if (options.started !== false) {
    service = createHookService({ root: () => path.join(base, "profile", "hooks"), env: options.env ?? { PATH: process.env.PATH }, homeDir: () => base, run });
    await service.load();
  }
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const broadcasts: HookChange[] = [];
  registerHookHandlers({
    handle: (channel, handler) => void handlers.set(channel, handler),
    service: () => service,
    workspaces: async () => [
      { workspaceRoot: workspace, name: "Repo" },
      { workspaceRoot: "relative/ignored", name: "Ignored" },
    ],
    broadcast: (change) => void broadcasts.push(change),
    env: options.env,
    // Stands in for `rendererDocumentOwner`: only an Aiden window's document passes.
    requireSender: (event) => {
      if ((event as { aidenWindow?: boolean }).aidenWindow !== true) throw new Error("Hooks settings need the active window.");
    },
  });
  const invokeFrom = async (event: unknown, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, channel);
    return handler(event, ...args);
  };
  const invoke = (channel: string, ...args: unknown[]) => invokeFrom({ aidenWindow: true }, channel, ...args);
  const list = async () => (await invoke("hooks:list")) as HooksOverview;
  return { base, workspace, runs, broadcasts, invoke, invokeFrom, list, service, channels: () => [...handlers.keys()] };
}

test("the list covers global hooks and each workspace's repo file, with workspace names", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.workspace, ".aiden", "hooks.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }] } }),
  );
  const saved = (await f.invoke("hooks:save", { scope: { kind: "global" }, event: "Stop", command: "  ./done.sh  " })) as {
    ok: boolean;
    value?: HookListing;
  };
  assert.equal(saved.ok, true);
  assert.equal(saved.value?.handler.command, "./done.sh", "the command is trimmed");

  const overview = await f.list();
  assert.equal(overview.available, true);
  assert.deepEqual(overview.workspaces, [{ workspaceRoot: f.workspace, name: "Repo" }], "relative roots are dropped");
  const byCommand = new Map(overview.hooks.map((hook) => [hook.handler.command, hook]));
  assert.equal(byCommand.get("./done.sh")?.status, "active");
  assert.equal(byCommand.get("./done.sh")?.scope.kind, "global");
  const repo = byCommand.get("./guard.sh");
  assert.equal(repo?.status, "waiting-for-approval");
  assert.deepEqual(repo?.scope, { kind: "workspace", workspaceRoot: f.workspace });
  assert.equal(overview.hooks.length, 2, "no hook is listed twice");
});

test("a repo hook is approved only for the digest the owner saw", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.workspace, ".aiden", "hooks.json");
  await fs.writeFile(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "./check.sh" }] }] } }));
  const seen = (await f.list()).hooks[0];
  assert.ok(seen);

  // The file changes after the owner looked: the old digest no longer approves anything.
  await fs.writeFile(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "./other.sh" }] }] } }));
  const current = (await f.list()).hooks[0];
  assert.ok(current);
  const stale = (await f.invoke("hooks:approveDigest", current.id, seen.digest)) as { ok: boolean };
  assert.equal(stale.ok, false);
  assert.equal((await f.list()).hooks[0]?.status, "waiting-for-approval");

  const approved = (await f.invoke("hooks:approveDigest", current.id, current.digest)) as { ok: boolean; value?: HookListing };
  assert.equal(approved.ok, true);
  assert.equal((await f.list()).hooks[0]?.status, "active");
  assert.ok(f.broadcasts.some((change) => change.reason === "hooks"), "windows hear about the approval");

  await assert.rejects(f.invoke("hooks:approveDigest", current.id), /Invalid hooks request/u, "a digest is required");
  await assert.rejects(f.invoke("hooks:approveDigest", current.id, "ABC"), /Invalid hooks request/u);
});

test("save refuses hooks for folders that are not workspaces, and bad fields", async (t) => {
  const f = await fixture(t);
  const refuse = (request: unknown) => assert.rejects(f.invoke("hooks:save", request), /Invalid hooks request/u, JSON.stringify(request));
  await refuse({ scope: { kind: "workspace", workspaceRoot: path.join(f.base, "elsewhere") }, event: "Stop", command: "./x.sh" });
  await refuse({ scope: { kind: "workspace", workspaceRoot: "repo" }, event: "Stop", command: "./x.sh" });
  await refuse({ scope: { kind: "chat", chatId: "c" }, event: "Stop", command: "./x.sh" });
  await refuse({ scope: { kind: "global" }, event: "TeammateIdle", command: "./x.sh" });
  await refuse({ scope: { kind: "global" }, event: "Stop", command: "   " });
  await refuse({ scope: { kind: "global" }, event: "Stop", command: "a\u0000b" });
  await refuse({ scope: { kind: "global" }, event: "Stop", command: "x".repeat(4097) });
  await refuse({ scope: { kind: "global" }, event: "Stop", command: "./x.sh", timeout: 121 });
  await refuse({ scope: { kind: "global" }, event: "Stop", command: "./x.sh", timeout: 1.5 });
  await refuse({ scope: { kind: "global" }, event: "Stop", command: "./x.sh", failClosed: true });
  await refuse({ scope: { kind: "global" }, event: "PreToolUse", command: "./x.sh", failClosed: "yes" });
  await refuse(null);
  assert.deepEqual((await f.list()).hooks, []);

  const workspaceHook = (await f.invoke("hooks:save", {
    scope: { kind: "workspace", workspaceRoot: `${f.workspace}/` },
    event: "PreToolUse",
    matcher: "Bash",
    command: "./guard.sh",
    timeout: 10,
    failClosed: true,
    name: "Guard",
  })) as { ok: boolean; value?: HookListing };
  assert.equal(workspaceHook.ok, true);
  assert.deepEqual(workspaceHook.value?.scope, { kind: "workspace", workspaceRoot: f.workspace });
  assert.equal(workspaceHook.value?.handler.failClosed, true);
  assert.equal(workspaceHook.value?.handler.timeout, 10);
  assert.equal(workspaceHook.value?.name, "Guard");
});

test("switches, pause, delete and the run log go through the service; Test runs once per call", async (t) => {
  const f = await fixture(t);
  const saved = (await f.invoke("hooks:save", { scope: { kind: "global" }, event: "Stop", command: "./done.sh" })) as { value: HookListing };
  const id = saved.value.id;

  assert.equal(await f.invoke("hooks:setEnabled", id, false), true);
  assert.equal((await f.list()).hooks[0]?.status, "disabled");
  await assert.rejects(f.invoke("hooks:setEnabled", id, "false"), /Invalid hooks request/u);
  assert.equal(await f.invoke("hooks:setEnabled", id, true), true);
  assert.equal(await f.invoke("hooks:setEnabled", "global:missing", false), false, "an unknown hook is not reported as switched");

  assert.equal(await f.invoke("hooks:setPaused", true), true);
  assert.equal((await f.list()).paused, true);
  await assert.rejects(f.invoke("hooks:setPaused", 1), /Invalid hooks request/u);
  await f.invoke("hooks:setPaused", false);

  assert.deepEqual(f.runs, [], "nothing runs until Test is pressed");
  await assert.rejects(f.invoke("hooks:test", id), /Invalid hooks request/u, "Test needs the digest on screen");
  const stale = (await f.invoke("hooks:test", id, "0".repeat(64))) as { ok: boolean; reason?: string };
  assert.equal(stale.ok, false, "a digest for another version is refused");
  assert.match(stale.reason ?? "", /changed since it was shown/u);
  assert.deepEqual(f.runs, [], "a refused test runs nothing");
  const tested = (await f.invoke("hooks:test", id, saved.value.digest)) as { ok: boolean; value?: { exitCode: number | null } };
  assert.equal(tested.ok, true);
  assert.equal(tested.value?.exitCode, 0);
  assert.deepEqual(f.runs, ["./done.sh"]);
  assert.ok(Array.isArray(await f.invoke("hooks:runLog", id)));

  assert.equal(((await f.invoke("hooks:delete", id)) as { ok: boolean }).ok, true);
  assert.deepEqual((await f.list()).hooks, []);
  for (const bad of ["", 7, "x".repeat(301), "a\nb"]) {
    await assert.rejects(f.invoke("hooks:delete", bad), /Invalid hooks request/u, JSON.stringify(bad));
  }
});

test("agent proposals are listed, then approved or rejected by id", async (t) => {
  const f = await fixture(t);
  assert.ok(f.service);
  const propose = async (command: string) => {
    const proposal = await f.service!.proposeHook({ scope: { kind: "chat", chatId: "chat-1" }, event: "Stop", handler: { type: "command", command } });
    assert.ok(proposal.ok);
    return proposal.value;
  };
  const keep = await propose("./keep.sh");
  const drop = await propose("./drop.sh");
  assert.deepEqual((await f.list()).proposals.map((proposal) => proposal.id).sort(), [keep.id, drop.id].sort());
  assert.deepEqual((await f.list()).hooks, [], "a proposal changes nothing on its own");

  assert.equal(await f.invoke("hooks:rejectProposal", drop.id), true);
  const approved = (await f.invoke("hooks:approveProposal", keep.id)) as { ok: boolean; value?: HookListing };
  assert.equal(approved.ok, true);
  const overview = await f.list();
  assert.deepEqual(overview.proposals, []);
  assert.deepEqual(overview.hooks.map((hook) => [hook.handler.command, hook.status]), [["./keep.sh", "active"]]);
  assert.ok(f.broadcasts.some((change) => change.reason === "proposals"));

  assert.equal(((await f.invoke("hooks:approveProposal", keep.id)) as { ok: boolean }).ok, false, "a proposal is answered once");
  await assert.rejects(f.invoke("hooks:approveProposal", { id: keep.id }), /Invalid hooks request/u);
});

test("before the service starts the list says so, and writes are refused", async (t) => {
  const f = await fixture(t, { started: false, env: { AIDEN_HOOKS: "0" } });
  const overview = await f.list();
  assert.equal(overview.available, false);
  assert.equal(overview.disabledByEnvironment, true);
  await assert.rejects(f.invoke("hooks:setPaused", true), /still starting/u);
});

test("every hooks channel refuses a sender that is not an Aiden window before touching the service", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace, ".aiden", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "./check.sh" }] }] } }));
  const repo = (await f.list()).hooks[0];
  assert.ok(repo);
  const before = f.broadcasts.length;
  const calls: Array<[string, ...unknown[]]> = [
    ["hooks:list"],
    ["hooks:save", { scope: { kind: "global" }, event: "Stop", command: "./x.sh" }],
    ["hooks:approveDigest", repo.id, repo.digest],
    ["hooks:setEnabled", repo.id, false],
    ["hooks:setPaused", true],
    ["hooks:test", repo.id, repo.digest],
    ["hooks:runLog", repo.id],
    ["hooks:delete", repo.id],
    ["hooks:approveProposal", "proposal-1"],
    ["hooks:rejectProposal", "proposal-1"],
  ];
  assert.deepEqual(calls.map(([channel]) => channel).sort(), f.channels().sort(), "the check covers every registered channel");
  for (const [channel, ...args] of calls) {
    await assert.rejects(f.invokeFrom({}, channel, ...args), /need the active window/u, channel);
  }
  assert.deepEqual(f.runs, [], "nothing ran");
  assert.equal(f.broadcasts.length, before, "nothing changed");
  const after = await f.list();
  assert.equal(after.paused, false);
  assert.deepEqual(after.hooks.map((hook) => [hook.id, hook.status]), [[repo.id, "waiting-for-approval"]]);
});
