import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StartPiRuntimeOperationInput } from "./pi-runtime-effect-core.js";
import { PiRuntimeEffectStore } from "./pi-runtime-effect-store.js";
import { DataStore } from "./data-store.js";
import {
  chatReplyInterrupted,
  clipInterruptedWaitSummary,
  createInterruptedWaitStore,
  emptyInterruptedWaits,
  normalizeInterruptedWaits,
  type InterruptedWaitDatabase,
} from "./interrupted-reply.js";
import { formatRecoveredAskUserQuestionAnswers, INTERRUPTED_WAIT_MAX_AGE_MS } from "../../renderer/shared/interrupted-reply.js";

function run(
  operationId: string,
  chatId: string,
  lane: StartPiRuntimeOperationInput["lane"] = "foreground",
): StartPiRuntimeOperationInput {
  return {
    operationId,
    runId: `run-${operationId}`,
    sessionId: `session-${chatId}`,
    chatId,
    lane,
    contributionRevision: 0,
  };
}

async function withStores(
  body: (open: () => Promise<PiRuntimeEffectStore>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-interrupted-reply-"));
  const opened: PiRuntimeEffectStore[] = [];
  let clock = 1_000;
  try {
    // Each open is a fresh launch reading the same run history.
    await body(async () => {
      const store = new PiRuntimeEffectStore({ root: () => directory, now: () => clock++ });
      opened.push(store);
      await store.initialize();
      return store;
    });
  } finally {
    await Promise.all(opened.map((store) => store.settleVerificationReceipts()));
    await rm(directory, { recursive: true, force: true });
  }
}

test("a reply still running at a crash is offered for resume on the next launch", async () => {
  await withStores(async (open) => {
    const before = await open();
    await before.startOperation(run("done", "chat"));
    await before.finishOperation("done", "completed");
    await before.startOperation(run("crashed", "chat"));
    assert.equal(await chatReplyInterrupted(before, "chat"), false, "a running reply is not interrupted");

    const after = await open();
    assert.equal(await chatReplyInterrupted(after, "chat"), true);
    assert.equal(await chatReplyInterrupted(after, "other-chat"), false);
  });
});

test("a quit offers resume, but a reply stopped or finished after it does not", async () => {
  await withStores(async (open) => {
    const store = await open();
    await store.startOperation(run("quit", "chat"));
    await store.finishOperation("quit", "interrupted");
    assert.equal(await chatReplyInterrupted(store, "chat"), true);

    await store.startOperation(run("stopped", "chat"));
    await store.finishOperation("stopped", "app_cancelled");
    assert.equal(await chatReplyInterrupted(store, "chat"), false);

    await store.startOperation(run("quit-again", "chat"));
    await store.finishOperation("quit-again", "interrupted");
    await store.startOperation(run("resumed", "chat"));
    await store.finishOperation("resumed", "completed");
    assert.equal(await chatReplyInterrupted(store, "chat"), false);
  });
});

test("subagent runs under the chat do not decide whether its reply was interrupted", async () => {
  await withStores(async (open) => {
    const store = await open();
    await store.startOperation(run("parent", "chat"));
    await store.finishOperation("parent", "interrupted");
    await store.startOperation(run("helper", "chat", "child"));
    await store.finishOperation("helper", "completed");
    assert.equal(await chatReplyInterrupted(store, "chat"), true);

    await store.startOperation(run("finished", "other"));
    await store.finishOperation("finished", "completed");
    await store.startOperation(run("helper-crash", "other", "child"));
    assert.equal(await chatReplyInterrupted(await open(), "other"), false);
  });
});

const questions = [
  {
    question: "Which database should I use?",
    header: "Database",
    multiSelect: false,
    options: [
      { label: "Postgres", description: "Relational." },
      { label: "SQLite", description: "Embedded." },
    ],
  },
  {
    question: "Which checks should run?",
    header: "Checks",
    multiSelect: true,
    options: [
      { label: "Lint", description: "Style." },
      { label: "Tests", description: "Behavior." },
    ],
  },
];

async function withWaitFile(body: (open: (now: () => number) => ReturnType<typeof createInterruptedWaitStore>, file: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-interrupted-waits-"));
  try {
    // Each open is a fresh launch reading the same file.
    await body(
      (now) =>
        createInterruptedWaitStore(
          new DataStore<InterruptedWaitDatabase>("interrupted-waits.json", emptyInterruptedWaits(), () => directory, {
            normalize: normalizeInterruptedWaits,
          }),
          now,
        ),
      path.join(directory, "interrupted-waits.json"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a question asked during the interrupted run is offered after a relaunch, and only that one", async () => {
  await withWaitFile(async (open) => {
    const before = open(() => 5_000);
    await before.remember("chat", { kind: "question", waitId: "q-1", askedAt: 5_000, questions });
    await before.remember("other-chat", { kind: "approval", waitId: "a-1", askedAt: 5_000, summary: "Run npm test" });

    const after = open(() => 6_000);
    assert.deepEqual(await after.forRun("chat", 4_000), { kind: "question", waitId: "q-1", askedAt: 5_000, questions });
    assert.deepEqual(await after.forRun("other-chat", 4_000), {
      kind: "approval",
      waitId: "a-1",
      askedAt: 5_000,
      summary: "Run npm test",
    });
    // Asked during an earlier run, not the one that was cut short.
    assert.equal(await after.forRun("chat", 5_001), undefined);

    // Answering it (or its card settling before the quit) removes it.
    await after.forget("q-1");
    assert.equal(await open(() => 6_000).forRun("chat", 4_000), undefined);
  });
});

test("a newer card replaces the chat's earlier one, and a week-old one is no longer offered", async () => {
  await withWaitFile(async (open) => {
    const store = open(() => 5_000);
    await store.remember("chat", { kind: "question", waitId: "q-1", askedAt: 5_000, questions });
    await store.remember("chat", { kind: "approval", waitId: "a-2", askedAt: 5_100, summary: "Edit README.md" });
    assert.equal((await open(() => 5_200).forRun("chat", 0))?.waitId, "a-2");
    assert.equal(await open(() => 5_100 + INTERRUPTED_WAIT_MAX_AGE_MS + 1).forRun("chat", 0), undefined);
  });
});

test("a damaged saved card is dropped instead of being offered", async () => {
  assert.deepEqual(
    normalizeInterruptedWaits({
      version: 1,
      waits: [
        { kind: "question", chatId: "chat", waitId: "q-1", askedAt: 1, questions: [{ question: "Only one option?", header: "One", options: [{ label: "A", description: "a" }] }] },
        { kind: "approval", chatId: "chat", waitId: "a-1", askedAt: "soon", summary: "Run it" },
        { kind: "approval", chatId: "chat", waitId: "a-2", askedAt: 2, summary: "Run it" },
      ],
    }).waits.map((wait) => wait.waitId),
    ["a-2"],
  );
  assert.deepEqual(normalizeInterruptedWaits("not json"), emptyInterruptedWaits());
  assert.equal(clipInterruptedWaitSummary("Run\n  npm   test"), "Run npm test");
  assert.equal(Array.from(clipInterruptedWaitSummary("x".repeat(400))).length, 300);
});

test("answers to a question from before a restart start a new turn that names each question", () => {
  assert.equal(
    formatRecoveredAskUserQuestionAnswers(questions, [
      { questionIndex: 1, kind: "multi", selected: ["Lint", "Tests"] },
    ]),
    "Answering the question you asked before Aiden restarted:\n\nWhich checks should run?\nAnswer: Lint, Tests",
  );
  // Skipping everything sends nothing.
  assert.equal(formatRecoveredAskUserQuestionAnswers(questions, []), undefined);
});
