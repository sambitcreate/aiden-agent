import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ALWAYS_NOW_GATE,
  createBotDeliveryFunnel,
  type BotDeliveryGate,
  type BotDeliveryInput,
} from "./funnel.js";
import { createBotDeliveryLog } from "./log.js";
import type { ScheduledTask } from "../types.js";

const NOW = Date.parse("2026-10-27T09:00:00.000Z");
const HOUR = 60 * 60 * 1_000;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "routine-1",
    name: "Morning brief",
    enabled: true,
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    permission: "read-only",
    botId: "bot:scout",
    routineSchedule: { kind: "daily", time: "09:00" },
    notify: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function routineResult(overrides: Partial<BotDeliveryInput> = {}): BotDeliveryInput {
  return {
    botId: "bot:scout",
    class: "routine_result",
    dedupeKey: "routine:routine-1:1761555600000",
    title: "Morning brief",
    body: "Your first meeting is at 9:30 with Priya.",
    status: "succeeded",
    routineTask: task(),
    requestId: "routine:routine-1:1761555600000",
    ...overrides,
  };
}

async function harness(
  gate: BotDeliveryGate = ALWAYS_NOW_GATE,
  ports: { mac?(input: BotDeliveryInput): Promise<void>; telegram?(input: BotDeliveryInput): Promise<void>; ownsPeerFinal?(botId:string,requestId:string):Promise<boolean> } = {},
) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "aiden-bot-delivery-"));
  const log = createBotDeliveryLog({ profileDir: () => profile, now: () => NOW });
  const calls = { mac: [] as BotDeliveryInput[], telegram: [] as BotDeliveryInput[] };
  const funnel = createBotDeliveryFunnel({
    log,
    gate,
    ownsPeerFinal: ports.ownsPeerFinal,
    mac: async (input) => {
      calls.mac.push(input);
      await ports.mac?.(input);
    },
    telegram: async (input) => {
      calls.telegram.push(input);
      await ports.telegram?.(input);
    },
    now: () => NOW,
  });
  return { profile, log, funnel, calls, cleanup: () => rm(profile, { recursive: true, force: true }) };
}

test("sends a routine result to mac, telegram and the phone feed once", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const input = routineResult();

  assert.equal(await h.funnel.deliver(input), "sent");
  assert.equal(await h.funnel.deliver(input), "duplicate");

  assert.equal(h.calls.mac.length, 1, "one Mac banner");
  assert.equal(h.calls.telegram.length, 1, "one Telegram message");
  assert.equal(h.calls.telegram[0]!.requestId, input.requestId, "Telegram dedupes by the routine fire");
  assert.equal(h.calls.telegram[0]!.title, "Morning brief");

  const rows = await h.log.due(undefined, NOW);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0], id: undefined },
    {
      id: undefined,
      botId: "bot:scout",
      class: "routine_result",
      dedupeKey: input.dedupeKey,
      title: "Morning brief",
      body: input.body,
      routineId: "routine-1",
      requestId: input.requestId,
      status: "succeeded",
      createdAt: NOW,
      deliverAfter: NOW,
      macSentAt: NOW,
      telegramSentAt: NOW,
      sentAt: NOW,
    },
  );
  assert.ok(rows[0]!.id.length > 0);
});

test("a deferred row is invisible to phones until it is due", async (t) => {
  const h = await harness({ decide: async () => ({ kind: "defer", until: NOW + HOUR }) });
  t.after(h.cleanup);

  assert.equal(await h.funnel.deliver(routineResult()), "deferred");
  assert.equal(await h.funnel.deliver(routineResult()), "deferred", "a held row stays held");
  assert.deepEqual(await h.log.due(undefined, NOW), []);
  assert.deepEqual(
    (await h.log.due(undefined, NOW + HOUR)).map(({ title }) => title),
    ["Morning brief"],
  );
  assert.equal(h.calls.mac.length, 0);
  assert.equal(h.calls.telegram.length, 0);
});

test("suppressed rows are logged but never notified", async (t) => {
  const h = await harness({ decide: async () => ({ kind: "suppress", reason: "daily_limit" }) });
  t.after(h.cleanup);
  const input = routineResult();

  assert.equal(await h.funnel.deliver(input), "suppressed");
  const row = await h.log.find(input.botId, input.dedupeKey);
  assert.equal(row?.suppressed, true, "the row is kept for the record");
  assert.deepEqual(await h.log.due(undefined, NOW), [], "phones never hear it");
  assert.deepEqual(await h.log.due(undefined, NOW + 24 * HOUR), [], "it never becomes due");
  assert.equal(h.calls.mac.length, 0);
  assert.equal(h.calls.telegram.length, 0);
});

