import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import { DataStore, type DataStoreOptions } from "./data-store.js";
import { emptySpendingDocument, type SpendingDocument } from "./spending-core.js";
import { issueSpendingUnknownAcknowledgement, parseDurableSpendingDocument, SpendingDispatchError, type SpendingDispatchInput } from "./spending-dispatch-ledger.js";
import { SpendingService } from "./spending-service.js";

process.env.TZ = "UTC";

const NOW = Date.UTC(2026, 10, 3, 12);
const result = (total: number) => ({ usage: { cost: { total } } });
const dispatch = (dispatchId: string, botId = "ada"): SpendingDispatchInput => ({ dispatchId, owner: { kind: "bot", id: botId, run: `run-${dispatchId}` }, providerId: "fixture-provider", modelId: "fixture-model", counts: true });
const code = (expected: string) => (error: unknown) => error instanceof SpendingDispatchError && error.code === expected;

async function fixture(t: test.TestContext, settings: unknown = { botMonthUsd: 10, routineRunUsd: 1 }) {
  const dir = await mkdtemp(path.join(tmpdir(), "aiden-spending-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "spending.json");
  const open = (options: DataStoreOptions<unknown> = {}, now = () => NOW) => {
    const store = new DataStore<unknown>("spending.json", emptySpendingDocument(), () => dir, { compact: true, fileMode: 0o600, ...options });
    const service = new SpendingService({
      persistence: {
        load: () => store.load(),
        reload: async () => { await store.reload(); return store.load(); },
        save: document => store.save(document),
      },
      settings: async () => settings,
      broadcast() {}, now,
    });
    return service;
  };
  return { file, open, saved: async () => JSON.parse(await readFile(file, "utf8")) as SpendingDocument };
}

test("an intent is durable before dispatch, and recovery records the saved response once before any later request", async t => {
  const f = await fixture(t);
  const input = dispatch("checkpoint-1");
  await f.open().beforeDispatch(input);
  assert.equal((await f.saved()).dispatches?.[input.dispatchId]?.state, "pending");
  const recovered = f.open();
  await assert.rejects(recovered.beforeDispatch(input), code("uncertain"));
  await assert.rejects(recovered.beforeDispatch(dispatch("checkpoint-2")), code("uncertain"));
  await recovered.afterDispatch(input, result(1.2));
  await recovered.afterDispatch(input, result(1.2));
  assert.equal((await recovered.status("bot", "ada"))?.spentUsd, 1.2);
  assert.equal((await f.saved()).runs["run-checkpoint-1"], 1.2);
  assert.deepEqual(await f.open().beforeDispatch(input), { state: "recorded", costUsd: 1.2 });
  await assert.rejects(recovered.beforeDispatch({ ...dispatch("checkpoint-2"), owner: input.owner }), code("limit"));
  await assert.rejects(recovered.afterDispatch(input, result(0.2)), code("conflict"));
  await assert.rejects(recovered.beforeDispatch({ ...input, modelId: "different" }), code("conflict"));
  assert.equal((await f.saved()).dispatches?.[input.dispatchId]?.costUsd, 1.2);
});

test("concurrent dispatches cannot bypass one unresolved Bot budget, while unrelated Bots remain independent", async t => {
  const f = await fixture(t);
  const spending = f.open();
  const outcomes = await Promise.allSettled([spending.beforeDispatch(dispatch("a")), spending.beforeDispatch(dispatch("b"))]);
  assert.equal(outcomes.filter(entry => entry.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(entry => entry.status === "rejected" && code("uncertain")(entry.reason)).length, 1);
  await spending.beforeDispatch(dispatch("c", "other"));
  assert.equal(Object.keys((await f.saved()).dispatches ?? {}).length, 2);
});

test("delegated usage charges recipient and root once, and either run/month budget refuses later requests", async t => {
  const f = await fixture(t, { botMonthUsd: 5, routineRunUsd: 1 });
  const spending = f.open();
  const input: SpendingDispatchInput = {
    ...dispatch("peer-1", "bea"),
    owner: { kind: "bot", id: "bea", run: "recipient-run", budgetScopes: [
      { kind: "bot", id: "ada", run: "root-run" },
      { kind: "bot", id: "ada", run: "root-run" },
      { kind: "bot", id: "bea", run: "recipient-run" },
    ] },
  };
  await spending.beforeDispatch(input);
  await assert.rejects(spending.beforeDispatch(dispatch("root-other", "ada")), code("uncertain"));
  await spending.afterDispatch(input, result(1.1));
  assert.equal((await spending.status("bot", "ada"))?.spentUsd, 1.1);
  assert.equal((await spending.status("bot", "bea"))?.spentUsd, 1.1);
  const saved = await f.saved();
  assert.equal(saved.runs["recipient-run"], 1.1);
  assert.equal(saved.runs["root-run"], 1.1);
  await assert.rejects(spending.beforeDispatch({ ...input, dispatchId: "peer-2", owner: { kind: "bot", id: "cee", budgetScopes: [{ kind: "bot", id: "ada", run: "root-run" }] } }), code("limit"));
  await spending.beforeDispatch(dispatch("independent", "cee"));
});

test("a priced failed response counts, but interrupted unknown usage remains fenced instead of fabricated zero", async t => {
  const f = await fixture(t);
  const spending = f.open();
  const first = dispatch("failed");
  await spending.beforeDispatch(first);
  await spending.afterDispatch(first, result(0.3));
  const interrupted = dispatch("interrupted");
  await spending.beforeDispatch(interrupted);
  await assert.rejects(spending.afterDispatch(interrupted, undefined), code("uncertain"));
  await assert.rejects(f.open().beforeDispatch(dispatch("later")), code("uncertain"));
  assert.equal((await spending.status("bot", "ada"))?.spentUsd, 0.3);
  assert.equal((await f.saved()).dispatches?.interrupted?.costUsd, undefined);
  const free = { ...dispatch("local", "local-bot"), counts: false };
  await spending.beforeDispatch(free);
  await spending.afterDispatch(free, undefined);
  assert.equal((await f.saved()).dispatches?.local?.costUsd, 0);
});

test("a post-publication failure reconciles receipts instead of dispatching or charging twice", async t => {
  const f = await fixture(t);
  let fail = true;
  const spending = f.open({ syncDirectory: async () => { if (fail) { fail = false; throw new Error("synthetic fsync failure"); } } });
  const input = dispatch("rename-committed");
  await assert.rejects(spending.beforeDispatch(input), code("storage"));
  assert.equal((await f.saved()).dispatches?.[input.dispatchId]?.state, "pending");
  await assert.rejects(spending.beforeDispatch(input), code("uncertain"));
  fail = true;
  await assert.rejects(spending.afterDispatch(input, result(0.7)), code("storage"));
  assert.equal((await f.saved()).dispatches?.[input.dispatchId]?.state, "recorded");
  await spending.afterDispatch(input, result(0.7));
  assert.equal((await spending.status("bot", "ada"))?.spentUsd, 0.7);
  assert.deepEqual(await spending.beforeDispatch(input), { state: "recorded", costUsd: 0.7 });
});

test("legacy balances migrate without inventing old dispatch receipts, and older routine balances are not evicted", async t => {
  const f = await fixture(t, { botMonthUsd: 100, routineRunUsd: 1 });
  await writeFile(f.file, JSON.stringify({ version: 1, chats: {}, bots: { ada: { period: "2026-11-01", spentUsd: 2, extraUsd: 0 } }, botLimits: {}, runs: { old: 1.2 } }));
  const spending = f.open();
  await spending.beforeDispatch(dispatch("new"));
  await spending.afterDispatch(dispatch("new"), result(0.3));
  const migrated = await f.saved();
  assert.equal(migrated.version, 2);
  assert.deepEqual(Object.keys(migrated.dispatches ?? {}), ["new"]);
  assert.equal((await spending.status("bot", "ada"))?.spentUsd, 2.3);
  // More than the old500 run history limit: a replay still sees its original cap.
  for (let i = 0; i < 501; i++) await spending.record({ kind: "bot", id: "ada", run: `recent-${i}` }, 0.001);
  const recovered = f.open();
  await assert.rejects(recovered.beforeDispatch({ ...dispatch("old-resume"), owner: { kind: "bot", id: "ada", run: "old" } }), code("limit"));
  assert.equal((await f.saved()).runs.old, 1.2);
});

test("delayed prior-month answers keep their dispatch month and cannot erase this month's spend", async t => {
  let now = Date.UTC(2026, 9, 31, 23);
  const f = await fixture(t, { botMonthUsd: 10 });
  const spending = f.open({}, () => now);
  const input = dispatch("late-october");
  await spending.beforeDispatch(input);
  now = Date.UTC(2026, 10, 1, 1);
  await spending.record({ kind: "bot", id: "ada" }, 2);
  await spending.afterDispatch(input, result(0.7));
  assert.equal((await spending.status("bot", "ada"))?.spentUsd, 2);
  assert.equal((await f.open({}, () => Date.UTC(2026, 9, 31, 23)).status("bot", "ada"))?.spentUsd, 0.7);
});

test("dispatch freezes each recipient/root billing period across timezone, settings and process restarts", async t => {
  const settings = { botMonthUsd: 10, monthStartDay: 1 };
  const f = await fixture(t, settings);
  const input: SpendingDispatchInput = { ...dispatch("timezone-boundary", "bea"), owner: { kind: "bot", id: "bea", run: "recipient", budgetScopes: [{ kind: "bot", id: "ada", run: "root" }] } };
  const originalZone = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    await f.open({}, () => Date.UTC(2026, 10, 1, 0, 30)).beforeDispatch(input);
    assert.deepEqual((await f.saved()).dispatches?.[input.dispatchId]?.billingPeriods, { bea: "2026-11-01", ada: "2026-11-01" });
    process.env.TZ = "America/New_York";
    settings.monthStartDay = 15;
    await f.open({}, () => Date.UTC(2026, 10, 1, 1)).afterDispatch(input, result(0.7));
    const saved = await f.saved();
    assert.deepEqual(Object.values(saved.botPeriods ?? {}).map(row => [row.botId, row.period, row.spentUsd]).sort(), [["ada", "2026-11-01", 0.7], ["bea", "2026-11-01", 0.7]]);
    process.env.TZ = "UTC";
    settings.monthStartDay = 1;
    const recovered = f.open({}, () => Date.UTC(2026, 10, 1, 1));
    assert.equal((await recovered.status("bot", "ada"))?.spentUsd, 0.7);
    assert.equal((await recovered.status("bot", "bea"))?.spentUsd, 0.7);
  } finally { process.env.TZ = originalZone; }
});

test("a legacy pending receipt without its original period cannot invent billing certainty", async t => {
  const f = await fixture(t);
  const input = dispatch("legacy-no-period");
  await f.open().beforeDispatch(input);
  const legacy = await f.saved();
  delete legacy.dispatches![input.dispatchId]!.billingPeriods;
  await writeFile(f.file, JSON.stringify(legacy));
  const recovered = f.open();
  await assert.rejects(recovered.afterDispatch(input, result(0.7)), code("uncertain"));
  assert.equal((await recovered.status("bot", "ada"))?.spentUsd, 0);
  assert.equal((await f.saved()).dispatches?.[input.dispatchId]?.state, "pending");
  await recovered.acknowledgeUncertain(issueSpendingUnknownAcknowledgement({ dispatchId: input.dispatchId, owner: input.owner }));
  assert.equal((await f.saved()).dispatches?.[input.dispatchId]?.state, "acknowledged_unknown");
  assert.equal((await f.saved()).dispatches?.[input.dispatchId]?.costUsd, undefined);
});

test("malformed or future saved money fails closed and is not replaced by an empty ledger", async t => {
  const f = await fixture(t);
  const corrupt = { version: 2, chats: { c: { spentUsd: "unknown", extraUsd: 0 } }, bots: {}, botLimits: {}, runs: {}, dispatches: {} };
  await writeFile(f.file, JSON.stringify(corrupt));
  await assert.rejects(f.open().beforeDispatch(dispatch("no-send")), code("storage"));
  assert.deepEqual(await f.saved(), corrupt);
  assert.throws(() => parseDurableSpendingDocument({ ...corrupt, version: 3 }), code("storage"));
});

test("a full journal refuses fresh identities without forgetting a previously consumed identity", async t => {
  const f = await fixture(t);
  const input = { ...dispatch("oldest"), counts: false };
  const journal: SpendingDocument = { ...emptySpendingDocument(), version: 2, dispatches: {} };
  for (let index = 0; index < 20_000; index++) {
    const dispatchId = index === 0 ? "oldest" : `receipt-${index}`;
    journal.dispatches![dispatchId] = { ...input, dispatchId, startedAt: NOW, monthStartDay: 1, state: "recorded", costUsd: 0, finishedAt: NOW };
  }
  await writeFile(f.file, JSON.stringify(journal));
  const spending = f.open();
  await assert.rejects(spending.beforeDispatch(dispatch("never-reused")), code("capacity"));
  assert.deepEqual(await spending.beforeDispatch(input), { state: "recorded", costUsd: 0 });
  assert.equal(Object.keys((await f.saved()).dispatches ?? {}).length, 20_000);
});

test("a blocked or rejected intent publication cannot reach the provider", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const saving = new Promise<void>(resolve => { entered = resolve; });
  let asked = 0;
  const spending = new SpendingService({
    persistence: { load: async () => undefined, save: async () => { entered(); await barrier; throw new Error("disk full"); } },
    settings: async () => ({}), broadcast() {},
  });
  const send = (async () => { await spending.beforeDispatch(dispatch("disk-full")); asked++; })();
  await saving;
  assert.equal(asked, 0);
  release();
  await assert.rejects(send, code("storage"));
  assert.equal(asked, 0);
});

test("SIGKILL at intent, saved-response and charge boundaries never sends an uncertain request again", async t => {
  const f = await fixture(t);
  const serviceUrl = pathToFileURL(path.resolve("main/services/spending-service.ts")).href;
  const dataStoreUrl = pathToFileURL(path.resolve("main/services/data-store.ts")).href;
  const runUntilKilled = async (stage: "intent" | "response" | "charged") => {
    const input = dispatch(`killed-${stage}`, `bot-${stage}`);
    const marker = `${f.file}.${stage}.response`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { SpendingService } from ${JSON.stringify(serviceUrl)};
      import { DataStore } from ${JSON.stringify(dataStoreUrl)};
      import { writeFile } from 'node:fs/promises';
      const store = new DataStore('spending.json', {version:1,chats:{},bots:{},botLimits:{},runs:{}}, () => ${JSON.stringify(path.dirname(f.file))}, {compact:true,fileMode:384});
      const spending = new SpendingService({persistence:{load:()=>store.load(),save:d=>store.save(d)},settings:async()=>({botMonthUsd:10,routineRunUsd:1}),broadcast(){},now:()=>${NOW}});
      const input = ${JSON.stringify(input)};
      await spending.beforeDispatch(input);
      if (${JSON.stringify(stage)} !== 'intent') await writeFile(${JSON.stringify(marker)}, JSON.stringify({usage:{cost:{total:1.2}}}));
      if (${JSON.stringify(stage)} === 'charged') await spending.afterDispatch(input, {usage:{cost:{total:1.2}}});
      process.stdout.write('checkpoint\\n');
      setInterval(()=>{},1000);
    `], { env: { ...process.env, AIDEN_ANALYTICS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Child checkpoint timed out: ${stderr}`)), 10_000);
      child.stdout.on("data", chunk => { if (String(chunk).includes("checkpoint")) { clearTimeout(timer); resolve(); } });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Child exited before checkpoint: ${stderr}`)); });
    });
    child.kill("SIGKILL");
    await exited;
    const recovered = f.open();
    if (stage === "charged") assert.deepEqual(await recovered.beforeDispatch(input), { state: "recorded", costUsd: 1.2 });
    else {
      await assert.rejects(recovered.beforeDispatch(input), code("uncertain"));
      if (stage === "response") {
        await recovered.afterDispatch(input, JSON.parse(await readFile(marker, "utf8")));
        await recovered.afterDispatch(input, JSON.parse(await readFile(marker, "utf8")));
      }
    }
    if (stage !== "intent") assert.equal((await recovered.status("bot", input.owner.id))?.spentUsd, 1.2);
    return input;
  };
  await runUntilKilled("intent");
  await runUntilKilled("response");
  await runUntilKilled("charged");
});

test("only an exact host-issued person acknowledgement permits a new attempt; unknown evidence and known caps survive", async t => {
  const f = await fixture(t, { botMonthUsd: 1 });
  const spending = f.open();
  const input = dispatch("unknown-person-resume");
  await spending.record({ kind: "bot", id: "ada" }, 0.7);
  await spending.beforeDispatch(input);
  await assert.rejects(spending.acknowledgeUncertain({ dispatchId: input.dispatchId }), code("invalid"));
  await assert.rejects(spending.acknowledgeUncertain(issueSpendingUnknownAcknowledgement({ dispatchId: input.dispatchId, owner: { kind: "bot", id: "other" } })), code("conflict"));
  assert.equal((await spending.pendingDispatch(input.owner))?.dispatchId, input.dispatchId);
  await spending.acknowledgeUncertain(issueSpendingUnknownAcknowledgement({ dispatchId: input.dispatchId, owner: input.owner }));
  const recovered = f.open();
  assert.equal(await recovered.pendingDispatch(input.owner), undefined);
  const saved = await f.saved();
  assert.equal(saved.dispatches?.[input.dispatchId]?.state, "acknowledged_unknown");
  assert.equal(saved.dispatches?.[input.dispatchId]?.costUsd, undefined);
  assert.equal((await recovered.status("bot", "ada"))?.spentUsd, 0.7, "acknowledgement never fabricates a price");
  assert.equal((await recovered.status("bot", "ada"))?.extraUsd, 0, "it does not grant more funds");
  await assert.rejects(recovered.beforeDispatch(input), code("uncertain"));
  const next = dispatch("new-person-authorized-attempt");
  await recovered.beforeDispatch(next);
  await recovered.afterDispatch(next, result(0.4));
  await assert.rejects(recovered.beforeDispatch(dispatch("cap-still-applies")), code("limit"));
  // A late actual provider report replaces uncertainty with its one known charge.
  await recovered.afterDispatch(input, result(0.2));
  await recovered.afterDispatch(input, result(0.2));
  assert.equal(Math.round((await recovered.status("bot", "ada"))!.spentUsd * 100), 130);
  assert.equal((await f.saved()).dispatches?.[input.dispatchId]?.acknowledgedAt, NOW);
});
