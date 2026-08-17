import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemorySessionRepo, JsonlSessionRepo, type Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { PiCompactionCoordinator, type PiCompactionEvent } from "./pi-compaction-core.js";
import {
  AIDEN_CHAT_MESSAGE_MARKER,
  AIDEN_PI_TRANSACTION,
  appendPiMessages,
  beginPiGenerationTurn,
  beginPiVisibleTurnLease,
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

function structuredSummary(label: string): string {
  return `## Goal\n${label}\n\n## Constraints & Preferences\n- none\n\n## Progress\n### Done\n- [x] preserved state\n\n### In Progress\n- [ ] continue\n\n### Blocked\n- none\n\n## Key Decisions\n- preserve continuity\n\n## Next Steps\n1. Continue\n\n## Critical Context\n- ${label}`;
}

function splitSummary(label: string): string {
  return `## Original Request\n${label}\n\n## Early Progress\n- preserved\n\n## Context for Suffix\n- continue`;
}

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
  await session.appendMessage(assistant(model, { input: 400, text: `middle-${suffix}` }));
  await session.appendMessage(user(`latest-${suffix}: ${"y".repeat(500)}`));
  const last = assistant(model, { input: 950, text: `answer-${suffix}` });
  await session.appendMessage(last);
  return last;
}

test("Pi coordinator appends a native checkpoint and rebuilds from it", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage(structuredSummary("Continue."))]);
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
    fauxAssistantMessage(structuredSummary("first checkpoint")),
    (context) => {
      summarySeen.push(JSON.stringify(context).includes("first checkpoint"));
      return fauxAssistantMessage(structuredSummary("updated checkpoint"));
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
  const compactions = (await session.getEntries()).filter((entry) => entry.type === "compaction");
  assert.equal(compactions.length, 2);
  assert.equal(
    compactions[compactions.length - 1]?.summary,
    structuredSummary("updated checkpoint"),
  );
});

test("repeated split with no new history preserves current upstream fallback behavior", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([
    fauxAssistantMessage(structuredSummary("OLD_GOAL_CANARY")),
    fauxAssistantMessage(splitSummary("CURRENT_PREFIX_CANARY")),
  ]);
  const session = await memorySession("repeated-split-upstream-parity");
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });

  const first = await appendCompressibleHistory(session, model, "retained-turn");
  assert.equal((await coordinator.check(first)).compacted, true);
  const sameTurnSuffix = assistant(model, {
    input: 950,
    text: `same retained turn ${"z".repeat(800)}`,
    timestamp: Date.now() + 1_000,
  });
  await session.appendMessage(sameTurnSuffix);
  assert.equal((await coordinator.check(sameTurnSuffix)).compacted, true);

  const checkpoint = [...(await session.getEntries())]
    .reverse()
    .find((entry) => entry.type === "compaction");
  const summary = checkpoint?.type === "compaction" ? checkpoint.summary : "";
  assert.match(summary, /No prior history/u);
  assert.match(summary, /CURRENT_PREFIX_CANARY/u);
  assert.doesNotMatch(summary, /OLD_GOAL_CANARY/u);
});