test("forgetBot removes the Bot's rows", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.funnel.deliver(routineResult());
  await h.funnel.deliver(routineResult({ botId: "bot:chef", dedupeKey: "routine:routine-2:1", title: "Dinner" }));

  await h.log.forgetBot("bot:scout");

  assert.deepEqual(
    (await h.log.due(undefined, NOW)).map(({ botId, title }) => ({ botId, title })),
    [{ botId: "bot:chef", title: "Dinner" }],
  );
});

test("one message is deduped per Bot, not across Bots", async (t) => {
  const h = await harness();
  t.after(h.cleanup);

  assert.equal(await h.funnel.deliver(routineResult()), "sent");
  assert.equal(await h.funnel.deliver(routineResult({ botId: "bot:chef" })), "sent");
  assert.equal((await h.log.due(undefined, NOW)).length, 2);
});

test("a Telegram failure retries only Telegram, never the Mac banner again", async (t) => {
  let telegramAttempts = 0;
  const h = await harness(ALWAYS_NOW_GATE, {
    telegram: async () => {
      telegramAttempts += 1;
      if (telegramAttempts === 1) throw new Error("The Telegram outbox is unavailable.");
    },
  });
  t.after(h.cleanup);
  const input = routineResult();

  await assert.rejects(h.funnel.deliver(input), /outbox is unavailable/u);
  assert.equal(h.calls.mac.length, 1);
  assert.equal((await h.log.find(input.botId, input.dedupeKey))?.sentAt, undefined, "not yet sent");

  assert.equal(await h.funnel.deliver(input), "sent");
  assert.equal(h.calls.mac.length, 1, "the Mac banner is shown exactly once");
  assert.equal(h.calls.telegram.length, 2);

  const row = await h.log.find(input.botId, input.dedupeKey);
  assert.equal(row?.macSentAt, NOW, "the Mac send is remembered");
  assert.equal(row?.telegramSentAt, NOW, "the retry stamped Telegram");
  assert.equal(row?.sentAt, NOW, "sentAt is all channels done");
  assert.equal((await h.log.due(undefined, NOW)).length, 1, "the retry reused the row");

  assert.equal(await h.funnel.deliver(input), "duplicate");
  assert.equal(h.calls.mac.length, 1);
  assert.equal(h.calls.telegram.length, 2);
});

test("a gate that counts calls is asked once across a delivery and its retry", async (t) => {
  let gateCalls = 0;
  let holdNewMessages = false;
  const gate: BotDeliveryGate = {
    decide: async () => {
      gateCalls += 1;
      return holdNewMessages ? { kind: "defer", until: NOW + HOUR } : { kind: "now" };
    },
  };
  let telegramAttempts = 0;
  const h = await harness(gate, {
    telegram: async () => {
      telegramAttempts += 1;
      if (telegramAttempts === 1) throw new Error("The Telegram outbox is unavailable.");
    },
  });
  t.after(h.cleanup);
  const input = routineResult();

  await assert.rejects(h.funnel.deliver(input), /outbox is unavailable/u);
  // A cap arriving between the two attempts would hold a new message, but the
  // stored row already passed the gate and must still be finished.
  holdNewMessages = true;

  assert.equal(await h.funnel.deliver(input), "sent");
  assert.equal(gateCalls, 1, "the gate saw the delivery, not its retry");
  assert.equal(h.calls.mac.length, 1);
  assert.equal(h.calls.telegram.length, 2);

  assert.equal(await h.funnel.deliver(input), "duplicate");
  assert.equal(gateCalls, 1, "a duplicate never reaches the gate");
});

