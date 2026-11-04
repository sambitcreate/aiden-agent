import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBotOpenWorkStore, BOT_OPEN_WORK_STORE_LIMITS } from "./store.js";
import type { BotOpenWorkResult } from "../../../renderer/shared/bot-open-work.js";
import { botSessionDirectory } from "../bot-routine-notes.js";
function success(value: BotOpenWorkResult) { if (!value.ok) throw new Error(`${value.code}: ${value.error}`); return value; }
async function fixture(t: { after(fn: () => unknown): void }, options: { now?: () => number; beforePublish?: () => Promise<void> } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-work-")); t.after(() => rm(root, { recursive: true, force: true }));
  let exists = true;
  const ports = { profileDir: () => root, botExists: async () => exists, ...options };
  const store = createBotOpenWorkStore(ports);
  const add = async (title = "Write the proposal", botId = "bot:one") => success(await store.mutate(botId, { action: "add", mutationId: randomUUID(), expectedRevision: (await store.snapshot(botId)).revision, title }));
  return { root, store, ports, add, remove: () => { exists = false; } };
}
test("saved items and durable Undo survive reopen; a later edit fences the earlier Undo", async (t) => {
  const f = await fixture(t); const created = await f.add(); const item = created.snapshot.items[0]!;
  const reopened = createBotOpenWorkStore(f.ports);
  assert.equal((await reopened.snapshot("bot:one")).undo[0]!.mutationId, created.mutationId);
  const edited = success(await reopened.mutate("bot:one", { action: "edit", mutationId: randomUUID(), id: item.id, expectedRevision: item.revision, patch: { state: "waiting", waitingReason: "Owner feedback" } }));
  const conflict = await reopened.mutate("bot:one", { action: "undo", mutationId: randomUUID(), undoOf: created.mutationId, expectedRevision: item.revision });
  assert.equal(conflict.ok ? "unexpected" : conflict.code, "undo_conflict");
  const undone = success(await reopened.mutate("bot:one", { action: "undo", mutationId: randomUUID(), undoOf: edited.mutationId, expectedRevision: edited.snapshot.items[0]!.revision }));
  assert.equal(undone.snapshot.items[0]!.state, "open");
  assert.equal(undone.snapshot.items[0]!.waitingReason, undefined);
  assert.notEqual(undone.snapshot.items[0]!.revision, item.revision);
  assert.equal((await stat(path.join(botSessionDirectory(f.root, "bot:one"), "open-work.json"))).mode & 0o777, 0o600);
});
test("Undo Add dismisses without losing its identity or stopping its execution", async (t) => {
  const f = await fixture(t); const created = await f.add();
  const undone = success(await f.store.mutate("bot:one", { action: "undo", mutationId: randomUUID(), undoOf: created.mutationId, expectedRevision: created.snapshot.items[0]!.revision }));
  assert.equal(undone.snapshot.items[0]!.id, created.itemId); assert.equal(undone.snapshot.items[0]!.state, "dismissed"); assert.equal(undone.snapshot.items[0]!.lastStop, undefined);
});
test("replayed identities do not repeat writes and a different payload cannot reuse one", async (t) => {
  const f = await fixture(t); const input = { action: "add" as const, mutationId: randomUUID(), expectedRevision: (await f.store.snapshot("bot:one")).revision, title: "Explicit task" };
  const one = success(await f.store.mutate("bot:one", input)); const two = success(await f.store.mutate("bot:one", input));
  assert.equal(two.replayed, true); assert.equal(two.itemId, one.itemId); assert.equal(two.snapshot.items.length, 1);
  const conflict = await f.store.mutate("bot:one", { ...input, title: "Another task" }); assert.equal(conflict.ok ? "unexpected" : conflict.code, "mutation_conflict");
  const source = { requestId: "person-1", source: { kind: "person" as const, submissionId: "1", entryId: "2" } };
  const addFromCall = async (title: string) => success(await f.store.mutate("bot:one", { action: "add", mutationId: randomUUID(), expectedRevision: (await f.store.snapshot("bot:one")).revision, title }, "bot", source));
  const a = await addFromCall("  Same responsibility  "), b = await addFromCall("same responsibility"); assert.equal(a.itemId, b.itemId); assert.equal(b.snapshot.items.length, 2);
});
test("two editors cannot overwrite each other and another Bot cannot edit this record", async (t) => {
  const f = await fixture(t); const created = await f.add(); const item = created.snapshot.items[0]!;
  const edit = { action: "edit" as const, id: item.id, expectedRevision: item.revision, patch: { note: "first editor" } };
  const results = await Promise.all([f.store.mutate("bot:one", { ...edit, mutationId: randomUUID() }), f.store.mutate("bot:one", { ...edit, mutationId: randomUUID(), patch: { note: "second editor" } })]);
  assert.equal(results.filter((r) => r.ok).length, 1); assert.equal(results.find((r) => !r.ok)?.code, "stale");
  const cross = await f.store.mutate("bot:other", { ...edit, mutationId: randomUUID() }); assert.equal(cross.ok ? "unexpected" : cross.code, "not_found");
});
test("active capacity refuses new work rather than dropping unfinished records", async (t) => {
  const f = await fixture(t); for (let n = 0; n < BOT_OPEN_WORK_STORE_LIMITS.active; n++) await f.add(`Task ${n}`);
  const full = await f.store.mutate("bot:one", { action: "add", mutationId: randomUUID(), expectedRevision: (await f.store.snapshot("bot:one")).revision, title: "One too many" });
  assert.equal(full.ok ? "unexpected" : full.code, "active_full"); assert.equal((await f.store.snapshot("bot:one")).items.length, 64);
});
test("a deletion at publication fences the writer and later calls cannot resurrect the directory", async (t) => {
  let release!: () => void, entered!: () => void; const barrier = new Promise<void>((r) => { release = r; }), reached = new Promise<void>((r) => { entered = r; });
  const f = await fixture(t, { beforePublish: async () => { entered(); await barrier; } });
  const creating = f.add(); await reached; f.remove(); const deleting = f.store.forgetBot("bot:one"); release();
  await assert.rejects(creating, /no longer available/u); await deleting;
  await assert.rejects(f.store.snapshot("bot:one"), /no longer available/u);
  await assert.rejects(stat(path.join(botSessionDirectory(f.root, "bot:one"), "open-work.json")), /ENOENT/u);
});
test("malformed storage is not replaced with an empty list", async (t) => {
  const f = await fixture(t); await f.add(); const file = path.join(botSessionDirectory(f.root, "bot:one"), "open-work.json"); await writeFile(file, "{broken");
  await assert.rejects(f.store.snapshot("bot:one")); await assert.rejects(f.add()); assert.equal(await readFile(file, "utf8"), "{broken");
});
for (const stage of ["before", "after"]) test(`SIGKILL ${stage} publication and retry admits one logical item`, async (t) => {
  const f = await fixture(t); const child = fork(fileURLToPath(new URL("./test-support/store-child.ts", import.meta.url)), [f.root, stage], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("exit", (code) => reject(new Error(`child exited ${code}`))); });
  child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve));
  const snapshot = await f.store.snapshot("bot:work");
  const initial = `ow_${(await import("node:crypto")).createHash("sha256").update(JSON.stringify({ botId: "bot:work", empty: true })).digest("hex").slice(0, 32)}`;
  const retry = success(await f.store.mutate("bot:work", { action: "add", mutationId: "10000000-0000-4000-8000-000000000001", expectedRevision: initial, title: "Keep this task across a crash" }));
  assert.equal(snapshot.items.length, stage === "before" ? 0 : 1); assert.equal(retry.snapshot.items.length, 1); assert.equal(retry.replayed, stage === "after");
});