test("overflow retries once per recovery streak and resets after success", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([
    fauxAssistantMessage(structuredSummary("overflow checkpoint")),
    fauxAssistantMessage(structuredSummary("overflow checkpoint after success")),
  ]);
  const session = await memorySession();
  await appendCompressibleHistory(session, model);
  const firstOverflow = assistant(model, {
    stopReason: "error",
    errorMessage: "Request exceeds the context window.",
  });
  await appendPiMessages(session, [firstOverflow]);
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
    first.messages?.some(
      (message) => message.role === "assistant" && message.stopReason === "error",
    ),
    false,
  );
  assert.equal(
    (await session.getBranch()).some(
      (entry) => entry.type === "custom" && entry.customType === AIDEN_PI_TRANSACTION,
    ),
    true,
  );
  assert.equal(
    (await session.buildContext()).messages.some(
      (message) => message.role === "assistant" && message.stopReason === "error",
    ),
    true,
  );

  const recovered = assistant(model, {
    input: 100,
    stopReason: "stop",
    text: "Recovered answer.",
    timestamp: Date.now() + 5,
  });
  await session.appendMessage(recovered);
  assert.equal((await coordinator.check(recovered)).compacted, false);
  assert.equal(
    (await session.buildContext()).messages.some(
      (message) => message.role === "assistant" && message.stopReason === "error",
    ),
    true,
  );

  const secondOverflow = assistant(model, {
    stopReason: "error",
    errorMessage: "Request still exceeds the context window.",
    timestamp: Date.now() + 10,
  });
  await session.appendMessage(secondOverflow);
  const second = await coordinator.check(secondOverflow);
  assert.equal(second.compacted, true);
  assert.equal(second.shouldRetry, true);
  assert.equal(second.failureCode, undefined);
  assert.equal(
    (await session.getEntries()).filter((entry) => entry.type === "compaction").length,
    2,
  );
  assert.equal(events.filter((event) => event.type === "start").length, 2);

  const thirdOverflow = assistant(model, {
    stopReason: "error",
    errorMessage: "Request still exceeds the context window.",
    timestamp: Date.now() + 20,
  });
  await session.appendMessage(thirdOverflow);
  const exhausted = await coordinator.check(thirdOverflow);
  assert.equal(exhausted.compacted, false);
  assert.equal(exhausted.shouldRetry, false);
  assert.equal(exhausted.failureCode, "retry-exhausted");
  assert.match(exhausted.errorMessage ?? "", /after one compact-and-retry/u);
  assert.equal(
    (await session.buildContext()).messages.some(
      (message) =>
        message.role === "assistant" &&
        (message.stopReason === "error" || message.stopReason === "length"),
    ),
    true,
  );
});

test("length-stop overflow remains durable but is removed from retry context", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage(structuredSummary("length checkpoint"))]);
  const session = await memorySession();
  await appendCompressibleHistory(session, model);
  await session.appendMessage(user("current overflow request", Date.now() + 1));
  const overflow = assistant(model, {
    input: 200,
    output: 20,
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
      (message) => message.role === "assistant" && message.stopReason === "length",
    ),
    true,
  );
});

test("transient provider failures remain durable but are retried without the failed tail", async () => {
  const { models, model } = compactionFixture();
  const session = await memorySession();
  await session.appendMessage(user("keep this request"));
  const firstFailure = assistant(model, {
    stopReason: "error",
    errorMessage: "503 service unavailable",
  });
  await appendPiMessages(session, [firstFailure]);
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
      (message) => message.role === "assistant" && message.stopReason === "error",
    ),
    true,
  );

  const secondFailure = assistant(model, {
    stopReason: "error",
    errorMessage: "network error: connection reset",
    timestamp: firstFailure.timestamp + 1,
  });
  await appendPiMessages(session, [secondFailure]);
  const second = await coordinator.check(secondFailure, {
    liveMessages: [...(first.messages ?? []), secondFailure],
  });
  assert.equal(second.shouldRetry, false);
  assert.equal(second.failureCode, "retry-exhausted");
  assert.match(second.errorMessage ?? "", /after one automatic retry/iu);
  assert.equal(second.messages?.[second.messages.length - 1]?.role, "user");
  assert.equal(
    (await session.buildContext()).messages.some(
      (message) => message.role === "assistant" && message.stopReason === "error",
    ),
    true,
  );
});

test("provider retry state does not consume overflow recovery", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage(structuredSummary("overflow after provider retry"))]);
  const session = await memorySession("independent-recovery-state");
  await appendCompressibleHistory(session, model);
  const providerFailure = assistant(model, {
    stopReason: "error",
    errorMessage: "503 service unavailable",
    timestamp: Date.now() + 1,
  });
  await session.appendMessage(providerFailure);
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    retryDelayMs: 0,
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });

  const providerRetry = await coordinator.check(providerFailure);
  assert.equal(providerRetry.shouldRetry, true);

  const overflow = assistant(model, {
    stopReason: "error",
    errorMessage: "Request exceeds the context window.",
    timestamp: providerFailure.timestamp + 1,
  });
  await session.appendMessage(overflow);
  const overflowRetry = await coordinator.check(overflow, {
    liveMessages: [...(providerRetry.messages ?? []), overflow],
  });

  assert.equal(overflowRetry.compacted, true);
  assert.equal(overflowRetry.shouldRetry, true);
  assert.equal(overflowRetry.failureCode, undefined);
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

