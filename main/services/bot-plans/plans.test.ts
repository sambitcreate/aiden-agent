import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { BOT_PLAN_MAX_MS, type BotPlanItem } from "../../../renderer/shared/bot-plans.js";
import { botSessionDirectory } from "../bot-routine-notes.js";
import { createBotRunAccess } from "../bot-runtime/bot-run-access.js";
import { newBotId } from "../bot-application-service.js";
import { botPlanProposalFingerprint, type BotPlanProposal } from "./validate.js";
import { createBotPlans, type BotPlans, type BotPlanRequest } from "./plans.js";
import type { BotPlanCoverCheck } from "./coverage.js";

const connector: BotPlanItem = { id: "i1", kind: "connector", app: "Calendar", action: "create events", max: 2, tools: [{ modelName: "cal__create_event", serverId: "cal", remoteName: "create_event", title: "Create event" }] };
const rule = (id = "default.purchase", fingerprint = "rule-fp"): BotPlanItem => ({ id: "i2", kind: "rule", ruleId: id, ruleFingerprint: fingerprint, label: "Purchase", max: 2 });
function proposal(items: BotPlanItem[] = [connector]): BotPlanProposal {
  const p: BotPlanProposal = { title: "Plan", why: "Do a job", steps: ["First", "Second"], items: structuredClone(items), authorization: { policyRevision: "policy-1", bindingRevision: "binding-1", proposalFingerprint: "", rules: items.flatMap((i) => i.kind === "rule" ? [{ id: i.ruleId, fingerprint: i.ruleFingerprint }] : []) } };
  p.authorization.proposalFingerprint = botPlanProposalFingerprint(p);
  return p;
}
const check = (executionId: string, override: Partial<BotPlanCoverCheck> = {}): BotPlanCoverCheck => ({ executionId, operationFingerprint: `op-${executionId}`, toolName: "cal__create_event", requestIds: ["req-1"], baseline: true, rules: [], action: { surface: "mcp", modelName: "cal__create_event", serverId: "cal", remoteName: "create_event", summary: "create event", destructive: "additive" }, ...override });
const request = (planId = "p1", p = proposal(), signal?: AbortSignal): BotPlanRequest => ({ botId: "b", planId, toolCallId: `call-${planId}`, proposal: p, requestIds: ["req-1"], signal });
function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const profileDir = await mkdtemp(path.join(tmpdir(), "bot-plans-"));
  let time = 1000, known = true;
  const revoked: string[] = [], validated: string[] = [];
  let validator: (botId: string, p: BotPlanProposal) => Promise<void> = async (id, p) => { validated.push(`${id}:${p.authorization.proposalFingerprint}`); };
  const options = { profileDir, knownBot: async () => known, now: () => time, revalidate: (id: string, p: BotPlanProposal) => validator(id, p), revokeAccess: (_: string, id: string) => { revoked.push(id); } };
  const plans = createBotPlans(options);
  t.after(async () => { await plans.forgetBot("b"); await rm(profileDir, { recursive: true, force: true }); });
  return { plans, profileDir, options, revoked, validated, file: path.join(botSessionDirectory(profileDir, "b"), "plans.json"), setTime: (n: number) => { time = n; }, setKnown: (v: boolean) => { known = v; }, setValidator: (v: typeof validator) => { validator = v; } };
}
async function waiting(plans: BotPlans, r = request()) {
  const result = plans.request(r);
  assert.equal((await plans.current("b"))?.status, "pending");
  return { result };
}
async function approve(plans: BotPlans, r = request()) {
  const wait = await waiting(plans, r);
  assert.equal(await plans.respond("b", r.planId, "approve"), "done");
  return wait.result;
}

test("approval stores a private 0600 version-one record and changes the live view once", async (t) => {
  const f = await fixture(t), changes: string[] = [];
  const off = f.plans.onChange((id) => changes.push(id));
  const w = await waiting(f.plans);
  assert.equal(changes.length, 1);
  assert.equal(await f.plans.respond("b", "p1", "approve"), "done");
  assert.deepEqual(await w.result, { status: "approved", fresh: true, expiresAt: 1000 + BOT_PLAN_MAX_MS });
  assert.equal((await f.plans.current("b"))?.status, "active");
  assert.equal(changes.length, 2);
  const disk = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(disk.version, 1); assert.equal(disk.plans[0].requestIds[0], "req-1");
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.equal(f.validated[0]?.startsWith("b:"), true);
  off();
});

