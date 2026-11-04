import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBotConnectorWatchService, type BotConnectorWatchServicePorts } from "./connector-service.js";
import { createBotEventRoutineStore } from "./store.js";
import { createBotWatches } from "./watch.js";
import type { BotConnectorWatchBinding } from "./connector-types.js";
import type { BotConnectorWatchCreateInput } from "../../../renderer/shared/bot-connector-watches.js";
import { eventRoutineAfterRun } from "./after-run.js";
import { createBotEventRunner, eventRoutineTask } from "./runner.js";
import { eventRoutinesToolSource } from "../bot-runtime/bot-tool-candidates.js";
import { createBotRoutinesTool } from "../schedule-tool.js";
import type { ScheduledRun } from "../types.js";
import { botConnectorExecutionRestriction, botConnectorInventoryServer, withBotConnectorExecutionRestriction } from "../bot-connector-inventory-scope.js";
import { createBotMcpScopeCache, resolveBotMcpInventory } from "../bot-mcp-inventory.js";

const BOT = "bot_test";
const binding: BotConnectorWatchBinding = { adapter: "imcp-mail-v1", serverId: "private-imcp-id", mailbox: "V10:12", account: "private-account-id", connection: { sourceId: "private-imcp-id", connectionFingerprint: "private-fingerprint", toolsetFingerprint: "private-toolset", exactFingerprint: "private-exact", tools: [] }, tools: [
  { name: "mail_mailboxes_list", toolId: "one", effect: "read", inputSchemaFingerprint: "schema-one", outputSchemaFingerprint: "no-schema", effectFingerprint: "read", exactFingerprint: "exact-one" },
  { name: "mail_messages_search", toolId: "two", effect: "read", inputSchemaFingerprint: "schema-two", outputSchemaFingerprint: "no-schema", effectFingerprint: "read", exactFingerprint: "exact-two" },
], labels: { providerLabel: "iMCP Mail", accountLabel: "person@example.test", resourceLabel: "Inbox" } };
function message(id: string) { return { "@id": id, mailbox: "V10:12", subject: `Project ${id}`, sender: { email: "sender@example.test" }, dateReceived: "2026-11-03T14:00:00Z", isRead: false }; }
function fixture(t: test.TestContext, overrides: Partial<BotConnectorWatchServicePorts> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-connector-service-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 1_793_718_000_000; let allowed = true; let exists = true; let messages = [message("first")]; let reads = 0; let discovery = 0;
  const events: string[] = [];
  const store = createBotEventRoutineStore({ profileDir: () => root, now: () => now });
  const ports: BotConnectorWatchServicePorts = { store, supported: () => true, knownBot: async () => exists,
    discover: async () => { discovery++; return { bindings: [structuredClone(binding)], unavailableReasons: ["Calendar is gated."] }; },
    withPort: async (_bot, _binding, _signal, action) => action({ assertEligible: async (_tool, signal) => { signal.throwIfAborted(); if (!allowed) throw new Error("revoked"); }, call: async (tool) => {
      reads++;
      return tool === "mail_mailboxes_list" ? { "@context": "https://schema.org", "@type": "ItemList", itemListElement: [{ "@id": "V10:12", account: { "@id": "private-account-id" } }] }
        : { "@context": "https://schema.org", "@type": "ItemList", itemListElement: messages, nextCursor: null, localIndex: { indexedMessageCount: messages.length, syncStatus: "unknown" } };
    } }),
    authorize: async () => { if (!allowed) throw new Error("revoked"); return { signal: new AbortController().signal, release() {} }; },
    dispatcher: { emit: async (_bot, _id, event) => { events.push(event.eventId); return "queued"; } }, changed() {}, isPaused: async () => false, now: () => now, ...overrides };
  const make = () => createBotConnectorWatchService(ports);
  return { store, ports, make, events, now: () => now, advance: (ms: number) => { now += ms; }, revoke: () => { allowed = false; }, deleteBot: () => { exists = false; }, setMessages: (ids: string[]) => { messages = ids.map(message); }, reads: () => reads, discoveries: () => discovery };
}
async function create(service: ReturnType<typeof createBotConnectorWatchService>) {
  const sources = await service.discoverSources(BOT);
  const input: BotConnectorWatchCreateInput = { botId: BOT, mutationId: randomUUID(), sourceChoiceId: sources.choices[0]!.id, name: "Project mail", prompt: "Summarize project updates.", condition: { kind: "email", unreadOnly: false }, everyMinutes: 15 };
  return { input, view: await service.create(input) };
}