test("transient hidden summary failure retries once with upstream request isolation", async () => {
  const { faux, models, model } = compactionFixture();
  const requestOptions: Array<{
    cacheRetention?: unknown;
    sessionId?: unknown;
  }> = [];
  faux.setResponses([
    (_context, options) => {
      requestOptions.push({
        cacheRetention: options?.cacheRetention,
        sessionId: options?.sessionId,
      });
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "terminated",
      });
    },
    (_context, options) => {
      requestOptions.push({
        cacheRetention: options?.cacheRetention,
        sessionId: options?.sessionId,
      });
      return fauxAssistantMessage(structuredSummary("retry recovered"));
    },
  ]);
  const session = await memorySession("summary-transient-retry");
  const last = await appendCompressibleHistory(session, model);
  const result = await new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    summaryRetry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  }).check(last);

  assert.equal(result.compacted, true);
  assert.equal(requestOptions.length, 2);
  assert.deepEqual(
    requestOptions.map((options) => options.cacheRetention),
    ["none", "none"],
  );
  assert.equal(typeof requestOptions[0]?.sessionId, "string");
  assert.equal(requestOptions[1]?.sessionId, requestOptions[0]?.sessionId);
});

test("transient hidden summary retry exhaustion is bounded and non-destructive", async () => {
  const { faux, models, model } = compactionFixture();
  let requests = 0;
  faux.setResponses(
    Array.from({ length: 2 }, () => () => {
      requests += 1;
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "stream ended without message_stop",
      });
    }),
  );
  const session = await memorySession("summary-transient-exhaustion");
  const last = await appendCompressibleHistory(session, model);
  const before = await session.getEntries();
  const result = await new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    summaryRetry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  }).check(last);

  assert.equal(result.compacted, false);
  assert.equal(requests, 2);
  assert.deepEqual(await session.getEntries(), before);
});

test("cancelling transient summary backoff starts no retry request", async () => {
  const { faux, models, model } = compactionFixture();
  const controller = new AbortController();
  let requests = 0;
  faux.setResponses([
    () => {
      requests += 1;
      setTimeout(() => controller.abort(), 0);
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "socket connection was closed",
      });
    },
  ]);
  const session = await memorySession("summary-backoff-cancel");
  const last = await appendCompressibleHistory(session, model);
  const before = await session.getEntries();
  const result = await new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    signal: controller.signal,
    summaryRetry: { enabled: true, maxRetries: 1, baseDelayMs: 10_000 },
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  }).check(last);

  assert.equal(result.compacted, false);
  assert.equal(requests, 1);
  assert.deepEqual(await session.getEntries(), before);
});

test("split summary calls receive separate current-upstream request identities", async () => {
  const { faux, models, model } = compactionFixture();
  const sessionIds: unknown[] = [];
  faux.setResponses([
    (_context, options) => {
      sessionIds.push(options?.sessionId);
      assert.equal(options?.cacheRetention, "none");
      return fauxAssistantMessage(structuredSummary("completed history"));
    },
    (_context, options) => {
      sessionIds.push(options?.sessionId);
      assert.equal(options?.cacheRetention, "none");
      return fauxAssistantMessage(splitSummary("active turn"));
    },
  ]);
  const session = await memorySession("split-request-isolation");
  await session.appendMessage(user(`completed ${"x".repeat(600)}`, 10));
  await session.appendMessage(assistant(model, { text: "completed answer", timestamp: 20 }));
  await session.appendMessage(user(`active ${"y".repeat(600)}`, 30));
  const last = assistant(model, {
    input: 950,
    text: `active suffix ${"z".repeat(200)}`,
    timestamp: 40,
  });
  await session.appendMessage(last);

  const result = await new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
  }).check(last);

  assert.equal(result.compacted, true);
  assert.equal(sessionIds.length, 2);
  assert.equal(typeof sessionIds[0], "string");
  assert.notEqual(sessionIds[1], sessionIds[0]);
});

test("an empty successful summary follows current upstream checkpoint semantics", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage("")]);
  const session = await memorySession();
  const last = await appendCompressibleHistory(session, model);
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });

  const result = await coordinator.check(last);

  assert.equal(result.compacted, true);
  const checkpoint = [...(await session.getEntries())]
    .reverse()
    .find((entry) => entry.type === "compaction");
  assert.equal(checkpoint?.type === "compaction" ? checkpoint.summary : undefined, "");
});