test("Not now resolves declined and creates no store", async (t) => {
  const f = await fixture(t), w = await waiting(f.plans);
  assert.equal(await f.plans.respond("b", "p1", "not_now"), "done");
  assert.deepEqual(await w.result, { status: "declined" });
  assert.equal(await f.plans.current("b"), null);
  await assert.rejects(access(f.file));
});

test("only the original live waiter is fresh; saved approval survives restart without entitlement", async (t) => {
  const f = await fixture(t), w = await waiting(f.plans);
  const replay = f.plans.request(request());
  await f.plans.current("b");
  await f.plans.respond("b", "p1", "approve");
  assert.equal((await w.result).status, "approved");
  assert.deepEqual(await replay, { status: "approved", fresh: false, expiresAt: 1000 + BOT_PLAN_MAX_MS });
  const restart = createBotPlans(f.options);
  assert.deepEqual(await restart.request(request()), { status: "approved", fresh: false, expiresAt: 1000 + BOT_PLAN_MAX_MS });
  let grants = 0;
  assert.equal(await restart.grantFreshAccess("b", "p1", async () => { grants++; }), false);
  assert.equal(grants, 0); assert.ok(await restart.cover("b", check("task-1")));
  await restart.endRuns("b", "finished");
});

test("replay binds tool call, run inputs and full immutable proposal identity", async (t) => {
  const f = await fixture(t), p = proposal();
  await approve(f.plans, request("p1", p));
  const changed = proposal(); changed.title = "Changed"; changed.authorization.proposalFingerprint = botPlanProposalFingerprint(changed);
  for (const r of [request("p1", changed), { ...request(), toolCallId: "other" }, { ...request(), requestIds: ["other-run"] }]) {
    await assert.rejects(f.plans.request(r), /identity|changed|match/iu);
  }
  p.title = "Mutated after request";
  assert.equal((await f.plans.current("b"))?.title, "Plan");
});

test("caps reserve atomically per durable task; changed operations cannot replay", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  assert.ok(await f.plans.cover("b", check("task-1")));
  assert.ok(await f.plans.cover("b", check("task-1")));
  assert.equal(await f.plans.cover("b", check("task-1", { operationFingerprint: "changed" })), undefined);
  const results = await Promise.all([f.plans.cover("b", check("task-2")), f.plans.cover("b", check("task-3"))]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await f.plans.current("b"))?.items[0]?.used, 2);
  assert.equal(await f.plans.cover("b", check("task-4")), undefined);
});

test("all named Ask first caps and baseline surface caps are conjunctive and atomic", async (t) => {
  const f = await fixture(t);
  const r1 = { id: "default.purchase", fingerprint: "rule-fp" }, r2 = { id: "custom.two", fingerprint: "second-fp" };
  await approve(f.plans, request("p1", proposal([connector, rule()])));
  assert.equal(await f.plans.cover("b", check("x", { rules: [r1, r2] })), undefined);
  assert.equal((await f.plans.current("b"))?.items[0]?.used, 0);
  assert.equal(await f.plans.cover("b", check("x", { rules: [{ ...r1, fingerprint: "edited" }] })), undefined);
  assert.ok(await f.plans.cover("b", check("x", { rules: [r1] })));
  const noSurface = { ...check("y"), action: { ...check("y").action!, serverId: "another" } } as BotPlanCoverCheck;
  assert.equal(await f.plans.cover("b", noSurface), undefined);
  assert.ok(await f.plans.cover("b", { ...noSurface, baseline: false, rules: [r1] }));
  assert.equal(await f.plans.cover("b", check("z", { rules: [r1] })), undefined);
  assert.equal((await f.plans.current("b"))?.items[0]?.used, 1, "a depleted rule must not partially charge the surface");
});

