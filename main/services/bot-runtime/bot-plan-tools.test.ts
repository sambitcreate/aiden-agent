import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { JsonValue } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, LiveDoc, MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { botMessageRequestId, botMessageTurnOf } from "../../../renderer/shared/bot-messages.js";
import { createBotPlans } from "../bot-plans/plans.js";
import { createBotPlanAuthority } from "../bot-plans/authority.js";
import type { BotPlanAccessPort, BotPlanBotTurnPort } from "../bot-plans/ports.js";
import { botPlanProposalFingerprint, validateBotPlanProposal, type BotPlanProposal } from "../bot-plans/validate.js";
import { createBotMessageLedger } from "../bot-messages/ledger.js";
import { createBotMessageCourier } from "../bot-messages/courier.js";
import { resolveBotAccessTarget, coveredByBotLocations } from "./bot-access-target.js";
import { createBotApprovals } from "./bot-approvals.js";
import { buildBotFileTools } from "../bot-file-tool-router.js";
import { botFileCandidates } from "./bot-file-candidates.js";
import { createBotRunAccess } from "./bot-run-access.js";
import { createBotRegistry, type BotRegistry } from "./bot-extension.js";
import { createBotHarnessHost, type BotHarnessHost } from "./harness-host.js";
import { botIngressAllowsTool, type BotToolFacts } from "./bot-tool-policy.js";
import { assemblyDeps, assemblyState, MAIL_SERVER, SEND_EMAIL_TOOL, testAuthority } from "./test-support/assembly-fixtures.js";
import { countingTool, recordingDeps } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor } from "./test-support/faux.js";
import type { BotToolCall } from "./tool-adapter.js";
import type { BotToolCandidate } from "./bot-tool-assembly.js";
import { BOT_PLAN_MEMO, planStepCandidate, proposePlanCandidate, type BotPlanToolDeps } from "./bot-plan-tools.js";

