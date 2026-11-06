import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runToolCall } from "@earendil-works/pi-agent-core";
import type { JsonObject } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BOT_LOCKED_RULES, defaultBotRules, type BotRule } from "../../../renderer/shared/bot-rules.js";
import { BOT_PLAN_MAX_MS } from "../../../renderer/shared/bot-plans.js";
import { buildBotFileTools, type BotFileToolLocation } from "../bot-file-tool-router.js";
import { createPiCodemodeTool } from "../pi-codemode.js";
import { resolveBotAccessTarget } from "../bot-runtime/bot-access-target.js";
import { createBotRunAccess } from "../bot-runtime/bot-run-access.js";
import { testAuthority, SEND_EMAIL_TOOL, READ_INBOX_TOOL } from "../bot-runtime/test-support/assembly-fixtures.js";
import type { BotRuntimeEffectiveAuthority } from "../bot-runtime-authority.js";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import { createBotPlans } from "./plans.js";
import type { BotPlanProposal } from "./validate.js";
import { createBotPlanAuthority, botPlanBindingRevision, type BotPlanAuthorityDeps } from "./authority.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
const connector = { connector: "Mail", action: "send updates", tools: [SEND_EMAIL_TOOL], max: 2 };
const input = (covers: unknown[] = [connector]) => ({ title: "Organize", why: "Complete the work", steps: [{ text: "Do the work" }], covers });
const textOf = (result: { content: readonly { type: string; text?: string }[] }) => result.content.flatMap((c) => c.type === "text" ? [c.text ?? ""] : []).join("\n");
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "plan-authority-")));
  const privateRoot = path.join(root, "Private"), home = path.join(privateRoot, "BotHome"), outside = path.join(root, "Documents", "Taxes");
  await fs.mkdir(home, { recursive: true }); await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "note.txt"), "original"); await fs.symlink(outside, path.join(root, "tax-link"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let authority = testAuthority({ mode: "custom", home, connections: true, shell: true, botHome: true, other: ["browser"] });
  let rules = defaultBotRules(), time = 1000, opened = 0, released = 0;
  let onFence: (() => Promise<void>) | undefined, rawIds: readonly (string | undefined)[] = [undefined];
  let hostIds: readonly string[] = ["aiden.bot-input-identity:11111111-1111-4111-8111-111111111111"];
  const callController = new AbortController(), admissions: AbortController[] = [];
  const fixedStat = await fs.stat(home, { bigint: true });
  let fixed: BotFileToolLocation[] = [{ id: "home", label: "Bot folder", root: home, expectedIdentity: { device: String(fixedStat.dev), inode: String(fixedStat.ino) } }];
  let inventory: { id: string; folderPath: string }[] = [];
  const runAccess = createBotRunAccess({ now: () => time });
  const resolveTarget = (requested: string) => resolveBotAccessTarget(requested, { homeDirectory: () => root, privateRoots: () => [privateRoot], approvedRoots: async () => inventory });
  const deps: BotPlanAuthorityDeps = {
    admit: async (botId) => {
      assert.equal(botId, authority.botId); opened++;
      const snapshot = structuredClone(authority), controller = new AbortController(); admissions.push(controller);
      let closed = false;
      return { authority: snapshot, signal: controller.signal, release() { assert.equal(closed, false); closed = true; released++; }, revalidateBeforeEffect: async () => {
        await onFence?.();
        if (controller.signal.aborted || JSON.stringify(snapshot) !== JSON.stringify(authority)) throw new Error("authority changed");
      } };
    },
    facts: async (_id, admission) => ({ authority: admission.authority, supportsImages: false, fileLocations: fixed.length, hasComputer: false,
      mcpTools: async () => new Map([[SEND_EMAIL_TOOL, admission.authority.connections[0]!.tools[0]!], [READ_INBOX_TOOL, admission.authority.connections[0]!.tools[1]!]]),
      mcpToolDescriptor: async (name) => name === SEND_EMAIL_TOOL ? { name: "send_email", inputSchema: { type: "object" }, annotations: { title: "Send email", readOnlyHint: false } } : undefined,
      skillToolNames: async () => new Set(),
    }),
    rules: async () => structuredClone(rules), locations: async () => structuredClone(fixed), resolveTarget, runAccess, now: () => time, homeDirectory: () => root,
  };
  const adapter = createBotPlanAuthority(deps);
  const call: BotToolCall = { callId: "call", taskId: "task", signal: callController.signal, entries: async () => [], submissions: async () => [], appendEntry: async () => {}, memo: async (_name, value) => value,
    runInputIds: async () => hostIds, runRequestIds: async () => rawIds, assertRunActive: async () => { if (callController.signal.aborted) throw new Error("run stopped"); } };
  const botId = authority.botId;
  const validated = async (covers: unknown[] = [connector]): Promise<BotPlanProposal> => {
    const result = await adapter.validate(botId, input(covers), call);
    assert.equal(result.ok, true, result.ok ? undefined : result.problems.join("\n"));
    if (!result.ok) throw new Error("invalid fixture proposal"); return result.proposal;
  };
  return { root, home, outside, privateRoot, botId, adapter, deps, call, callController, runAccess, resolveTarget, validated, admissions,
    authority: () => authority, setAuthority: (value: BotRuntimeEffectiveAuthority) => { authority = value; }, rules: () => rules, setRules: (value: BotRule[]) => { rules = value; },
    setTime: (value: number) => { time = value; }, setHostIds: (value: readonly string[]) => { hostIds = value; }, setRawIds: (value: readonly (string | undefined)[]) => { rawIds = value; },
    setFixed: (value: BotFileToolLocation[]) => { fixed = value; }, setInventory: (value: typeof inventory) => { inventory = value; }, setFence: (value: typeof onFence) => { onFence = value; },
    balance: () => ({ opened, released }),
  };
}
const grant = (p: BotPlanProposal, access: "read" | "write" = "read", expiresAt = 1000 + BOT_PLAN_MAX_MS) => {
  const authorization = p.authorization.folder; assert.ok(authorization);
  return { path: authorization.root, access, planId: "plan-1", expiresAt, requestIds: authorization.requestIds, authorization };
};

test("binding identity covers the complete authority and all effective rules, with locked rules and stable rule order", async (t) => {
  const f = await fixture(t), authority = f.authority(), rules = f.rules();
  const fingerprint = botPlanBindingRevision(authority, rules);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(botPlanBindingRevision(authority, [...rules].reverse()), fingerprint);
  assert.equal(botPlanBindingRevision(authority, rules.filter((r) => !r.locked)), fingerprint);
  assert.notEqual(botPlanBindingRevision({ ...authority, catalogRevision: "next" }, rules), fingerprint);
  assert.notEqual(botPlanBindingRevision({ ...authority, provider: { ...authority.provider, modelFingerprint: "changed" } }, rules), fingerprint);
  assert.notEqual(botPlanBindingRevision(authority, [...rules, { id: "custom.new", text: "Send an update", behavior: "ask", locked: false }]), fingerprint);
  assert.notEqual(botPlanBindingRevision(authority, rules.map((r) => r.id === "default.delete" ? { ...r, behavior: "hand_off" } : r)), fingerprint);
  assert.equal(BOT_LOCKED_RULES.length, 2);
});

test("validation captures a fresh exact admission and revalidation rejects same-server binding/tool/policy drift", async (t) => {
  const f = await fixture(t), p = await f.validated();
  await f.adapter.revalidate(f.botId, p);
  for (const change of [
    (a: BotRuntimeEffectiveAuthority) => ({ ...a, botPolicy: { ...a.botPolicy, revision: "next" } }),
    (a: BotRuntimeEffectiveAuthority) => ({ ...a, connections: a.connections.map((c) => ({ ...c, exactFingerprint: "rebound" })) }),
    (a: BotRuntimeEffectiveAuthority) => ({ ...a, connections: a.connections.map((c) => ({ ...c, tools: c.tools.map((tool) => ({ ...tool, toolId: tool.toolId + "-new" })) })) }),
  ]) {
    const original = f.authority(); f.setAuthority(change(original));
    await assert.rejects(f.adapter.revalidate(f.botId, p), /changed|stale|match/iu); f.setAuthority(original);
  }
  assert.deepEqual(f.balance(), { opened: 5, released: 5 });
});

test("changed live tool descriptor and newly read-only tool cannot replace an approved item", async (t) => {
  const f = await fixture(t), p = await f.validated(), facts = f.deps.facts;
  f.deps.facts = async (id, admission) => ({ ...await facts(id, admission), mcpToolDescriptor: async () => ({ name: "send_email", inputSchema: { type: "object" }, annotations: { title: "New destructive action", readOnlyHint: false } }) });
  await assert.rejects(f.adapter.revalidate(f.botId, p), /changed|stale|match/iu);
  f.deps.facts = facts;
  const original = f.authority();
  f.setAuthority({ ...original, connections: original.connections.map((c) => ({ ...c, tools: c.tools.map((tool) => ({ ...tool, effect: "read" as typeof tool.effect })) })) });
  await assert.rejects(f.adapter.revalidate(f.botId, p));
  assert.equal(f.balance().opened, f.balance().released);
});

test("new or edited effective rules during real core admission prevent the actual callback", async (t) => {
  for (const edited of [false, true]) {
    const f = await fixture(t), p = await f.validated();
    const plans = createBotPlans({ profileDir: path.join(f.root, "plans"), knownBot: async () => true, now: () => 1000, revalidate: f.adapter.revalidate, revokeAccess: f.adapter.revokeAccess });
    t.after(() => plans.forgetBot(f.botId));
    const result = plans.request({ botId: f.botId, planId: "plan-1", toolCallId: "call", proposal: p, requestIds: ["run-1"], signal: undefined });
    await plans.current(f.botId); await plans.respond(f.botId, "plan-1", "approve"); await result;
    const permit = await plans.cover(f.botId, { executionId: "execute", operationFingerprint: "exact-op", toolName: SEND_EMAIL_TOOL, requestIds: ["run-1"], baseline: true, rules: [], action: { surface: "mcp", modelName: SEND_EMAIL_TOOL, serverId: f.authority().connections[0]!.sourceId, remoteName: "send_email", summary: "send", destructive: "additive" } });
    assert.ok(permit);
    const entered = deferred(), release = deferred(); let first = true, effects = 0;
    f.setFence(async () => { if (first) { first = false; entered.resolve(); await release.promise; } });
    const admission = plans.admit(permit, async () => { effects++; });
    await entered.promise;
    f.setRules(edited ? f.rules().map((r) => r.id === "default.communicate" ? { ...r, behavior: "hand_off" } : r) : [...f.rules(), { id: "custom.new", text: "Send email", behavior: "ask", locked: false }]);
    release.resolve(); assert.deepEqual(await admission, { admitted: false }); assert.equal(effects, 0);
    assert.equal(f.balance().opened, f.balance().released);
  }
});

test("own fixed private home is inside, canonicalized, and never turned into an outside grant", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.resolveTarget(f.home), { kind: "refused", reason: "private" });
  const p = await f.validated([{ files: f.home, action: "write" }]);
  assert.deepEqual(p.items, [{ id: "i1", kind: "files", path: f.home, access: "write", grant: false }]);
  assert.equal(p.authorization.folder, undefined);
  assert.equal((await f.adapter.access.scopeOf(f.botId, f.home, "write")).kind, "inside");
  await f.adapter.revalidate(f.botId, p);
});