test("two matching asks need two rule items; a rule alone cannot cover baseline", async (t) => {
  const f = await fixture(t), refs = [{ id: "default.purchase", fingerprint: "rule-fp" }, { id: "custom.two", fingerprint: "second-fp" }];
  const second = { ...rule("custom.two", "second-fp"), id: "i3" };
  await approve(f.plans, request("p1", proposal([connector, rule(), second])));
  assert.ok(await f.plans.cover("b", check("all", { rules: refs })));
  await approve(f.plans, request("p2", proposal([{ ...rule(), id: "i1" }])));
  assert.equal(await f.plans.cover("b", check("baseline", { rules: [refs[0]!] })), undefined);
  assert.ok(await f.plans.cover("b", check("rule-only", { baseline: false, rules: [refs[0]!] })));
  assert.equal(await f.plans.cover("b", check("ungated", { baseline: false })), undefined);
});

test("joined steer stays covered, other runs and Computer Use do not", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  assert.equal(await f.plans.cover("b", check("later", { requestIds: ["req-2"] })), undefined);
  assert.ok(await f.plans.cover("b", check("steer", { requestIds: ["req-1", "req-3"] })));
  assert.equal(await f.plans.cover("b", check("computer", { toolName: "computer_use" })), undefined);
});

test("site coverage uses real host boundaries and only HTTP browser actions", async (t) => {
  const f = await fixture(t); await approve(f.plans, request("p1", proposal([{ id: "i1", kind: "site", host: "example.com", max: 4 }])));
  for (const [url, allowed] of [["https://example.com", true], ["https://docs.example.com/path", true], ["https://evil-example.com", false], ["https://example.com.evil.test", false], ["file://example.com/path", false]]) {
    const result = await f.plans.cover("b", check(url as string, { toolName: "browser_click", action: { surface: "browser", tool: "browser_click", url: url as string } }));
    assert.equal(!!result, allowed);
  }
});

test("exact expiry ends authority, revokes before returning and never renews on replay", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  f.setTime(1000 + BOT_PLAN_MAX_MS);
  assert.equal(await f.plans.cover("b", check("expired")), undefined);
  assert.deepEqual(f.revoked, ["p1"]);
  assert.equal((await f.plans.current("b"))?.status, "expired");
  assert.deepEqual(await f.plans.request(request()), { status: "ended" });
  await f.plans.current("b"); assert.equal(f.revoked.length, 1);
});

test("Stop, idle, all steps done and replacement revoke only the owned plan", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  assert.equal(await f.plans.respond("b", "p1", "stop"), "done");
  assert.equal((await f.plans.current("b"))?.status, "stopped");
  await approve(f.plans, request("p2")); await f.plans.endRuns("b", "finished");
  await approve(f.plans, request("p3"));
  assert.equal(await f.plans.markStep("b", ["req-1"], 3, "done"), "no_step");
  assert.equal(await f.plans.markStep("b", ["req-1"], 1, "done"), "marked");
  assert.equal(await f.plans.markStep("b", ["req-1"], 2, "skipped"), "finished");
  assert.equal(await f.plans.markStep("b", ["other"], 1, "done"), "no_plan");
  await approve(f.plans, request("p4")); await approve(f.plans, request("p5"));
  assert.deepEqual(f.revoked, ["p1", "p2", "p3", "p4"]);
});

test("fresh folder entitlement is one-use and serialized against Stop", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  const entered = deferred(), release = deferred(); let grants = 0;
  const grant = f.plans.grantFreshAccess("b", "p1", async () => { entered.resolve(); await release.promise; grants++; });
  await entered.promise;
  const stopped = f.plans.respond("b", "p1", "stop");
  release.resolve(); assert.equal(await grant, true); await stopped;
  assert.equal(await f.plans.grantFreshAccess("b", "p1", async () => { grants++; }), false);
  assert.equal(grants, 1); assert.deepEqual(f.revoked, ["p1"]);
  await approve(f.plans, request("p2")); await f.plans.respond("b", "p2", "stop");
  assert.equal(await f.plans.grantFreshAccess("b", "p2", async () => { grants++; }), false);
});

test("fresh grant callback failure consumes entitlement and revokes its possible partial grant", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  await assert.rejects(f.plans.grantFreshAccess("b", "p1", async () => { throw new Error("grant failed"); }), /grant failed/u);
  assert.equal(await f.plans.grantFreshAccess("b", "p1", async () => {}), false);
  assert.ok(f.revoked.includes("p1"));
});