const BOT = "ada";
const input = (covers: unknown[] = [{ shell: "bot_home" }]) => ({ title: "Prepare a report", why: "Organize the results", steps: [{ text: "Read the sources" }, { text: "Write the report" }], covers });
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(part => part.text ?? "").join("");
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t: TestContext, useProductionAuthority = false) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bot-plan-tools-")));
  const home = path.join(dir, "Home"), outside = path.join(dir, "Outside"), privateRoot = path.join(dir, "Private");
  await Promise.all([home, outside, privateRoot].map(folder => fs.mkdir(folder)));
  await fs.writeFile(path.join(outside, "report.txt"), "source");
  const disposals: Array<() => Promise<void>> = [];
  t.after(async () => { for (const dispose of disposals) await dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  const runAccess = createBotRunAccess({ now: Date.now });
  let ids: readonly (string | undefined)[] = ["req-1"], mapped: readonly string[] = ["req-1"], revision = "p1", live = true;
  let grants = 0, validations = 0, requests = 0;
  let beforeGrant: (() => Promise<void>) | undefined;
  const memos = new Map<string, JsonValue>();
  const base = testAuthority({ mode: "custom", home, shell: true, botHome: true, other: ["browser"] });
  const facts: BotToolFacts = { authority: { ...base, botId: BOT, managedHome: { ...base.managedHome, botId: BOT } }, supportsImages: true, fileLocations: 1, hasComputer: false, mcpTools: async () => new Map(), skillToolNames: async () => new Set() };
  const access: BotPlanAccessPort = {
    async scopeOf(_botId, requested, requiredAccess) {
      const target = await resolveBotAccessTarget(requested, { homeDirectory: () => dir, privateRoots: () => [privateRoot], approvedRoots: async () => [] });
      if (target.kind !== "folder") return { kind: "invalid" };
      if (coveredByBotLocations(target.root, [{ root: home }], requiredAccess)) return { kind: "inside" };
      return { kind: "outside", authorization: { policyRevision: revision, requestIds: [...mapped], target: "folder", root: target.root, identity: { device: target.device, inode: target.inode }, choices: ["not_now", "once"] } };
    },
    async allowOnce(_botId, grant) {
      await beforeGrant?.();
      const target = await resolveBotAccessTarget(grant.path, { homeDirectory: () => dir, privateRoots: () => [privateRoot], approvedRoots: async () => [] });
      if (!live || revision !== grant.authorization.policyRevision || target.kind !== "folder" || target.device !== grant.authorization.identity?.device || target.inode !== grant.authorization.identity?.inode) throw new Error("The folder or task changed. Ask for access again.");
      grants++;
      runAccess.grant(BOT, { requestIds: grant.requestIds, target: "folder", key: grant.path, root: grant.path, label: "Outside", policyRevision: revision, identity: grant.authorization.identity, access: grant.access, owner: { kind: "plan", id: grant.planId }, expiresAt: grant.expiresAt, grantedAt: Date.now() });
    },
    revokePlan: (botId, planId) => runAccess.revokeOwner(botId, { kind: "plan", id: planId }),
  };
  const productionAuthority = createBotPlanAuthority({
    admit: async id => {
      assert.equal(id, BOT);
      const snapshot = { ...facts.authority, botPolicy: { ...facts.authority.botPolicy, revision } }, cancellation = new AbortController();
      return { authority: snapshot, signal: cancellation.signal, release() { cancellation.abort(); }, revalidateBeforeEffect: async () => {
        if (snapshot.botPolicy.revision !== revision) throw new Error("Access changed");
      } };
    },
    facts: async (_id, admission) => ({ ...facts, authority: admission.authority }), rules: async () => [],
    locations: async () => [{ id: "home", root: home, label: "Home", expectedIdentity: facts.authority.managedHome.incarnation }],
    resolveTarget: requested => resolveBotAccessTarget(requested, { homeDirectory: () => dir, privateRoots: () => [privateRoot], approvedRoots: async () => [] }),
    runAccess, homeDirectory: () => dir,
  });
  const effectiveAccess: BotPlanAccessPort = useProductionAuthority ? { ...productionAuthority.access, allowOnce: async (...args) => { await productionAuthority.access.allowOnce(...args); grants++; } } : access;
  const makePlans = () => createBotPlans({ profileDir: dir, knownBot: async () => true,
    revalidate: useProductionAuthority ? productionAuthority.revalidate : async (_id, proposal) => {
      if (proposal.authorization.policyRevision !== revision) throw new Error("Access changed");
    }, revokeAccess: effectiveAccess.revokePlan });
  let plans = makePlans();
  const controller = new AbortController();
  const call = (): BotToolCall => ({
    taskId: "host-task-1", callId: "provider-call-1", signal: controller.signal,
    assertRunActive: async () => { if (!live || !ids.length) throw new Error("The owning run ended"); if (controller.signal.aborted) throw controller.signal.reason; },
    runRequestIds: async () => ids, runInputIds: async () => mapped,
    entries: async () => [], submissions: async () => [], appendEntry: async () => {},
    memo: async <T extends JsonValue>(name: string, candidate: T) => { if (!memos.has(name)) memos.set(name, structuredClone(candidate)); return structuredClone(memos.get(name)) as T; },
    readMemo: async <T extends JsonValue>(name: string) => structuredClone(memos.get(name)) as T | undefined,
  });
  const deps: BotPlanToolDeps = {
    plans: {
      request: request => { requests++; return plans.request(request); },
      current: (...args) => plans.current(...args), markStep: (...args) => plans.markStep(...args),
      grantFreshAccess: (...args) => plans.grantFreshAccess(...args), respond: (...args) => plans.respond(...args),
    },
    validate: async (_id, value, current) => {
      assert.ok(current, "the real candidate supplies its current call"); validations++;
      if (useProductionAuthority) return productionAuthority.validate(BOT, value, current);
      const currentIds = await current.runInputIds!();
      const scoped = { ...access, scopeOf: async (id: string, requested: string, mode: "read" | "write") => {
        const scope = await access.scopeOf(id, requested, mode);
        return scope.authorization ? { ...scope, authorization: { ...scope.authorization, requestIds: [...currentIds] } } : scope;
      } };
      return validateBotPlanProposal(value, { botId: BOT, facts, policyRevision: revision, bindingRevision: "b1", rules: [], access: scoped });
    }, access: effectiveAccess, botName: async () => "Jester",
  };
  const candidate = () => proposePlanCandidate(BOT, deps);
  const execute = (value: unknown = input()) => candidate().bind!(call()).execute("provider-call-1", value);
  const pending = async () => { const current = await plans.current(BOT); return current?.status === "pending" ? current : undefined; };
  const approve = async () => { await waitFor(async () => !!await pending()); const plan = (await pending())!; assert.equal(await plans.respond(BOT, plan.planId, "approve"), "done"); return plan.planId; };
  const files = botFileCandidates([{ id: "home", root: home, label: "Home" }], { routine: false, recordOwnWrite() {}, runAccess: { resolve: async current => runAccess.location(BOT, await current.runInputIds!(), revision) } });
  return { dir, home, outside, privateRoot, runAccess, access, deps, candidate, execute, pending, approve, call, memos, controller, files,
    plans: () => plans, restart: () => { plans = makePlans(); runAccess.clearAll(); },
    setIds(raw: readonly (string | undefined)[], stable: readonly string[] = raw.filter((id): id is string => id !== undefined)) { ids = raw; mapped = stable; },
    setRevision(value: string) { revision = value; }, end() { live = false; },
    beforeGrant(value: () => Promise<void>) { beforeGrant = value; },
    counts: () => ({ grants, validations, requests }), onCleanup(dispose: () => Promise<void>) { disposals.push(dispose); },
  };
}

test("invalid proposals report all problems without a plan card", async t => {
  const f = await fixture(t);
  await assert.rejects(f.execute(input([{ rule: "locked.money" }, { connector: "Absent", action: "send", tools: ["missing"] }])), /money[\s\S]*isn't a granted|isn't a granted[\s\S]*money/u);
  assert.equal(await f.plans().current(BOT), null);
  assert.equal(f.counts().requests, 0);
});

test("approval replay preserves original immutable proposal, IDs and attribution after steers and restart", async t => {
  const f = await fixture(t), execution = f.execute();
  const planId = await f.approve();
  assert.match(textOf(await execution), /The person approved “Prepare a report”/u);
  f.setIds(["req-1", "steer-2"]);
  f.deps.botName = async () => "Renamed Bot";
  f.setRevision("p2");
  assert.match(textOf(await f.execute()), /The person approved/u);
  assert.equal(f.counts().validations, 1, "replay uses the captured snapshot rather than validating a replacement");
  const stored = JSON.parse(await fs.readFile(path.join(f.dir, "bots", BOT, "plans.json"), "utf8"));
  assert.deepEqual(stored.plans[0].requestIds, ["req-1"]);
  assert.equal(stored.plans[0].proposal.authorization.policyRevision, "p1");
  await assert.rejects(f.execute({ ...input(), title: "Changed task" }), /replay|changed/iu);
  f.restart();
  assert.match(textOf(await f.execute()), /The person approved/u);
  await f.plans().respond(BOT, planId, "stop");
  assert.equal(textOf(await f.execute()), "This plan has ended. Ask again for a new task.");
  assert.equal((await f.plans().current(BOT))?.status, "stopped");
  assert.ok(f.memos.has(BOT_PLAN_MEMO));
});

test("concurrent executions of one durable identity cannot attach changed arguments to the winning proposal", async t => {
  const f = await fixture(t), arrived = deferred(), release = deferred(), validate = f.deps.validate;
  let arrivals = 0;
  f.deps.validate = async (...args) => {
    const proposal = await validate(...args);
    if (++arrivals === 2) arrived.resolve();
    await release.promise;
    return proposal;
  };
  const first = f.execute(), changed = f.execute({ ...input(), title: "A different task" });
  void first.catch(() => {}); void changed.catch(() => {});
  await arrived.promise; release.resolve();
  await f.approve();
  const settled = await Promise.allSettled([first, changed]);
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  const refused = settled.find(result => result.status === "rejected");
  assert.ok(refused?.status === "rejected");
  assert.match(String(refused.reason), /replay.*changed|identity changed/iu);
  assert.equal(f.counts().requests, 1, "changed arguments are rejected before a second waiter attaches");
});

for (const mode of ["read", "write"] as const) test(`fresh ${mode} folder grant uses the real B router and cannot be recreated by replay`, async t => {
  const f = await fixture(t), value = input([{ files: f.outside, action: mode }]);
  const execution = f.execute(value), planId = await f.approve();
  assert.match(textOf(await execution), /approved/u);
  const tool = (name: string) => f.files.find(candidate => candidate.tool.name === name)!.bind!(f.call());
  const read = await tool("read_file").execute("read", { location: "run.access", path: "report.txt" });
  assert.match(textOf(read), /source/u);
  if (mode === "read") {
    await assert.rejects(tool("write_file").execute("write", { location: "run.access", path: "report.txt", content: "changed" }), /allows reading this folder only/u);
    await assert.rejects(tool("edit_file").execute("edit", { location: "run.access", path: "report.txt", old_text: "source", new_text: "changed" }), /allows reading this folder only/u);
    assert.equal(await fs.readFile(path.join(f.outside, "report.txt"), "utf8"), "source");
  } else {
    await tool("write_file").execute("write", { location: "run.access", path: "report.txt", content: "changed" });
    assert.equal(await fs.readFile(path.join(f.outside, "report.txt"), "utf8"), "changed");
  }
  await f.execute(value);
  assert.equal(f.counts().grants, 1);
  f.restart();
  assert.match(textOf(await f.execute(value)), /request_access/u);
  await assert.rejects(tool("read_file").execute("read-again", { location: "run.access", path: "report.txt" }), /not available|not.*allowed|unknown|unavailable/iu);
  assert.equal(f.counts().grants, 1);
  await f.plans().respond(BOT, planId, "stop");
});

test("Not now returns the planned text and creates no active authority", async t => {
  const f = await fixture(t), execution = f.execute();
  await waitFor(async () => !!await f.pending());
  await f.plans().respond(BOT, (await f.pending())!.planId, "not_now");
  assert.equal(textOf(await execution), "The person said Not now to “Prepare a report”. Don't start it. Ask what they'd like instead.");
  assert.equal(await f.plans().current(BOT), null);
});

test("aborting a pending plan withdraws its waiter and refuses a late approval", async t => {
  const f = await fixture(t), execution = f.execute(); void execution.catch(() => {});
  await waitFor(async () => !!await f.pending());
  const id = (await f.pending())!.planId;
  f.controller.abort(new Error("The person stopped this run"));
  await assert.rejects(execution, /person stopped this run/u);
  assert.equal(await f.plans().current(BOT), null);
  assert.equal(await f.plans().respond(BOT, id, "approve"), "not_waiting");
  assert.equal(f.counts().grants, 0);
});

test("plan_step is idempotent, binds current mapped inputs and maps every outcome", async t => {
  const f = await fixture(t), execution = f.execute(); await f.approve(); await execution;
  const step = (n: number, status = "done") => planStepCandidate(BOT, f.plans()).bind!(f.call()).execute("step", { step: n, status });
  assert.equal(textOf(await step(3)), "This plan has no step 3.");
  assert.equal(textOf(await step(1)), "Step 1 marked done.");
  assert.equal(textOf(await step(1)), "Step 1 marked done.");
  assert.equal(textOf(await step(1, "skipped")), "Step 1 was already marked done.");
  f.setIds(["req-1", "joined"]);
  assert.equal(textOf(await step(2, "skipped")), "All steps are marked; the plan has ended.");
  assert.equal(textOf(await step(2, "skipped")), "All steps are marked; the plan has ended.");
  assert.equal(textOf(await step(1, "skipped")), "No approved plan is running in this turn.");
  await assert.rejects(step(0), /step|1|10/iu);
});

test("empty, reply, unattended, malformed Bot and missing delivery-port ingress creates no waiter", async t => {
  const f = await fixture(t);
  for (const ids of [[], ["routine:r"], ["tg:1"], ["intro:ada"], [`botreply:${randomUUID()}`], ["bot:j:1:bad"], [botMessageRequestId("j", 1, randomUUID())], ["person", "routine:r"]]) {
    f.setIds(ids);
    await assert.rejects(f.execute(), /turn|delivery|available|owning|input/iu);
    assert.equal(await f.plans().current(BOT), null);
  }
  f.setIds([undefined], [`input:${randomUUID()}`]);
  const execution = f.execute(); await f.approve();
  assert.match(textOf(await execution), /approved/u);
});

test("abort or lost current run after approval prevents success and fresh folder access", async t => {
  const f = await fixture(t), value = input([{ files: f.outside, action: "write" }]);
  const entered = deferred(), release = deferred();
  f.beforeGrant(async () => { entered.resolve(); await release.promise; });
  const execution = f.execute(value); void execution.catch(() => {});
  const id = await f.approve(); await entered.promise;
  f.end(); f.controller.abort(new Error("Stopped")); release.resolve();
  await assert.rejects(execution, /Stopped|changed|ended/iu);
  assert.equal(f.runAccess.location(BOT, ["req-1"], "p1"), undefined);
  assert.notEqual((await f.plans().current(BOT))?.status, "active");
  assert.equal(await f.plans().respond(BOT, id, "approve"), "not_waiting");
});

test("Stop queued during a fresh grant wins the final result and revokes only that owner", async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.beforeGrant(async () => { entered.resolve(); await release.promise; });
  const execution = f.execute(input([{ files: f.outside, action: "read" }]));
  const id = await f.approve(); await entered.promise;
  const stopped = f.plans().respond(BOT, id, "stop"); release.resolve(); await stopped;
  assert.equal(textOf(await execution), "This plan has ended. Ask again for a new task.");
  assert.equal(f.runAccess.location(BOT, ["req-1"], "p1"), undefined);
});

