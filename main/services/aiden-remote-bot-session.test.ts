import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BOT_PRESETS } from "../../renderer/shared/bot-presets.js";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import { AidenRemoteBotService } from "./aiden-remote-bots.js";
import {
  AidenRemoteBotSessionService,
  BOT_REMOTE_FAILED_REPLY_TEXT,
  projectBotSessionEntries,
  projectBotSessionState,
  redactRemoteError,
  type AidenRemoteBotSessionRuntime,
} from "./aiden-remote-bot-session.js";
import { parseAidenRemoteBotSession, parseAidenRemoteBotSessionEvent } from "./aiden-remote-protocol.js";
import {
  BOT_NOTICE_ENTRY_KIND,
  createBotSessionService,
  type BotSessionState,
} from "./bot-runtime/bot-session-service.js";
import { createBotStarter } from "./bot-runtime/bot-starter.js";
import { spawnHarnessChild } from "./bot-runtime/test-support/child.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor } from "./bot-runtime/test-support/faux.js";
import { recordingDeps } from "./bot-runtime/test-support/fixtures.js";
import { BOT_ROUTINE_SILENT_INSTRUCTION, type BotRoutine } from "./scheduled-bot-routines.js";

const BOT_ID = "bot_session_1";
const DEVICE_ID = "device_1";
const RESUME_KEY = "resume-request-0001";