test("list/startup never discover or read; explicit source options are opaque and create is stable across restart", async (t) => {
  const f = fixture(t); let service = f.make();
  assert.deepEqual((await service.list(BOT)).watches, []); assert.equal(f.reads(), 0); assert.equal(f.discoveries(), 0);
  const result = await create(service);
  assert.equal(result.view.id, result.input.mutationId);
  assert.equal(f.reads(), 0, "saving consent arms a later check rather than immediately reading Mail");
  service = f.make();
  assert.deepEqual(await service.create(result.input), result.view);
  const json = JSON.stringify(await service.list(BOT));
  for (const privateText of ["private-account-id", "private-imcp-id", "private-fingerprint", "mail_messages_search", "V10:12"]) assert.equal(json.includes(privateText), false);
  assert.equal((await service.list(BOT)).templates.find((row) => row.kind === "calendar")!.available, false);
});

test("semantic checks establish baseline, ignore disappearance, and atomically hand off one new message", async (t) => {
  const f = fixture(t); const service = f.make(); const { view } = await create(service);
  const timers: (() => void)[] = [];
  const watches = createBotWatches({ store: f.store, routines: () => f.store.all(), check: service.check, dispatcher: f.ports.dispatcher,
    authorizeDispatch: service.authorize, isPaused: async () => false, paused: async () => {}, recovered: async () => {}, now: f.now, setTimer: (run) => { timers.push(run); return { cancel() {} }; } });
  t.after(() => watches.dispose());
  assert.equal(await watches.checkNow(BOT, view.id), "baseline"); assert.equal(f.events.length, 0);
  assert.equal(await watches.checkNow(BOT, view.id), "no_change"); assert.equal(f.events.length, 0);
  f.setMessages([]); assert.equal(await watches.checkNow(BOT, view.id), "no_change"); assert.equal(f.events.length, 0);
  f.setMessages(["second"]); f.advance(15 * 60_000);
  assert.equal(await watches.checkNow(BOT, view.id), "changed"); assert.equal(f.events.length, 1);
  assert.equal((await f.store.list(BOT))[0]!.watch!.connectorBaseline!.items[0]!.id, "second");
  assert.equal((await f.store.list(BOT))[0]!.watch!.pending, undefined, "durable dispatcher ownership acknowledges only the matching pending transition");
});

test("test check previews without advancing baseline or dispatching and stale edits return current revision", async (t) => {
  const f = fixture(t); const service = f.make(); const { view } = await create(service);
  const result = await service.testCheck({ botId: BOT, id: view.id, expectedRevision: view.revision });
  assert.equal(result.result, "baseline"); assert.equal(result.itemCount, 1); assert.deepEqual(result.preview, ["Project first"]);
  assert.equal((await f.store.list(BOT))[0]!.watch!.connectorBaseline, undefined); assert.deepEqual(f.events, []);
  const changed = await service.setEnabled({ botId: BOT, id: view.id, expectedRevision: view.revision, mutationId: randomUUID(), enabled: false });
  await assert.rejects(service.testCheck({ botId: BOT, id: view.id, expectedRevision: view.revision }), (error: unknown) => (error as { code: string; details: { currentRevision: string } }).code === "revision_conflict" && (error as { details: { currentRevision: string } }).details.currentRevision === changed.revision);
});

