import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InMemorySessionRepo,
  type Session,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  PiCompactionCoordinator,
  type PiCompactionEvent,
} from "./pi-compaction-core.js";
import {
  AIDEN_CHAT_MESSAGE_MARKER,
  appendPiMessages,
  PiCompactionSessionStore,
  syncChatMessagesToPiSession,
} from "./pi-compaction-session-store.js";
import type { ChatMessage } from "./types.js";

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

async function memorySession(id = "compaction-test"): Promise<Session> {
  return new InMemorySessionRepo().create({ id });
}

function user(text: string, timestamp = Date.now()) {
  return { role: "user" as const, content: text, timestamp };
}

function assistant(
  model: Model<Api>,
  options: {
    input?: number;
    output?: number;
    stopReason?: AssistantMessage["stopReason"];
    errorMessage?: string;
    timestamp?: number;
    text?: string;
  } = {},
): AssistantMessage {
  const input = options.input ?? 950;
  const output = options.output ?? 20;
  return {
    role: "assistant",
    content: [{ type: "text", text: options.text ?? "Working state." }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { ...ZERO_COST },
    },
    stopReason: options.stopReason ?? "stop",
    errorMessage: options.errorMessage,
    timestamp: options.timestamp ?? Date.now(),
  };
}

function compactionFixture() {
  const faux = fauxProvider({
    api: "openai-completions",
    provider: "faux-compaction",
    models: [{ id: "faux-summary", contextWindow: 1_000, maxTokens: 200 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() as Model<Api> };
}

async function appendCompressibleHistory(
  session: Session,
  model: Model<Api>,
  suffix = "one",
): Promise<AssistantMessage> {
  await session.appendMessage(user(`old-${suffix}: ${"x".repeat(1_200)}`));
  await session.appendMessage(
    assistant(model, { input: 400, text: `middle-${suffix}` }),
  );
  await session.appendMessage(user(`latest-${suffix}: ${"y".repeat(500)}`));
  const last = assistant(model, { input: 950, text: `answer-${suffix}` });
  await session.appendMessage(last);
  return last;
}

test("Pi coordinator appends a native checkpoint and rebuilds from it", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([
    fauxAssistantMessage(
      "## Goal\nContinue.\n\n## Progress\nDone: preserved exact state.",
    ),
  ]);
  const session = await memorySession();
  const last = await appendCompressibleHistory(session, model);
  const before = await session.getEntries();
  const events: PiCompactionEvent[] = [];
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    onEvent: (event) => events.push(event),
  });

  const result = await coordinator.check(last);

  assert.equal(result.compacted, true);
  assert.equal(result.shouldRetry, false);
  assert.equal(result.messages?.[0]?.role, "compactionSummary");
  const after = await session.getEntries();
  assert.equal(after.length, before.length + 1);
  assert.equal(after[after.length - 1]?.type, "compaction");
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "end"],
  );
});

test("repeated compaction updates the previous Pi summary", async () => {
  const { faux, models, model } = compactionFixture();
  const summarySeen: boolean[] = [];
  faux.setResponses([
    fauxAssistantMessage("first checkpoint"),
    (context) => {
      summarySeen.push(JSON.stringify(context).includes("first checkpoint"));
      return fauxAssistantMessage("updated checkpoint");
    },
  ]);
  const session = await memorySession();
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });
  const first = await appendCompressibleHistory(session, model, "first");
  assert.equal((await coordinator.check(first)).compacted, true);
  const second = await appendCompressibleHistory(session, model, "second");
  second.timestamp = Date.now() + 1_000;
  assert.equal((await coordinator.check(second)).compacted, true);

  assert.deepEqual(summarySeen, [true]);
  const compactions = (await session.getEntries()).filter(
    (entry) => entry.type === "compaction",
  );
  assert.equal(compactions.length, 2);
  assert.equal(
    compactions[compactions.length - 1]?.summary,
    "updated checkpoint",
  );
});

test("overflow compacts and retries at most once", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage("overflow checkpoint")]);
  const session = await memorySession();
  await appendCompressibleHistory(session, model);
  const firstOverflow = assistant(model, {
    stopReason: "error",
    errorMessage: "Request exceeds the context window.",
  });
  await session.appendMessage(firstOverflow);
  const events: PiCompactionEvent[] = [];
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    onEvent: (event) => events.push(event),
  });

  const first = await coordinator.check(firstOverflow);
  assert.equal(first.compacted, true);
  assert.equal(first.shouldRetry, true);
  assert.equal(
    (await session.buildContext()).messages.some(
      (message) =>
        message.role === "assistant" && message.stopReason === "error",
    ),
    false,
  );

  const recovered = assistant(model, {
    stopReason: "stop",
    text: "Recovered answer.",
    timestamp: Date.now() + 5,
  });
  await session.appendMessage(recovered);
  assert.equal(
    (await session.buildContext()).messages.some(
      (message) =>
        message.role === "assistant" && message.stopReason === "error",
    ),
    false,
  );

  const secondOverflow = assistant(model, {
    stopReason: "error",
    errorMessage: "Request still exceeds the context window.",
    timestamp: Date.now() + 10,
  });
  await session.appendMessage(secondOverflow);
  const second = await coordinator.check(secondOverflow);
  assert.equal(second.compacted, false);
  assert.equal(second.shouldRetry, false);
  assert.match(second.errorMessage ?? "", /after one compact-and-retry/u);
  assert.equal(
    (await session.getEntries()).filter((entry) => entry.type === "compaction")
      .length,
    1,
  );
  assert.equal(events.filter((event) => event.type === "start").length, 1);
  assert.equal(
    (await session.buildContext()).messages.some(
      (message) =>
        message.role === "assistant" &&
        (message.stopReason === "error" || message.stopReason === "length"),
    ),
    false,
  );
});