test("three held rows produce one digest banner and stay three rows for phones", async (t) => {
  const h = await harness({ decide: async () => ({ kind: "defer", until: NOW + HOUR }) });
  t.after(h.cleanup);
  for (const key of ["a", "b", "c"]) {
    assert.equal(await h.funnel.deliver(routineResult({ dedupeKey: key, requestId: key })), "deferred");
  }
  assert.equal(await h.funnel.flush(NOW), NOW + HOUR, "nothing is due yet; the next held row is");
  assert.equal(h.calls.mac.length, 0);
  assert.equal(await h.funnel.flush(NOW + HOUR), undefined);
  assert.equal(h.calls.mac.length, 1);
  assert.equal(h.calls.mac[0]?.class, "digest");
  assert.equal(h.calls.mac[0]?.body, "While you were away: 3 updates.");
  assert.equal(h.calls.telegram.length, 1);
  assert.equal((await h.log.due(undefined, NOW + HOUR)).filter((row) => row.class === "routine_result").length, 3);
  assert.ok((await h.log.list("bot:scout")).every((row) => row.sentAt !== undefined));
  await h.funnel.flush(NOW + 2 * HOUR);
  assert.equal(h.calls.mac.length, 1, "a flushed row is never sent again");
});

test("an away digest whose Telegram keeps failing shows one Mac banner and keeps one Telegram identity", async (t) => {
  let telegramUp = false;
  const h = await harness({ decide: async () => ({ kind: "defer", until: NOW + HOUR }) }, {
    telegram: async () => {
      if (!telegramUp) throw new Error("The Telegram outbox is unavailable.");
    },
  });
  t.after(h.cleanup);
  for (const key of ["a", "b"]) await h.funnel.deliver(routineResult({ dedupeKey: key, requestId: key }));
  await h.funnel.flush(NOW + HOUR);
  await h.funnel.flush(NOW + HOUR + 5 * 60_000);
  await h.funnel.flush(NOW + HOUR + 10 * 60_000);
  assert.equal(h.calls.mac.length, 1, "the banner went out once");
  telegramUp = true;
  await h.funnel.flush(NOW + HOUR + 15 * 60_000);
  await h.funnel.flush(NOW + HOUR + 20 * 60_000);
  assert.equal(h.calls.mac.length, 1);
  const ids = new Set(h.calls.telegram.map((input) => input.requestId));
  assert.equal(ids.size, 1, "every Telegram attempt carries the same request id");
  assert.equal(h.calls.telegram.length, 4, "three failures, then one success, then nothing");
  assert.equal((await h.log.due(undefined, NOW + 2 * HOUR)).filter((row) => row.class === "routine_result").length, 2);
});

test("a held issue is sent on its own, from the stored row", async (t) => {
  const h = await harness({ decide: async () => ({ kind: "defer", until: NOW + HOUR }) });
  t.after(h.cleanup);
  await h.funnel.deliver({ botId: "bot:scout", class: "issue", dedupeKey: "issue:1", title: "Briefing needs you", body: "Sign in again.", status: "info" });
  await h.funnel.deliver(routineResult());
  await h.funnel.flush(NOW + HOUR);
  assert.deepEqual(h.calls.mac.map((input) => [input.class, input.title]), [
    ["issue", "Briefing needs you"],
    ["routine_result", "Morning brief"],
  ]);
});

test("the first row over the daily limit leaves one note that more is in the chat", async (t) => {
  const h = await harness({ decide: async () => ({ kind: "suppress", reason: "daily_limit", digestKey: "digest:limit:2026-10-27" }) });
  t.after(h.cleanup);
  assert.equal(await h.funnel.deliver(routineResult({ dedupeKey: "a" })), "suppressed");
  assert.equal(await h.funnel.deliver(routineResult({ dedupeKey: "b" })), "suppressed");
  assert.deepEqual(h.calls.mac.map((input) => input.body), ["More updates are in the chat."]);
  assert.deepEqual((await h.log.due(undefined, NOW)).map((row) => row.class), ["digest"]);
});

test("two deliveries of one key at once send once", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const [first, second] = await Promise.all([h.funnel.deliver(routineResult()), h.funnel.deliver(routineResult())]);
  assert.deepEqual([first, second].sort(), ["duplicate", "sent"]);
  assert.equal(h.calls.mac.length, 1);
});

test("a delivery after the Bot is forgotten writes nothing and sends nothing", async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  await h.log.forgetBot("bot:scout");
  assert.equal(await h.funnel.deliver(routineResult()), "duplicate");
  assert.equal(h.calls.mac.length, 0);
  assert.deepEqual(await h.log.list("bot:scout"), []);
});