test("Run now reserves a durable stable event and revision before dispatch; retry and expired receipt cannot repeat", async (t) => {
  let failAfterReservation = true;
  const f = fixture(t, { dispatcher: { emit: async () => { if (failAfterReservation) throw new Error("process died after pending reservation"); return "queued"; } } });
  const { view } = await create(f.make()); const input = { botId: BOT, id: view.id, expectedRevision: view.revision, mutationId: randomUUID() };
  await assert.rejects(f.make().runNow(input), /process died/);
  const reserved = (await f.store.list(BOT))[0]!;
  assert.notEqual(String(reserved.updatedAt), input.expectedRevision); assert.ok(reserved.watch!.pending); assert.equal(reserved.connector!.mutations.length, 1);
  failAfterReservation = false;
  const replay = await f.make().runNow(input); assert.equal(replay.admitted, true); assert.equal(replay.revision, String(reserved.updatedAt));
  f.advance(2 * 86_400_000);
  await f.store.mutate(BOT, view.id, (row) => ({ next: { ...row, connector: { ...row.connector!, mutations: [] } }, result: undefined }));
  await assert.rejects(f.make().runNow(input), (error: unknown) => (error as { code: string }).code === "revision_conflict");
});

test("full edits, pause/resume and deletion are revisioned, replayable and never resurrect a deleted watch", async (t) => {
  const f = fixture(t); const service = f.make(); const { input, view } = await create(service);
  const edit = { ...input, id: view.id, expectedRevision: view.revision, mutationId: randomUUID(), name: "Renamed", subject: undefined };
  delete edit.subject;
  const updated = await service.update(edit); assert.equal(updated.name, "Renamed"); assert.notEqual(updated.revision, view.revision);
  assert.deepEqual(await f.make().update(edit), updated);
  const pauseInput = { botId: BOT, id: view.id, expectedRevision: updated.revision, mutationId: randomUUID(), enabled: false };
  const paused = await service.setEnabled(pauseInput); assert.equal(paused.state, "paused");
  const resumed = await service.setEnabled({ ...pauseInput, expectedRevision: paused.revision, mutationId: randomUUID(), enabled: true }); assert.equal(resumed.enabled, true);
  const deletion = { botId: BOT, id: view.id, expectedRevision: resumed.revision, mutationId: randomUUID() };
  assert.equal((await service.remove(deletion)).removed, true); assert.equal((await f.make().remove(deletion)).removed, true);
  assert.deepEqual((await service.list(BOT)).watches, []);
  await assert.rejects(f.make().create(input), (error: unknown) => (error as { code: string }).code === "not_found");
});

test("revoked grants, missing Bots, unknown executable fields and expired source options refuse writes", async (t) => {
  const f = fixture(t); const service = f.make(); const { input, view } = await create(service);
  await assert.rejects(service.create({ ...input, mutationId: randomUUID(), tool: "shell" } as BotConnectorWatchCreateInput));
  f.advance(16 * 60_000); await assert.rejects(service.create({ ...input, mutationId: randomUUID() }), /expired/);
  f.revoke(); await assert.rejects(service.setEnabled({ botId: BOT, id: view.id, expectedRevision: view.revision, mutationId: randomUUID(), enabled: true }), /revoked/);
  f.deleteBot(); await assert.rejects(service.create({ ...input, mutationId: randomUUID() }), /no longer exists/);
});


test("UTF-16 prompt bounds admit CJK and fully escaped JSON at the contract boundary", async (t) => {
  const f = fixture(t); const service = f.make(); const { input } = await create(service);
  const cjk = await service.create({ ...input, mutationId: randomUUID(), prompt: "界".repeat(22_000) });
  assert.equal(cjk.prompt.length, 22_000);
  const escaped = await service.create({ ...input, mutationId: randomUUID(), prompt: "\u0001".repeat(32_768) });
  assert.equal(escaped.prompt.length, 32_768);
  await assert.rejects(service.create({ ...input, mutationId: randomUUID(), prompt: "界".repeat(32_769) }), (error: unknown) => (error as { code: string }).code === "invalid_request");
});