test("outside file-parent and symlink targets capture canonical pinned authorization with mapped host IDs", async (t) => {
  const f = await fixture(t), p = await f.validated([{ files: "~/tax-link/note.txt", action: "read" }]);
  const stat = await fs.stat(f.outside, { bigint: true });
  assert.deepEqual(p.items, [{ id: "i1", kind: "files", path: f.outside, access: "read", grant: true }]);
  assert.deepEqual(p.authorization.folder?.identity, { device: String(stat.dev), inode: String(stat.ino) });
  assert.deepEqual(p.authorization.folder?.requestIds, await f.call.runInputIds!());
  assert.equal(p.authorization.folder?.root, f.outside);
  assert.equal(p.authorization.folder?.policyRevision, f.authority().botPolicy.revision);
  assert.match(p.authorization.folder?.inventoryRevision ?? "", /^[a-f0-9]{64}$/u);
  f.setHostIds(["joined-host-input"]); f.setRawIds(["joined-person-input"]);
  await f.adapter.revalidate(f.botId, p);
  assert.deepEqual(p.authorization.folder?.requestIds, ["aiden.bot-input-identity:11111111-1111-4111-8111-111111111111"]);
});

test("outside scope without real mapped owner IDs fails closed; fixed declarations do not need a fabricated owner", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.adapter.access.scopeOf(f.botId, f.outside, "read")).kind, "invalid");
  assert.equal((await f.adapter.validate(f.botId, input([{ files: f.outside, action: "read" }]))).ok, false);
  f.setHostIds([]); f.setRawIds(["a-real-raw-request-is-not-the-host-proof"]);
  assert.equal((await f.adapter.validate(f.botId, input([{ files: f.outside, action: "read" }]), f.call)).ok, false);
  assert.equal((await f.adapter.validate(f.botId, input([{ files: f.home, action: "read" }]), f.call)).ok, true);
});

