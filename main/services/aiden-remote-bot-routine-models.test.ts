import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { AIDEN_REMOTE_CONTRACT_REVISION } from "./aiden-remote-protocol.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createAidenRemoteRequestHandler, type AidenRemoteRouterDependencies } from "./aiden-remote-router.js";
import type { BotRoutineModelSave, BotRoutineModelSettings } from "../../renderer/shared/bot-routine-models.js";
const base = "/bots/bot_model/routine-models/routine_model";
async function host(t: test.TestContext, options: { port?: AidenRemoteRouterDependencies["botRoutineModels"]; capabilities?: string[]; negotiated?: boolean } = {}) {
  let allowed = true;
  const handler = createAidenRemoteRequestHandler({ instanceId: "routine-model-test", displayName: () => "Host", appVersion: "0.63.0", devices: {
    authenticate: async () => ({ id: "phone_model", type: "iphone", revoked: false, acceptsBotCapabilities: options.negotiated ?? true, capabilities: new Set(options.capabilities ?? ["server:read", "bot:read", "bot:write", "chat:read", "bot:routine-models"]) as never }),
    acquireDeviceAuthorization: () => { if (!allowed) throw new Error("Device revoked."); return () => {}; },
  }, pairing: { exchange: async () => { throw new Error("Unused"); } }, connectionMode: () => "lan", now: Date.now, log() {}, botRoutineModels: options.port });
  const server = createServer(handler); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing listener.");
  return { revoke: () => { allowed = false; }, request: (path: string, method = "GET", body?: unknown, signal?: AbortSignal) => fetch(`http://127.0.0.1:${address.port}/api/aiden/v1${path}`, { method, signal, headers: { authorization: `Bearer ${"r".repeat(43)}`, "aiden-protocol-version": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) };
}
function fixture() {
  let settings: BotRoutineModelSettings = { botId: "bot_model", routineId: "routine_model", revision: "v1", selection: { mode: "inherit" }, updatedAt: 1 }, effects = 0;
  const receipts = new Set<string>(); let beforePublish = async () => {}, afterPublish = async () => {};
  const port: NonNullable<AidenRemoteRouterDependencies["botRoutineModels"]> = {
    listRoutines: async () => ({ botId: settings.botId, routines: [{ id: settings.routineId, name: "Morning review", kind: "scheduled" }] }),
    resumeStatus: async () => ({ requiresUnknownCostAcknowledgement: false }),
    read: async () => settings, catalog: async () => ({ revision: "catalog1", providers: [] }), readRuns: async () => [],
    save: async (input, lifetime) => {
      await beforePublish(); await lifetime!.assertCurrent();
      const replayed = receipts.has(input.mutationId);
      if (!replayed) { effects++; receipts.add(input.mutationId); settings = { ...settings, revision: "v2", selection: input.selection, lastMutationId: input.mutationId }; }
      await afterPublish(); return { ok: true, mutationId: input.mutationId, replayed, settings };
    },
  };
  return { port, get effects() { return effects; }, before: (callback: () => Promise<void>) => { beforePublish = callback; }, after: (callback: () => Promise<void>) => { afterPublish = callback; } };
}
const save = (): BotRoutineModelSave => ({ botId: "bot_model", routineId: "routine_model", mutationId: randomUUID(), expectedRevision: "v1", catalogRevision: "catalog1", selection: { mode: "inherit" } });

test("routine model routes require complete wiring, negotiation and current read/write grants", async (t) => {
  const f = fixture();
  for (const [port, negotiated, advertised] of [[f.port, true, true], [undefined, true, false], [f.port, false, false]] as const) {
    const server = await host(t, { port, negotiated }); const info = await (await server.request("/server")).json();
    assert.equal((info.serverCapabilities ?? []).includes("bot:routine-models"), advertised);
  }
  const reader = await host(t, { port: f.port, capabilities: ["bot:read", "chat:read", "bot:routine-models"] });
  assert.equal((await reader.request(base)).status, 200);
  assert.equal((await reader.request(base + "/runs")).status, 200);
  assert.equal((await reader.request("/bots/bot_model/routine-models")).status, 200);
  assert.equal((await reader.request("/bots/bot_model/routine-resume-status")).status, 403);
  assert.equal((await reader.request(base + "/catalog")).status, 403);
  assert.equal((await reader.request(base, "POST", save())).status, 403);
  const hidden = await host(t, { port: f.port, capabilities: ["bot:read", "bot:write", "bot:routine-models"] });
  assert.equal((await hidden.request(base)).status, 403); assert.equal(f.effects, 0);
});
test("a phone cannot author a grant or redirect its model save to another routine", async (t) => {
  const f = fixture(), server = await host(t, { port: f.port });
  assert.equal((await server.request(base, "POST", { ...save(), grant: { exactFingerprint: "forged" } })).status, 400);
  assert.equal((await server.request(base, "POST", { ...save(), routineId: "other" })).status, 400);
  assert.equal((await server.request(base + "?provider=other")).status, 400); assert.equal(f.effects, 0);
});
test("device revocation before grant publication prevents a late save", async (t) => {
  const f = fixture(); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  f.before(async () => { entered(); await gate; }); const server = await host(t, { port: f.port });
  const pending = server.request(base, "POST", save()); await ready; server.revoke(); release();
  assert.notEqual((await pending).status, 200); assert.equal(f.effects, 0);
});
test("disconnect after publication retains one accepted grant and replays its same identity", async (t) => {
  const f = fixture(); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; }); let first = true;
  f.after(async () => { if (first) { first = false; entered(); await gate; } });
  const server = await host(t, { port: f.port }), input = save(), controller = new AbortController();
  const pending = server.request(base, "POST", input, controller.signal).catch(() => undefined);
  await ready; controller.abort(); await pending; release();
  const response = await server.request(base, "POST", input), result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.mutationId, input.mutationId); assert.equal(result.replayed, true); assert.equal(f.effects, 1);
  assert.equal((await (await server.request(base)).json()).lastMutationId, input.mutationId);
});