async function courierPort(_t: TestContext, f: Awaited<ReturnType<typeof fixture>>, deadline: number) {
  const deliveryId = randomUUID(), requestId = botMessageRequestId("jester", 1, deliveryId);
  const ledger = createBotMessageLedger({ file: () => path.join(f.dir, "messages.json"), now: Date.now });
  await ledger.reserve({ id: deliveryId, fromBotId: "jester", toBotId: BOT, fromName: "Jester", toName: "Ada", hop: 1, targetRequestId: requestId, createdAt: Date.now(), deadline, status: "delivered", message: "Help", waiting: [], effects: [{ id: `${deliveryId}:target`, kind: "target", botId: BOT, requestId, text: "Help" }] });
  const notices: Array<{ outcome?: string }> = [], notifications: unknown[] = [];
  const courier = createBotMessageCourier({ ledger, now: Date.now, roster: async () => [BOT, "jester"].map(id => ({ id, name: id, purpose: "Help", acceptsMessages: true, sendsMessages: true })), enabled: async () => true, approvals: createBotApprovals({ publish() {} }),
    sessions: { send: async () => { throw new Error("No model or session starts in this test"); }, state: async () => ({ kind: "idle" }), submissionForRequest: async () => "existing-submission", awaitReply: async (_botId, _submissionId, signal) => {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { kind: "interrupted" };
    }, markSilent: async () => {}, appendEntry: async (_id, _kind, data) => { notices.push(data as { outcome?: string }); } },
    deliver: async data => { notifications.push(data); },
    onStateChange: () => () => {}, setTimer: (fn, ms) => { const handle = setTimeout(fn, ms); return { cancel() { clearTimeout(handle); } }; },
  });
  f.onCleanup(() => courier.dispose());
  let reads = 0;
  const port: BotPlanBotTurnPort = { originOf: ids => { const turn = ids.map(botMessageTurnOf).find(turn => turn.kind === "message"); return turn?.kind === "message" ? { originBotId: turn.fromBotId } : undefined; }, announceWaiting: (...args) => { reads++; return courier.announceWaiting(...args); } };
  f.setIds([requestId]); f.deps.botTurns = port;
  return { ledger, deliveryId, notices, notifications, reads: () => reads };
}

