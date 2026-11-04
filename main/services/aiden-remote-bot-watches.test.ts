import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Ajv from "ajv";
import { createAidenRemoteRequestHandler, type AidenRemoteRouterDependencies } from "./aiden-remote-router.js";
import { AIDEN_REMOTE_CONTRACT_REVISION, type AidenRemoteCapability } from "./aiden-remote-protocol.js";
import { BotConnectorWatchError, createBotConnectorWatchService } from "./bot-routine-events/connector-service.js";
import { createBotEventRoutineStore } from "./bot-routine-events/store.js";
import type { BotConnectorWatchBinding } from "./bot-routine-events/connector-types.js";
import { electronConnectorWatchRemotePorts } from "./bot-routine-events/connector-watch-startup.js";
import { hostPlatformCapabilities } from "./host-platform-capabilities.js";

const fixture = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/fixtures/bot-watches.json", import.meta.url), "utf8"));
const token = "a".repeat(43);
async function server(t: test.TestContext, options: { host?: { bots: boolean }; wired?: boolean; capabilities?: AidenRemoteCapability[]; accepted?: boolean; watches?: NonNullable<AidenRemoteRouterDependencies["botWatches"]>; authorization?: { revoked: boolean; capabilities: AidenRemoteCapability[] } } = {}) {
  let calls = 0;
  let loads = 0;
  const watches: NonNullable<AidenRemoteRouterDependencies["botWatches"]> = {
    list: async () => { calls++; return structuredClone(fixture.list); },
    discoverSources: async () => { calls++; return structuredClone(fixture.sources); },
    create: async (input) => { calls++; if (input.condition.kind !== "email") throw new BotConnectorWatchError("invalid_request", "Calendar is gated."); return { ...structuredClone(fixture.watch), id: input.mutationId, botId: input.botId }; },
    update: async () => { throw new BotConnectorWatchError("revision_conflict", "Refresh this watch.", { currentRevision: fixture.watch.revision }); },
    setEnabled: async () => structuredClone(fixture.watch), remove: async () => structuredClone(fixture.removal), testCheck: async () => structuredClone(fixture.test), runNow: async () => structuredClone(fixture.run),
  };
  const watchPorts = options.host ? await electronConnectorWatchRemotePorts(options.host, async () => { loads++; return options.watches ?? watches; })
    : options.wired === false ? {} : { botWatches: options.watches ?? watches };
  const handler = createAidenRemoteRequestHandler({ instanceId: "instance-test", displayName: () => "Host", appVersion: "0.63.0", devices: {
    acquireDeviceAuthorization: () => () => {}, authenticate: async (credential) => credential === token ? { id: "device-test", type: "iphone", revoked: options.authorization?.revoked ?? false, acceptsBotCapabilities: options.accepted ?? true,
      capabilities: new Set(options.authorization?.capabilities ?? options.capabilities ?? ["server:read", "bot:read", "bot:write", "bot:watches"]) } : null,
  }, pairing: { exchange: async () => { throw new Error("unused"); } }, connectionMode: () => "lan", now: Date.now, log() {}, ...watchPorts });
  const app = createServer(handler); await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { app.close(() => resolve()); app.closeAllConnections(); }));
  const address = app.address(); if (!address || typeof address === "string") throw new Error("No listener");
  return { calls: () => calls, loads: () => loads, request: (path: string, method = "GET", body?: unknown, signal?: AbortSignal) => fetch(`http://127.0.0.1:${address.port}/api/aiden/v1${path}`, { method, signal, headers: { authorization: `Bearer ${token}`, "aiden-protocol-version": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) };
}

test("Electron watch routes are available on Mac and Linux Bots hosts without loading them on unsupported hosts", async (t) => {
  for (const host of [hostPlatformCapabilities("darwin", "arm64"), hostPlatformCapabilities("linux", "x64"), hostPlatformCapabilities("linux", "arm64"), hostPlatformCapabilities("win32", "x64"), { bots: false }]) {
    const api = await server(t, { host });
    const info = await (await api.request("/server")).json();
    assert.equal(info.serverCapabilities.includes("bot:watches"), host.bots);
    assert.equal(api.loads(), host.bots ? 1 : 0);
    assert.equal(api.calls(), 0, "loading route ports and negotiating never discovers or reads a source");
    const response = await api.request("/bots/bot_fixture/watches");
    assert.equal(response.status, host.bots ? 200 : 404);
    assert.equal(api.calls(), host.bots ? 1 : 0);
  }
});

test("new watch capability is advertised only with complete host routes and a Bot-negotiating device", async (t) => {
  assert.equal(AIDEN_REMOTE_CONTRACT_REVISION, fixture.contractRevision);
  for (const options of [{}, { wired: false }, { accepted: false }]) {
    const host = await server(t, options); const response = await host.request("/server"); const data = await response.json();
    assert.equal(response.status, 200); assert.equal((data.serverCapabilities ?? []).includes("bot:watches"), options.wired !== false && options.accepted !== false);
  }
});

test("watch routes require both negotiated watch visibility and existing read/write grants before source calls", async (t) => {
  const old = await server(t, { capabilities: ["bot:read", "bot:write"] });
  assert.equal((await old.request("/bots/bot_fixture/watches")).status, 403); assert.equal(old.calls(), 0);
  const read = await server(t, { capabilities: ["bot:read", "bot:watches"] });
  assert.equal((await read.request("/bots/bot_fixture/watches")).status, 200);
  assert.equal((await read.request("/bots/bot_fixture/watches/sources", "POST", {})).status, 403); assert.equal(read.calls(), 1);
  const withheld = await server(t, { wired: false }); assert.equal((await withheld.request("/bots/bot_fixture/watches")).status, 404);
});

test("source discovery is explicit, wire bodies cannot smuggle raw operations or another Bot, and conflicts are definitive", async (t) => {
  const host = await server(t); const list = await host.request("/bots/bot_fixture/watches"); assert.deepEqual(await list.json(), fixture.list);
  const sources = await host.request("/bots/bot_fixture/watches/sources", "POST", {}); assert.deepEqual(await sources.json(), fixture.sources);
  const before = host.calls();
  for (const extra of [{ tool: "MULTI_EXECUTE", arguments: {} }, { botId: "another-bot" }]) {
    const response = await host.request("/bots/bot_fixture/watches", "POST", { ...extra, mutationId: fixture.watch.id, sourceChoiceId: fixture.sources.choices[0].id, name: "Test", prompt: "Tell me.", condition: { kind: "email", unreadOnly: false }, everyMinutes: 15 });
    assert.equal(response.status, 400);
  }
  assert.equal(host.calls(), before, "invalid raw operations never reach the connector service");
  const conflict = await host.request(`/bots/bot_fixture/watches/${fixture.watch.id}`, "PATCH", { expectedRevision: "1", mutationId: fixture.watch.id, name: "Test", prompt: "Tell me.", condition: { kind: "email", unreadOnly: false }, everyMinutes: 15 });
  const body = await conflict.json(); assert.equal(conflict.status, 409); assert.equal(body.error.code, "revision_conflict"); assert.equal(body.error.details.currentRevision, fixture.watch.revision); assert.equal(typeof body.error.requestId, "string");
});

test("shared synthetic watch fixtures satisfy the actual closed OpenAPI response contracts", () => {
  const schema = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/openapi.json", import.meta.url), "utf8"));
  const ajv = new Ajv({ strict: false, validateFormats: false }); ajv.addSchema(schema, "contract");
  for (const [key, name] of [["list", "BotConnectorWatchList"], ["sources", "BotConnectorWatchSourceList"], ["watch", "BotConnectorWatch"], ["test", "BotConnectorWatchTestResult"], ["removal", "BotConnectorWatchRemoval"], ["run", "BotConnectorWatchRunResult"]]) {
    const validate = ajv.compile({ $ref: `contract#/components/schemas/${name}` });
    assert.equal(validate(fixture[key]), true, `${key}: ${ajv.errorsText(validate.errors)}`);
  }
  const validate = ajv.compile({ $ref: "contract#/components/schemas/BotConnectorWatch" });
  assert.equal(validate({ ...fixture.watch, binding: { account: "private" } }), false, "private binding fields are forbidden on the wire");
});


test("Remote watch requests admit the full UTF-16 prompt contract in UTF-8 and escaped JSON", async (t) => {
  const host = await server(t);
  for (const prompt of ["界".repeat(22_000), "\u0001".repeat(32_768)]) {
    const response = await host.request("/bots/bot_fixture/watches", "POST", { mutationId: fixture.watch.id, sourceChoiceId: fixture.sources.choices[0].id, name: "Project", prompt, condition: { kind: "email", unreadOnly: false }, everyMinutes: 15 });
    assert.equal(response.status, 201); assert.equal((await response.json()).id, fixture.watch.id);
  }
  assert.equal(host.calls(), 2);
});

test("real watch creation refuses aggregate CJK/escaped prompt overflow before accepted GET responses hit the Remote limit", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-remote-watch-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding: BotConnectorWatchBinding = { adapter: "imcp-mail-v1", serverId: "synthetic-imcp", account: "synthetic-account", mailbox: "synthetic-inbox",
    connection: { sourceId: "synthetic-imcp", connectionFingerprint: "connection", toolsetFingerprint: "toolset", exactFingerprint: "exact", tools: [] },
    tools: ["mail_mailboxes_list", "mail_messages_search"].map((name) => ({ name, toolId: name, effect: "read", inputSchemaFingerprint: "input", outputSchemaFingerprint: "output", effectFingerprint: "read", exactFingerprint: name })),
    labels: { providerLabel: "Mail", accountLabel: "person@example.test", resourceLabel: "Inbox" } };
  const store = createBotEventRoutineStore({ profileDir: () => root });
  const watches = createBotConnectorWatchService({ store, supported: () => true, knownBot: async () => true,
    discover: async () => ({ bindings: [binding], unavailableReasons: [] }), withPort: async () => { throw new Error("a config write must not read Mail"); },
    authorize: async () => ({ signal: new AbortController().signal, release() {} }), dispatcher: { emit: async () => "queued" }, changed() {}, isPaused: async () => false, now: Date.now });
  const host = await server(t, { watches });
  const sourceResponse = await host.request("/bots/bot_test/watches/sources", "POST", {}); const sources = await sourceResponse.json();
  const create = (index: number) => host.request("/bots/bot_test/watches", "POST", { mutationId: randomUUID(), sourceChoiceId: sources.choices[0].id,
    name: `Project ${index}`, prompt: (index % 2 ? "\u0001" : "界").repeat(32_768), condition: { kind: "email", unreadOnly: false }, everyMinutes: 15 });
  const responses = [await create(0), await create(1), ...await Promise.all(Array.from({ length: 14 }, (_, index) => create(index + 2)))];
  const accepted = responses.filter((response) => response.status === 201);
  assert.ok(accepted.length >= 2 && accepted.length < 16);
  for (const response of responses) {
    const data = await response.json();
    if (response.status !== 201) { assert.equal(response.status, 400); assert.equal(data.error.code, "invalid_request"); assert.match(data.error.message, /Shorten/); }
  }
  const response = await host.request("/bots/bot_test/watches"); const text = await response.text();
  assert.equal(response.status, 200); assert.ok(Buffer.byteLength(text, "utf8") <= 900 * 1024);
  const list = JSON.parse(text); assert.equal(list.watches.length, accepted.length);
  assert.ok(list.watches.some((row: { prompt: string }) => row.prompt === "界".repeat(32_768)));
  assert.ok(list.watches.some((row: { prompt: string }) => row.prompt === "\u0001".repeat(32_768)));
  assert.ok(Buffer.byteLength(text, "utf8") > 850 * 1024, "the accepted list is close to the configuration cap");
  for (const row of await store.list("bot_test")) await store.mutate("bot_test", row.id, (fresh) => ({ next: { ...fresh, lastRunAt: 1_793_718_000_000,
    watch: { ...fresh.watch!, lastCheckAt: 1_793_718_000_000, nextCheckAt: 1_793_718_900_000, lastResult: "error", lastError: "\u0001".repeat(200) } }, result: undefined }));
  const healthResponse = await host.request("/bots/bot_test/watches"); const healthText = await healthResponse.text();
  assert.equal(healthResponse.status, 200); assert.ok(Buffer.byteLength(healthText, "utf8") > Buffer.byteLength(text, "utf8"));
  assert.ok(Buffer.byteLength(healthText, "utf8") < 1_048_576); assert.equal(JSON.parse(healthText).watches.length, accepted.length);
  for (const row of await store.list("bot_test")) await store.mutate("bot_test", row.id, (fresh) => ({ next: { ...fresh, prompt: "\u0001".repeat(32_768) }, result: undefined }));
  const oversized = await host.request("/bots/bot_test/watches"); const error = await oversized.json();
  assert.equal(oversized.status, 403); assert.equal(error.error.code, "capability_denied"); assert.match(error.error.message, /backup|support/);
});