test("private, whole-Mac, filesystem root, relative and missing targets cannot obtain new outside grants", async (t) => {
  const f = await fixture(t);
  for (const files of [f.privateRoot, "/", "whole_mac", "relative", path.join(f.root, "missing")]) {
    assert.equal((await f.adapter.validate(f.botId, input([{ files, action: "write" }]), f.call)).ok, false, files);
  }
  assert.equal(f.balance().opened, f.balance().released);
});

test("read-only fixed access requires a separate explicit write upgrade", async (t) => {
  const f = await fixture(t); f.setFixed([{ id: "taxes", label: "Taxes", root: f.outside, access: "read" }]);
  const read = await f.validated([{ files: f.outside, action: "read" }]), write = await f.validated([{ files: f.outside, action: "write" }]);
  assert.equal(read.items[0]!.kind === "files" && read.items[0].grant, false);
  assert.equal(write.items[0]!.kind === "files" && write.items[0].grant, true);
});

test("real B router and nested codemode enforce the adapter's explicit read/write grants", async (t) => {
  for (const access of ["read", "write"] as const) {
    const f = await fixture(t), p = await f.validated([{ files: f.outside, action: access }]);
    await f.adapter.access.allowOnce(f.botId, grant(p, access));
    const tools = buildBotFileTools({ defaultLocation: { id: "home", label: "Home", root: f.home }, lateLocation: { id: "run.access", label: "Plan", resolve: async () => f.runAccess.location(f.botId, p.authorization.folder!.requestIds, f.authority().botPolicy.revision) }, temporaryPrivateRoots: () => [f.privateRoot] });
    const byName = (name: string) => { const tool = tools.find((tool) => tool.name === name); assert.ok(tool); return tool; };
    assert.match(textOf(await byName("read_file").execute("read", { location: "run.access", path: "note.txt" })), /original/u);
    for (const operation of ["write_file", "edit_file"] as const) {
      await fs.writeFile(path.join(f.outside, "note.txt"), "original");
      const args = { location: "run.access", path: "note.txt", ...(operation === "write_file" ? { content: "changed" } : { old_string: "original", new_string: "changed" }) };
      if (access === "read") await assert.rejects(byName(operation).execute("direct", args), /reading this folder only/u);
      else if (operation === "write_file") await byName(operation).execute("direct", args);
      else continue; // Native edit helper acceptance is outside this pure adapter suite.
      await fs.writeFile(path.join(f.outside, "note.txt"), "original");
      const message = fauxAssistantMessage("Edit the file");
      const codemode = createPiCodemodeTool({ tools: () => tools, executeTool: async (_parent, name, value) => runToolCall({ type: "toolCall", id: "nested", name, arguments: value as JsonObject }, { tools, assistantMessage: message, context: { messages: [message], tools } }) });
      const result = await codemode.execute("nested-plan", { code: `text(await tools.${operation}(${JSON.stringify(args)}));` });
      if (access === "read") { assert.match(textOf(result), /reading this folder only/u); assert.equal(await fs.readFile(path.join(f.outside, "note.txt"), "utf8"), "original"); }
      else assert.equal(await fs.readFile(path.join(f.outside, "note.txt"), "utf8"), "changed");
    }
    f.adapter.revokeAccess(f.botId, "plan-1");
    await assert.rejects(byName("read_file").execute("ended", { location: "run.access", path: "note.txt" }), /Ask with request_access first/u);
  }
});

