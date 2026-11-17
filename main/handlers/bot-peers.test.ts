import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { registerBotPeerHandlers, type BotPeerOwnerPort } from "./bot-peers.js";
import { parseBotPeerSettings, parseBotPeerCatalog, parseBotPeerExchangeDetail, parseBotPeerExchangeList, parseBotPeerEvidence } from "../../renderer/shared/bot-peers.js";

const sample = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/fixtures/bot-peers.json", import.meta.url), "utf8"));
function fixture() {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  const listeners = new Set<() => void>(); let destroyed = false, effects = 0, loads = 0;
  let beforeLoad = async () => {}, beforePublication = async () => {}, afterPublication = async () => {};
  let settings = parseBotPeerSettings(sample.settings); const accepted = new Set<string>();
  const service: BotPeerOwnerPort = {
    settings: async () => settings, catalog: async () => parseBotPeerCatalog(sample.catalog),
    exchanges: async () => parseBotPeerExchangeList(sample.exchanges), exchange: async () => parseBotPeerExchangeDetail(sample.detail),
    evidence: async () => parseBotPeerEvidence(sample.evidence),
    mutate: async (_id, input, lifetime) => {
      await beforePublication(); await lifetime.assertCurrent();
      const replayed = accepted.has(input.mutationId);
      if (!replayed) { accepted.add(input.mutationId); effects++; settings = { ...settings, lastMutationId: input.mutationId }; }
      await afterPublication(); return { ok: true, mutationId: input.mutationId, replayed, snapshot: settings };
    },
    stop: async (_id, _exchange, input, lifetime) => { await beforePublication(); await lifetime.assertCurrent(); effects++; return { ok: true, mutationId: input.mutationId, replayed: false, exchange: parseBotPeerExchangeDetail(sample.stopAccepted.exchange) }; },
  };
  registerBotPeerHandlers({ handle: (channel, handler) => handlers.set(channel, handler), owner: () => ({ isDestroyed: () => destroyed, onInvalidated: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } }), service: async () => { loads++; await beforeLoad(); return service; } });
  return { service, get effects() { return effects; }, get loads() { return loads; }, get listeners() { return listeners.size; },
    invoke: (action: string, value: unknown) => handlers.get(`bots:peers:${action}`)!({}, value),
    destroy: () => { destroyed = true; for (const listener of listeners) listener(); }, newDocument: () => { destroyed = false; },
    beforeLoad: (callback: () => Promise<void>) => { beforeLoad = callback; }, before: (callback: () => Promise<void>) => { beforePublication = callback; }, after: (callback: () => Promise<void>) => { afterPublication = callback; } };
}
function barrier() { let release!: () => void, enter!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; }); return { entered, release, wait: async () => { enter(); await gate; } }; }

test("registered owner controls expose closed peer records and reject delegation facts in commands", async () => {
  const f = fixture(), botId = sample.settings.botId;
  assert.deepEqual(await f.invoke("settings", { botId }), sample.settings);
  assert.deepEqual(await f.invoke("catalog", { botId }), sample.catalog);
  assert.deepEqual(await f.invoke("exchanges", { botId }), sample.exchanges);
  assert.deepEqual(await f.invoke("exchange", { botId, exchangeId: sample.detail.id }), sample.detail);
  assert.deepEqual(await f.invoke("evidence", { botId, exchangeId: sample.detail.id, kind: "source" }), sample.evidence);
  await assert.rejects(f.invoke("mutate", { ...sample.approve, origin: { sourceBotId: botId } }));
  await assert.rejects(f.invoke("stop", { ...sample.stop, peerGeneration: "caller-choice" }));
  await assert.rejects(f.invoke("catalog", { botId, account: "caller-choice" }));
  assert.equal(f.effects, 0); assert.equal(f.listeners, 0);
});
test("inactive owner documents cannot load the peer service or publish a later approval", async () => {
  const first = fixture(); first.destroy(); await assert.rejects(first.invoke("mutate", sample.approve)); assert.equal(first.loads, 0);
  const second = fixture(), load = barrier(); second.beforeLoad(load.wait);
  const waiting = second.invoke("mutate", sample.approve); await load.entered; second.destroy(); load.release();
  await assert.rejects(waiting); assert.equal(second.effects, 0); assert.equal(second.listeners, 0);
  const third = fixture(), publish = barrier(); third.before(publish.wait);
  const pending = third.invoke("mutate", sample.approve); await publish.entered; third.destroy(); publish.release();
  await assert.rejects(pending); assert.equal(third.effects, 0); assert.equal(third.listeners, 0);
});
test("a lost publication response keeps an accepted pair decision observable to its original retry", async () => {
  const f = fixture(), published = barrier(); f.after(published.wait);
  const pending = f.invoke("mutate", sample.approve); await published.entered; f.destroy(); published.release();
  await assert.rejects(pending); assert.equal(f.effects, 1);
  f.newDocument(); f.after(async () => {});
  const replay = await f.invoke("mutate", sample.approve) as { ok: boolean; replayed: boolean; mutationId: string };
  assert.equal(replay.ok, true); assert.equal(replay.replayed, true); assert.equal(replay.mutationId, sample.approve.mutationId); assert.equal(f.effects, 1);
});
test("late reads and service receipts cannot publish another Bot or exchange", async () => {
  const f = fixture(), read = barrier(); f.beforeLoad(read.wait);
  const pending = f.invoke("settings", { botId: sample.settings.botId }); await read.entered; f.destroy(); read.release(); await assert.rejects(pending);
  f.newDocument(); f.beforeLoad(async () => {});
  f.service.settings = async () => ({ ...sample.settings, botId: "other_bot" });
  await assert.rejects(f.invoke("settings", { botId: sample.settings.botId }));
  f.service.exchange = async () => ({ ...sample.detail, id: "other_exchange" });
  await assert.rejects(f.invoke("exchange", { botId: sample.settings.botId, exchangeId: sample.detail.id }));
  await assert.rejects(f.invoke("evidence", { botId: sample.settings.botId, exchangeId: sample.detail.id, kind: "result" }));
});