async function waitThroughIO(predicate: () => Promise<boolean>) {
  const until = performance.now() + 10_000;
  while (!await predicate()) {
    if (performance.now() >= until) throw new Error("Timed out waiting for the durable I/O boundary");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

test("real A ledger/courier rereads replay deadlines and deduplicates the waiting notification", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = await fixture(t), a = await courierPort(t, f, Date.now() + 60_000);
  const execution = f.execute();
  await waitThroughIO(async () => !!await f.pending());
  const replay = f.execute();
  await waitThroughIO(async () => { t.mock.timers.tick(0); return a.reads() === 2 && a.notices.filter(notice => notice.outcome === "waiting_approval").length === 1; });
  t.mock.timers.tick(60_000);
  assert.equal(textOf(await execution), "Nobody approved “Prepare a report” in time, so it didn't start.");
  assert.match(textOf(await replay), /in time|ended/u);
  assert.equal((await a.ledger.get(a.deliveryId))?.waiting.length, 1);
  assert.equal(a.reads(), 2);
  assert.equal(a.notices.filter(notice => notice.outcome === "waiting_approval").length, 1);
  assert.equal(await f.plans().current(BOT), null);
  assert.equal(textOf(await f.execute()), "Nobody approved “Prepare a report” in time, so it didn't start.");
  assert.equal(a.reads(), 3);
  assert.equal(await f.plans().current(BOT), null);
});

test("an outside-folder plan cannot expose private files through a broad home grant", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.privateRoot, "token.txt"), "private-canary");
  await assert.rejects(f.execute(input([{ files: f.privateRoot, action: "read" }])), /isn't a folder this Bot can use/u);
  assert.equal(await f.plans().current(BOT), null);
  const execution = f.execute(input([{ files: f.dir, action: "read" }])); await f.approve(); await execution;
  const tools = buildBotFileTools({ defaultLocation: { id: "home", root: f.home, label: "Home" }, temporaryPrivateRoots: () => [f.privateRoot],
    lateLocation: { id: "run.access", label: "Task folder", resolve: async () => f.runAccess.location(BOT, await f.call().runInputIds!(), "p1") },
  });
  const read = tools.find(tool => tool.name === "read_file")!;
  await assert.rejects(read.execute("private", { location: "run.access", path: "Private/token.txt" }), /private Bot session, memory and settings files/u);
  assert.equal(await fs.readFile(path.join(f.privateRoot, "token.txt"), "utf8"), "private-canary");
});