test("grant refuses changed request IDs, root, pinned inode, inventory or policy and always releases admission", async (t) => {
  const f = await fixture(t), p = await f.validated([{ files: f.outside, action: "read" }]), g = grant(p);
  for (const bad of [{ ...g, requestIds: ["different"] }, { ...g, path: f.home }]) await assert.rejects(f.adapter.access.allowOnce(f.botId, bad));
  f.setInventory([{ id: "new", folderPath: f.outside }]); await assert.rejects(f.adapter.access.allowOnce(f.botId, g)); f.setInventory([]);
  const original = f.authority(); f.setAuthority({ ...original, botPolicy: { ...original.botPolicy, revision: "new" } });
  await assert.rejects(f.adapter.access.allowOnce(f.botId, g)); f.setAuthority(original);
  await fs.rename(f.outside, f.outside + "-old"); await fs.mkdir(f.outside);
  await assert.rejects(f.adapter.access.allowOnce(f.botId, g)); await assert.rejects(f.adapter.revalidate(f.botId, p));
  assert.equal(f.runAccess.location(f.botId, g.requestIds, original.botPolicy.revision), undefined);
  assert.equal(f.balance().opened, f.balance().released);
});

test("expiry crossing final admission prevents grant; original expiry and sixty-minute ceiling are retained", async (t) => {
  const f = await fixture(t), p = await f.validated([{ files: f.outside, action: "read" }]), g = grant(p, "read", 1100);
  f.setFence(async () => { f.setTime(1100); });
  await assert.rejects(f.adapter.access.allowOnce(f.botId, g));
  assert.equal(f.runAccess.location(f.botId, g.requestIds, f.authority().botPolicy.revision), undefined);
  f.setFence(undefined); f.setTime(1000);
  await f.adapter.access.allowOnce(f.botId, grant(p, "read", 1000 + BOT_PLAN_MAX_MS * 2));
  assert.ok(f.runAccess.location(f.botId, g.requestIds, f.authority().botPolicy.revision));
  f.setTime(1000 + BOT_PLAN_MAX_MS); assert.equal(f.runAccess.location(f.botId, g.requestIds, f.authority().botPolicy.revision), undefined);
  assert.equal(f.balance().opened, f.balance().released);
});

