import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import Ajv from "ajv";
import { createAidenRemoteRequestHandler, type AidenRemoteRouterDependencies } from "./aiden-remote-router.js";
import { AIDEN_REMOTE_BOT_PEERS_CONTRACT_REVISION, parseAidenRemoteBotRoutineNotificationList, parseAidenRemoteBotSession, type AidenRemoteCapability } from "./aiden-remote-protocol.js";
import { projectRemoteBotOpenWork, projectRemoteBotOpenWorkResult, remoteBotOpenWorkMutationVisible } from "./aiden-remote-bot-open-work.js";
import type { BotPeerOwnerService } from "./bot-peers/service-main.js";
import { parseBotPeerExchangeDetail } from "../../renderer/shared/bot-peers.js";
import type { BotOpenWorkSnapshot } from "../../renderer/shared/bot-open-work.js";

const fixture = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/fixtures/bot-peers.json", import.meta.url), "utf8"));
const openFixture = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/fixtures/bot-open-work.json", import.meta.url), "utf8"));
const base = `/bots/${fixture.settings.botId}`;
const all: AidenRemoteCapability[] = ["server:read", "bot:read", "bot:write", "chat:read", "bot:peers", "bot:open-work"];
function barrier() { let release!: () => void, enter!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; }), wait = new Promise<void>((resolve) => { release = resolve; }); return { entered, release, block: async () => { enter(); await wait; } }; }
function service() {
  let effects = 0, ready = true; const receipts = new Set<string>();
  const port: BotPeerOwnerService = {
    isReady: () => ready, settings: async () => structuredClone(fixture.settings), catalog: async () => structuredClone(fixture.catalog), exchanges: async () => structuredClone(fixture.exchanges), exchange: async () => structuredClone(fixture.detail), evidence: async () => structuredClone(fixture.evidence),
    mutate: async (_bot, command, lifetime) => { await lifetime.assertCurrent(); const replayed = receipts.has(command.mutationId); if (!replayed) { effects++; receipts.add(command.mutationId); } return { ok: true, mutationId: command.mutationId, replayed, snapshot: structuredClone(fixture.settings) }; },
    stop: async (_bot, _exchange, command, lifetime) => { await lifetime.assertCurrent(); return { ...fixture.stopAccepted, mutationId: command.mutationId }; },
  };
  return { port, get effects() { return effects; }, unready: () => { ready = false; } };
}
async function host(t: test.TestContext, port?: BotPeerOwnerService, initial: AidenRemoteCapability[] = all, openWork?: AidenRemoteRouterDependencies["botOpenWork"], sessions?: AidenRemoteRouterDependencies["botSessions"]) {
  let capabilities = new Set(initial), revoked = false;
  const handler = createAidenRemoteRequestHandler({ instanceId: "peer-contract-test", displayName: () => "Host", appVersion: "0.64.0", connectionMode: () => "lan", now: Date.now, log() {},
    devices: { authenticate: async () => ({ id: "device-peers", type: "iphone", revoked, acceptsBotCapabilities: true, capabilities }), acquireDeviceAuthorization: () => { if (revoked) throw new Error("Device revoked."); return () => {}; } },
    pairing: { exchange: async () => { throw new Error("unused"); } }, botPeers: port, botOpenWork: openWork, botSessions: sessions });
  const server = createServer(handler); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing listener.");
  return { setCapabilities: (value: AidenRemoteCapability[]) => { capabilities = new Set(value); }, revoke: () => { revoked = true; },
    request: (resource: string, method = "GET", body?: unknown, signal?: AbortSignal) => fetch(`http://127.0.0.1:${address.port}/api/aiden/v1${resource}`, { method, signal, headers: { authorization: `Bearer ${"p".repeat(43)}`, "aiden-protocol-version": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) };
}
test("peer readiness and grants distinguish owner metadata from conversation content", async (t) => {
  assert.equal(AIDEN_REMOTE_BOT_PEERS_CONTRACT_REVISION, fixture.contractRevision);
  const f = service(), server = await host(t, f.port, ["server:read", "bot:read", "bot:peers"]);
  assert.ok((await (await server.request("/server")).json()).serverCapabilities.includes("bot:peers"));
  assert.equal((await server.request(base + "/peers")).status, 200); assert.equal((await server.request(base + "/peers/catalog")).status, 200);
  assert.equal((await server.request(base + "/peer-exchanges")).status, 403);
  assert.equal((await server.request(base + "/peers", "POST", fixture.approve)).status, 403); assert.equal(f.effects, 0);
  f.unready(); assert.ok(!(await (await server.request("/server")).json()).serverCapabilities.includes("bot:peers"));
  assert.equal((await server.request(base + "/peers")).status, 404);
});
test("HTTP peer controls bind path resources and reject extra authority fields before effects", async (t) => {
  const f = service(), server = await host(t, f.port);
  assert.equal((await server.request(base + "/peers", "POST", { ...fixture.approve, botId: "other_bot" })).status, 400);
  assert.equal((await server.request(base + "/peers", "POST", { ...fixture.approve, origin: { botId: fixture.settings.botId } })).status, 400);
  assert.equal((await server.request(base + "/peer-exchanges/other/stop", "POST", fixture.stop)).status, 400);
  assert.equal((await server.request(base + "/peers/catalog?account=other")).status, 400); assert.equal(f.effects, 0);
  assert.deepEqual(await (await server.request(base + "/peer-exchanges/exchange_one/evidence/source")).json(), fixture.evidence);
  f.port.exchange = async () => parseBotPeerExchangeDetail({ ...fixture.detail, id: "other_exchange" });
  assert.equal((await server.request(base + "/peer-exchanges/exchange_one")).status, 500);
});
test("authorization lost before acceptance prevents effects, while loss after acceptance preserves same-request retry", async (t) => {
  const f = service(), before = barrier(), mutate = f.port.mutate;
  f.port.mutate = async (...args) => { await before.block(); return mutate(...args); };
  const server = await host(t, f.port), refused = server.request(base + "/peers", "POST", fixture.approve);
  await before.entered; server.setCapabilities(all.filter((value) => value !== "bot:write")); before.release();
  assert.equal((await refused).status, 403); assert.equal(f.effects, 0);
  server.setCapabilities(all); const after = barrier();
  f.port.mutate = async (...args) => { const result = await mutate(...args); await after.block(); return result; };
  const accepted = server.request(base + "/peers", "POST", fixture.approve); await after.entered;
  server.setCapabilities(all.filter((value) => value !== "bot:peers")); after.release();
  const lost = await accepted; assert.equal(lost.status, 409); assert.equal((await lost.json()).error.code, "idempotency_in_flight"); assert.equal(f.effects, 1);
  server.setCapabilities(all); f.port.mutate = mutate;
  const replay = await (await server.request(base + "/peers", "POST", fixture.approve)).json();
  assert.equal(replay.replayed, true); assert.equal(replay.mutationId, fixture.approve.mutationId); assert.equal(f.effects, 1);
});
test("non-peer clients receive closed Open work shapes and cannot guess hidden peer mutations or evidence", async (t) => {
  const visible = structuredClone(openFixture.item); visible.links.push({ kind: "peer", exchangeId: "exchange_one", peerBotId: "bot_researcher" });
  const hidden = { ...structuredClone(visible), id: "peer_work", source: { kind: "peer" as const, exchangeId: "exchange_one", role: "incoming" as const, peerBotId: "bot_researcher" } };
  const snapshot: BotOpenWorkSnapshot = { botId: fixture.settings.botId, revision: "work_latest", items: [visible, hidden], undo: [{ mutationId: fixture.approve.mutationId, itemId: hidden.id, expectedRevision: hidden.revision, expiresAt: Date.now() + 10_000 }] };
  const projected = projectRemoteBotOpenWork(snapshot, false);
  assert.deepEqual(projected.items.map((item) => item.id), [visible.id]); assert.ok(projected.items[0].links.every((link) => link.kind !== "peer")); assert.equal(projected.undo.length, 0);
  assert.equal(snapshot.items.length, 2); assert.ok(snapshot.items[0].links.some((link) => link.kind === "peer"));
  assert.equal(remoteBotOpenWorkMutationVisible(snapshot, { action: "undo", mutationId: fixture.stop.mutationId, expectedRevision: hidden.revision, undoOf: fixture.approve.mutationId }), false);
  assert.deepEqual(projectRemoteBotOpenWorkResult({ ok: false, code: "stale", error: "Changed", snapshot }, false), { ok: false, code: "stale", error: "Changed", snapshot: projected });
  let effects = 0, evidenceReads = 0;
  const server = await host(t, service().port, all.filter((value) => value !== "bot:peers"), { snapshot: async () => snapshot, mutateByPerson: async () => { effects++; return { ok: true, mutationId: fixture.stop.mutationId, replayed: false, snapshot }; }, evidence: async () => { evidenceReads++; return undefined; } });
  const response = await server.request(base + "/open-work"); assert.deepEqual(await response.json(), projected);
  assert.equal((await server.request(base + "/open-work", "POST", { action: "stop", mutationId: fixture.stop.mutationId, id: hidden.id, expectedRevision: hidden.revision })).status, 404);
  assert.equal((await server.request(base + "/open-work/peer_work/evidence/source")).status, 404);
  assert.equal(effects, 0); assert.equal(evidenceReads, 0);
});
test("peer session and notification reads recheck current opt-in before publishing a late result", async (t) => {
  for (const kind of ["session", "feed"] as const) {
    const hold = barrier();
    const session = { botId: fixture.settings.botId, epoch: "e1", seq: 1, state: "idle", interrupted: false, entries: [fixture.peerEntry], hasOlder: false, question: null, approval: null };
    const server = await host(t, service().port, all, undefined, {
      session: async () => { await hold.block(); return session; },
      routineNotificationFeed: async () => { await hold.block(); return { notifications: [fixture.peerNotification], now: fixture.peerNotification.finishedAt }; },
    } as never);
    const pending = server.request(kind === "session" ? base + "/session" : "/bots/routine-notifications");
    await hold.entered; server.setCapabilities(all.filter((value) => value !== "bot:peers")); hold.release();
    const response = await pending; assert.equal(response.status, 200);
    const body = await response.json(); assert.deepEqual(kind === "session" ? body.entries : body.notifications, []);
  }
});
test("held Bot reads refuse projections whose separate grants were removed before publication", async (t) => {
  const cases: Array<{ kind: "session" | "feed"; capability: AidenRemoteCapability }> = [
    { kind: "session", capability: "bot:access-requests" },
    { kind: "session", capability: "bot:plans" },
    { kind: "session", capability: "bot:allowed" },
    { kind: "feed", capability: "bot:access-requests" },
    { kind: "feed", capability: "bot:messaging" },
  ];
  for (const { kind, capability } of cases) {
    await t.test(`${kind}: ${capability}`, async (t) => {
      const hold = barrier();
      const session = { botId: fixture.settings.botId, epoch: "e1", seq: 1, state: "idle", interrupted: false, entries: [], hasOlder: false, question: null, approval: null };
      const server = await host(t, service().port, [...all, capability], undefined, {
        session: async () => { await hold.block(); return session; },
        routineNotificationFeed: async () => { await hold.block(); return { notifications: [], now: fixture.peerNotification.finishedAt }; },
      } as never);
      const pending = server.request(kind === "session" ? base + "/session" : "/bots/routine-notifications");
      await hold.entered;
      server.setCapabilities(all);
      hold.release();
      const response = await pending;
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "capability_denied");
    });
  }
});
test("normative peer schemas are closed and restrict final markers, notification kinds and large evidence IDs", () => {
  const contract = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/openapi.json", import.meta.url), "utf8"));
  const ajv = new Ajv({ strict: false, validateFormats: false }); ajv.addSchema(contract, "contract");
  for (const [key, schema] of [["settings", "BotPeerSettings"], ["catalog", "BotPeerCatalog"], ["approve", "BotPeerMutation"], ["describe", "BotPeerMutation"], ["revoke", "BotPeerMutation"], ["accepted", "BotPeerMutationResult"], ["conflict", "BotPeerMutationResult"], ["exchanges", "BotPeerExchangeList"], ["detail", "BotPeerExchangeDetail"], ["waiting", "BotPeerExchangeDetail"], ["stop", "BotPeerStopMutation"], ["stopAccepted", "BotPeerStopResult"], ["stopped", "BotPeerStopResult"], ["evidence", "BotPeerEvidence"], ["peerEntry", "BotSessionEntry"], ["peerFinalEntry", "BotSessionEntry"]]) {
    const validate = ajv.compile({ $ref: `contract#/components/schemas/${schema}` }); assert.equal(validate(fixture[key]), true, `${key}: ${ajv.errorsText(validate.errors)}`);
    assert.equal(validate({ ...fixture[key], privateAuthority: "caller choice" }), false, key);
  }
  const entry = ajv.compile({ $ref: "contract#/components/schemas/BotSessionEntry" }); assert.equal(entry({ ...fixture.peerEntry, final: true }), false);
  const feed = { notifications: [fixture.peerNotification], now: fixture.peerNotification.finishedAt };
  const validateFeed = ajv.compile({ $ref: "contract#/components/schemas/BotRoutineNotificationList" }); assert.equal(validateFeed(feed), true);
  assert.equal(validateFeed({ ...feed, notifications: [{ ...fixture.peerNotification, routineId: "fake_routine" }] }), false);
  assert.deepEqual(parseAidenRemoteBotRoutineNotificationList(feed), feed);
  assert.throws(() => parseAidenRemoteBotRoutineNotificationList({ ...feed, notifications: [{ ...fixture.peerNotification, status: "succeeded" }] }));
  const session = { botId: fixture.settings.botId, epoch: "peer_epoch", seq: 1, state: "idle", interrupted: false, entries: [fixture.peerEntry, fixture.peerFinalEntry], hasOlder: false, question: null, approval: null };
  assert.deepEqual(parseAidenRemoteBotSession(session).entries, session.entries);
  assert.throws(() => parseAidenRemoteBotSession({ ...session, entries: [{ ...fixture.peerEntry, final: true }] }));
});