test("plan termination removes a real B grant without revoking a different owner", async (t) => {
  const f = await fixture(t), runAccess = createBotRunAccess({ now: () => 1000 });
  const plans = createBotPlans({ ...f.options, revokeAccess: (id, planId) => runAccess.revokeOwner(id, { kind: "plan", id: planId }) });
  await approve(plans);
  await plans.grantFreshAccess("b", "p1", async () => runAccess.grant("b", { requestIds: ["req-1"], target: "folder", key: "/outside", root: "/outside", label: "Outside", policyRevision: "p", access: "read", owner: { kind: "plan", id: "p1" }, grantedAt: 1000, expiresAt: 1000 + BOT_PLAN_MAX_MS, identity: { device: "1", inode: "2" } }));
  assert.equal(runAccess.location("b", ["req-1"], "p")?.access, "read");
  runAccess.grant("b", { requestIds: ["another-run"], target: "folder", key: "/separate", root: "/separate", label: "Separate", policyRevision: "p", access: "write", owner: { kind: "access", id: "other" }, grantedAt: 1000, expiresAt: 1000 + BOT_PLAN_MAX_MS, identity: { device: "1", inode: "3" } });
  await plans.respond("b", "p1", "stop");
  assert.equal(runAccess.location("b", ["req-1"], "p"), undefined);
  assert.equal(runAccess.location("b", ["another-run"], "p")?.root, "/separate");
});

test("Stop before admission prevents callback, admission before Stop allows only started effect to finish", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  const permit = await f.plans.cover("b", check("first")); assert.ok(permit);
  let effects = 0;
  await f.plans.respond("b", "p1", "stop");
  assert.deepEqual(await f.plans.admit(permit, async () => { effects++; }), { admitted: false });
  await approve(f.plans, request("p2"));
  const next = await f.plans.cover("b", check("second")); assert.ok(next);
  const finish = deferred<string>();
  const admitted = await f.plans.admit(next, () => { effects++; return finish.promise; });
  assert.equal(admitted.admitted, true);
  assert.equal(await f.plans.respond("b", "p2", "stop"), "done", "Stop must not await external I/O");
  finish.resolve("completed");
  if (admitted.admitted) assert.equal(await admitted.started, "completed");
  assert.equal(effects, 1);
});

test("admission is durable, one-use, and cannot be forged or repeated after restart", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  const permit = await f.plans.cover("b", check("task")); assert.ok(permit);
  let calls = 0;
  assert.deepEqual(await f.plans.admit({ ...permit }, async () => { calls++; }), { admitted: false });
  const result = await f.plans.admit(permit, async () => {
    calls++;
    const file = JSON.parse(await readFile(f.file, "utf8"));
    assert.equal(file.plans[0].counted.task.admittedAt, 1000);
    return "done";
  });
  assert.equal(result.admitted, true);
  const replay = await f.plans.admit(permit, async () => { calls++; return "duplicate"; });
  if (result.admitted && replay.admitted) { assert.equal(replay.started, result.started); assert.equal(await replay.started, "done"); }
  const restarted = createBotPlans(f.options), recovered = await restarted.cover("b", check("task")); assert.ok(recovered);
  assert.deepEqual(await restarted.admit(recovered, async () => { calls++; }), { admitted: false });
  assert.equal(calls, 1);
  await restarted.endRuns("b", "finished");
});

test("an execution reservation never transfers to a replacement plan", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  assert.ok(await f.plans.cover("b", check("task")));
  await approve(f.plans, request("p2"));
  assert.equal(await f.plans.cover("b", check("task")), undefined);
});

test("approval revalidates captured authority immediately before publish and refuses stale answers", async (t) => {
  const f = await fixture(t), w = await waiting(f.plans);
  f.setValidator(async (id, p) => { assert.equal(id, "b"); assert.equal(p.authorization.bindingRevision, "binding-1"); throw new Error("binding changed"); });
  await assert.rejects(f.plans.respond("b", "p1", "approve"), /binding changed/u);
  await assert.rejects(w.result, /binding changed/u);
  assert.equal(await f.plans.current("b"), null);
  await assert.rejects(access(f.file));
});