test("delegation suppresses the initial routine update and delivers one counted root final; quiet roots send no channels",async t=>{
 const h=await harness(ALWAYS_NOW_GATE,{ownsPeerFinal:async(_bot,request)=>request==="routine:routine-1:1761555600000"});t.after(h.cleanup);assert.equal(await h.funnel.deliver(routineResult()),"suppressed");assert.equal((await h.log.list("bot:scout")).length,0);const final={...routineResult(),class:"peer_result"as const,dedupeKey:"peer-root:accepted-root",routineTask:undefined,requestId:"accepted-root"};assert.equal(await h.funnel.deliver(final),"sent");assert.equal(await h.funnel.deliver(final),"duplicate");assert.equal(h.calls.mac.length,1);assert.equal(h.calls.telegram.length,1);assert.equal((await h.log.list("bot:scout"))[0]?.class,"peer_result");assert.equal(await h.funnel.deliver({...final,dedupeKey:"peer-root:quiet-root",quiet:true}),"suppressed");assert.equal(h.calls.mac.length,1);assert.equal(h.calls.telegram.length,1);const rows=await h.log.list("bot:scout");assert.equal(rows.find(row=>row.dedupeKey==="peer-root:quiet-root")?.quiet,true);
});

test("a quiet peer final cannot create a daily-limit digest or enter a later mixed digest",async t=>{
 let decisions=0;const h=await harness({decide:async()=>{decisions++;return {kind:"suppress",reason:"daily_limit",digestKey:"daily-limit"};}});t.after(h.cleanup);await h.funnel.deliver({...routineResult(),class:"peer_result",dedupeKey:"peer-quiet",requestId:"root-quiet",quiet:true});await h.funnel.flush(NOW+HOUR);assert.equal(decisions,0);assert.equal(h.calls.mac.length,0);assert.equal(h.calls.telegram.length,0);const rows=await h.log.list("bot:scout");assert.equal(rows.length,1);assert.equal(rows[0]?.quiet,true);assert.equal(rows[0]?.class,"peer_result");
});

test("a peer final awaiting the delivery gate cannot write or notify a replacement Bot",async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"aiden-peer-delivery-identity-"));t.after(()=>rm(root,{recursive:true,force:true}));const log=createBotDeliveryLog({profileDir:()=>root}),channels:string[]=[];let current="old",replace=true;const publication={assertCurrent:async()=>{if(current!=="old")throw new Error("Previous Bot identity");}},funnel=createBotDeliveryFunnel({log,gate:{decide:async()=>{if(replace)current="replacement";return {kind:"now"};}},now:()=>NOW,mac:async()=>{channels.push("mac");},telegram:async()=>{channels.push("telegram");}}),input={botId:"bot:scout",class:"peer_result"as const,dedupeKey:"old-peer-root",title:"Private final",body:"Old private result",status:"succeeded"as const,publication};
 await assert.rejects(funnel.deliver(input),/Previous Bot identity/u);assert.deepEqual(await log.list(input.botId),[]);assert.deepEqual(channels,[]);current="old";replace=false;assert.equal(await funnel.deliver(input),"sent");assert.equal((await log.list(input.botId)).length,1);assert.deepEqual(channels,["mac","telegram"]);
});

test("quiet-hours peer results revalidate their protected original root after reopening and cannot join a replacement digest",async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"aiden-peer-delayed-identity-"));t.after(()=>rm(root,{recursive:true,force:true}));const log=createBotDeliveryLog({profileDir:()=>root}),channels:string[]=[];let live=true;const peerPublication=async()=>live?{assertCurrent:async()=>{if(!live)throw new Error("retired root");}}:undefined,ports={log,peerPublication,gate:{decide:async()=>({kind:"defer"as const,until:NOW+HOUR})},now:()=>NOW,mac:async()=>{channels.push("mac");},telegram:async()=>{channels.push("telegram");}},funnel=createBotDeliveryFunnel(ports);
 for(const requestId of ["first-root","second-root"])assert.equal(await funnel.deliver({botId:"bot:scout",class:"peer_result",dedupeKey:requestId,requestId,title:"Peer result",body:"Private old result",status:"succeeded"}),"deferred");live=false;const reopened=createBotDeliveryFunnel({...ports,log:createBotDeliveryLog({profileDir:()=>root})});await reopened.flush(NOW+HOUR);assert.deepEqual(channels,[]);assert.equal((await log.list("bot:scout")).length,2,"no replacement digest is published");
 live=true;await reopened.flush(NOW+HOUR);assert.deepEqual(channels,["mac","telegram"]);assert.equal((await log.list("bot:scout")).filter(row=>row.class==="digest").length,1);await reopened.flush(NOW+HOUR);assert.equal(channels.length,2);
});