test("real HTTP source discovery stops metadata and publication after revocation, capability loss or disconnect", async (t) => {
  for (const change of ["revoked", "capability", "disconnect"] as const) {
    const root = mkdtempSync(path.join(os.tmpdir(), "aiden-watch-discovery-lifetime-")); t.after(() => rmSync(root, { recursive: true, force: true }));
    let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
    let finished!: () => void; const done = new Promise<void>((resolve) => { finished = resolve; });
    let metadataCalls = 0; let published = 0; let discoverySignal: AbortSignal | undefined;
    const authorization = { revoked: false, capabilities: ["bot:read", "bot:write", "bot:watches"] as AidenRemoteCapability[] };
    const watches = createBotConnectorWatchService({ store: createBotEventRoutineStore({ profileDir: () => root }), supported: () => true, knownBot: async () => true, isPaused: async () => false,
      changed() {}, now: Date.now, dispatcher: { emit: async () => "queued" }, authorize: async () => { throw new Error("unused"); }, withPort: async () => { throw new Error("unused"); },
      discover: async (_bot, signal, current) => { discoverySignal = signal; try { await current(); metadataCalls++; started(); await blocked; await current(); metadataCalls++; published++; return { bindings: [], unavailableReasons: [] }; } finally { finished(); } },
    });
    const host = await server(t, { watches, authorization }); const controller = new AbortController();
    const result = host.request("/bots/bot_test/watches/sources", "POST", {}, controller.signal).then((response) => response, () => undefined);
    await entered;
    if (change === "revoked") authorization.revoked = true;
    else if (change === "capability") authorization.capabilities = ["bot:read", "bot:watches"];
    else {
      const disconnected = new Promise<void>((resolve) => discoverySignal!.addEventListener("abort", () => resolve(), { once: true }));
      controller.abort(); await disconnected;
    }
    release(); await done; const response = await result;
    if (change === "disconnect") assert.equal(discoverySignal!.aborted, true);
    else assert.equal(response!.status, 403);
    assert.equal(metadataCalls, 1); assert.equal(published, 0);
  }
});