test("abort and deletion during awaited approval validation fence publication", async (t) => {
  const f = await fixture(t), abort = new AbortController(), w = await waiting(f.plans, request("p1", proposal(), abort.signal));
  const entered = deferred(), release = deferred();
  f.setValidator(async () => { entered.resolve(); await release.promise; });
  const answer = f.plans.respond("b", "p1", "approve"); await entered.promise;
  abort.abort(); release.resolve();
  await answer; assert.deepEqual(await w.result, { status: "ended" });
  await assert.rejects(access(f.file));
  const w2 = await waiting(f.plans, request("p2"));
  const entered2 = deferred(), release2 = deferred(); f.setValidator(async () => { entered2.resolve(); await release2.promise; });
  const answer2 = f.plans.respond("b", "p2", "approve"); await entered2.promise;
  const forgetting = f.plans.forgetBot("b"); release2.resolve();
  await answer2; await forgetting; assert.deepEqual(await w2.result, { status: "ended" });
  await assert.rejects(access(f.file));
});

test("unreadable and malformed version-one stores fail closed without overwriting evidence", async (t) => {
  const f = await fixture(t); await mkdir(path.dirname(f.file), { recursive: true });
  for (const text of ["garbage", JSON.stringify({ version: 2, plans: [], receipts: [] }), JSON.stringify({ version: 1, plans: [{ status: "active" }], receipts: [] })]) {
    await writeFile(f.file, text);
    assert.equal(await f.plans.cover("b", check("x")), undefined);
    assert.equal(await f.plans.current("b"), null);
    await assert.rejects(f.plans.request(request()), /store|read|invalid/iu);
    assert.equal(await readFile(f.file, "utf8"), text);
  }
});

test("unknown and deleted Bots get no writes or pending cards", async (t) => {
  const f = await fixture(t); f.setKnown(false);
  assert.deepEqual(await f.plans.request(request()), { status: "ended" });
  await assert.rejects(access(f.file)); f.setKnown(true);
  await approve(f.plans); await f.plans.forgetBot("b");
  await assert.rejects(access(f.file));
  assert.deepEqual(await f.plans.request(request("p2")), { status: "ended" });
  assert.equal(await f.plans.cover("b", check("later")), undefined);
});

test("history compaction keeps at most twenty full records and hash-only ended replay receipts", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 22; i++) { await approve(f.plans, request(`p${i}`)); if (i === 0) assert.ok(await f.plans.cover("b", check("old-task"))); }
  let disk = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(disk.plans.length, 20);
  assert.ok(disk.receipts.some((r: { planId: string }) => r.planId === "p0"));
  f.setTime(1000 + 25 * 60 * 60_000); await f.plans.current("b");
  await f.plans.endRuns("b", "finished");
  disk = JSON.parse(await readFile(f.file, "utf8"));
  assert.ok(disk.plans.length <= 1);
  assert.ok(!JSON.stringify(disk.receipts).includes("Calendar"));
  assert.ok(!JSON.stringify(disk.receipts).includes("Do a job"));
  assert.ok(!JSON.stringify(disk.receipts).includes("create_event"));
  assert.deepEqual(await createBotPlans(f.options).request(request("p0")), { status: "ended" });
  const changed = proposal(); changed.title = "Different"; changed.authorization.proposalFingerprint = botPlanProposalFingerprint(changed);
  await assert.rejects(f.plans.request(request("p0", changed)), /identity|changed|match/iu);
  f.setTime(1000 + 26 * 60 * 60_000); await approve(f.plans, request("p-new"));
  assert.equal(await f.plans.cover("b", check("old-task")), undefined);
});

test("expiry crossing the admission write prevents the actual callback", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  const permit = await f.plans.cover("b", check("crossing")); assert.ok(permit);
  let reads = 0, effects = 0;
  f.options.knownBot = async () => { if (++reads === 3) f.setTime(1000 + BOT_PLAN_MAX_MS); return true; };
  assert.deepEqual(await f.plans.admit(permit, async () => { effects++; }), { admitted: false });
  assert.equal(effects, 0);
  assert.ok(f.revoked.includes("p1"));
});