test("delivery history preserves 200 owed peer finals and admits a new row only after a delivery settles",async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"aiden-peer-delivery-capacity-"));t.after(()=>rm(root,{recursive:true,force:true}));const log=createBotDeliveryLog({profileDir:()=>root});for(let n=0;n<200;n++)await log.append({botId:"bot:scout",class:n===0?"digest":"peer_result",peerRootIds:[`root-${n}`],requestId:`root-${n}`,dedupeKey:`root-${n}`,title:"Owed final",body:"Result",status:"succeeded",createdAt:NOW,deliverAfter:NOW+HOUR});const pending=await log.list("bot:scout"),oldest=pending[199]!;await assert.rejects(log.append({botId:"bot:scout",class:"peer_result",peerRootIds:["new-root"],requestId:"new-root",dedupeKey:"new-root",title:"New final",body:"New",status:"succeeded",createdAt:NOW,deliverAfter:NOW+HOUR}),/No owed result was discarded/u);assert.deepEqual((await log.list("bot:scout")).map(row=>row.dedupeKey),pending.map(row=>row.dedupeKey));await log.markChannel("bot:scout",oldest.id,"mac",NOW+HOUR);await log.markChannel("bot:scout",oldest.id,"telegram",NOW+HOUR);await log.markSent("bot:scout",oldest.id,NOW+HOUR);await log.settlePeerReferences("bot:scout",oldest.id,async facts=>{assert.deepEqual(facts.pending,[]);assert.deepEqual(facts.settled,["root-0"]);},NOW+HOUR);await log.append({botId:"bot:scout",class:"peer_result",peerRootIds:["new-root"],requestId:"new-root",dedupeKey:"new-root",title:"New final",body:"New",status:"succeeded",createdAt:NOW,deliverAfter:NOW+HOUR});assert.equal((await log.list("bot:scout")).length,200);assert.equal(await log.find("bot:scout",oldest.dedupeKey),undefined);assert.ok(await log.find("bot:scout","root-1"));assert.ok(await log.find("bot:scout","new-root"));
});

test("a full queue of 200 owed peer finals drains without digest headroom and preserves an incomplete digest",async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"aiden-peer-full-flush-"));t.after(()=>rm(root,{recursive:true,force:true}));const log=createBotDeliveryLog({profileDir:()=>root}),owed=new Set<string>(),channels:string[]=[];for(let n=0;n<200;n++){owed.add(`root-${n}`);await log.append({botId:"bot:scout",class:"peer_result",peerRootIds:[`root-${n}`],requestId:`root-${n}`,dedupeKey:`root-${n}`,title:"Owed",body:"Result",status:"succeeded",createdAt:NOW,deliverAfter:NOW+HOUR});}let failDigest=true;const ports={log,gate:ALWAYS_NOW_GATE,now:()=>NOW+HOUR,peerPublication:async()=>({assertCurrent:async()=>{}}),peerSettled:async(_bot:string,root:string)=>{owed.delete(root);},mac:async(input:BotDeliveryInput)=>{channels.push(`mac:${input.class}`);},telegram:async(input:BotDeliveryInput)=>{if(input.class==="digest"&&failDigest)throw new Error("Temporary digest failure");channels.push(`telegram:${input.class}`);}};await createBotDeliveryFunnel(ports).flush(NOW+HOUR);assert.deepEqual(channels,["mac:peer_result","telegram:peer_result","mac:digest"]);assert.equal(owed.size,199);const digest=(await log.list("bot:scout")).find(row=>row.class==="digest")!;assert.equal(digest.sentAt,undefined);assert.equal(digest.peerRootIds?.length,199);assert.equal((await log.list("bot:scout")).length,200);await assert.rejects(log.append({botId:"bot:scout",class:"peer_result",peerRootIds:["next"],requestId:"next",dedupeKey:"next",title:"Next",body:"Next",status:"succeeded",createdAt:NOW,deliverAfter:NOW+HOUR}),/No owed result was discarded/u);failDigest=false;await createBotDeliveryFunnel({...ports,log:createBotDeliveryLog({profileDir:()=>root})}).flush(NOW+HOUR);assert.equal(owed.size,0);assert.deepEqual(channels,["mac:peer_result","telegram:peer_result","mac:digest","telegram:digest"]);await createBotDeliveryFunnel(ports).flush(NOW+HOUR);assert.equal(channels.length,4);for(let n=0;n<2;n++)await log.append({botId:"bot:scout",class:"peer_result",peerRootIds:[`later-${n}`],requestId:`later-${n}`,dedupeKey:`later-${n}`,title:"Later",body:"Later",status:"succeeded",createdAt:NOW+HOUR,deliverAfter:NOW+2*HOUR});assert.equal((await log.list("bot:scout")).length,200);
});