test("only matching plan-owned access is revoked; independent grants remain", async (t) => {
  const f = await fixture(t), p = await f.validated([{ files: f.outside, action: "read" }]), g = grant(p);
  await f.adapter.access.allowOnce(f.botId, g);
  const pinned = p.authorization.folder!.identity!;
  f.runAccess.grant(f.botId, { requestIds: ["other-input"], target: "folder", key: f.outside, root: f.outside, label: "Other", identity: pinned, policyRevision: f.authority().botPolicy.revision, access: "write", owner: { kind: "access", id: "independent" }, grantedAt: 1000, expiresAt: 2000 });
  f.adapter.revokeAccess(f.botId, "wrong-plan"); assert.ok(f.runAccess.location(f.botId, g.requestIds, f.authority().botPolicy.revision));
  f.adapter.access.revokePlan(f.botId, "plan-1"); assert.equal(f.runAccess.location(f.botId, g.requestIds, f.authority().botPolicy.revision), undefined);
  assert.ok(f.runAccess.location(f.botId, ["other-input"], f.authority().botPolicy.revision));
});

test("full/off access cannot receive a new ephemeral outside grant and aborted owners release admission", async (t) => {
  const f = await fixture(t), p = await f.validated([{ files: f.outside, action: "read" }]), original = f.authority();
  for (const next of [{ ...original, accessMode: "full" as const }, { ...original, files: { ...original.files, mode: "off" as const } }]) {
    f.setAuthority(next); await assert.rejects(f.adapter.access.allowOnce(f.botId, grant(p)));
  }
  f.setAuthority(original); f.callController.abort();
  await assert.rejects(f.adapter.validate(f.botId, input(), f.call));
  assert.equal(f.balance().opened, f.balance().released);
});

test("grant installation retains the captured access, owner and deadline while awaiting a fresh fence", async (t) => {
  const f = await fixture(t), p = await f.validated([{ files: f.outside, action: "read" }]), g = grant(p, "read", 1200);
  const entered = deferred(), release = deferred();
  f.setFence(async () => { entered.resolve(); await release.promise; });
  const installing = f.adapter.access.allowOnce(f.botId, g); await entered.promise;
  g.access = "write"; g.planId = "different-plan"; g.expiresAt = 1000 + BOT_PLAN_MAX_MS;
  release.resolve(); await installing;
  assert.equal(f.runAccess.location(f.botId, p.authorization.folder!.requestIds, f.authority().botPolicy.revision)?.access, "read");
  f.adapter.revokeAccess(f.botId, "different-plan");
  assert.ok(f.runAccess.location(f.botId, p.authorization.folder!.requestIds, f.authority().botPolicy.revision), "the captured plan still owns the grant");
  f.setTime(1200); assert.equal(f.runAccess.location(f.botId, p.authorization.folder!.requestIds, f.authority().botPolicy.revision), undefined);
});