function bot(id = BOT_ID): BotDefinition {
  return {
    id,
    revision: "bot_revision_1",
    name: "Planner",
    instructions: "Plan carefully.",
    avatar: { version: 1, shape: "orb", color: "sky" },
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

/** A Bot store with one live Bot and no other side effects. */
function botService(options: { sessionStates?: Map<string, "needs_model" | "idle"> } = {}) {
  const application = {
    async get(botId: string) {
      return botId === BOT_ID ? bot() : null;
    },
    async list() {
      return [bot()];
    },
  };
  return new AidenRemoteBotService({
    application: application as never,
    chatStore: { get: async () => null },
    sessionStates: async (ids) => new Map(
      ids.flatMap((id) => (options.sessionStates?.has(id) ? [[id, options.sessionStates.get(id)!] as const] : [])),
    ),
  });
}

/** A fake durable runtime: one interrupted turn that a Resume continues. */
function fakeRuntime(initial: BotSessionState) {
  let state: BotSessionState = initial;
  const calls = { resume: 0, abort: 0, dismiss: 0 };
  let closeWatch: () => void = () => {};
  const conversation = {
    async watch() {
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
      closeWatch = () => resolveClosed();
      return {
        value: { entries: [], docs: {} },
        start() {},
        stop: async () => {},
        closed,
      };
    },
    async abort() {
      calls.abort += 1;
    },
  };
  const runtime: AidenRemoteBotSessionRuntime = {
    async send() {
      return { submissionId: "sub_1", deduped: false };
    },
    async resume() {
      calls.resume += 1;
      if (state.kind === "interrupted") state = { kind: "running", submissionId: state.submissionId };
      return state;
    },
    async dismiss() {
      calls.dismiss += 1;
      state = { kind: "idle" };
      return state;
    },
    async stop() {
      if (state.kind === "running") {
        calls.abort += 1;
        state = { kind: "idle" };
      }
      return state;
    },
    async state() {
      return state;
    },
    async conversation() {
      return conversation as never;
    },
  };
  return {
    runtime,
    calls,
    closeWatch: () => closeWatch(),
    setState(next: BotSessionState) {
      state = next;
    },
  };
}

function sessionService(runtime: AidenRemoteBotSessionRuntime, bots = botService()) {
  return new AidenRemoteBotSessionService({
    bots,
    runtime: async () => runtime,
    presets: {
      list: () => [],
      create: async () => ({ botId: BOT_ID, created: true }),
    },
    notifyBotsChanged: () => {},
    projectorIdleMs: 60_000,
  });
}

test("a second Resume with the same request key is a no-op that returns the current state", async () => {
  const fake = fakeRuntime({ kind: "interrupted", submissionId: "sub_1" });
  const service = sessionService(fake.runtime);

  const first = await service.resume(DEVICE_ID, BOT_ID, RESUME_KEY, {});
  const second = await service.resume(DEVICE_ID, BOT_ID, RESUME_KEY, {});

  assert.deepEqual(first, { state: "running", interrupted: false });
  assert.deepEqual(second, first);
  assert.equal(fake.calls.resume, 1, "the provider-facing resume runs once");
  await service.close();
});

test("a Resume after the turn already resumed reads the current state without a second resume", async () => {
  const fake = fakeRuntime({ kind: "interrupted", submissionId: "sub_1" });
  const service = sessionService(fake.runtime);

  await service.resume(DEVICE_ID, BOT_ID, RESUME_KEY, {});
  const replayedAfterRestart = await service.resume(DEVICE_ID, BOT_ID, "resume-request-0002", {});

  assert.equal(replayedAfterRestart.state, "running");
  assert.equal(fake.calls.resume, 2, "a new request key is a new request");
  await service.close();
});

test("a Bot without a model reports needs_model on its session and preset summaries", async () => {
  const fake = fakeRuntime({ kind: "needs_model" });
  const bots = botService({ sessionStates: new Map([[BOT_ID, "needs_model"]]) });
  const service = sessionService(fake.runtime, bots);

  const session = await service.session(BOT_ID);
  assert.equal(session.state, "needs_model");
  assert.equal(session.interrupted, false);
  assert.deepEqual(session.entries, []);

  const summary = await bots.summaryOf(BOT_ID);
  assert.equal(summary.sessionState, "needs_model");
  await service.close();
});

test("a model error that blocks a turn is reported as unavailable, not as an unknown state", () => {
  assert.deepEqual(
    projectBotSessionState({ kind: "model_error", message: "Sign in to the provider." }),
    { state: "unavailable", interrupted: false },
  );
  assert.deepEqual(
    projectBotSessionState({ kind: "interrupted", submissionId: "sub_1", blocked: "access_changed" }),
    { state: "interrupted", interrupted: true, blocked: "access_changed" },
  );
});

test("Stop ends a running turn but leaves an interrupted one for Dismiss", async () => {
  const running = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  await sessionService(running.runtime).stop(DEVICE_ID, BOT_ID, "stop-request-0001", {});
  assert.equal(running.calls.abort, 1);

  const paused = fakeRuntime({ kind: "interrupted", submissionId: "sub_1" });
  const view = await sessionService(paused.runtime).stop(DEVICE_ID, BOT_ID, "stop-request-0002", {});
  assert.equal(paused.calls.abort, 0, "a paused turn is not aborted by Stop");
  assert.equal(view.state, "interrupted");
});

test("a session reopened on the host gets a new epoch, so clients refetch instead of folding", async () => {
  const fake = fakeRuntime({ kind: "idle" });
  const service = sessionService(fake.runtime);

  const before = await service.session(BOT_ID);
  fake.closeWatch();
  await new Promise((resolve) => setImmediate(resolve));
  const after = await service.session(BOT_ID);

  assert.notEqual(after.epoch, before.epoch);
  assert.equal(after.seq, 0);
  await service.close();
});

// ---------------------------------------------------------------------------
// Projection parity, live stream, and edge cases
// ---------------------------------------------------------------------------

type RawEntry = { id: number; kind: string; model?: unknown[]; data?: unknown };
const user = (id: number, text: string): RawEntry => ({
  id, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1_700_000_000_000 }],
});
const assistant = (id: number, text: string, stopReason = "stop", content?: unknown[]): RawEntry => ({
  id,
  kind: "pi.assistant",
  model: [{ role: "assistant", content: content ?? [{ type: "text", text }], stopReason, timestamp: 1_700_000_001_000 }],
});
const notice = (id: number, data: unknown): RawEntry => ({ id, kind: BOT_NOTICE_ENTRY_KIND, data });
const card = (id: number, pluginId: string, status = "pending"): RawEntry => ({
  id, kind: "aiden.connect-card", data: { type: "connect_card", pluginId, reason: "I can read your mail.", status },
});