test("compaction preserves closed isolated host-failure provenance", async () => {
  for (const [failure, failureCode] of [
    ["inference", "host-inference"],
    ["policy", "host-policy"],
  ] as const) {
    const { faux, models, model } = compactionFixture();
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "PRIVATE_COMPACTION_HOST_DETAIL",
      }),
    ]);
    const session = await memorySession(`compaction-host-${failure}`);
    const last = await appendCompressibleHistory(session, model, failure);
    let pendingFailure: "inference" | "policy" | undefined = failure;
    const result = await new PiCompactionCoordinator({
      session,
      models,
      model,
      thinkingLevel: "off",
      consumeHostFailure: () => {
        const value = pendingFailure;
        pendingFailure = undefined;
        return value;
      },
      settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    }).check(last);

    assert.equal(result.failureCode, failureCode);
    assert.doesNotMatch(result.errorMessage ?? "", /PRIVATE_COMPACTION_HOST_DETAIL/u);
    assert.equal(pendingFailure, undefined);
  }
});

test("an ordinary nonempty summary follows current upstream checkpoint semantics", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage("A vague paragraph with no continuity structure.")]);
  const session = await memorySession();
  const last = await appendCompressibleHistory(session, model);
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });

  const result = await coordinator.check(last);
  assert.equal(result.compacted, true);
  const checkpoint = [...(await session.getEntries())]
    .reverse()
    .find((entry) => entry.type === "compaction");
  assert.equal(
    checkpoint?.type === "compaction" ? checkpoint.summary : undefined,
    "A vague paragraph with no continuity structure.",
  );
});

test("a length-stopped summary follows current upstream checkpoint semantics", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([
    fauxAssistantMessage(structuredSummary("truncated"), {
      stopReason: "length",
    }),
  ]);
  const session = await memorySession();
  const last = await appendCompressibleHistory(session, model);
  const result = await new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  }).check(last);
  assert.equal(result.compacted, true);
  assert.equal(
    [...(await session.getEntries())].reverse().find((entry) => entry.type === "compaction")?.type,
    "compaction",
  );
});

test("split-turn output follows current upstream checkpoint semantics", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage(structuredSummary("wrong half"))]);
  const session = await memorySession();
  await session.appendMessage(user(`one turn ${"x".repeat(800)}`, 10));
  const last = assistant(model, {
    input: 950,
    text: "retained suffix",
    timestamp: 20,
  });
  await session.appendMessage(last);
  const result = await new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
  }).check(last);
  assert.equal(result.compacted, true);
  const checkpoint = [...(await session.getEntries())]
    .reverse()
    .find((entry) => entry.type === "compaction");
  assert.match(checkpoint?.type === "compaction" ? checkpoint.summary : "", /wrong half/u);
});

test("a complete split-turn summary commits both independently valid halves", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage(splitSummary("one turn"))]);
  const session = await memorySession();
  await session.appendMessage(user(`one turn ${"x".repeat(800)}`, 10));
  const last = assistant(model, {
    input: 950,
    text: "retained suffix",
    timestamp: 20,
  });
  await session.appendMessage(last);
  const result = await new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
  }).check(last);
  assert.equal(result.compacted, true);
  const checkpoint = [...(await session.getEntries())]
    .reverse()
    .find((entry) => entry.type === "compaction");
  const summary = checkpoint?.type === "compaction" ? checkpoint.summary : "";
  assert.match(summary, /No prior history/iu);
  assert.match(summary, /Original Request/iu);
});

test("pre-prompt pressure does not compact without valid usage", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses(
    Array.from({ length: 20 }, () => fauxAssistantMessage(structuredSummary("seeded checkpoint"))),
  );
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

  assert.equal(result.compacted, false);
  assert.equal(
    (await session.getEntries()).some((entry) => entry.type === "compaction"),
    false,
  );
});

test("pre-prompt pressure ignores usage from before the latest checkpoint", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage(structuredSummary("initial checkpoint"))]);
  const session = await memorySession("stale-pre-prompt-usage");
  const last = await appendCompressibleHistory(session, model);
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });
  assert.equal((await coordinator.check(last)).compacted, true);
  await session.appendMessage(user("new prompt with no newer assistant usage", Date.now() + 1_000));

  const result = await coordinator.checkContextPressure();

  assert.equal(result.compacted, false);
  assert.equal(
    (await session.getEntries()).filter((entry) => entry.type === "compaction").length,
    1,
  );
});