test("finishing every step revokes the plan's router access while preserving another owner's grant", async t => {
  const f = await fixture(t), execution = f.execute(input([{ files: f.outside, action: "read" }])); await f.approve(); await execution;
  const stat = await fs.stat(f.outside, { bigint: true });
  f.runAccess.grant(BOT, { requestIds: ["other-run"], target: "folder", key: f.outside, root: f.outside, label: "Other owner", access: "write", owner: { kind: "access", id: "independent" }, policyRevision: "p1", identity: { device: String(stat.dev), inode: String(stat.ino) }, grantedAt: Date.now(), expiresAt: Date.now() + 60_000 });
  const step = planStepCandidate(BOT, f.plans()).bind!(f.call());
  await step.execute("step-1", { step: 1, status: "done" });
  assert.equal(textOf(await step.execute("step-2", { step: 2, status: "done" })), "All steps are marked; the plan has ended.");
  const read = () => f.files.find(candidate => candidate.tool.name === "read_file")!.bind!(f.call()).execute("read", { location: "run.access", path: "report.txt" });
  await assert.rejects(read(), /Ask with request_access first/u);
  f.setIds(["other-run"]);
  assert.match(textOf(await read()), /source/u);
});

test("a pinned folder replacement after approval fails the fresh grant and ends the plan", async t => {
  const f = await fixture(t);
  f.beforeGrant(async () => {
    await fs.rename(f.outside, `${f.outside}-old`);
    await fs.mkdir(f.outside);
    await fs.writeFile(path.join(f.outside, "report.txt"), "replacement");
  });
  const execution = f.execute(input([{ files: f.outside, action: "write" }])); void execution.catch(() => {});
  await f.approve();
  await assert.rejects(execution, /outside-folder access changed.*request_access/u);
  assert.equal(f.counts().grants, 0);
  assert.equal(f.runAccess.location(BOT, ["req-1"], "p1"), undefined);
  assert.equal((await f.plans().current(BOT))?.status, "stopped");
  assert.equal(await fs.readFile(path.join(f.outside, "report.txt"), "utf8"), "replacement");
});

test("missing authoritative A delivery fails closed even when the claimed ID parses", async t => {
  const f = await fixture(t), a = await courierPort(t, f, Date.now() + 60_000);
  f.setIds([botMessageRequestId("jester", 1, randomUUID())]);
  const result = await f.execute();
  assert.match(textOf(result), /delivery|unavailable/iu);
  assert.equal(await f.plans().current(BOT), null);
  assert.equal((await a.ledger.get(a.deliveryId))?.waiting.length, 0);
});

test("an approved Bot plan stores A's original expiry and an expired replay reports ended", async t => {
  const f = await fixture(t), deadline = Date.now() + 60_000, a = await courierPort(t, f, deadline);
  const value = input([{ files: f.outside, action: "read" }]);
  const execution = f.execute(value), id = await f.approve();
  const approved = textOf(await execution);
  assert.doesNotMatch(approved, /next 60 minutes/u, "a 30-minute Bot delivery cannot promise an hour");
  assert.equal((await f.plans().current(BOT))?.expiresAt, deadline);
  const stored = JSON.parse(await fs.readFile(path.join(f.dir, "bots", BOT, "plans.json"), "utf8"));
  assert.equal(stored.plans[0].deadline, deadline);
  assert.equal(stored.plans[0].from, "Jester");
  f.setIds([botMessageRequestId("jester", 1, a.deliveryId), "joined-person"]);
  f.deps.botName = async () => "Jester renamed";
  assert.match(textOf(await f.execute(value)), /approved/u);
  const replayed = JSON.parse(await fs.readFile(path.join(f.dir, "bots", BOT, "plans.json"), "utf8"));
  assert.deepEqual(replayed.plans[0].requestIds, [botMessageRequestId("jester", 1, a.deliveryId)]);
  assert.equal(replayed.plans[0].from, "Jester");
  await f.plans().respond(BOT, id, "stop");
  await a.ledger.update(a.deliveryId, row => ({ ...row, status: "expired" }));
  assert.equal(textOf(await f.execute(value)), "This plan has ended. Ask again for a new task.");
  assert.equal(f.counts().grants, 1);
});

test("replay rejects a changed authoritative deadline instead of renewing its original owner", async t => {
  const f = await fixture(t), deadline = Date.now() + 60_000, a = await courierPort(t, f, deadline);
  const execution = f.execute(); await f.approve(); await execution;
  await a.ledger.update(a.deliveryId, row => ({ ...row, deadline: deadline + 10_000 }));
  assert.match(textOf(await f.execute()), /deadline changed/u);
  assert.equal((await f.plans().current(BOT))?.expiresAt, deadline);
  assert.equal((await f.plans().current(BOT))?.status, "stopped");
});

const entryOf = (candidate: BotToolCandidate) => ({ ...candidate, replay: candidate.replay ?? "unsafe" as const });
async function memoryHarness(f: Awaited<ReturnType<typeof fixture>>, responses: Parameters<typeof createFauxModels>[0], extra: BotToolCandidate[] = []) {
  const deps = { ...recordingDeps({ tools: [f.candidate(), planStepCandidate(BOT, f.deps.plans), ...extra].map(entryOf) }), turnAllows: botIngressAllowsTool };
  const registry = createBotRegistry(BOT, deps);
  await registry.refresh();
  const faux = createFauxModels(responses);
  const harness = await Harness.open(new MemoryStorage(), { registry, models: faux.models }, ctx);
  registry.attachHarness(harness);
  const conversation = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  return { harness, conversation, faux, deps };
}
const toolStep = (name: string, args: unknown) => fauxAssistantMessage([fauxToolCall(name, JSON.parse(JSON.stringify(args)) as import("@earendil-works/pi-ai").JsonObject)], { stopReason: "toolUse" });