test("deletion requested while admission publication awaits knownBot wins before invocation", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  const permit = await f.plans.cover("b", check("deleting")); assert.ok(permit);
  const entered = deferred(), release = deferred(); let reads = 0, effects = 0;
  f.options.knownBot = async () => { if (++reads === 3) { entered.resolve(); await release.promise; } return true; };
  const admission = f.plans.admit(permit, async () => { effects++; });
  await entered.promise; const forgetting = f.plans.forgetBot("b"); release.resolve();
  assert.deepEqual(await admission, { admitted: false }); await forgetting;
  assert.equal(effects, 0);
});

test("approval crossing its last asynchronous publication check cannot publish expired authority", async (t) => {
  const f = await fixture(t), w = await waiting(f.plans); let reads = 0;
  f.options.knownBot = async () => { if (++reads === 3) f.setTime(1000 + BOT_PLAN_MAX_MS); return true; };
  assert.equal(await f.plans.respond("b", "p1", "approve"), "not_waiting");
  assert.deepEqual(await w.result, { status: "ended" });
  await assert.rejects(access(f.file));
});

test("retention always keeps the active plan when many approvals share a timestamp", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 22; i++) await approve(f.plans, request(`p${i}`));
  assert.equal((await f.plans.current("b"))?.planId, "p21");
  assert.equal((await f.plans.current("b"))?.status, "active");
  assert.ok(await f.plans.cover("b", check("latest")));
});

test("final admission held after durable write still rejects expiry before synchronous invocation", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  const permit = await f.plans.cover("b", check("held")); assert.ok(permit);
  const entered = deferred(), release = deferred(); let validates = 0, effects = 0;
  f.setValidator(async () => {
    if (++validates !== 2) return;
    const disk = JSON.parse(await readFile(f.file, "utf8"));
    assert.equal(disk.plans[0].counted.held.admittedAt, 1000, "hold only after the real durable write");
    entered.resolve(); await release.promise;
  });
  const admission = f.plans.admit(permit, async () => { effects++; });
  await entered.promise; f.setTime(1000 + BOT_PLAN_MAX_MS); release.resolve();
  assert.deepEqual(await admission, { admitted: false }); assert.equal(effects, 0);
  assert.equal((await f.plans.current("b"))?.status, "expired");
});

test("captured binding drift fails coverage and final admission despite unchanged tool names", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  const permit = await f.plans.cover("b", check("reserved")); assert.ok(permit);
  let calls = 0;
  f.setValidator(async (_id, p) => { assert.equal(p.authorization.bindingRevision, "binding-1"); throw new Error("binding-2 is current"); });
  assert.equal(await f.plans.cover("b", check("new")), undefined);
  assert.deepEqual(await f.plans.admit(permit, async () => { calls++; }), { admitted: false });
  assert.equal(calls, 0);
  assert.equal((await f.plans.current("b"))?.items[0]?.used, 1);
});

test("corrupting an already observed store revokes its grant and creates no fallback authority", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  await f.plans.grantFreshAccess("b", "p1", async () => {});
  await writeFile(f.file, "broken");
  assert.equal(await f.plans.cover("b", check("later")), undefined);
  assert.deepEqual(f.revoked, ["p1"]);
  assert.equal(await f.plans.current("b"), null);
  assert.equal(await readFile(f.file, "utf8"), "broken");
});

test("strict store decoding rejects malformed operation identities, unknown caps and over-reservation", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  const base = JSON.parse(await readFile(f.file, "utf8"));
  const counts: unknown[] = [
    { x: { operationFingerprint: {}, itemIds: ["i1"] } },
    { x: { operationFingerprint: 42, itemIds: ["i1"] } },
    { x: { operationFingerprint: "", itemIds: ["i1"] } },
    { x: { operationFingerprint: "x".repeat(513), itemIds: ["i1"] } },
    { x: { operationFingerprint: "op", itemIds: ["unknown"] } },
    { x: { operationFingerprint: "op", itemIds: ["i1", "i1"] } },
    { x: { operationFingerprint: "op", itemIds: [] } },
    { x: { operationFingerprint: "op", itemIds: ["i1"], admittedAt: 1000 + BOT_PLAN_MAX_MS } },
    Object.fromEntries(["a", "b", "c"].map((id) => [id, { operationFingerprint: `op-${id}`, itemIds: ["i1"] }])),
  ];
  for (const counted of counts) {
    const bad = structuredClone(base); bad.plans[0].counted = counted;
    await writeFile(f.file, JSON.stringify(bad));
    const restarted = createBotPlans(f.options);
    assert.equal(await restarted.cover("b", check("fresh")), undefined);
    assert.equal(await restarted.current("b"), null);
  }
});