test("terminal history protects current Undo and refuses overflow instead of losing a reversible item", async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 128; n++) {
    const created = await f.add(`Finished task ${n}`); const item = created.snapshot.items.find((candidate) => candidate.id === created.itemId)!;
    success(await f.store.mutate("bot:one", { action: "edit", mutationId: randomUUID(), id: item.id, expectedRevision: item.revision, patch: { state: "done" } }));
  }
  const active = await f.add("Keep this unfinished"); const item = active.snapshot.items.find((candidate) => candidate.id === active.itemId)!;
  const blocked = await f.store.mutate("bot:one", { action: "edit", mutationId: randomUUID(), id: item.id, expectedRevision: item.revision, patch: { state: "done" } });
  assert.equal(blocked.ok ? "unexpected" : blocked.code, "history_full");
  const refusedStop = await f.store.mutate("bot:one", { action: "stop_and_dismiss", mutationId: randomUUID(), id: item.id, expectedRevision: item.revision });
  assert.equal(refusedStop.ok ? "unexpected" : refusedStop.code, "history_full", "stop-and-dismiss reserves history before any external Stop");
  const current = await f.store.snapshot("bot:one"); assert.equal(current.items.find((candidate) => candidate.id === item.id)!.lastStop, undefined); assert.equal(current.items.filter((candidate) => candidate.state === "done").length, 128); assert.equal(current.items.find((candidate) => candidate.id === item.id)!.state, "open");
});
test("the 24-hour retry window is bounded and does not evict a live mutation identity", async (t) => {
  let at = 1_000; const f = await fixture(t, { now: () => at }); const created = await f.add(); let current = created.snapshot.items[0]!;
  for (let n = 1; n < 512; n++) {
    const edited = success(await f.store.mutate("bot:one", { action: "edit", mutationId: randomUUID(), id: current.id, expectedRevision: current.revision, patch: { note: `Revision ${n}` } })); current = edited.snapshot.items[0]!;
  }
  const full = await f.store.mutate("bot:one", { action: "edit", mutationId: randomUUID(), id: current.id, expectedRevision: current.revision, patch: { note: "overflow" } });
  assert.equal(full.ok ? "unexpected" : full.code, "receipts_full"); assert.equal((await f.store.snapshot("bot:one")).items[0]!.note, "Revision 511");
  at += 86_400_001;
  const expired = await f.store.mutate("bot:one", { action: "undo", mutationId: randomUUID(), undoOf: created.mutationId, expectedRevision: current.revision });
  assert.equal(expired.ok ? "unexpected" : expired.code, "undo_expired");
  const saved = success(await f.store.mutate("bot:one", { action: "edit", mutationId: randomUUID(), id: current.id, expectedRevision: current.revision, patch: { note: "after expiry" } })); assert.equal(saved.snapshot.items[0]!.note, "after expiry");
});
test("peer slots reserve active capacity before admission, survive reopen and never overwrite a person's later edit",async t=>{
 const f=await fixture(t),input={exchangeId:"peer_exchange",role:"incoming"as const,peerBotId:"bot:two",title:"Delegated responsibility",expiresAt:Date.now()+86400000};await f.store.reservePeer("bot:one",input);assert.equal((await f.store.snapshot("bot:one")).items.length,0);const store=createBotOpenWorkStore(f.ports);await store.reservePeer("bot:one",input);assert.equal((await store.peerReservations("bot:one")).length,1);for(let n=0;n<63;n++)await f.add(`Other ${n}`);await assert.rejects(store.reservePeer("bot:one",{...input,exchangeId:"peer_overflow"}),/64 active/u);assert.equal((await store.peerReservations("bot:one")).length,1);
 await store.activatePeer("bot:one",input.exchangeId,{submissionId:"17",entryId:"18"});let item=(await store.snapshot("bot:one")).items.find(item=>item.source.kind==="peer")!;assert.equal(item.source.kind,"peer");assert.equal(item.state,"waiting");await store.completePeer("bot:one",input.exchangeId,"failed",Date.now());const revision=(await store.snapshot("bot:one")).revision;await store.completePeer("bot:one",input.exchangeId,"failed",Date.now());assert.equal((await store.snapshot("bot:one")).revision,revision);item=(await store.snapshot("bot:one")).items.find(row=>row.id===item.id)!;const result=await store.mutate("bot:one",{action:"edit",mutationId:randomUUID(),id:item.id,expectedRevision:item.revision,patch:{state:"open",title:"Owner's revised responsibility"}});assert.equal(result.ok,true);await store.completePeer("bot:one",input.exchangeId,"completed",Date.now());item=(await store.snapshot("bot:one")).items.find(row=>row.id===item.id)!;assert.equal(item.state,"open");assert.equal(item.title,"Owner's revised responsibility");assert.equal(item.completion,undefined);
});