test("phones see what the Mac shows: no self-intro prompt, no [SILENT] turn, and a failed turn surfaces", () => {
  const entries = projectBotSessionEntries([
    notice(1, { notice: "hidden_input", requestId: "intro:bot" }),
    user(2, "Introduce yourself to me for the first time."),
    assistant(3, "Hi, I'm your Meal Planner."),
    notice(4, { notice: "routine", label: "Morning brief", requestId: "routine:t:1" }),
    user(5, `Check my inbox.\n\n${BOT_ROUTINE_SILENT_INSTRUCTION}`),
    assistant(6, "[SILENT]"),
    notice(7, { notice: "routine", label: "Weekly plan", requestId: "routine:t:2" }),
    user(8, `Plan the week.\n\n${BOT_ROUTINE_SILENT_INSTRUCTION}`),
    assistant(9, "", "toolUse", [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }]),
    assistant(10, "Here's the plan."),
    user(11, "Thanks!"),
    assistant(12, "", "error"),
  ] as never);

  assert.deepEqual(
    entries.map((entry) => entry.type === "message" ? [entry.role, entry.text, entry.label ?? null] : [entry.type]),
    [
      ["assistant", "Hi, I'm your Meal Planner.", null],
      ["user", "Plan the week.", "Weekly plan"],
      ["assistant", "Here's the plan.", null],
      ["user", "Thanks!", null],
      ["assistant", BOT_REMOTE_FAILED_REPLY_TEXT, null],
    ],
  );
});

test("a routine label cut at the wire bound never splits an emoji, so the session stays servable", () => {
  const label = `${"a".repeat(119)}🍳 breakfast`;
  const entries = projectBotSessionEntries([
    notice(1, { notice: "routine", label, requestId: "routine:t:1" }),
    user(2, "Cook something \uD83D"),
  ] as never);
  const session = parseAidenRemoteBotSession({
    botId: BOT_ID, epoch: "epoch_1", seq: 0, state: "idle", interrupted: false, entries, hasOlder: false,
  });
  const message = session.entries[0];
  assert.equal(message?.type, "message");
  assert.equal(message?.type === "message" && message.label, `${"a".repeat(119)}🍳`);
  assert.equal(message?.type === "message" && message.text, "Cook something �");
});

test("routine errors reach phones without local paths or key-shaped secrets", () => {
  const redacted = redactRemoteError(
    "ENOENT: no such file '/Users/sam/Library/Application Support/Aiden/bots/bot~3a1/session.sqlite' (key sk-abcdefghijklmnopqrstuv)",
  );
  assert.ok(!redacted.includes("/Users"), redacted);
  assert.ok(!redacted.includes("sk-abcdef"), redacted);
  assert.match(redacted, /^ENOENT: no such file/u);
  assert.equal(redactRemoteError("   "), "This routine failed.");
});

/** A conversation whose watch the test drives frame by frame. */
function drivenConversation(initial: RawEntry[]) {
  let listener: ((view: unknown) => Promise<void>) | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const conversation = {
    async watch() {
      return {
        value: { entries: initial, docs: {} },
        start(next: (view: unknown) => Promise<void>) { listener = next; },
        stop: async () => {},
        closed,
      };
    },
  };
  return {
    conversation,
    async emit(entries: RawEntry[], partial?: string) {
      const docs = partial === undefined
        ? {}
        : { "pi.live": { generation: { message: { content: [{ type: "text", text: partial }] } } } };
      await listener!({ entries, docs });
    },
    /** What a harness close (idle close, delete, quit) does to every watch. */
    end: () => resolveClosed(),
  };
}

interface Frame { type: string; seq: number; epoch: string; payload: any }

/** Serve one Bot's SSE stream over HTTP and collect parsed frames. */
async function openStream(service: AidenRemoteBotSessionService, botId = BOT_ID) {
  const server = createServer((_request, response) => {
    void service.openEvents("device_1", botId, response).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const frames: Frame[] = [];
  const state = { ended: false };
  const decoder = new TextDecoder();
  let buffer = "";
  const reading = (async () => {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) frames.push(parseAidenRemoteBotSessionEvent(JSON.parse(data.slice(6))) as unknown as Frame);
      }
    }
    state.ended = true;
  })();
  return {
    frames,
    get ended() { return state.ended; },
    async until(predicate: () => boolean, what: string) {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await reading.catch(() => undefined);
    },
  };
}