const browserCheck = (requestIds: string[], executionId = randomUUID()) => ({ executionId, operationFingerprint: executionId,
  toolName: "browser_click", requestIds, baseline: true, rules: [], action: { surface: "browser" as const, tool: "browser_click" as const, url: "https://example.com/report" } });

async function pendingOtherPlan(f: Awaited<ReturnType<typeof fixture>>, planId = "other-plan") {
  const memo = f.memos.get(BOT_PLAN_MEMO) as { proposal: JsonValue; requestIds: string[] };
  const waiting = f.plans().request({ botId: BOT, planId, toolCallId: "other-call", requestIds: memo.requestIds,
    proposal: memo.proposal as unknown as BotPlanProposal, signal: undefined });
  assert.equal((await f.plans().current(BOT))?.planId, planId);
  return { waiting, planId };
}

test("an approved plan replay remains approved while another plan card is pending", async t => {
  const f = await fixture(t), value = input([{ files: f.outside, action: "read" }, { site: "example.com", action: "browse" }]);
  const execution = f.execute(value), planId = await f.approve(); await execution;
  const other = await pendingOtherPlan(f);
  try {
    assert.equal((await f.plans().current(BOT))?.status, "pending");
    assert.equal((await f.plans().current(BOT, planId))?.status, "active");
    assert.match(textOf(await f.execute(value)), /The person approved/u);
    assert.equal(f.counts().grants, 1, "replay cannot reinstall the folder");
    assert.ok(await f.plans().cover(BOT, browserCheck(["req-1"])));
    await f.plans().respond(BOT, planId, "stop");
    assert.equal((await f.plans().current(BOT))?.planId, other.planId);
    assert.equal((await f.plans().current(BOT))?.status, "pending");
  } finally { await f.plans().respond(BOT, other.planId, "not_now"); await other.waiting; }
});

for (const loss of ["expired", "throws", "missing", "changed"] as const) {
  test(`approved replay with ${loss} A authority stops only its owner and removes coverage and folder access`, async t => {
    const f = await fixture(t), deadline = Date.now() + 60_000;
    await courierPort(t, f, deadline);
    const value = input([{ files: f.outside, action: "read" }, { site: "example.com", action: "browse" }]);
    const execution = f.execute(value), planId = await f.approve(); await execution;
    const ids = [...await f.call().runInputIds!()];
    assert.ok(f.runAccess.location(BOT, ids, "p1"));
    const permit = await f.plans().cover(BOT, browserCheck(ids));
    assert.ok(permit);
    const other = await pendingOtherPlan(f);
    f.deps.botTurns!.announceWaiting = async () => {
      if (loss === "throws") throw new Error("A row unavailable");
      if (loss === "missing") return undefined;
      return { deadline: loss === "changed" ? deadline + 10_000 : deadline, expired: loss === "expired" };
    };
    try {
      const replay = textOf(await f.execute(value));
      assert.match(replay, loss === "expired" ? /plan has ended/u : loss === "changed" ? /deadline changed/u : /delivery is unavailable/u);
      assert.doesNotMatch(replay, /Nobody approved/u);
      assert.equal((await f.plans().current(BOT, planId))?.status, "stopped");
      assert.equal(await f.plans().cover(BOT, browserCheck(ids)), undefined);
      let started = false;
      assert.deepEqual(await f.plans().admit(permit, async () => { started = true; }), { admitted: false });
      assert.equal(started, false, "an already issued permit cannot survive authority loss");
      assert.equal(f.runAccess.location(BOT, ids, "p1"), undefined);
      assert.equal(f.counts().grants, 1);
      assert.equal((await f.plans().current(BOT))?.planId, other.planId);
      assert.equal((await f.plans().current(BOT))?.status, "pending", "stopping P1 never dismisses P2");
    } finally { await f.plans().respond(BOT, other.planId, "not_now"); await other.waiting; }
  });
}

test("authority loss on an ended replay never stops a different active plan", async t => {
  const f = await fixture(t), deadline = Date.now() + 60_000;
  await courierPort(t, f, deadline);
  const execution = f.execute(), planId = await f.approve(); await execution;
  const other = await pendingOtherPlan(f);
  await f.plans().respond(BOT, other.planId, "approve"); await other.waiting;
  f.deps.botTurns!.announceWaiting = async () => ({ deadline, expired: true });
  assert.equal(textOf(await f.execute()), "This plan has ended. Ask again for a new task.");
  assert.equal((await f.plans().current(BOT, planId))?.status, "finished");
  assert.equal((await f.plans().current(BOT))?.planId, other.planId);
  assert.equal((await f.plans().current(BOT))?.status, "active");
});

test("a skipped step cannot be reported as changed to done", async t => {
  const f = await fixture(t), execution = f.execute(); await f.approve(); await execution;
  const tool = planStepCandidate(BOT, f.plans()).bind!(f.call());
  assert.equal(textOf(await tool.execute("skip", { step: 1, status: "skipped" })), "Step 1 marked skipped.");
  assert.equal(textOf(await tool.execute("conflict", { step: 1, status: "done" })), "Step 1 was already marked skipped.");
});