test("default compaction settings keep Pi's fixed 16384 token reserve", async () => {
  const { faux, models, model } = compactionFixture();
  const fixedModel = {
    ...model,
    contextWindow: 32_000,
    maxTokens: 4_000,
  } as Model<Api>;
  faux.setResponses([fauxAssistantMessage(structuredSummary("fixed defaults"))]);
  const session = await memorySession("fixed-default-settings");
  await session.appendMessage(user(`old ${"x".repeat(100_000)}`, 10));
  await session.appendMessage(assistant(fixedModel, { input: 12_000, timestamp: 20 }));
  await session.appendMessage(user("current", 30));
  const last = assistant(fixedModel, { input: 20_000, timestamp: 40 });
  await session.appendMessage(last);

  const result = await new PiCompactionCoordinator({
    session,
    models,
    model: fixedModel,
    thinkingLevel: "off",
  }).check(last);

  assert.equal(result.compacted, true);
});

test("oversized summarizer input follows current upstream's single request path", async () => {
  const { faux, models, model } = compactionFixture();
  let requests = 0;
  faux.setResponses([
    () => {
      requests += 1;
      return fauxAssistantMessage(structuredSummary("single-upstream-request"));
    },
  ]);
  const session = await memorySession();
  await session.appendMessage(user(`oversized-${"x".repeat(12_000)}`, 10));
  await session.appendMessage(
    assistant(model, { input: 950, text: "older answer", timestamp: 20 }),
  );
  await session.appendMessage(user("latest", 30));
  const last = assistant(model, {
    input: 950,
    text: "latest answer",
    timestamp: 40,
  });
  await session.appendMessage(last);
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });

  const result = await coordinator.check(last);
  assert.equal(result.compacted, true);
  assert.equal(requests, 1);
  assert.match(JSON.stringify(result.messages), /single-upstream-request/u);
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

test("cancellation racing checkpoint append restores the exact prior branch leaf", async () => {
  const { faux, models, model } = compactionFixture();
  faux.setResponses([fauxAssistantMessage(structuredSummary("must not commit"))]);
  const session = await memorySession("checkpoint-append-cancel");
  const last = await appendCompressibleHistory(session, model);
  const priorLeaf = await session.getLeafId();
  const appendCompaction = session.appendCompaction.bind(session);
  let coordinator!: PiCompactionCoordinator;
  session.appendCompaction = async (...args) => {
    const checkpointId = await appendCompaction(...args);
    coordinator.abort();
    return checkpointId;
  };
  coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  });

  const result = await coordinator.check(last);

  assert.equal(result.compacted, false);
  assert.equal(await session.getLeafId(), priorLeaf);
  assert.equal((await session.getBranch()).some((entry) => entry.type === "compaction"), false);
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
      (entry) => entry.type === "custom" && entry.customType === AIDEN_CHAT_MESSAGE_MARKER,
    ).length,
    2,
  );
  assert.equal((await session.buildContext()).messages.length, 2);
});

test("chat synchronization keeps historical images model-neutral", async () => {
  const { model } = compactionFixture();
  const session = await memorySession();
  const message: ChatMessage = {
    id: "image-user",
    role: "user",
    content: "Inspect this image",
    createdAt: 10,
    attachments: [
      {
        id: "image-1",
        kind: "image",
        name: "screen.png",
        mimeType: "image/png",
        size: 128,
        data: "private-image-data",
      },
    ],
  };

  await syncChatMessagesToPiSession(session, [message], model, false);
  const context = await session.buildContext();
  assert.equal(JSON.stringify(context.messages).includes("private-image-data"), true);
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

  await assert.rejects(appendPiMessages(session, [first, second]), /batch failure/u);
  assert.equal((await session.buildContext()).messages.length, 0);
  session.appendMessage = appendMessage;
  await appendPiMessages(session, [first, second]);
  assert.deepEqual(
    (await session.buildContext()).messages.map((entry) => entry.role),
    ["user", "assistant"],
  );
});

test("visible-turn lease fails closed when its source leaf cannot be read", async () => {
  const session = await memorySession();
  const errors: unknown[] = [];
  session.getLeafId = async () => {
    throw new Error("PRIVATE_LEAF_CANARY");
  };

  const lease = await beginPiVisibleTurnLease(session, (error) => {
    errors.push(error);
  });

  assert.equal(lease.started, false);
  assert.equal(errors.length, 1);
  await assert.rejects(lease.commit("visible-id"), /transaction did not start/u);
  await assert.doesNotReject(lease.rollback());
});

