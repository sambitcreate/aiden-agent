import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { createAidenRemoteRequestHandler, type AidenRemoteRouterDependencies } from "./aiden-remote-router.js";
import { AIDEN_REMOTE_CONTRACT_REVISION, type AidenRemoteCapability } from "./aiden-remote-protocol.js";
import { createBotOpenWorkStore } from "./bot-open-work/store.js";
import { createBotOpenWorkService } from "./bot-open-work/service.js";

const fixture = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/fixtures/bot-open-work.json", import.meta.url), "utf8"));
const token = "o".repeat(43);
async function host(t: test.TestContext, options: { capabilities?: AidenRemoteCapability[]; negotiated?: boolean; port?: AidenRemoteRouterDependencies["botOpenWork"] } = {}) {
  const handler = createAidenRemoteRequestHandler({ instanceId: "open-work-test", displayName: () => "Host", appVersion: "0.63.0", devices: {
    authenticate: async () => ({ id: "device-open-work", type: "iphone", revoked: false, acceptsBotCapabilities: options.negotiated ?? true,
      capabilities: new Set(options.capabilities ?? ["server:read", "bot:read", "chat:read", "bot:write", "bot:open-work"]) }), acquireDeviceAuthorization: () => () => {},
  }, pairing: { exchange: async () => { throw new Error("unused"); } }, connectionMode: () => "lan", now: Date.now, log() {}, botOpenWork: options.port });
  const server = createServer(handler); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing listener");
  return { request: (resource: string, method = "GET", body?: unknown, signal?: AbortSignal) => fetch(`http://127.0.0.1:${address.port}/api/aiden/v1${resource}`, { method, signal, headers: { authorization: `Bearer ${token}`, "aiden-protocol-version": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) };
}
function portable(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-open-work-remote-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  return createBotOpenWorkService({ store: createBotOpenWorkStore({ profileDir: () => root, botExists: async () => true }), execution: { inspect: async () => ({ kind: "missing" }), stop: async () => "not_running" } });
}
test("Open work opt-in is advertised only with complete ports; task contents require chat visibility", async (t) => {
  assert.equal(AIDEN_REMOTE_CONTRACT_REVISION, fixture.contractRevision);
  const service = portable(t);
  for (const [port, negotiated, expected] of [[service, true, true], [undefined, true, false], [service, false, false]] as const) {
    const server = await host(t, { port, negotiated }); const response = await server.request("/server"); const info = await response.json();
    assert.equal((info.serverCapabilities ?? []).includes("bot:open-work"), expected);
  }
  const hidden = await host(t, { port: service, capabilities: ["bot:read", "bot:write", "bot:open-work"] });
  assert.equal((await hidden.request("/bots/bot_test/open-work")).status, 403);
  const absent = await host(t); assert.equal((await absent.request("/bots/bot_test/open-work")).status, 404);
});
test("actual HTTP edits return current state on stale revisions, preserve Undo and reject forged provenance", async (t) => {
  const service = portable(t); const server = await host(t, { port: service });
  const snapshot = await (await server.request("/bots/bot_test/open-work")).json();
  const add = { action: "add", mutationId: randomUUID(), expectedRevision: snapshot.revision, title: "Review the brief" };
  const added = await (await server.request("/bots/bot_test/open-work", "POST", add)).json(); assert.equal(added.ok, true); assert.equal(added.snapshot.items.length, 1);
  const current = added.snapshot.items[0];
  const changed = await (await server.request("/bots/bot_test/open-work", "POST", { action: "edit", mutationId: randomUUID(), id: current.id, expectedRevision: current.revision, patch: { state: "waiting", waitingReason: "Waiting for an answer" } })).json();
  assert.equal(changed.ok, true); assert.equal(changed.snapshot.items[0].state, "waiting");
  const stale = await (await server.request("/bots/bot_test/open-work", "POST", { action: "dismiss", mutationId: randomUUID(), id: current.id, expectedRevision: current.revision })).json();
  assert.equal(stale.ok, false); assert.equal(stale.code, "stale"); assert.equal(stale.snapshot.items[0].state, "waiting");
  assert.equal((await server.request("/bots/bot_test/open-work", "POST", { ...add, source: { entryId: "999" } })).status, 400);
  assert.equal((await server.request(`/bots/bot_test/open-work/${current.id}/evidence/source`)).status, 404);
  const undone = await (await server.request("/bots/bot_test/open-work", "POST", { action: "undo", mutationId: randomUUID(), undoOf: changed.undo.mutationId, expectedRevision: changed.undo.expectedRevision })).json();
  assert.equal(undone.ok, true); assert.equal(undone.snapshot.items[0].state, "open");
});
test("HTTP disconnect after an accepted Add preserves its exact replay identity and does not duplicate it", async (t) => {
  const service = portable(t); let committed!: () => void; const ready = new Promise<void>((resolve) => { committed = resolve; }); let respond!: () => void; const wait = new Promise<void>((resolve) => { respond = resolve; }); let first = true;
  const server = await host(t, { port: { ...service, mutateByPerson: async (botId, mutation) => { const result = await service.mutateByPerson(botId, mutation); if (first) { first = false; committed(); await wait; } return result; } } });
  const before = await service.snapshot("bot_test"); const add = { action: "add", mutationId: randomUUID(), expectedRevision: before.revision, title: "Keep one durable record" };
  const controller = new AbortController(); const response = server.request("/bots/bot_test/open-work", "POST", add, controller.signal).catch(() => undefined);
  await ready; controller.abort(); await response; respond();
  const replay = await (await server.request("/bots/bot_test/open-work", "POST", add)).json();
  assert.equal(replay.ok, true); assert.equal(replay.replayed, true); assert.equal(replay.snapshot.items.length, 1); assert.equal(replay.mutationId, add.mutationId);
});
test("evidence resolves the selected item's host-owned source and transports the full escaped text boundary", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-open-work-evidence-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  let reads = 0;
  const service = createBotOpenWorkService({ store: createBotOpenWorkStore({ profileDir: () => root, botExists: async () => true }), execution: {
    inspect: async () => ({ kind: "missing" }), stop: async () => "not_running", evidence: async (_bot, submissionId) => {
      reads++; return { submissionId, entryId: submissionId === "10" ? "11" : "21", text: submissionId === "10" ? "\u0001".repeat(32768) : "Another item's source", truncated: false };
    },
  } });
  const ids: string[] = [];
  for (const [title, submissionId, entryId] of [["Task A", "10", "11"], ["Task B", "20", "21"]]) {
    const before = await service.toolSnapshot("bot_test");
    const result = await service.mutateByBot("bot_test", { action: "add", mutationId: randomUUID(), expectedRevision: before.revision, title: title! }, { requestId: `person-${submissionId}`, source: { kind: "person", submissionId: submissionId!, entryId: entryId! } });
    assert.equal(result.ok, true); if (result.ok) ids.push(result.itemId!);
  }
  const server = await host(t, { port: service });
  const response = await server.request(`/bots/bot_test/open-work/${ids[0]}/evidence/source`); const text = await response.text(); const evidence = JSON.parse(text);
  assert.equal(response.status, 200); assert.equal(evidence.itemId, ids[0]); assert.equal(evidence.submissionId, "10"); assert.equal(evidence.entryId, "11");
  assert.equal(evidence.text, "\u0001".repeat(32768)); assert.equal(evidence.truncated, false); assert.ok(Buffer.byteLength(text) < 256 * 1024);
  const before = reads;
  assert.equal((await server.request(`/bots/bot_test/open-work/${ids[0]}/evidence/source?entryId=21`)).status, 400);
  assert.equal((await server.request("/bots/bot_test/open-work/unknown-item/evidence/source")).status, 404);
  assert.equal(reads, before, "caller IDs cannot select another item’s source entry");
});
test("normative Open work and evidence fixtures satisfy the closed OpenAPI contracts", () => {
  const schema = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/openapi.json", import.meta.url), "utf8")); const ajv = new Ajv({ strict: false, validateFormats: false }); ajv.addSchema(schema, "contract");
  for (const [key, name] of [["snapshot", "BotOpenWorkSnapshot"], ["item", "BotOpenWorkItem"], ["result", "BotOpenWorkResult"], ["stale", "BotOpenWorkResult"], ["evidenceSource", "BotOpenWorkEvidence"], ["evidenceResult", "BotOpenWorkEvidence"]]) {
    const validate = ajv.compile({ $ref: `contract#/components/schemas/${name}` }); assert.equal(validate(fixture[key]), true, `${key}: ${ajv.errorsText(validate.errors)}`);
  }
});