test("the session stream is gapless, clears a finished partial, and rewrites history with a snapshot", async () => {
  const driven = drivenConversation([user(1, "Hi")]);
  const fake = fakeRuntime({ kind: "running", submissionId: "sub_1" });
  const runtime = { ...fake.runtime, conversation: async () => driven.conversation as never };
  const service = sessionService(runtime);
  const stream = await openStream(service);
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    assert.equal(stream.frames[0]!.type, "snapshot");

    await driven.emit([user(1, "Hi")], "Hel");
    fake.setState({ kind: "idle" });
    await driven.emit([user(1, "Hi"), assistant(2, "Hello!")]);
    // A routine turn that turns out silent hides its already-shown input.
    const routine = [notice(3, { notice: "routine", label: "Brief", requestId: "r" }), user(4, "Brief me")];
    await driven.emit([user(1, "Hi"), assistant(2, "Hello!"), ...routine]);
    await driven.emit([user(1, "Hi"), assistant(2, "Hello!"), ...routine, assistant(5, "[SILENT]")]);
    await stream.until(() => stream.frames.filter((frame) => frame.type === "snapshot").length === 2, "the rewrite snapshot");

    const seqs = stream.frames.map((frame) => frame.seq);
    assert.deepEqual(seqs, seqs.map((_, index) => seqs[0]! + index), "every frame is exactly one after the last");
    assert.ok(stream.frames.every((frame) => frame.epoch === stream.frames[0]!.epoch));
    const types = stream.frames.map((frame) => frame.type);
    const answer = types.indexOf("entry", types.indexOf("partial") + 1);
    assert.equal(stream.frames[answer]!.payload.entry.text, "Hello!");
    assert.equal(types[answer + 1], "partial", "the partial is cleared explicitly after the answer arrives");
    assert.equal(stream.frames[answer + 1]!.payload.text, "");
    const rewrite = stream.frames[stream.frames.length - 1]!;
    assert.equal(rewrite.type, "snapshot");
    assert.deepEqual(rewrite.payload.session.entries.map((entry: { text: string }) => entry.text), ["Hi", "Hello!"]);
  } finally {
    await stream.close();
    await service.close();
  }
});

test("deleting a Bot while its stream is open ends the stream and the next read is not found", async () => {
  const driven = drivenConversation([user(1, "Hi")]);
  const fake = fakeRuntime({ kind: "idle" });
  let exists = true;
  const bots = new AidenRemoteBotService({
    application: { get: async (id: string) => (id === BOT_ID && exists ? bot() : null), list: async () => [] } as never,
    chatStore: { get: async () => null },
  });
  const service = sessionService({ ...fake.runtime, conversation: async () => driven.conversation as never }, bots);
  const stream = await openStream(service);
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    exists = false;
    driven.end();
    await stream.until(() => stream.ended, "the stream to end");
    assert.equal(stream.frames[stream.frames.length - 1]!.type, "closed");
    await assert.rejects(service.session(BOT_ID), { code: "not_found" });
  } finally {
    await stream.close();
    await service.close();
  }
});

test("a connect card finished on the Mac reads as connected on the next fetch, with nothing committed", async () => {
  const driven = drivenConversation([user(1, "Help with email"), card(2, "gmail")]);
  const connected = new Set<string>();
  const fake = fakeRuntime({ kind: "idle" });
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => ({ ...fake.runtime, conversation: async () => driven.conversation as never }),
    connectCardStatus: async (_botId, entry) => (connected.has(entry.pluginId) ? "connected" : entry.status),
  });
  const cardOf = (session: { entries: Array<{ type: string }> }) =>
    session.entries.find((entry) => entry.type === "connect_card") as unknown as { status: string; name: string };
  try {
    assert.equal(cardOf(await service.session(BOT_ID)).status, "pending");
    connected.add("gmail");
    const shown = cardOf(await service.session(BOT_ID));
    assert.equal(shown.status, "connected");
    assert.equal(shown.name, "Gmail");
  } finally {
    await service.close();
  }
});