test("proposal input is captured before awaiting admission dependencies", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred(), facts = f.deps.facts;
  f.deps.facts = async (id, admission) => { entered.resolve(); await release.promise; return facts(id, admission); };
  const request = input([{ files: f.outside, action: "read" }]);
  const validation = f.adapter.validate(f.botId, request, f.call); await entered.promise;
  (request.covers[0] as { action: string }).action = "write";
  release.resolve(); const result = await validation; assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.proposal.items[0]!.kind === "files" && result.proposal.items[0].access, "read");
});

test("a related inventory change during final grant admission cannot publish the old folder snapshot", async (t) => {
  const f = await fixture(t), p = await f.validated([{ files: f.outside, action: "read" }]);
  f.setFence(async () => { f.setInventory([{ id: "new-related-root", folderPath: f.outside }]); });
  await assert.rejects(f.adapter.access.allowOnce(f.botId, grant(p)), /changed|stale/iu);
  assert.equal(f.runAccess.location(f.botId, p.authorization.folder!.requestIds, f.authority().botPolicy.revision), undefined);
});

test("unrelated root inventory changes do not invalidate a target-specific snapshot", async (t) => {
  const f = await fixture(t), p = await f.validated([{ files: f.outside, action: "read" }]);
  const unrelated = path.join(f.root, "Unrelated"); await fs.mkdir(unrelated);
  f.setInventory([{ id: "unrelated", folderPath: unrelated }]);
  await f.adapter.revalidate(f.botId, p); await f.adapter.access.allowOnce(f.botId, grant(p));
  assert.ok(f.runAccess.location(f.botId, p.authorization.folder!.requestIds, f.authority().botPolicy.revision));
});

test("own fixed file-parent declarations retain their actual home and fail if that pinned home is replaced", async (t) => {
  const f = await fixture(t); await fs.writeFile(path.join(f.home, "own.txt"), "own");
  const p = await f.validated([{ files: "~/Private/BotHome/own.txt", action: "write" }]);
  assert.deepEqual(p.items, [{ id: "i1", kind: "files", path: f.home, access: "write", grant: false }]);
  await fs.rename(f.home, f.home + "-old"); await fs.mkdir(f.home);
  await assert.rejects(f.adapter.revalidate(f.botId, p));
  assert.equal(f.balance().opened, f.balance().released);
});

test("temporary aliases cannot be promoted into fixed authority and dependency failures release admissions", async (t) => {
  const f = await fixture(t), original = f.deps.facts;
  f.deps.facts = async () => { throw new Error("facts unavailable"); };
  await assert.rejects(f.adapter.validate(f.botId, input(), f.call), /facts unavailable/u);
  f.deps.facts = original;
  f.setFixed([{ id: "run.access", label: "Temporary", root: f.outside }]);
  await assert.rejects(f.adapter.validate(f.botId, input([{ files: f.outside, action: "read" }]), f.call));
  assert.equal(f.balance().opened, f.balance().released);
});

test("caller abort during the final rules read and admission abort during final target read both fail closed", async (t) => {
  const f = await fixture(t), rules = f.deps.rules;
  let reads = 0;
  f.deps.rules = async (id) => { if (++reads === 2) f.callController.abort(); return rules(id); };
  await assert.rejects(f.adapter.validate(f.botId, input(), f.call));
  assert.equal(f.balance().opened, f.balance().released);
  const g = await fixture(t), p = await g.validated([{ files: g.outside, action: "read" }]), resolve = g.deps.resolveTarget;
  let targets = 0;
  g.deps.resolveTarget = async (requested) => {
    const target = await resolve(requested);
    if (++targets === 2) g.admissions[g.admissions.length - 1]!.abort();
    return target;
  };
  await assert.rejects(g.adapter.access.allowOnce(g.botId, grant(p)));
  assert.equal(g.runAccess.location(g.botId, p.authorization.folder!.requestIds, g.authority().botPolicy.revision), undefined);
  assert.equal(g.balance().opened, g.balance().released);
});