test("host execution identities cannot exploit object prototypes or change reserved targets", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  const op = check("__proto__", { operationFingerprint: "host canonical identity" });
  assert.ok(await f.plans.cover("b", op));
  assert.equal(await f.plans.cover("b", { ...op, action: { surface: "mcp", modelName: "cal__create_event", serverId: "changed-target", remoteName: "create_event", summary: "create", destructive: "additive" } }), undefined);
  assert.ok(await f.plans.cover("b", check("constructor")));
  assert.equal((await f.plans.current("b"))?.items[0]?.used, 2);
  assert.equal(await f.plans.cover("b", check("last")), undefined);
  const malformed = check("bad", { operationFingerprint: {} as string });
  assert.equal(await f.plans.cover("b", malformed), undefined);
  assert.equal((await f.plans.current("b"))?.status, "active");
});

test("expiry timer revokes independently of another read or call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t); await approve(f.plans);
  const ended = deferred();
  const off = f.plans.onChange(() => { if (f.revoked.includes("p1")) ended.resolve(); });
  f.setTime(1000 + BOT_PLAN_MAX_MS); t.mock.timers.tick(BOT_PLAN_MAX_MS);
  await ended.promise;
  assert.deepEqual(f.revoked, ["p1"]);
  off();
});

test("losing a previously readable store revokes its owner and cannot reopen its approval", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  await rm(f.file);
  assert.equal(await f.plans.current("b"), null);
  assert.deepEqual(f.revoked, ["p1"]);
  await assert.rejects(f.plans.request(request()), /store|read|invalid/iu);
});

test("Stop requested while admission awaits its final validator wins before actual invocation", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  const permit = await f.plans.cover("b", check("stop-during-admit")); assert.ok(permit);
  const entered = deferred(), release = deferred(); let validates = 0, effects = 0;
  f.setValidator(async () => { if (++validates === 2) { entered.resolve(); await release.promise; } });
  const admission = f.plans.admit(permit, async () => { effects++; });
  await entered.promise; const stop = f.plans.respond("b", "p1", "stop"); release.resolve();
  assert.deepEqual(await admission, { admitted: false }); assert.equal(await stop, "done");
  assert.equal(effects, 0); assert.deepEqual(f.revoked, ["p1"]);
});

test("run termination requested during admission also prevents invocation", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  const permit = await f.plans.cover("b", check("idle-during-admit")); assert.ok(permit);
  const entered = deferred(), release = deferred(); let validates = 0, effects = 0;
  f.setValidator(async () => { if (++validates === 2) { entered.resolve(); await release.promise; } });
  const admission = f.plans.admit(permit, async () => { effects++; });
  await entered.promise; const idle = f.plans.endRuns("b", "finished"); release.resolve();
  assert.deepEqual(await admission, { admitted: false }); await idle;
  assert.equal(effects, 0); assert.equal((await f.plans.current("b"))?.status, "finished");
});

test("queued final-step and replacement approval also fence held admission", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  await f.plans.markStep("b", ["req-1"], 1, "done");
  const permit = await f.plans.cover("b", check("last-step")); assert.ok(permit);
  let entered = deferred(), release = deferred(), validates = 0, effects = 0;
  f.setValidator(async () => { if (++validates === 2) { entered.resolve(); await release.promise; } });
  const admission = f.plans.admit(permit, async () => { effects++; });
  await entered.promise; const marked = f.plans.markStep("b", ["req-1"], 2, "done"); release.resolve();
  assert.deepEqual(await admission, { admitted: false }); assert.equal(await marked, "finished");
  f.setValidator(async () => {}); await approve(f.plans, request("p2"));
  const oldPermit = await f.plans.cover("b", check("replacement")); assert.ok(oldPermit);
  const next = await waiting(f.plans, request("p3"));
  entered = deferred(); release = deferred(); validates = 0;
  f.setValidator(async () => { if (++validates === 2) { entered.resolve(); await release.promise; } });
  const oldAdmission = f.plans.admit(oldPermit, async () => { effects++; });
  await entered.promise; const replacing = f.plans.respond("b", "p3", "approve"); release.resolve();
  assert.deepEqual(await oldAdmission, { admitted: false }); assert.equal(await replacing, "done");
  assert.equal((await next.result).status, "approved"); assert.equal(effects, 0);
});