test("failure recovery and the actual routines tool can only pause a connector watch, preserving pending work and receipts", async (t) => {
  const f = fixture(t, { dispatcher: { emit: async () => { throw new Error("dispatch interrupted"); } } });
  const service = f.make(); const { view: created } = await create(service);
  const runInput = { botId: BOT, id: created.id, expectedRevision: created.revision, mutationId: randomUUID() };
  await assert.rejects(service.runNow(runInput), /dispatch interrupted/);
  const before = (await f.store.list(BOT))[0]!;
  const raised: string[] = []; const changed: string[] = [];
  const runs: ScheduledRun[] = [3, 2, 1].map((index) => ({ id: `run-${index}`, taskId: before.id, startedAt: index, finishedAt: index + 1,
    result: "error", output: "", failure: { kind: "temporary", code: "offline" } }));
  await eventRoutineAfterRun(eventRoutineTask(before), runs[0]!, { store: f.store, runs: async () => runs,
    changed: (id) => void changed.push(id), issues: { resolve: async () => false, raise: async (issue) => {
      raised.push(issue.kind); return { ...issue, id: randomUUID(), createdAt: f.now() };
    } } });
  const paused = (await f.store.list(BOT))[0]!;
  assert.equal(paused.enabled, false); assert.ok(paused.updatedAt > before.updatedAt);
  assert.deepEqual(raised, ["routine_paused"]); assert.deepEqual(changed, [BOT]);
  assert.deepEqual(paused.connector, before.connector, "internal pauses preserve historical mutation results and exact source binding");
  assert.equal(paused.watch!.pending!.eventId, before.watch!.pending!.eventId);
  assert.equal(paused.watch!.pending!.revision, paused.updatedAt, "the existing durable event follows the new revision");
  const resumed = await service.setEnabled({ botId: BOT, id: created.id, expectedRevision: String(paused.updatedAt), mutationId: randomUUID(), enabled: true });
  const tool = createBotRoutinesTool(BOT, { list: async () => [], pause: async () => { throw new Error("wrong routine source"); },
    propose: async () => { throw new Error("unexpected proposal"); }, eventRoutines: eventRoutinesToolSource(async () => ({ store: f.store, changed: (id) => void changed.push(id) })) });
  const result = await tool.execute("pause-call", { action: "pause", id: created.id });
  assert.ok(result.content.some((item) => item.type === "text" && JSON.parse(item.text).routine.enabled === false));
  const toolPaused = (await f.store.list(BOT))[0]!;
  assert.equal(toolPaused.enabled, false); assert.ok(toolPaused.updatedAt > Number(resumed.revision));
  assert.equal(toolPaused.watch!.pending!.revision, toolPaused.updatedAt);
  assert.deepEqual(await service.runNow(runInput), before.connector!.mutations[0]!.result, "the old run identity only replays its original receipt");
  await assert.rejects(f.store.update(BOT, created.id, { enabled: true }), /connector watch controls/);
  await assert.rejects(f.store.remove(BOT, created.id), /connector watch controls/);
});

function barrier() {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}

test("Bot pause during Mail page one forbids page two and discards foreground previews and background baselines", async (t) => {
  for (const foreground of [true, false]) {
    let paused = false; const started = barrier(); const finish = barrier(); let searchCalls = 0;
    const f = fixture(t, { isPaused: async () => paused, withPort: async (_bot, _binding, _signal, action) => action({ assertEligible: async () => {}, call: async (tool) => {
      if (tool === "mail_mailboxes_list") return { "@context": "https://schema.org", "@type": "ItemList", itemListElement: [{ "@id": binding.mailbox, account: { "@id": binding.account } }] };
      searchCalls++; started.release(); await finish.promise;
      return { "@context": "https://schema.org", "@type": "ItemList", itemListElement: [message("one")], nextCursor: "opaque-page-two", localIndex: { indexedMessageCount: 2, syncStatus: "unknown" } };
    } }) });
    const service = f.make(); const { view } = await create(service); const routine = (await f.store.list(BOT))[0]!;
    const pending = foreground ? service.testCheck({ botId: BOT, id: view.id, expectedRevision: view.revision }) : service.check(routine, new AbortController().signal);
    const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
    await started.promise; paused = true; finish.release();
    const result = await outcome;
    if (foreground) assert.ok("error" in result, "a paused test cannot return message previews");
    else { assert.ok("value" in result); assert.equal((result.value as { ok: boolean }).ok, false); }
    assert.equal(searchCalls, 1, "no second page may be read after the Bot pauses");
    assert.equal((await f.store.list(BOT))[0]!.watch!.connectorBaseline, undefined); assert.deepEqual(f.events, []);
  }
});