for (const final of [false, true]) test(`durable mixed tool round ${final ? "ends coverage before work after a final mark" : "marks a non-final step without a spurious ordinary card"}`, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), markQueued = deferred();
  const proposal: BotPlanProposal = { title: "Send reports", why: "Finish the task", steps: final ? ["Send reports"] : ["Read reports", "Send reports"],
    items: [{ id: "i1", kind: "connector", app: "Mail", action: "send mail", max: 10, tools: [{ modelName: SEND_EMAIL_TOOL, serverId: MAIL_SERVER.id, remoteName: "send_email", title: "Send mail" }] }],
    authorization: { policyRevision: "1", bindingRevision: "binding-1", rules: [], proposalFingerprint: "" } };
  proposal.authorization.proposalFingerprint = botPlanProposalFingerprint(proposal);
  let held = false, arm = false;
  const plans = createBotPlans({ profileDir: f.dir, knownBot: async () => true, revokeAccess() {}, revalidate: async () => {
    if (arm && !held) { held = true; entered.resolve(); await release.promise; }
  } });
  const waiting = plans.request({ botId: BOT, planId: "round-plan", toolCallId: "proposal", proposal, requestIds: ["person"], signal: undefined });
  await plans.current(BOT); await plans.respond(BOT, "round-plan", "approve"); await waiting;
  const step = planStepCandidate(BOT, { markStep: (...args) => { const marked = plans.markStep(...args); markQueued.resolve(); return marked; } });
  const tool = countingTool(SEND_EMAIL_TOOL), state = assemblyState(testAuthority({ mode: "custom", home: f.home, connections: true }));
  const deps = assemblyDeps(state, { plans, candidates: () => [step, { tool, mcp: true }], approve: async () => "deny" });
  const work = fauxToolCall(tool.name, { text: "report" }, { id: "work" }), mark = fauxToolCall("plan_step", { step: 1, status: "done" }, { id: "mark" });
  const faux = createFauxModels([fauxAssistantMessage(final ? [mark, work] : [work, mark], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const registry = createBotRegistry(BOT, deps); await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { registry, models: faux.models }, ctx); registry.attachHarness(harness);
  const conversation = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  try {
    arm = !final;
    const submitted = await conversation.submit({ type: "input", content: "Send reports", requestId: "person" }, ctx);
    if (!final) {
      await entered.promise;
      // A parallel round creates the mark task immediately; a sequential round
      // leaves its slot without a task until the covered call has finished.
      const markStarted = await conversation.commit(async tx => (await tx.doc(LiveDoc, conversation.id))?.tools?.some(slot => slot.name === "plan_step" && slot.taskId !== undefined), ctx);
      if (markStarted) await markQueued.promise;
      release.resolve();
    }
    await submitted.wait(ctx);
    assert.equal(deps.approvals.length, final ? 1 : 0);
    assert.equal(tool.executions.length, final ? 0 : 1);
    const view = await plans.current(BOT);
    assert.equal(view?.status, final ? "finished" : "active");
    assert.equal(view?.steps[0]?.status, "done");
  } finally { release.resolve(); await harness.close(ctx); await plans.endRuns(BOT, "finished"); }
});

test("both plan tools are model-only in the real codemode registry", async t => {
  const f = await fixture(t);
  const app = await memoryHarness(f, [toolStep("codemode", { code: "for (const name of ['propose_plan','plan_step']) { try { text(await tools[name]({step:1,status:'done'})); } catch (error) { text(name + ': ' + error.message); } }" }), fauxAssistantMessage("done")], [{ tool: countingTool("web_search"), replay: "safe" }]);
  try {
    await (await app.conversation.submit({ type: "input", content: "try", requestId: "person" }, ctx)).wait(ctx);
    const result = (await app.conversation.context(ctx)).entries.find(entry => entry.kind === ToolResultEntry.kind);
    assert.match(JSON.stringify(result?.model), /propose_plan:.*(?:not|unknown|function)/iu);
    assert.match(JSON.stringify(result?.model), /plan_step:.*(?:not|unknown|function)/iu);
    assert.equal(await f.plans().current(BOT), null);
    assert.equal(f.counts().validations, 0);
  } finally { await app.harness.close(ctx); }
});

for (const mode of ["read", "write"] as const) test(`real unnamed durable run commits its ${mode} grant, joined steer keeps it, queued run cannot inherit it`, async t => {
  const f = await fixture(t, true);
  const app = await memoryHarness(f, [
    toolStep("propose_plan", input([{ files: f.outside, action: mode }])),
    toolStep("codemode", { code: "text(await tools.read_file({location:'run.access',path:'report.txt'})); try { text(await tools.write_file({location:'run.access',path:'report.txt',content:'updated'})); } catch (error) { text(error.message); }" }),
    toolStep("plan_step", { step: 1, status: "done" }), fauxAssistantMessage("first done"),
    toolStep("read_file", { location: "run.access", path: "report.txt" }),
    toolStep("plan_step", { step: 2, status: "done" }), fauxAssistantMessage("queued done"),
  ], f.files);
  try {
    const first = await app.conversation.submit({ type: "input", content: "Prepare the report" }, ctx);
    await waitFor(async () => !!await f.pending());
    const joined = await app.conversation.submit({ type: "input", content: "Also explain it", requestId: "joined-steer", whenBusy: "steer" }, ctx);
    const queued = await app.conversation.submit({ type: "input", content: "A new task", whenBusy: "followUp" }, ctx);
    await f.approve();
    assert.equal((await first.wait(ctx)).status, "done");
    assert.equal((await joined.wait(ctx)).status, "done");
    assert.equal((await queued.wait(ctx)).status, "done");
    const results = (await app.conversation.context(ctx)).entries.filter(entry => entry.kind === ToolResultEntry.kind).map(entry => JSON.stringify(entry.model));
    assert.equal(results.filter(result => result.includes("source")).length, 1, "the nested read uses its current call after propose_plan has committed");
    assert.equal(results.filter(result => result.includes("Ask with request_access first")).length, 1, "a fresh unnamed run has a new host input identity");
    assert.equal(results.filter(result => result.includes("No approved plan is running in this turn")).length, 1);
    assert.ok(results.some(result => result.includes("Step 1 marked done")));
    assert.equal(await fs.readFile(path.join(f.outside, "report.txt"), "utf8"), mode === "read" ? "source" : "updated");
    if (mode === "read") assert.ok(results.some(result => result.includes("allows reading this folder only")));
    const stored = JSON.parse(await fs.readFile(path.join(f.dir, "bots", BOT, "plans.json"), "utf8"));
    assert.equal(stored.plans[0].requestIds.length, 1, "later steer IDs do not rewrite the original approval identity");
    assert.match(stored.plans[0].requestIds[0], /^input:[0-9a-f-]{36}$/u);
    assert.equal(app.deps.approvals.length, 0);
  } finally { await app.harness.close(ctx); }
});