test("a later pending row re-arms a shared passive root and settlement waits for every current reference",async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"aiden-peer-root-references-"));t.after(()=>rm(root,{recursive:true,force:true}));const log=createBotDeliveryLog({profileDir:()=>root}),channels:string[]=[];let settled=false,fail=true;const ports={log,gate:ALWAYS_NOW_GATE,now:()=>NOW,peerPublication:async()=>({assertCurrent:async()=>{}}),peerSettled:async()=>{settled=true;},peerPending:async()=>{settled=false;},mac:async()=>{channels.push("mac");},telegram:async()=>{if(fail)throw new Error("Temporary failure");channels.push("telegram");}};
 // The earlier note really settled. A crash before final publication can
 // cause the retried root to acquire another day's note before its own row.
 await log.append({botId:"bot:scout",class:"digest",peerRootIds:["shared-root"],dedupeKey:"old-note",title:"Old note",body:"Updates",status:"info",createdAt:NOW,deliverAfter:NOW,macSentAt:NOW,telegramSentAt:NOW,sentAt:NOW,peerSettledAt:NOW});settled=true;await log.append({botId:"bot:scout",class:"digest",peerRootIds:["shared-root"],dedupeKey:"new-note",title:"New note",body:"Updates",status:"info",createdAt:NOW,deliverAfter:NOW,macSentAt:NOW});await createBotDeliveryFunnel(ports).deliver({botId:"bot:scout",class:"peer_result",requestId:"shared-root",dedupeKey:"suppressed-result",title:"Result",body:"Result",status:"succeeded",quiet:true});assert.equal(settled,false);assert.deepEqual(channels,[]);assert.equal((await log.find("bot:scout","new-note"))?.peerSettledAt,undefined);fail=false;await createBotDeliveryFunnel({...ports,log:createBotDeliveryLog({profileDir:()=>root})}).flush(NOW);assert.equal(settled,true);assert.deepEqual(channels,["telegram"]);assert.ok((await log.list("bot:scout")).every(row=>row.peerSettledAt!==undefined));
});

test('bot_message final delivery is durable and deduplicated',async t=>{
 const h=await harness();t.after(h.cleanup);
 const input:BotDeliveryInput={botId:'bot:scout',class:'bot_message',dedupeKey:'message:delivery:final',title:'Scouts reply',body:'The final answer',status:'info'};
 assert.equal(await h.funnel.deliver(input),'sent');assert.equal(await h.funnel.deliver(input),'duplicate');
 assert.equal(h.calls.mac.length,1);assert.equal(h.calls.telegram.length,1);
 assert.equal((await h.log.list(input.botId))[0]?.class,'bot_message');
});

test("a deferred access issue retains its audience gate when flushed from the durable log", async (t) => {
  const h = await harness({ decide: async () => ({ kind: "defer", until: NOW + HOUR }) }); t.after(h.cleanup);
  await h.funnel.deliver({ botId: "bot:scout", class: "issue", dedupeKey: "issue:access_gate", title: "Allow Reports", body: "Prepare a summary.", status: "info", requiredCapability: "bot:access-requests" });
  assert.equal(h.calls.mac.length, 0);
  await h.funnel.flush(NOW + HOUR);
  assert.equal(h.calls.mac.length, 1);
  assert.equal(h.calls.mac[0]!.requiredCapability, "bot:access-requests");
  assert.equal((await h.log.find("bot:scout", "issue:access_gate"))?.requiredCapability, "bot:access-requests");
});