test("length-stop overflow is abandoned before retry context is rebuilt", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage("length checkpoint")]);
  const session = await memorySession();
  await appendCompressibleHistory(session, model);
  await session.appendMessage(user("current overflow request", Date.now() + 1));
  const overflow = assistant(model, {
    input: model.contextWindow,
    output: 0,
    stopReason: "length",
  });
  await session.appendMessage(overflow);
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });

  const result = await coordinator.check(overflow);

  assert.equal(result.compacted, true);
  assert.equal(result.shouldRetry, true);
  const retryMessages = result.messages ?? [];
  assert.notEqual(retryMessages[retryMessages.length - 1]?.role, "assistant");
  assert.equal(
    (await session.buildContext()).messages.some(
      (message) =>
        message.role === "assistant" && message.stopReason === "length",
    ),
    false,
  );
});

test("transient provider failures are durably abandoned and retried only once", async () => {
  const { models, model } = compactionFixture();
  const session = await memorySession();
  await session.appendMessage(user("keep this request"));
  const firstFailure = assistant(model, {
    stopReason: "error",
    errorMessage: "503 service unavailable",
  });
  await session.appendMessage(firstFailure);
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    retryDelayMs: 0,
  });

  const first = await coordinator.check(firstFailure);
  assert.equal(first.shouldRetry, true);
  assert.equal(first.retryDelayMs, 0);
  assert.equal(first.messages?.[first.messages.length - 1]?.role, "user");
  assert.equal(
    (await session.buildContext()).messages.some(
      (message) =>
        message.role === "assistant" && message.stopReason === "error",
    ),
    false,
  );

  const secondFailure = assistant(model, {
    stopReason: "error",
    errorMessage: "network error: connection reset",
    timestamp: firstFailure.timestamp + 1,
  });
  await session.appendMessage(secondFailure);
  const second = await coordinator.check(secondFailure);
  assert.equal(second.shouldRetry, false);
  assert.match(second.errorMessage ?? "", /after one automatic retry/iu);
  assert.equal(second.messages?.[second.messages.length - 1]?.role, "user");
  assert.equal(
    (await session.buildContext()).messages.some(
      (message) =>
        message.role === "assistant" && message.stopReason === "error",
    ),
    false,
  );
});

test("summary failure leaves the append-only history authoritative", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "summarizer unavailable",
    }),
  ]);
  const session = await memorySession();
  const last = await appendCompressibleHistory(session, model);
  const before = await session.getEntries();
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });

  const result = await coordinator.check(last);

  assert.equal(result.compacted, false);
  assert.equal(result.shouldRetry, false);
  assert.deepEqual(await session.getEntries(), before);
});

test("an empty successful summary is rejected without hiding history", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage("")]);
  const session = await memorySession();
  const last = await appendCompressibleHistory(session, model);
  const before = await session.getEntries();
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });

  const result = await coordinator.check(last);

  assert.equal(result.compacted, false);
  assert.match(result.errorMessage ?? "", /empty summary/u);
  assert.deepEqual(await session.getEntries(), before);
});

test("pre-prompt pressure compacts zero-usage reconstructed history", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage("seeded checkpoint")]);
  const session = await memorySession();
  await session.appendMessage(user(`older-seeded-${"x".repeat(4_000)}`, 10));
  await session.appendMessage(
    assistant(model, {
      input: 0,
      output: 0,
      text: "rehydrated",
      timestamp: 20,
    }),
  );
  await session.appendMessage(user(`newer-seeded-${"y".repeat(4_000)}`, 30));
  await session.appendMessage(
    assistant(model, {
      input: 0,
      output: 0,
      text: "also rehydrated",
      timestamp: 40,
    }),
  );
  await session.appendMessage(user("current", 50));
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });

  const result = await coordinator.checkContextPressure();

  assert.equal(result.compacted, true);
  assert.equal(result.messages?.[0]?.role, "compactionSummary");
});