for (const provenance of ["absent", "wrong_sender", "valid"] as const) test(`real runtime ${provenance} Bot metadata governs plan ingress`, async t => {
  const f = await fixture(t, true), a = await courierPort(t, f, Date.now() + 60_000);
  const requestId = botMessageRequestId("jester", 1, a.deliveryId);
  const app = await memoryHarness(f, [toolStep("propose_plan", input()), fauxAssistantMessage("done")]);
  try {
    const submitted = await app.conversation.submit({ type: "input", content: "Bot request", requestId,
      ...(provenance === "absent" ? {} : { entry: { kind: "aiden.bot-message-input", data: { kind: "request", botId: provenance === "wrong_sender" ? "impostor" : "jester", botName: "Jester", deliveryId: a.deliveryId, text: "Help", deadline: Date.now() + 60_000 } } }),
    }, ctx);
    if (provenance === "valid") await f.approve();
    assert.equal((await submitted.wait(ctx)).status, provenance === "valid" ? "done" : "unanswered");
    const results = (await app.conversation.context(ctx)).entries.filter(entry => entry.kind === ToolResultEntry.kind);
    if (provenance === "valid") {
      assert.match(JSON.stringify(results.map(entry => entry.model)), /The person approved/u);
      assert.equal((await a.ledger.get(a.deliveryId))?.waiting.length, 1);
    } else {
      assert.equal(f.counts().requests, 0);
      assert.equal(f.counts().validations, 0);
      assert.equal(app.faux.calls(), 0, "untrusted Bot metadata cannot reach generation");
      assert.equal(await f.plans().current(BOT), null);
    }
  } finally { await app.harness.close(ctx); }
});

for (const checkpoint of ["after approval", "after folder grant"] as const) test(`real durable restart ${checkpoint} before result commit replays approval without another card`, async t => {
  const f = await fixture(t, true), held = deferred();
  let hold = true;
  let activeSignal: AbortSignal | undefined;
  const holdUntilAbort = async () => {
    held.resolve();
    await new Promise<void>((_resolve, reject) => {
      if (activeSignal?.aborted) reject(activeSignal.reason);
      else activeSignal?.addEventListener("abort", () => reject(activeSignal?.reason), { once: true });
    });
  };
  const request = f.deps.plans.request;
  f.deps.plans.request = async input => {
    activeSignal = input.signal;
    const answer = await request(input);
    if (hold && checkpoint === "after approval" && answer.status === "approved") await holdUntilAbort();
    return answer;
  };
  const current = f.deps.plans.current;
  f.deps.plans.current = async (...args) => {
    const view = await current(...args);
    if (hold && checkpoint === "after folder grant" && view?.status === "active") await holdUntilAbort();
    return view;
  };
  const open = async (responses: Parameters<typeof createFauxModels>[0]) => {
    let registry!: BotRegistry;
    const faux = createFauxModels(responses);
    const host = await createBotHarnessHost({ profileDir: f.dir, models: faux.models, buildRegistry: id => registry = createBotRegistry(id, { ...recordingDeps({ tools: [entryOf(f.candidate())] }), turnAllows: botIngressAllowsTool }) });
    assert.ok(!("unavailable" in host));
    const opened = await (host as BotHarnessHost).open(BOT);
    await registry.refresh();
    return { ...opened, host: host as BotHarnessHost };
  };
  const before = await open([toolStep("propose_plan", checkpoint === "after folder grant" ? input([{ files: f.outside, action: "read" }]) : input())]);
  await before.conversation.configure({ model: FAUX_MODEL_REF }, ctx);
  const submission = await before.conversation.submit({ type: "input", content: "go" }, ctx);
  await f.approve(); await held.promise;
  assert.equal(f.counts().grants, checkpoint === "after folder grant" ? 1 : 0);
  assert.equal((await before.conversation.context(ctx)).entries.filter(entry => entry.kind === ToolResultEntry.kind).length, 0);
  await before.host.shutdown();
  f.restart(); hold = false;
  const after = await open([fauxAssistantMessage("resumed")]);
  try {
    after.harness.resume();
    await waitFor(async () => (await after.conversation.context(ctx)).entries.some(entry => entry.kind === ToolResultEntry.kind));
    const resumed = await after.harness.submission(submission.id, ctx);
    assert.equal((await resumed!.wait(ctx)).status, "done");
    const results = (await after.conversation.context(ctx)).entries.filter(entry => entry.kind === ToolResultEntry.kind);
    assert.equal(results.length, 1);
    assert.match(JSON.stringify(results[0]!.model), /The person approved/u);
    assert.notEqual((await f.plans().current(BOT))?.status, "pending");
    assert.equal(f.counts().validations, 1, "recovery never validates a replacement proposal under the old plan ID");
    assert.equal(f.counts().requests, 2);
    assert.equal(f.counts().grants, checkpoint === "after folder grant" ? 1 : 0, "recovery never repeats a fresh grant");
    if (checkpoint === "after folder grant") {
      assert.match(JSON.stringify(results[0]!.model), /request_access/u);
      const stored = JSON.parse(await fs.readFile(path.join(f.dir, "bots", BOT, "plans.json"), "utf8"));
      assert.equal(f.runAccess.location(BOT, stored.plans[0].requestIds, "p1"), undefined);
    }
  } finally { await after.host.shutdown(); }
});