test("visible assistant synchronization reconciles a committed unmarked Pi tail", async () => {
  const { model } = compactionFixture();
  const session = await memorySession();
  await appendPiMessages(session, [
    assistant(model, { text: "Recovered exactly once", timestamp: 20 }),
  ]);
  await syncChatMessagesToPiSession(
    session,
    [
      {
        id: "assistant-recovered",
        role: "assistant",
        content: "Recovered exactly once",
        createdAt: 21,
      },
    ],
    model,
    false,
  );
  const branch = await session.getBranch();
  assert.equal(branch.filter((entry) => entry.type === "message").length, 1);
  assert.equal(
    branch.filter(
      (entry) => entry.type === "custom" && entry.customType === AIDEN_CHAT_MESSAGE_MARKER,
    ).length,
    1,
  );
});

test("primary generation reconciles a visible assistant after a journal batch failure", async () => {
  const source = await readFile(new URL("./llm-client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /!persisted\.messageId \|\| !piJournalHealthy/u);
  assert.match(
    source,
    /if \(!piJournalHealthy\) \{[\s\S]{0,500}await reconcileVisibleAssistant\(\);/u,
  );
  assert.doesNotMatch(source, /chat:\s*persisted\.chat/u);
  assert.match(source, /chat:\s*chatForRenderer\(persisted\.chat/u);
  assert.match(
    source,
    /if \(persisted\.error\) \{[\s\S]{0,300}await turnLease\.rollback\(\);[\s\S]{0,200}await agent\.reconcileDurableEvidenceAfterRollback\(\);/u,
  );
  assert.match(source, /catch \(recoveryError\) \{[\s\S]{0,200}quarantineFailedPiRecovery\(/u);
  assert.match(source, /if \(!turnLease\) \{[\s\S]{0,250}quarantineFailedPiRecovery\(/u);
});

test("compaction transport awaits hidden-summary usage accounting", async () => {
  const source = await readFile(new URL("./pi-compaction-core.ts", import.meta.url), "utf8");
  assert.match(source, /await onAssistantMessage\(message\)/u);
  assert.doesNotMatch(source, /void stream\s*\.result\(\)/u);
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
  assert.equal(context.messages[0]?.role === "user" ? context.messages[0].content : "", enriched);
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

test("reopen rolls back a transaction interrupted by process death", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-crash-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "sessions");
  await mkdir(root, { recursive: true });
  const firstStore = new PiCompactionSessionStore({ root: async () => root });
  const first = await firstStore.openChat("chat-crash-test");
  await first.appendMessage(user("committed", 10));
  await first.appendCustomEntry(AIDEN_PI_TRANSACTION, {
    transactionId: "interrupted",
    phase: "begin",
  });
  await first.appendMessage(user("partial duplicate", 20));

  const reopened = await new PiCompactionSessionStore({
    root: async () => root,
  }).openChat("chat-crash-test");
  assert.deepEqual(
    (await reopened.buildContext()).messages.map((message) =>
      message.role === "user" ? message.content : message.role,
    ),
    ["committed"],
  );
});

test("reopen rolls back a Pi batch until visible persistence commits the turn", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-turn-crash-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "sessions");
  await mkdir(root, { recursive: true });
  const first = await new PiCompactionSessionStore({
    root: async () => root,
  }).openChat("chat-turn-crash");
  await first.appendMessage(user("visible user", 10));
  await beginPiGenerationTurn(first);
  await appendPiMessages(first, [
    assistant(compactionFixture().model, {
      text: "invisible assistant",
      timestamp: 20,
    }),
  ]);
  const reopened = await new PiCompactionSessionStore({
    root: async () => root,
  }).openChat("chat-turn-crash");
  assert.deepEqual(
    (await reopened.buildContext()).messages.map((message) => message.role),
    ["user"],
  );
});

test("repairing a committed failed turn preserves the outer visible transaction", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-repair-visible-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "sessions");
  await mkdir(root, { recursive: true });
  const store = new PiCompactionSessionStore({ root: async () => root });
  const session = await store.openChat("chat-repair-visible");
  const { models, model } = compactionFixture();

  const failedLease = await beginPiVisibleTurnLease(session);
  await appendPiMessages(session, [user("failed request", 10)]);
  const failed = assistant(model, {
    stopReason: "aborted",
    text: "partial",
    timestamp: 20,
  });
  await appendPiMessages(session, [failed]);
  await failedLease.commit("visible-failed-assistant");

  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  });
  const repaired = await coordinator.prepareForPrompt();
  assert.equal(repaired.errorMessage, undefined);
  assert.deepEqual(
    (await session.buildContext()).messages.map((message) => message.role),
    ["user", "assistant"],
  );
  const openTransactions = new Set<string>();
  for (const entry of await session.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== AIDEN_PI_TRANSACTION) continue;
    const marker = entry.data as { transactionId?: string; phase?: string };
    if (!marker.transactionId) continue;
    if (marker.phase === "begin") openTransactions.add(marker.transactionId);
    if (marker.phase === "commit") openTransactions.delete(marker.transactionId);
  }
  assert.deepEqual([...openTransactions], []);

  const successfulLease = await beginPiVisibleTurnLease(session);
  await appendPiMessages(session, [user("next request", 30)]);
  await appendPiMessages(session, [assistant(model, { text: "next answer", timestamp: 40 })]);
  await successfulLease.commit("visible-next-assistant");

  const reopened = await new PiCompactionSessionStore({
    root: async () => root,
  }).openChat("chat-repair-visible");
  assert.deepEqual(
    (await reopened.buildContext()).messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.match(JSON.stringify(await reopened.buildContext()), /next answer/u);
});

test("failed outer-transaction repair restores the original committed leaf", async () => {
  const session = await memorySession("failed-outer-repair");
  const { models, model } = compactionFixture();
  const lease = await beginPiVisibleTurnLease(session);
  await appendPiMessages(session, [user("failed request", 10)]);
  const failed = assistant(model, {
    stopReason: "aborted",
    text: "durable partial",
    timestamp: 20,
  });
  await appendPiMessages(session, [failed]);
  await lease.commit("visible-failed");

  const appendCustomEntry = session.appendCustomEntry.bind(session);
  session.appendCustomEntry = async (customType, data) => {
    if (customType === AIDEN_PI_TRANSACTION && (data as { phase?: unknown })?.phase === "commit") {
      throw new Error("injected enclosing commit repair failure");
    }
    return appendCustomEntry(customType, data);
  };
  const result = await new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  }).prepareForPrompt();

  assert.equal(result.failureCode, undefined);
  assert.deepEqual(
    (await session.buildContext()).messages.map((message) => message.role),
    ["user", "assistant"],
  );
  const openTransactions = new Set<string>();
  for (const entry of await session.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== AIDEN_PI_TRANSACTION) continue;
    const marker = entry.data as { transactionId?: string; phase?: string };
    if (!marker.transactionId) continue;
    if (marker.phase === "begin") openTransactions.add(marker.transactionId);
    if (marker.phase === "commit") openTransactions.delete(marker.transactionId);
  }
  assert.deepEqual([...openTransactions], []);
});