test("source discovery checks pause between metadata operations and explicit pause aborts the active transport signal", async (t) => {
  let paused = false; let calls = 0; const started = barrier(); const finish = barrier(); let signal: AbortSignal | undefined;
  const f = fixture(t, { isPaused: async () => paused, discover: async (_bot, activeSignal, assertActive) => {
    signal = activeSignal; await assertActive(); calls++; started.release(); await finish.promise;
    await assertActive(); calls++;
    return { bindings: [binding], unavailableReasons: [] };
  } });
  const service = f.make(); const pending = service.discoverSources(BOT);
  const outcome = pending.then(() => false, () => true);
  await started.promise; paused = true; service.pauseBot(BOT); assert.equal(signal!.aborted, true); finish.release();
  assert.equal(await outcome, true); assert.equal(calls, 1);
});

test("pause followed by resume before an old read finishes does not record a source failure or disable the watch", async (t) => {
  const started = barrier(); const finish = barrier(); let paused = false;
  const f = fixture(t, { isPaused: async () => paused, withPort: async (_bot, _binding, _signal, action) => action({ assertEligible: async () => {}, call: async (tool) => {
    if (tool === "mail_mailboxes_list") return { "@context": "https://schema.org", "@type": "ItemList", itemListElement: [{ "@id": binding.mailbox, account: { "@id": binding.account } }] };
    started.release(); await finish.promise;
    return { "@context": "https://schema.org", "@type": "ItemList", itemListElement: [message("late")], nextCursor: null, localIndex: { indexedMessageCount: 1, syncStatus: "unknown" } };
  } }) });
  const service = f.make(); const { view } = await create(service);
  const watches = createBotWatches({ store: f.store, routines: () => f.store.all(), check: service.check, dispatcher: f.ports.dispatcher,
    isPaused: async () => paused, paused: async () => { throw new Error("interruption is not a source failure"); }, recovered: async () => {}, now: f.now, setTimer: () => ({ cancel() {} }) });
  t.after(() => watches.dispose());
  const checking = watches.checkNow(BOT, view.id);
  await started.promise; paused = true; service.pauseBot(BOT); paused = false; finish.release();
  assert.equal(await checking, "skipped");
  const row = (await f.store.list(BOT))[0]!;
  assert.equal(row.enabled, true); assert.equal(row.watch!.failures, 0); assert.equal(row.watch!.lastError, undefined); assert.equal(row.watch!.connectorBaseline, undefined);
});

test("aggregate prompt capacity is atomic across service instances and refused edits leave the accepted list intact", async (t) => {
  const f = fixture(t); const first = f.make(); const second = f.make();
  const sources = await Promise.all([first.discoverSources(BOT), second.discoverSources(BOT)]);
  const results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => (index % 2 ? first : second).create({ botId: BOT,
    sourceChoiceId: sources[index % 2 ? 0 : 1]!.choices[0]!.id, mutationId: randomUUID(), name: `Mail ${index}`, prompt: (index % 2 ? "界" : "\u0001").repeat(32_768), condition: { kind: "email", unreadOnly: false }, everyMinutes: 15 })));
  const accepted = results.filter((result) => result.status === "fulfilled");
  assert.ok(accepted.length > 0 && accepted.length < 16);
  for (const result of results) if (result.status === "rejected") assert.equal((result.reason as { code: string }).code, "invalid_request");
  const list = await first.list(BOT); assert.equal(list.watches.length, accepted.length);
  assert.ok(Buffer.byteLength(JSON.stringify(list), "utf8") <= 900 * 1024);
  const target = list.watches.find((row) => row.prompt.startsWith("界"))!;
  const changed = { ...target, prompt: "\u0001".repeat(32_768) };
  const candidate = { ...list, watches: list.watches.map((row) => row.id === target.id ? changed : row) };
  assert.ok(Buffer.byteLength(JSON.stringify(candidate), "utf8") > 900 * 1024, "the attempted edit independently crosses the aggregate budget");
  await assert.rejects(first.update({ botId: BOT, id: target.id, expectedRevision: target.revision, mutationId: randomUUID(),
    name: target.name, prompt: changed.prompt, condition: target.condition, everyMinutes: target.everyMinutes }), /Shorten/);
  assert.deepEqual(await first.list(BOT), list);
});

