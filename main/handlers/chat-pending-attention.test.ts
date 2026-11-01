import assert from "node:assert/strict";
import test from "node:test";
import type { ChatPendingAttention } from "../../renderer/shared/chat-pending-attention.js";
import {
  createPendingAttentionRecorder,
  DetachedPromptLog,
  liveRunAttention,
  readInterruptedRunWaits,
  type InterruptedRunWaits,
} from "../services/chat-pending-attention.js";
import { HostRunRegistry } from "../services/host-run-registry.js";
import {
  createInterruptedWaitStore,
  emptyInterruptedWaits,
  type InterruptedWaitDatabase,
} from "../services/interrupted-reply.js";
import type { DurablePiRuntimeOperation } from "../services/pi-runtime-effect-core.js";
import { registerChatPendingAttentionHandlers } from "./chat-pending-attention.js";

const T0 = Date.parse("2026-10-31T10:00:00.000Z");

const question = {
  question: "Which branch should I target?",
  header: "Branch",
  multiSelect: false,
  options: [
    { label: "main", description: "The default branch." },
    { label: "release", description: "The release branch." },
  ],
};

function approval(approvalId: string, summary = "Run npm test") {
  return { approvalId, summary, toolCallId: "call-a", toolName: "run_command" };
}

function questionnaire(promptId: string) {
  return { version: 1, promptId, toolCallId: "call-q", questions: [question] };
}

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function harness(options: {
  chats: readonly string[];
  interrupted?: (chatIds: readonly string[]) => Promise<ReadonlyMap<string, InterruptedRunWaits>>;
}) {
  const clock = { now: T0 };
  const registry = new HostRunRegistry({ now: () => clock.now });
  const log = new DetachedPromptLog();
  const changes = { count: 0 };
  const recorder = createPendingAttentionRecorder({
    runs: registry,
    log,
    now: () => clock.now,
    onChange: () => {
      changes.count += 1;
    },
  });
  const handlers = new Map<string, Handler>();
  registerChatPendingAttentionHandlers<unknown>({
    handle: (channel, handler) => {
      assert.equal(handlers.has(channel), false, `${channel} registered twice`);
      handlers.set(channel, handler);
    },
    runs: registry,
    detached: log,
    knownChatIds: async (ids) => new Set(ids.filter((id) => options.chats.includes(id))),
    interruptedWaits: options.interrupted ?? (async () => new Map()),
  });
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} is not registered`);
    return handler({}, ...args);
  };
  const pending = async (ids: unknown) => (await invoke("chats:pendingAttention", ids)) as ChatPendingAttention[];
  return { clock, registry, recorder, invoke, pending, changes };
}

test("a live approval reports its summary, when it was raised, and when its run started", async () => {
  const { clock, registry, pending } = harness({ chats: ["chat-a", "chat-b"] });
  registry.begin({ runId: "run-a", chatId: "chat-a", origin: "renderer" });
  clock.now = T0 + 5_000;
  registry.publish("run-a", "chat:approval", approval("approval-1"));
  clock.now = T0 + 9_000;
  registry.publish("run-a", "chat:approval", approval("approval-2", "Delete the build folder"));

  assert.deepEqual(await pending(["chat-a", "chat-b"]), [
    {
      chatId: "chat-a",
      kind: "approval",
      summary: "Run npm test",
      since: T0 + 5_000,
      runStartedAt: T0,
      count: 2,
    },
  ]);
});

test("an approval outranks a question, and the question shows once the approval is answered", async () => {
  const { clock, registry, pending } = harness({ chats: ["chat-a"] });
  registry.begin({ runId: "run-a", chatId: "chat-a", origin: "remote" });
  clock.now = T0 + 1_000;
  registry.publish("run-a", "chat:questionnaire", questionnaire("prompt-1"));
  clock.now = T0 + 2_000;
  registry.publish("run-a", "chat:approval", approval("approval-1"));
  assert.equal((await pending(["chat-a"]))[0]?.kind, "approval");

  registry.resolveAttention("approval-1");
  assert.deepEqual(await pending(["chat-a"]), [
    {
      chatId: "chat-a",
      kind: "question",
      summary: "Which branch should I target?",
      since: T0 + 1_000,
      runStartedAt: T0,
      count: 1,
    },
  ]);
});

test("a long command is cut to 200 characters on one line", async () => {
  const { registry, pending } = harness({ chats: ["chat-a"] });
  registry.begin({ runId: "run-a", chatId: "chat-a", origin: "renderer" });
  const command = `git commit -m "${"x".repeat(150)}"\n  && ${"y".repeat(150)}`;
  registry.publish("run-a", "chat:approval", approval("approval-1", command));

  const [attention] = await pending(["chat-a"]);
  assert.equal(Array.from(attention!.summary).length, 200);
  assert.ok(attention!.summary.startsWith('git commit -m "xxx'));
  assert.ok(attention!.summary.endsWith("…"));
  assert.equal(attention!.summary.includes("\n"), false);
});

test("a run with nothing to answer reports when it started; a finished one reports nothing", async () => {
  const { clock, registry, pending } = harness({ chats: ["chat-a"] });
  clock.now = T0 + 3_000;
  registry.begin({ runId: "run-a", chatId: "chat-a", origin: "headless" });
  assert.deepEqual(await pending(["chat-a"]), [
    { chatId: "chat-a", kind: "working", summary: "", runStartedAt: T0 + 3_000, count: 0 },
  ]);

  registry.publish("run-a", "chat:done", {});
  assert.deepEqual(await pending(["chat-a"]), []);
});

test("prompts a window left behind stay as Unavailable until the chat runs again", async () => {
  const { clock, registry, recorder, invoke, pending } = harness({ chats: ["chat-a"] });
  registry.begin({ runId: "run-a", chatId: "chat-a", origin: "renderer" });
  clock.now = T0 + 4_000;
  registry.publish("run-a", "chat:questionnaire", questionnaire("prompt-1"));
  clock.now = T0 + 6_000;
  registry.publish("run-a", "chat:approval", approval("approval-1"));

  // The window closes: the host records, then settles, both prompts.
  recorder.runDetached("run-a");
  registry.resolveAttention("prompt-1");
  registry.resolveAttention("approval-1");
  const unavailable: ChatPendingAttention = {
    chatId: "chat-a",
    kind: "detached",
    summary: "Which branch should I target?",
    since: T0 + 4_000,
    runStartedAt: T0,
    count: 2,
  };
  // Still listed while the run carries on, and after it ends.
  assert.deepEqual(await pending(["chat-a"]), [unavailable]);
  registry.publish("run-a", "chat:done", {});
  assert.deepEqual(await pending(["chat-a"]), [unavailable]);

  // A new message in the chat makes them moot.
  clock.now = T0 + 60_000;
  recorder.runBegan("chat-a");
  registry.begin({ runId: "run-b", chatId: "chat-a", origin: "renderer" });
  assert.deepEqual(await pending(["chat-a"]), [
    { chatId: "chat-a", kind: "working", summary: "", runStartedAt: T0 + 60_000, count: 0 },
  ]);

  // Or the person dismisses them.
  registry.publish("run-b", "chat:approval", approval("approval-2"));
  recorder.runDetached("run-b");
  registry.resolveAttention("approval-2");
  registry.publish("run-b", "chat:done", {});
  assert.equal((await pending(["chat-a"]))[0]?.kind, "detached");
  await invoke("chats:dismissDetachedAttention", "chat-a");
  assert.deepEqual(await pending(["chat-a"]), []);
});

test("a prompt the run raises after its window left shows as Unavailable from when it was refused", async () => {
  const { clock, registry, recorder, pending, changes } = harness({ chats: ["chat-a"] });
  registry.begin({ runId: "run-a", chatId: "chat-a", origin: "renderer" });
  // The person switches chats while the run works; nothing was waiting yet.
  clock.now = T0 + 2_000;
  recorder.runDetached("run-a");
  assert.equal((await pending(["chat-a"]))[0]?.kind, "working");

  // Later the run asks for an approval; the host refuses it unpublished.
  clock.now = T0 + 30_000;
  recorder.promptShortCircuited("run-a", {
    id: "approval-late",
    type: "approval_required",
    payload: { summary: "Run   npm\n publish" },
  });
  clock.now = T0 + 31_000;
  recorder.promptShortCircuited("run-a", {
    id: "prompt-late",
    type: "question_required",
    payload: { questions: [question] },
  });
  assert.deepEqual(await pending(["chat-a"]), [
    {
      chatId: "chat-a",
      kind: "detached",
      summary: "Run npm publish",
      since: T0 + 30_000,
      runStartedAt: T0,
      count: 2,
    },
  ]);
  // Each refusal tells the renderer to reread, since no activity change will.
  assert.equal(changes.count, 2);

  // A run the registry never heard of leaves nothing behind.
  recorder.promptShortCircuited("run-unknown", { id: "x", type: "approval_required", payload: { summary: "x" } });
  assert.equal((await pending(["chat-a"]))[0]?.count, 2);
  assert.equal(changes.count, 2);
});

test("summaries drop control and bidirectional formatting characters", async () => {
  const { registry, pending } = harness({ chats: ["chat-a", "chat-b", "chat-c"] });
  registry.begin({ runId: "run-a", chatId: "chat-a", origin: "renderer" });
  registry.publish("run-a", "chat:approval", approval("approval-1", "rm \u202Etxt.exe\u202C\u0007 -f\u200B now"));
  assert.equal((await pending(["chat-a"]))[0]?.summary, "rm txt.exe -f now");

  // Joiners shape emoji and scripts such as Persian, so they survive.
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
  const persian = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645";
  registry.begin({ runId: "run-b", chatId: "chat-b", origin: "renderer" });
  registry.publish("run-b", "chat:approval", approval("approval-2", `Send ${family} ${scotland} ${persian}`));
  assert.equal((await pending(["chat-b"]))[0]?.summary, `Send ${family} ${scotland} ${persian}`);

  // Tag characters outside a flag hide text, so they go.
  const hidden = "\u{E0069}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}";
  registry.begin({ runId: "run-c", chatId: "chat-c", origin: "renderer" });
  registry.publish("run-c", "chat:approval", approval("approval-3", `Run${hidden} tests \u{1F3F4}\u{E0067} ${scotland}`));
  assert.equal((await pending(["chat-c"]))[0]?.summary, `Run tests \u{1F3F4} ${scotland}`);
});

test("unknown chats are left out and malformed requests are refused", async () => {
  const { registry, pending, invoke } = harness({ chats: ["chat-a"] });
  registry.begin({ runId: "run-x", chatId: "chat-unlisted", origin: "renderer" });
  registry.publish("run-x", "chat:approval", approval("approval-x"));
  registry.begin({ runId: "run-a", chatId: "chat-a", origin: "renderer" });

  assert.deepEqual((await pending(["chat-unlisted", "chat-a", "chat-a"])).map((row) => row.chatId), ["chat-a"]);
  assert.deepEqual(await pending([]), []);
  await assert.rejects(pending("chat-a"), /Invalid chat identifiers/);
  await assert.rejects(pending(["chat-a", "../etc"]), /Invalid chat identifier/);
  await assert.rejects(pending(["chat-a", 7]), /Invalid chat identifier/);
  await assert.rejects(pending(Array.from({ length: 2_001 }, (_, index) => `chat-${index}`)), /Too many/);
  await assert.rejects(invoke("chats:dismissDetachedAttention", { id: "chat-a" }), /Invalid chat identifier/);
});

function memoryWaits(now: () => number, reads = { count: 0 }) {
  let database: InterruptedWaitDatabase = emptyInterruptedWaits();
  return createInterruptedWaitStore(
    {
      load: async () => {
        reads.count += 1;
        return structuredClone(database);
      },
      update: async (mutation) => {
        const draft = structuredClone(database);
        const result = mutation(draft);
        database = draft;
        return result;
      },
    },
    now,
  );
}

function operation(chatId: string, startedAt: number, state: DurablePiRuntimeOperation["state"]): DurablePiRuntimeOperation {
  return {
    version: 1,
    operationId: `op-${chatId}-${startedAt}`,
    runId: `run-${chatId}-${startedAt}`,
    sessionId: "session",
    chatId,
    lane: "foreground",
    contributionRevision: 0,
    state,
    startedAt,
    updatedAt: startedAt,
  };
}

test("waits saved during a run a quit cut short come back as interrupted, oldest first", async () => {
  const now = T0 + 120_000;
  const reads = { count: 0 };
  const waits = memoryWaits(() => now, reads);
  const operations = new Map<string, DurablePiRuntimeOperation[]>([
    ["chat-a", [operation("chat-a", T0, "interrupted")]],
    // A later run settled normally, so its older waits are not offered.
    ["chat-b", [operation("chat-b", T0, "interrupted"), operation("chat-b", T0 + 50_000, "completed")]],
  ]);
  let initialized = 0;
  const reader = {
    initialize: async () => {
      initialized += 1;
    },
    listOperationsByChat: async (chatId: string) => operations.get(chatId) ?? [],
  };
  await waits.remember("chat-a", { kind: "approval", waitId: "approval-1", askedAt: T0 + 7_000, summary: "Run npm test" });
  await waits.remember("chat-a", { kind: "question", waitId: "prompt-1", askedAt: T0 + 9_000, questions: [question] });
  // Asked before the interrupted run began: not part of it.
  await waits.remember("chat-a", { kind: "approval", waitId: "approval-0", askedAt: T0 - 1_000, summary: "Old" });
  await waits.remember("chat-b", { kind: "approval", waitId: "approval-b", askedAt: T0 + 1_000, summary: "Run make" });

  const { pending } = harness({
    chats: ["chat-a", "chat-b", "chat-c"],
    interrupted: (chatIds) => readInterruptedRunWaits(chatIds, { waits, operations: reader }),
  });
  reads.count = 0;
  assert.deepEqual(await pending(["chat-a", "chat-b", "chat-c"]), [
    {
      chatId: "chat-a",
      kind: "interrupted",
      summary: "Run npm test",
      since: T0 + 7_000,
      runStartedAt: T0,
      count: 2,
    },
  ]);
  assert.equal(initialized, 1);
  // One read of the wait file however many chats hold waits.
  assert.equal(reads.count, 1);

  // Unreadable history hides the rows rather than failing the request, and says why.
  const failures: unknown[] = [];
  const broken = harness({
    chats: ["chat-a"],
    interrupted: (chatIds) =>
      readInterruptedRunWaits(chatIds, {
        waits,
        operations: { ...reader, initialize: async () => Promise.reject(new Error("locked")) },
        onError: (error) => failures.push(error),
      }),
  });
  assert.deepEqual(await broken.pending(["chat-a"]), []);
  assert.deepEqual(
    failures.map((error) => (error as Error).message),
    ["locked"],
  );
});

test("a chat working again leaves the Interrupted shelf for Working", async () => {
  const interrupted: InterruptedRunWaits = {
    runStartedAt: T0,
    waits: [{ kind: "approval", waitId: "approval-1", askedAt: T0 + 7_000, summary: "Run npm test" }],
  };
  const { clock, registry, pending } = harness({
    chats: ["chat-a"],
    interrupted: async () => new Map([["chat-a", interrupted]]),
  });
  assert.equal((await pending(["chat-a"]))[0]?.kind, "interrupted");

  // The person sends again; the new run has nothing to answer yet.
  clock.now = T0 + 90_000;
  registry.begin({ runId: "run-b", chatId: "chat-a", origin: "renderer" });
  assert.deepEqual(await pending(["chat-a"]), [
    { chatId: "chat-a", kind: "working", summary: "", runStartedAt: T0 + 90_000, count: 0 },
  ]);
});

test("a paired device reads a live run's start and oldest waiting ask, never this Mac's Unavailable rows", () => {
  const { clock, registry, recorder } = harness({ chats: ["chat-a"] });
  assert.equal(liveRunAttention("chat-a", registry), undefined, "no live run reads as nothing");

  registry.begin({ runId: "run-a", chatId: "chat-a", origin: "renderer" });
  assert.deepEqual(liveRunAttention("chat-a", registry), { runStartedAt: T0 });

  clock.now = T0 + 2_000;
  registry.publish("run-a", "chat:questionnaire", questionnaire("prompt-1"));
  clock.now = T0 + 3_000;
  registry.publish("run-a", "chat:approval", approval("approval-1", "Run   npm\ntest"));
  assert.deepEqual(liveRunAttention("chat-a", registry), {
    runStartedAt: T0,
    attentionSince: T0 + 3_000,
    summary: "Run npm test",
  });

  // The window leaves: this Mac keeps an Unavailable row, a paired device sees a working run.
  recorder.runDetached("run-a");
  registry.resolveAttention("prompt-1");
  registry.resolveAttention("approval-1");
  assert.deepEqual(liveRunAttention("chat-a", registry), { runStartedAt: T0 });

  registry.publish("run-a", "chat:done", {});
  assert.equal(liveRunAttention("chat-a", registry), undefined);
});