test("retry exhaustion reconciles a visible partial before persisting its marker", async () => {
  const session = await memorySession("retry-visible-reconcile");
  const { models, model } = compactionFixture();
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
  });
  coordinator.beginPrompt();
  const lease = await beginPiVisibleTurnLease(session);
  await appendPiMessages(session, [user("retry request", 10)]);

  const first = assistant(model, {
    stopReason: "error",
    errorMessage: "503 first failure",
    text: "first partial",
    timestamp: 20,
  });
  await appendPiMessages(session, [first]);
  assert.equal((await coordinator.check(first)).shouldRetry, true);

  const second = assistant(model, {
    stopReason: "error",
    errorMessage: "503 second failure",
    text: "visible partial",
    timestamp: 30,
  });
  await appendPiMessages(session, [second]);
  const exhausted = await coordinator.check(second);
  assert.equal(exhausted.failureCode, "retry-exhausted");
  assert.deepEqual(
    (await session.buildContext()).messages.map((message) => message.role),
    ["user", "assistant", "assistant"],
  );

  const visible: ChatMessage = {
    id: "visible-retry-exhausted",
    role: "assistant",
    content: "visible partial",
    createdAt: 40,
  };
  await syncChatMessagesToPiSession(session, [visible], model, true);
  await lease.commit(visible.id, { markerAlreadyPersisted: true });
  await syncChatMessagesToPiSession(session, [visible], model, true);

  const context = await session.buildContext();
  assert.deepEqual(
    context.messages.map((message) => message.role),
    ["user", "assistant", "assistant"],
  );
  assert.match(JSON.stringify(context), /visible partial/u);
  assert.equal(context.messages.length, 3);
});