test("bounded watch metadata stays valid UTF-16 and saved config rejects unpaired surrogates", async (t) => {
  const edge = `X${"😀".repeat(250)}`;
  const f = fixture(t, { discover: async () => ({ bindings: [{ ...binding, labels: { providerLabel: "iMCP Mail", accountLabel: edge, resourceLabel: edge } }], unavailableReasons: [`X${"😀".repeat(100)}`] }) });
  const service = f.make(); const sources = await service.discoverSources(BOT);
  assert.equal(sources.choices[0]!.resourceLabel, `X${"😀".repeat(249)}`);
  assert.equal(sources.choices[0]!.accountLabel, `X${"😀".repeat(249)}`);
  assert.equal(sources.unavailableReasons[0], `X${"😀".repeat(99)}`);
  const input: BotConnectorWatchCreateInput = { botId: BOT, mutationId: randomUUID(), sourceChoiceId: sources.choices[0]!.id, name: "Mail 😀", prompt: "Summarize 😀", condition: { kind: "email", unreadOnly: false }, everyMinutes: 15 };
  const created = await service.create(input);
  assert.deepEqual(created.source, { providerLabel: "iMCP Mail", accountLabel: `X${"😀".repeat(249)}`, resourceLabel: `X${"😀".repeat(249)}` });
  for (const field of ["name", "prompt"] as const) {
    await assert.rejects(service.create({ ...input, mutationId: randomUUID(), [field]: "invalid\uD83D" }), (error: unknown) => (error as { code: string }).code === "invalid_request");
    await assert.rejects(service.update({ ...input, id: created.id, expectedRevision: created.revision, mutationId: randomUUID(), [field]: "invalid\uDE00" }), (error: unknown) => (error as { code: string }).code === "invalid_request");
  }
  await assert.rejects(service.create({ ...input, mutationId: randomUUID(), condition: { kind: "email", unreadOnly: false, subject: "invalid\uD83D" } }), /invalid text/);
  await f.store.mutate(BOT, created.id, (row) => ({ next: { ...row, watch: { ...row.watch!, lastError: `X${"😀".repeat(100)}` } }, result: undefined }));
  const list = await service.list(BOT);
  assert.equal(list.watches[0]!.lastError, `X${"😀".repeat(99)}�`, "an already truncated stored error is repaired before native projection");
  const json = JSON.stringify({ sources, list });
  assert.equal(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/u.test(json), false, "no escaped orphan surrogate reaches native JSON decoders");
  f.ports.discover = async () => ({ bindings: [{ ...binding, labels: { providerLabel: "iMCP Mail", accountLabel: "", resourceLabel: "   " } }], unavailableReasons: [] });
  const emptyLabels = await service.discoverSources(BOT);
  assert.equal(emptyLabels.choices[0]!.accountLabel, "Selected Mail account");
  assert.equal(emptyLabels.choices[0]!.resourceLabel, "Mail mailbox");
});