test("a connection request for an app Aiden can't connect is refused without bothering the Mac", async () => {
  const requested: string[] = [];
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => fakeRuntime({ kind: "idle" }).runtime,
    connectionRequested: async ({ pluginId }) => { requested.push(pluginId); },
  });
  await assert.rejects(
    service.requestConnection(DEVICE_ID, BOT_ID, "connect-request-0001", { pluginId: "not-a-real-app" }),
    { code: "not_found", status: 404 },
  );
  await assert.rejects(
    service.requestConnection(DEVICE_ID, BOT_ID, "connect-request-0002", { pluginId: "Gmail!" }),
    { code: "invalid_request", status: 400 },
  );
  assert.deepEqual(requested, []);
  const receipt = await service.requestConnection(DEVICE_ID, BOT_ID, "connect-request-0003", { pluginId: "gmail" });
  assert.deepEqual(receipt, { pluginId: "gmail", name: "Gmail", status: "sent" });
  assert.deepEqual(requested, ["gmail"]);
});

test("a routine change with a stale If-Match is a revision conflict that changes nothing", async () => {
  const routine: BotRoutine = {
    id: "routine_1", botId: BOT_ID, name: "Brief", prompt: "Brief me", schedule: { kind: "daily", time: "08:00" },
    timezone: "UTC", label: "Every day at 8:00 AM", enabled: true, updatedAt: 5_000,
  };
  const writes: string[] = [];
  const service = new AidenRemoteBotSessionService({
    bots: botService(),
    runtime: async () => fakeRuntime({ kind: "idle" }).runtime,
    routines: {
      list: async () => [routine],
      create: async () => { throw new Error("unused"); },
      update: async (input) => {
        writes.push(`update:${input.expectedUpdatedAt}`);
        return { ...routine, enabled: false, updatedAt: 6_000 };
      },
      delete: async () => { writes.push("delete"); },
    },
  });
  const current = (await service.listRoutines(BOT_ID)).routines[0]!.revision;
  await assert.rejects(
    service.updateRoutine(BOT_ID, "routine_1", "routine_revision_4000", { enabled: false }),
    (error: { code: string; status: number; details?: { currentRevision?: string } }) =>
      error.code === "revision_conflict" && error.status === 409 && error.details?.currentRevision === current,
  );
  await assert.rejects(service.deleteRoutine(BOT_ID, "routine_1", "routine_revision_4000"), { code: "revision_conflict" });
  assert.deepEqual(writes, []);
  const updated = await service.updateRoutine(BOT_ID, "routine_1", current, { enabled: false });
  assert.equal(updated.enabled, false);
  assert.notEqual(updated.revision, current);
  assert.deepEqual(writes, ["update:5000"]);
});

test("Start Chat from phones with different request keys and the Mac makes one Bot and one self-intro", async () => {
  const created: string[] = [];
  const sent: string[] = [];
  const store = new Map<string, BotDefinition>();
  const keys = new Map<string, string>();
  const make = async (input: { name: string }, audience: string) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const made = { ...bot(`bot_preset_${created.length + 1}`), name: input.name };
    created.push(audience);
    store.set(made.id, made);
    return made;
  };
  const starter = createBotStarter({
    async findBotByCreationKey(key) {
      const id = keys.get(key);
      return id ? store.get(id) ?? null : null;
    },
    async createBot(input, _access, key) {
      const made = await make(input, "desktop");
      keys.set(key, made.id);
      return made;
    },
    async rememberCreation(key, botId) {
      keys.set(key, botId);
    },
    session: {
      state: async () => ({ kind: "idle" }),
      send: async (botId) => { sent.push(botId); return { submissionId: "1", deduped: false }; },
      conversation: async () => ({ context: async () => ({ entries: [] }) }) as never,
    },
  });
  const bots = new AidenRemoteBotService({
    application: { get: async (id: string) => store.get(id) ?? null, list: async () => [...store.values()] } as never,
    chatStore: { get: async () => null },
  });
  const service = new AidenRemoteBotSessionService({
    bots,
    runtime: async () => fakeRuntime({ kind: "idle" }).runtime,
    presets: {
      list: () => BOT_PRESETS,
      create: async (presetId, { audienceId }) => {
        const result = await starter.startFromPreset(presetId, { createBot: (input) => make(input, audienceId) });
        return { botId: result.bot.id, created: result.created };
      },
    },
  });
  const presetId = BOT_PRESETS[0]!.id;
  const [phoneA, phoneB, mac] = await Promise.all([
    service.createFromPreset("device_a", "preset-request-0001", { presetId }),
    service.createFromPreset("device_b", "preset-request-0002", { presetId }),
    starter.startFromPreset(presetId),
  ]);
  const later = await service.createFromPreset("device_a", "preset-request-0003", { presetId });

  assert.equal(created.length, 1, "one Bot");
  assert.equal(new Set([phoneA.bot.id, phoneB.bot.id, mac.bot.id, later.bot.id]).size, 1);
  assert.equal([phoneA.created, phoneB.created, mac.created].filter(Boolean).length, 1);
  assert.equal(later.created, false);
  assert.deepEqual(sent, [phoneA.bot.id], "only the creating call sends the self-intro");
});