test("peer reservation, activation and completion recheck the original identity at atomic publication",async t=>{
 let incarnation="original",retire=false;const f=await fixture(t,{beforePublish:async()=>{if(retire)incarnation="replacement";}}),guard={assertCurrent:async()=>{if(incarnation!=="original")throw new Error("Previous Bot identity");}},input={exchangeId:"private-exchange",role:"incoming"as const,peerBotId:"peer-bot",title:"Old private task",expiresAt:Date.now()+86400000};
 retire=true;await assert.rejects(f.store.reservePeer("bot:one",input,guard),/Previous Bot identity/u);assert.equal((await f.store.peerReservations("bot:one")).length,0);
 retire=false;incarnation="original";await f.store.reservePeer("bot:one",input,guard);retire=true;await assert.rejects(f.store.activatePeer("bot:one",input.exchangeId,undefined,guard),/Previous Bot identity/u);assert.equal((await f.store.snapshot("bot:one")).items.length,0);
 retire=false;incarnation="original";await f.store.activatePeer("bot:one",input.exchangeId,undefined,guard);retire=true;await assert.rejects(f.store.completePeer("bot:one",input.exchangeId,"completed",Date.now(),guard),/Previous Bot identity/u);assert.equal((await f.store.snapshot("bot:one")).items[0]?.state,"waiting");retire=false;incarnation="original";await f.store.completePeer("bot:one",input.exchangeId,"completed",Date.now(),guard);assert.equal((await f.store.snapshot("bot:one")).items[0]?.state,"done");
});
