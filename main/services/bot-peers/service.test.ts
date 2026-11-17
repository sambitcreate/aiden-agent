import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBotCapabilityStore } from "../bot-capability-store.js";
import { createBotCapabilityOpaqueKeyStore } from "../bot-capability-key-store.js";
import { createBotCapabilityStateCheckpoint, type BotCapabilityBootstrapMarkerState } from "../bot-capability-state-checkpoint.js";
import { createBotPeerService, type BotPeerHostIdentity } from "./service.js";
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-peer-service-")); t.after(() => rm(root, { recursive: true, force: true }));
  let anchor: string | null = null, marker: BotCapabilityBootstrapMarkerState | null = null, lost = false, unavailableCalls = 0;
  const bots = new Map<string, BotPeerHostIdentity>(["A", "B", "C"].map((id) => [id, { botId: id, name: `Bot ${id}`, incarnation: `incarnation-${id}`, active: true }]));
  const open = async () => { const store = createBotCapabilityStore({ root: () => root, checkpoint: createBotCapabilityStateCheckpoint({ root: () => root, keyStore: createBotCapabilityOpaqueKeyStore({ root: () => root }), anchor: { load: async () => anchor, store: async (next, previous) => { assert.equal(anchor, previous); anchor = next; } }, bootstrapMarker: { load: async () => marker, store: async (next, previous) => { assert.deepEqual(marker, previous); marker = next; } }, inspectInitialBootstrap: async () => "clean" as const }) }); await store.initialize(); return store; };
  const store = await open(), effects: string[] = [], never = async (): Promise<never> => { unavailableCalls++; throw new Error("Metadata must not start a model, connector or task."); };
  const service = createBotPeerService({ persistence: { read: () => store.getPeerMessagingState(), write: async (...args) => { await store.savePeerMessagingState(...args); if (lost) { lost = false; throw new Error("Lost owner response after publication"); } } }, identity: async (id) => bots.get(id), directory: async () => [...bots.values()], verifiedReply: never, root: never, runtime: { state: never, admit: never, receipt: never, stop: never, row: never, evidence: never }, links: { reserve: never, activate: never, outcome: never }, final: never, available: () => false, changed: (ids) => { effects.push(...ids); } });
  const life = () => ({ signal: new AbortController().signal, assertCurrent() {} });
  const command = async () => ({ action: "approve" as const, botId: "A", mutationId: randomUUID(), expectedRevision: (await service.settings("A")).revision, catalogRevision: (await service.catalog("A")).revision, peerBotId: "B" });
  return { root, bots, store, service, open, command, life, effects, lose() { lost = true; }, get unavailableCalls() { return unavailableCalls; } };
}
test("named pair approval is bidirectional, identity-bound, model-free and a rename never rebinds it", async (t) => {
  const f = await fixture(t), input = await f.command(), result = await f.service.mutate("A", input, f.life()); assert.equal(result.ok, true);
  const a = await f.service.settings("A"), b = await f.service.settings("B"); assert.equal(a.pairs.length, 1); assert.equal(b.pairs.length, 1); assert.equal(a.pairs[0]!.id, b.pairs[0]!.id); assert.equal(b.pairs[0]!.peer.botId, "A"); assert.ok(f.effects.includes("A") && f.effects.includes("B"));
  f.bots.get("B")!.name = "Renamed B"; assert.equal((await f.service.settings("A")).pairs[0]!.id, a.pairs[0]!.id); assert.equal((await f.service.settings("A")).pairs[0]!.peer.name, "Renamed B"); f.bots.get("B")!.incarnation = "recreated-B"; assert.equal((await f.service.settings("A")).pairs.length, 0); assert.equal(f.unavailableCalls, 0);
});
test("lost approval response settles its original receipt after counterpart deletion without recreating authority", async (t) => {
  const f = await fixture(t), input = await f.command(); f.lose(); const lost = await f.service.mutate("A", input, f.life()); assert.equal(lost.ok, false); assert.equal((await f.service.settings("A")).lastMutationId, input.mutationId); f.bots.delete("B");
  const replay = await f.service.mutate("A", input, f.life()); assert.equal(replay.ok, true); if (replay.ok) { assert.equal(replay.replayed, true); assert.equal(replay.snapshot.pairs.length, 0); assert.equal(replay.mutationId, input.mutationId); }
  const other = await f.service.mutate("A", { ...input, mutationId: randomUUID(), expectedRevision: (await f.service.settings("A")).revision, catalogRevision: (await f.service.catalog("A")).revision }, f.life()); assert.equal(other.ok, false); assert.equal(f.bots.has("B"), false); assert.equal(f.unavailableCalls, 0);
});
test("owner lifetime, stale catalogs, self pairs and copied private files cannot mint a pair", async (t) => {
  const f = await fixture(t), input = await f.command(), controller = new AbortController(); controller.abort(); assert.equal((await f.service.mutate("A", input, { signal: controller.signal, assertCurrent() {} })).ok, false); assert.equal((await f.service.settings("A")).pairs.length, 0);
  assert.equal((await f.service.mutate("A", { ...input, peerBotId: "A" }, f.life())).ok, false); f.bots.get("B")!.incarnation = "new-B"; assert.equal((await f.service.mutate("A", input, f.life())).ok, false); assert.equal((await f.service.settings("A")).pairs.length, 0);
  assert.equal((await f.service.mutate("A", await f.command(), f.life())).ok, true); const file = path.join(f.root, "bot-capabilities.json"), saved = await readFile(file, "utf8"), altered = JSON.parse(saved) as { peerMessaging: string }; altered.peerMessaging = altered.peerMessaging.replace("new-B", "forged-incarnation"); await writeFile(file, JSON.stringify(altered)); await assert.rejects(f.open()); await writeFile(file, saved); await f.open(); assert.equal((await f.service.settings("A")).pairs.length, 1);
});
test("cross-document read validation cannot deadlock or publish after a concurrent protected authority mutation",async t=>{
 const f=await fixture(t),controller=new AbortController();let validated=0;
 await assert.rejects(f.store.saveRoutineModelsState(null,"{}",async()=>{validated++;if(await f.store.getPeerMessagingState()!==null)throw new Error("authority changed");await f.store.savePeerMessagingState(null,"{}",async()=>{},()=>true);},()=>!controller.signal.aborted),/authority changed/u);
 assert.ok(validated>=1);assert.equal(await f.store.getRoutineModelsState(),null);assert.equal(await f.store.getPeerMessagingState(),"{}");
 await assert.rejects(f.store.saveRoutineModelsState(null,"{}",async()=>{assert.equal(await f.store.getPeerMessagingState(),"{}");controller.abort();},()=>!controller.signal.aborted));assert.equal(await f.store.getRoutineModelsState(),null);
 await f.store.saveRoutineModelsState(null,"{}",async()=>{assert.equal(await f.store.getPeerMessagingState(),"{}");},()=>true);assert.equal(await f.store.getRoutineModelsState(),"{}");
});
test("an unrelated protected document write revalidates and publishes without losing the owner decision",async t=>{
 const f=await fixture(t);let first=true;await f.store.savePeerMessagingState(null,"{}",async()=>{await f.store.getRoutineModelsState();if(first){first=false;await f.store.saveRoutineModelsState(null,"{}",async()=>{},()=>true);}},()=>true);assert.equal(await f.store.getPeerMessagingState(),"{}");assert.equal(await f.store.getRoutineModelsState(),"{}");
});