test("journal quarantine blocks reuse and deletion until recovery settles", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-quarantine-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "sessions");
  await mkdir(root, { recursive: true });
  const store = new PiCompactionSessionStore({ root: async () => root });
  await store.openChat("chat-quarantine");
  let releaseRecovery!: () => void;
  const recovery = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  store.quarantineChatUntilRecovered("chat-quarantine", recovery);

  await assert.rejects(store.openChat("chat-quarantine"), /indeterminate write/u);
  await assert.rejects(store.deleteChat("chat-quarantine"), /indeterminate write/u);
  releaseRecovery();
  await recovery;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(await store.openChat("chat-quarantine"));

  store.quarantineChatUntilRecovered(
    "chat-quarantine",
    Promise.reject(new Error("recovery failed")),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(store.openChat("chat-quarantine"), /indeterminate write/u);
});

test("newest corrupt duplicate is quarantined and older valid history reopens", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-fallback-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "sessions");
  await mkdir(root, { recursive: true });
  const repo = new JsonlSessionRepo({
    fs: new NodeExecutionEnv({ cwd: root }),
    sessionsRoot: root,
  });
  const older = await repo.create({
    id: "chat-fallback-test",
    cwd: root,
    metadata: {
      kind: "aiden-chat-compaction-v1",
      chatId: "chat-fallback-test",
    },
  });
  await older.appendMessage(user("older valid", 10));
  await new Promise((resolve) => setTimeout(resolve, 2));
  const newer = await repo.create({
    id: "chat-fallback-test",
    cwd: root,
    metadata: {
      kind: "aiden-chat-compaction-v1",
      chatId: "chat-fallback-test",
    },
  });
  await newer.appendMessage(user("newer but corrupt", 20));
  await appendFile((await newer.getMetadata()).path, "{not-json\n");

  const reopened = await new PiCompactionSessionStore({
    root: async () => root,
  }).openChat("chat-fallback-test");
  assert.match(JSON.stringify(await reopened.buildContext()), /older valid/u);
});

test("corrupt indexed headers delete with private chat data", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-corrupt-delete-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "sessions");
  await mkdir(root, { recursive: true });
  const store = new PiCompactionSessionStore({ root: async () => root });
  const session = await store.openChat("chat-corrupt-delete");
  await session.appendMessage(user("PRIVATE BODY", 10));
  const metadata = await session.getMetadata();
  const lines = (await readFile(metadata.path, "utf8")).split("\n");
  lines[0] = `{broken-header,"chatId":"chat-corrupt-delete"}`;
  await writeFile(metadata.path, lines.join("\n"));

  await store.deleteChat("chat-corrupt-delete");
  await assert.rejects(stat(metadata.path), { code: "ENOENT" });
});

test("deleting one chat never matches another journal's body text", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-delete-owner-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "sessions");
  await mkdir(root, { recursive: true });
  const store = new PiCompactionSessionStore({ root: async () => root });
  await store.openChat("chat-a");
  const other = await store.openChat("chat-b");
  await other.appendMessage(user('{"chatId":"chat-a","id":"chat-a"}', 10));
  const otherPath = (await other.getMetadata()).path;
  await store.deleteChat("chat-a");
  assert.equal((await stat(otherPath)).isFile(), true);
});

test("reopen repairs a torn final JSONL line and retains the committed prefix", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-torn-tail-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "sessions");
  await mkdir(root, { recursive: true });
  const first = await new PiCompactionSessionStore({
    root: async () => root,
  }).openChat("chat-torn-tail");
  await first.appendMessage(user("durable prefix", 10));
  const metadata = await first.getMetadata();
  await appendFile(metadata.path, '{"type":"custom","id":"torn');
  const reopened = await new PiCompactionSessionStore({
    root: async () => root,
  }).openChat("chat-torn-tail");
  assert.match(JSON.stringify(await reopened.buildContext()), /durable prefix/u);
  assert.equal((await readFile(metadata.path, "utf8")).endsWith("\n"), true);
});

test("startup reconciliation removes indexed orphan journals", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-orphan-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "sessions");
  await mkdir(root, { recursive: true });
  const store = new PiCompactionSessionStore({ root: async () => root });
  const orphan = await store.openChat("chat-orphan-test");
  const metadata = await orphan.getMetadata();

  await store.reconcileChats(new Set());
  await assert.rejects(stat(metadata.path), { code: "ENOENT" });
});