test("cancelling summary generation leaves the journal uncompacted", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([
    async (_context, options) => {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return fauxAssistantMessage("", {
        stopReason: "aborted",
        errorMessage: "summary cancelled",
      });
    },
  ]);
  const session = await memorySession();
  const last = await appendCompressibleHistory(session, model);
  const before = await session.getEntries();
  let coordinator!: PiCompactionCoordinator;
  coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    onEvent: (event) => {
      if (event.type === "start") coordinator.abort();
    },
  });

  const result = await coordinator.check(last);

  assert.equal(result.compacted, false);
  assert.equal(result.shouldRetry, false);
  assert.deepEqual(await session.getEntries(), before);
});

test("chat synchronization is idempotent and markers stay out of context", async () => {
  const { model } = compactionFixture();
  const session = await memorySession();
  const messages: ChatMessage[] = [
    { id: "user-1", role: "user", content: "Hello", createdAt: 10 },
    { id: "assistant-1", role: "assistant", content: "Hi", createdAt: 20 },
  ];

  await syncChatMessagesToPiSession(session, messages, model, false);
  await syncChatMessagesToPiSession(session, messages, model, false);

  const entries = await session.getEntries();
  assert.equal(entries.filter((entry) => entry.type === "message").length, 2);
  assert.equal(
    entries.filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === AIDEN_CHAT_MESSAGE_MARKER,
    ).length,
    2,
  );
  assert.equal((await session.buildContext()).messages.length, 2);
});

test("chat synchronization rolls back a message when its marker append fails", async () => {
  const { model } = compactionFixture();
  const session = await memorySession();
  const message: ChatMessage = {
    id: "user-atomic",
    role: "user",
    content: "Only once",
    createdAt: 10,
  };
  const appendMarker = session.appendCustomEntry.bind(session);
  let failMarker = true;
  session.appendCustomEntry = async (...args) => {
    if (failMarker) {
      failMarker = false;
      throw new Error("injected marker failure");
    }
    return appendMarker(...args);
  };

  await assert.rejects(
    syncChatMessagesToPiSession(session, [message], model, false),
    /marker failure/u,
  );
  assert.equal((await session.buildContext()).messages.length, 0);
  await syncChatMessagesToPiSession(session, [message], model, false);
  assert.deepEqual(
    (await session.buildContext()).messages.map((entry) => entry.role),
    ["user"],
  );
});

test("Pi message batches roll back partial appends before a safe retry", async () => {
  const { model } = compactionFixture();
  const session = await memorySession();
  const first = user("first", 10);
  const second = assistant(model, { text: "second", timestamp: 20 });
  const appendMessage = session.appendMessage.bind(session);
  let calls = 0;
  session.appendMessage = async (message) => {
    calls += 1;
    if (calls === 2) throw new Error("injected batch failure");
    return appendMessage(message);
  };

  await assert.rejects(
    appendPiMessages(session, [first, second]),
    /batch failure/u,
  );
  assert.equal((await session.buildContext()).messages.length, 0);
  session.appendMessage = appendMessage;
  await appendPiMessages(session, [first, second]);
  assert.deepEqual(
    (await session.buildContext()).messages.map((entry) => entry.role),
    ["user", "assistant"],
  );
});

test("primary generation reconciles a visible assistant after a journal batch failure", async () => {
  const source = await readFile(
    new URL("./llm-client.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /!persisted\.messageId \|\| !piJournalHealthy/u);
  assert.match(
    source,
    /if \(!piJournalHealthy\) \{[\s\S]{0,500}await reconcileVisibleAssistant\(\);/u,
  );
});

test("journal synchronization stores the exact enriched skill turn once", async () => {
  const { model } = compactionFixture();
  const session = await memorySession();
  const message: ChatMessage = {
    id: "skill-user",
    role: "user",
    content: "Review this",
    createdAt: 10,
  };
  const enriched = "<skill>Exact private instructions</skill>\n\nReview this";

  await syncChatMessagesToPiSession(
    session,
    [message],
    model,
    false,
    new Map([[message.id, enriched]]),
  );
  await syncChatMessagesToPiSession(session, [message], model, false);

  const context = await session.buildContext();
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0]?.role, "user");
  assert.equal(
    context.messages[0]?.role === "user" ? context.messages[0].content : "",
    enriched,
  );
});

test("durable journals are private and delete with their chat", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-session-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "sessions");
  await mkdir(root, { recursive: true });
  const store = new PiCompactionSessionStore({ root: async () => root });

  const session = await store.openChat("chat-privacy-test");
  await session.appendMessage(user("private"));
  const metadata = await session.getMetadata();
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.dirname(metadata.path))).mode & 0o777, 0o700);
  assert.equal((await stat(metadata.path)).mode & 0o777, 0o600);

  await store.deleteChat("chat-privacy-test");
  await assert.rejects(stat(metadata.path), { code: "ENOENT" });
});