test("overlapping Stop and failed/irrelevant transitions always release their admission fences", async (t) => {
  const f = await fixture(t); await approve(f.plans);
  const permit = await f.plans.cover("b", check("overlapping")); assert.ok(permit);
  const entered = deferred(), release = deferred(); let validates = 0, effects = 0;
  f.setValidator(async () => { if (++validates === 2) { entered.resolve(); await release.promise; } });
  const admission = f.plans.admit(permit, async () => { effects++; });
  await entered.promise;
  const stop1 = f.plans.respond("b", "p1", "stop"), stop2 = f.plans.respond("b", "p1", "stop"); release.resolve();
  assert.deepEqual(await admission, { admitted: false });
  assert.deepEqual(await Promise.all([stop1, stop2]), ["done", "not_waiting"]);
  await f.plans.respond("b", "missing", "stop");
  assert.equal(await f.plans.markStep("b", ["req-1"], 8, "done"), "no_plan");
  const knownBot = f.options.knownBot;
  f.options.knownBot = async () => { throw new Error("inventory unavailable"); };
  await assert.rejects(f.plans.respond("b", "missing", "stop"), /inventory unavailable/u);
  f.options.knownBot = knownBot;
  const next = await waiting(f.plans, request("p2"));
  f.setValidator(async () => { throw new Error("stale proposal"); });
  await assert.rejects(f.plans.respond("b", "p2", "approve"), /stale proposal/u);
  await assert.rejects(next.result, /stale proposal/u);
  f.setValidator(async () => {}); await approve(f.plans, request("p3"));
  const healthy = await f.plans.cover("b", check("healthy")); assert.ok(healthy);
  const result = await f.plans.admit(healthy, async () => { effects++; });
  assert.equal(result.admitted, true); if (result.admitted) await result.started;
  assert.equal(effects, 1, "no stale counter may fence the next plan");
});

test("a production-minted Bot can approve, replay after restart and reserve its exact cap", async (t) => {
  const profileDir = await mkdtemp(path.join(tmpdir(), "bot-plans-production-id-"));
  const botId = newBotId();
  const options = { profileDir, knownBot: async (id: string) => id === botId, now: () => 1000,
    revalidate: async (id: string) => { assert.equal(id, botId); }, revokeAccess: () => {} };
  const plans = createBotPlans(options);
  const restarted = createBotPlans(options);
  t.after(async () => { await plans.forgetBot(botId); await restarted.forgetBot(botId); await rm(profileDir, { recursive: true, force: true }); });
  const r = { ...request(), botId };
  const result = plans.request(r);
  void result.catch(() => undefined);
  assert.equal((await plans.current(botId))?.status, "pending");
  assert.equal(await plans.respond(botId, r.planId, "approve"), "done");
  assert.deepEqual(await result, { status: "approved", fresh: true, expiresAt: 1000 + BOT_PLAN_MAX_MS });
  assert.deepEqual(await restarted.request(r), { status: "approved", fresh: false, expiresAt: 1000 + BOT_PLAN_MAX_MS });
  assert.ok(await restarted.cover(botId, check("production-first")));
  assert.ok(await restarted.cover(botId, check("production-first")), "same durable identity reuses one reservation");
  assert.ok(await restarted.cover(botId, check("production-second")));
  assert.equal(await restarted.cover(botId, check("production-over-cap")), undefined);
  assert.equal((await restarted.current(botId))?.items[0]?.used, 2);
  const file = JSON.parse(await readFile(path.join(botSessionDirectory(profileDir, botId), "plans.json"), "utf8"));
  assert.equal(file.plans[0].botId, botId);
  for (const invalid of ["../bot", "bot/../other", "bot\\other", "bot:\u0000escape", "bot:\nnext", "bot:\u202ehidden", `bot:${"x".repeat(157)}`]) {
    await assert.rejects(plans.request({ ...r, botId: invalid }), /Invalid plan request/u);
  }
});