test("all 256 Bot profiles remain readable and profile capacity refuses describe and two-profile approval atomically",async t=>{
 const f=await fixture(t),seed=Array.from({length:255},(_,n)=>({botId:`saved-${n}`,incarnation:`saved-inc-${n}`,revision:`saved-revision-${n}`,routingDescription:"Saved routing",updatedAt:1})),state={version:1,revision:"seeded-history",profiles:seed,pairs:[],roots:[],exchanges:[],receipts:[]};await f.store.savePeerMessagingState(null,JSON.stringify(state),async()=>{},()=>true);
 // Approval would insert both A and B, so the one remaining slot is insufficient.
 const prior=await f.store.getPeerMessagingState(),approval=await f.service.mutate("A",await f.command(),f.life());assert.equal(approval.ok,false);if(!approval.ok)assert.equal(approval.code,"history_full");assert.equal(await f.store.getPeerMessagingState(),prior);assert.equal((await f.service.settings("B")).pairs.length,0);
 const describe={action:"describe" as const,botId:"A",mutationId:randomUUID(),expectedRevision:(await f.service.settings("A")).revision,routingDescription:"A routing"};assert.equal((await f.service.mutate("A",describe,f.life())).ok,true);assert.equal(JSON.parse((await f.store.getPeerMessagingState())!).profiles.length,256);await f.open();assert.equal((await f.service.settings("A")).routingDescription,"A routing");
 const full=await f.store.getPeerMessagingState(),refused=await f.service.mutate("B",{action:"describe",botId:"B",mutationId:randomUUID(),expectedRevision:(await f.service.settings("B")).revision,routingDescription:"Cannot add a 257th profile"},f.life());assert.equal(refused.ok,false);if(!refused.ok)assert.equal(refused.code,"history_full");assert.equal(await f.store.getPeerMessagingState(),full);assert.equal((await f.service.settings("A")).routingDescription,"A routing");
 const edit=await f.service.mutate("A",{...describe,mutationId:randomUUID(),expectedRevision:(await f.service.settings("A")).revision,routingDescription:"Edited at capacity"},f.life());assert.equal(edit.ok,true);assert.equal((await f.service.settings("A")).routingDescription,"Edited at capacity");assert.equal(f.unavailableCalls,0);
});