test("normative model settings, fallback and run evidence satisfy their closed wire schemas", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/fixtures/bot-routine-models.json", import.meta.url), "utf8"));
  assert.equal(fixture.contractRevision, AIDEN_REMOTE_CONTRACT_REVISION);
  const schema = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/openapi.json", import.meta.url), "utf8"));
  const ajv = new Ajv({ strict: false, validateFormats: false }); ajv.addSchema(schema, "contract");
  for (const [key, name] of [["settings", "BotRoutineModelSettings"], ["inherit", "BotRoutineModelSettings"], ["save", "BotRoutineModelSave"], ["catalog", "BotRoutineModelCatalog"], ["result", "BotRoutineModelResult"], ["conflict", "BotRoutineModelResult"], ["runs", "BotRoutineModelRuns"], ["resumeStatus", "BotExecutionResumeStatus"], ["resume", "BotResumeRequest"], ["directory", "BotRoutineModelDirectory"]]) {
    const validate = ajv.compile({ $ref: `contract#/components/schemas/${name}` });
    assert.equal(validate(fixture[key]), true, `${key}: ${ajv.errorsText(validate.errors)}`);
  }
  const save = ajv.compile({ $ref: "contract#/components/schemas/BotRoutineModelSave" });
  assert.equal(save({ ...fixture.save, privateBinding: { provider: "forged" } }), false);
  const resume = ajv.compile({ $ref: "contract#/components/schemas/BotResumeRequest" });
  const missingReceipt = { ...fixture.resume }; delete missingReceipt.expectedCostReceiptId;
  assert.equal(resume(missingReceipt), false);
  assert.equal(resume({ ...fixture.resume, expectedCostReceiptId: "private-dispatch-id" }), false);
  const status = ajv.compile({ $ref: "contract#/components/schemas/BotExecutionResumeStatus" });
  const missingStatusReceipt = { ...fixture.resumeStatus }; delete missingStatusReceipt.costReceiptId;
  assert.equal(status(missingStatusReceipt), false);
  assert.equal(status({ requiresUnknownCostAcknowledgement: false, costReceiptId: fixture.resumeStatus.costReceiptId }), false);
  const runs = ajv.compile({ $ref: "contract#/components/schemas/BotRoutineModelRuns" });
  const missingTimezone = structuredClone(fixture.runs); delete missingTimezone[0].timezone;
  assert.equal(runs(missingTimezone), false);
  assert.equal(fixture.runs[0].submissionId, "9007199254740993", "run provenance preserves IDs beyond Number precision");
});