test("multi-connector metadata overflow refuses discovery atomically without replacing or publishing source choices", async (t) => {
  const f = fixture(t); const service = f.make();
  const original = await service.discoverSources(BOT);
  const established = await service.create({ botId: BOT, sourceChoiceId: original.choices[0]!.id, mutationId: randomUUID(), name: "Saved source", prompt: "Summarize.", condition: { kind: "email", unreadOnly: false }, everyMinutes: 15 });
  const longSources = Array.from({ length: 500 }, (_, index) => ({ ...binding, serverId: `synthetic-connector-${Math.floor(index / 50)}`,
    connection: { ...binding.connection, sourceId: `synthetic-connector-${Math.floor(index / 50)}` },
    mailbox: `synthetic-box-${index}`, labels: { providerLabel: `Mail ${Math.floor(index / 50)}`, accountLabel: "界".repeat(500), resourceLabel: "界".repeat(500) } }));
  assert.equal(new Set(longSources.map((source) => source.serverId)).size, 10);
  for (let index = 0; index < 10; index++) {
    const mailboxes = longSources.slice(index * 50, (index + 1) * 50).map((source) => ({ "@id": source.mailbox, name: source.labels.resourceLabel, account: { "@id": source.account, email: source.labels.accountLabel } }));
    assert.ok(Buffer.byteLength(JSON.stringify({ "@type": "ItemList", itemListElement: mailboxes }), "utf8") < 256 * 1024, "each connector's metadata independently fits the source-read bound");
  }
  const independentMinimumBytes = 500 * 2 * 500 * 3;
  assert.ok(independentMinimumBytes > 1_048_576, "labels alone cross the standard response limit");
  f.ports.discover = async () => ({ bindings: longSources, unavailableReasons: [] });
  for (const botId of [BOT, "bot_large_one", "bot_large_two", "bot_large_three", "bot_large_four", "bot_large_five"]) {
    await assert.rejects(service.discoverSources(botId), (error: unknown) => (error as { code: string }).code === "unavailable" && /Source labels.*Narrow/u.test((error as Error).message));
  }
  const saved = await service.create({ botId: BOT, sourceChoiceId: original.choices[0]!.id, mutationId: randomUUID(), name: "Original source", prompt: "Summarize.", condition: { kind: "email", unreadOnly: false }, everyMinutes: 15 });
  assert.equal(saved.source.resourceLabel, "Inbox", "a refused refresh cannot replace an earlier approved source option");
  f.ports.discover = async () => ({ bindings: [binding], unavailableReasons: [] });
  const later = await service.discoverSources("bot_after_refusals");
  assert.equal(later.choices.length, 1, "repeated refused results publish no options into the bounded global cache");
  assert.deepEqual((await service.list(BOT)).watches.map((row) => row.id), [established.id, saved.id], "accepted private bindings remain intact");
});

test("connector event model execution inherits the selected scope across awaits and real inventory cache misses", async (t) => {
  const f = fixture(t); const service = f.make(); const { view } = await create(service); const routine = (await f.store.list(BOT))[0]!;
  const inspected: string[] = [];
  const runner = createBotEventRunner({ undelivered: () => false, executor: { run: async (task, options) => {
    await Promise.resolve();
    assert.equal(botConnectorInventoryServer(), binding.serverId);
    const restriction = botConnectorExecutionRestriction()!;
    assert.equal(restriction.routineId, routine.id);
    assert.equal(restriction.revision, routine.updatedAt);
    assert.equal(restriction.binding.account, "private-account-id");
    restriction.binding.mailbox = "forged-other-mailbox";
    assert.equal(botConnectorExecutionRestriction()?.binding.mailbox, "V10:12", "callers cannot mutate the task's captured source");
    await assert.rejects(withBotConnectorExecutionRestriction({ ...restriction, binding: { ...restriction.binding, account: "other-account" } }, async () => undefined), /cannot switch its accepted account/u);
    const scopes = await resolveBotMcpInventory(new AbortController().signal, { scopeCache: createBotMcpScopeCache(),
      listServers: async () => [binding.serverId, "unrelated-connector"].map((id) => ({ id, name: id, transport: "stdio", command: "synthetic-only", enabled: true })), credentialSignature: async () => "c".repeat(64),
      incarnations: { reconcileNamespace: async (_namespace, resources) => resources.map(({ sourceId }) => ({ sourceId, resourceIncarnation: "a".repeat(43), credentialIncarnation: "b".repeat(43) })) },
      inspectTools: async (server) => { inspected.push(server.id); return [{ name: "read", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }]; } });
    assert.deepEqual(scopes.map((scope) => scope.serverId), [binding.serverId]);
    return { id: options!.runId!, taskId: task.id, result: "success", output: "Done", startedAt: f.now(), finishedAt: f.now() };
  } } });
  assert.equal((await runner.run(routine, { eventId: "synthetic-change", source: "watch", payload: "New mail" })).settled, true);
  assert.deepEqual(inspected, [binding.serverId], "model admission inventory cannot incidentally connect the unrelated server");
  assert.equal(botConnectorInventoryServer(), undefined); assert.equal(botConnectorExecutionRestriction(), undefined); assert.equal(view.id, routine.id);
});