// --- Real durable runtime -----------------------------------------------------

const durableRoots: string[] = [];
after(() => {
  for (const root of durableRoots) rmSync(root, { recursive: true, force: true });
});

async function interruptedDurableBot() {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "aiden-remote-bot-session-"));
  durableRoots.push(profileDir);
  const child = spawnHarnessChild("stream", [profileDir, "bot:killed", "req-killed"]);
  await child.waitFor("STREAMING");
  await child.kill();
  const fauxModels = createFauxModels([fauxAssistantMessage("resumed answer"), fauxAssistantMessage("extra")]);
  const runtime = await createBotSessionService({
    profileDir,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(["bot:killed"]),
  });
  await runtime.initialize();
  let exists = true;
  const bots = new AidenRemoteBotService({
    application: {
      get: async (id: string) => (id === "bot:killed" && exists ? bot("bot:killed") : null),
      list: async () => [],
    } as never,
    chatStore: { get: async () => null },
  });
  const service = new AidenRemoteBotSessionService({ bots, runtime: async () => runtime });
  return { runtime, service, fauxModels, markDeleted: () => { exists = false; } };
}

test("two phones tapping Resume at once on a turn killed mid-stream make one provider request", async () => {
  const { runtime, service, fauxModels } = await interruptedDurableBot();
  try {
    const paused = await service.session("bot:killed");
    assert.equal(paused.state, "interrupted");
    assert.equal(paused.interrupted, true);

    const [first, second] = await Promise.all([
      service.resume("device_a", "bot:killed", "resume-request-000a", {}),
      service.resume("device_b", "bot:killed", "resume-request-000b", {}),
    ]);
    assert.equal(first.state, "running");
    assert.deepEqual(second, first);
    await waitFor(async () => (await runtime.state("bot:killed")).kind === "idle", { what: "the resumed turn" });
    assert.equal(fauxModels.calls(), 1);

    const settled = await service.session("bot:killed");
    assert.equal(settled.state, "idle");
    assert.ok(settled.entries.some((entry) => entry.type === "message" && entry.text === "resumed answer"));
  } finally {
    await service.close();
    await runtime.shutdown();
  }
});

test("deleting a durable Bot while a phone streams its chat closes the stream", async () => {
  const { runtime, service, fauxModels, markDeleted } = await interruptedDurableBot();
  const stream = await openStream(service, "bot:killed");
  try {
    await stream.until(() => stream.frames.length >= 1, "the first snapshot");
    assert.equal(stream.frames[0]!.payload.session.state, "interrupted");
    markDeleted();
    await runtime.deleteBot("bot:killed");
    await stream.until(() => stream.ended, "the stream to end");
    assert.equal(stream.frames[stream.frames.length - 1]!.type, "closed");
    assert.equal(fauxModels.calls(), 0, "deleting a paused Bot never resumes it");
    await assert.rejects(service.session("bot:killed"), { code: "not_found" });
  } finally {
    await stream.close();
    await service.close();
    await runtime.shutdown();
  }
});
