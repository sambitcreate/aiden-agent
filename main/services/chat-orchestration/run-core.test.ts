import assert from "node:assert/strict";
import test from "node:test";

import type { AidenRemoteStreamState } from "../aiden-remote-streams.js";
import { ChatRunCore, type ChatRunCoreServices } from "./run-core.js";

class Untracked extends Error {}

interface FakeRun {
  owner: string;
  chatId: string;
  state: AidenRemoteStreamState;
  question?: boolean;
  approval?: { toolName: string; summary: string; expiresAt: string };
}

/** Stream and chat services backed by plain records; `set` changes a run and tells its watchers. */
function fakeServices(replies: Record<string, string> = {}) {
  const runs = new Map<string, FakeRun>();
  const watchers = new Map<string, Set<{ onChange(): void; onClose(): void }>>();
  const find = (owner: string, runId: string) => {
    const run = runs.get(runId);
    if (!run || run.owner !== owner) throw new Error("unknown stream");
    return run;
  };
  const services = {
    chats: {
      messagesWindow: async (chatId: string) => ({
        chatId,
        messages: replies[chatId]
          ? [
              {
                id: `${chatId}-reply`,
                role: "assistant",
                text: replies[chatId],
                createdAt: "2026-11-22T10:00:00.000Z",
              },
            ]
          : [],
      }),
    },
    streams: {
      status: (owner: string, runId: string) => ({ ...find(owner, runId), streamId: runId }),
      pendingQuestion: (owner: string, runId: string) => (find(owner, runId).question ? {} : null),
      pendingApproval: (owner: string, runId: string) => find(owner, runId).approval ?? null,
      watch: (owner: string, runId: string, handlers: { onChange(): void; onClose(): void }) => {
        find(owner, runId);
        const set = watchers.get(runId) ?? new Set();
        set.add(handlers);
        watchers.set(runId, set);
        return () => set.delete(handlers);
      },
    },
  } as unknown as ChatRunCoreServices;
  return {
    services,
    add(owner: string, chatId: string, runId: string, state: AidenRemoteStreamState = "running") {
      runs.set(runId, { owner, chatId, state });
    },
    set(runId: string, change: Partial<FakeRun>) {
      Object.assign(runs.get(runId)!, change);
      for (const watcher of [...(watchers.get(runId) ?? [])]) watcher.onChange();
    },
    watching(runId: string) {
      return watchers.get(runId)?.size ?? 0;
    },
  };
}

function core() {
  return new ChatRunCore({
    answerIn: async () => "Aiden on Studio",
    untrackedRun: () => new Untracked("untracked"),
  });
}

const never = () => new AbortController().signal;

test("a run reaching a terminal state answers the wait with its reply", async () => {
  const fake = fakeServices({ "chat-1": "All done." });
  fake.add("app-a", "chat-1", "run-1");
  const runs = core();
  const waiting = runs.wait(fake.services, "app-a", "chat-1", "run-1", {
    timeoutMs: 60_000,
    signal: never(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.watching("run-1"), 1);
  fake.set("run-1", { state: "done" });
  const outcome = await waiting;
  assert.deepEqual(outcome, {
    kind: "snapshot",
    snapshot: {
      chatId: "chat-1",
      runId: "run-1",
      state: "done",
      outcome: "completed",
      reply: {
        id: "chat-1-reply",
        role: "assistant",
        text: "All done.",
        createdAt: "2026-11-22T10:00:00.000Z",
      },
    },
  });
  assert.equal(fake.watching("run-1"), 0, "the wait detaches once answered");
});

test("waiting for the person answers the wait; text events alone do not", async () => {
  const fake = fakeServices();
  fake.add("app-a", "chat-1", "run-1");
  const runs = core();
  const waiting = runs.wait(fake.services, "app-a", "chat-1", "run-1", {
    timeoutMs: 60_000,
    signal: never(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  fake.set("run-1", {});
  await new Promise((resolve) => setImmediate(resolve));
  fake.set("run-1", {
    approval: { toolName: "bash", summary: "Run tests", expiresAt: "2026-11-22T10:05:00.000Z" },
  });
  const outcome = await waiting;
  assert.equal(outcome.kind, "snapshot");
  assert.deepEqual(outcome.kind === "snapshot" && outcome.snapshot, {
    chatId: "chat-1",
    runId: "run-1",
    state: "waiting_for_approval",
    approveIn: "Aiden on Studio",
    approval: { toolName: "bash", summary: "Run tests", expiresAt: "2026-11-22T10:05:00.000Z" },
  });
});

test("a timeout answers running and leaves the run running", async () => {
  const fake = fakeServices();
  fake.add("app-a", "chat-1", "run-1");
  const runs = core();
  runs.track("app-a", "run-1");
  const outcome = await runs.wait(fake.services, "app-a", "chat-1", "run-1", {
    timeoutMs: 20,
    signal: never(),
  });
  assert.deepEqual(outcome, {
    kind: "snapshot",
    snapshot: { chatId: "chat-1", runId: "run-1", state: "running" },
  });
  assert.equal(fake.services.streams.status("app-a", "run-1").state, "running");
  assert.equal(runs.liveRuns(fake.services, "app-a"), 1);
  assert.equal(fake.watching("run-1"), 0);
});

test("aborting the caller's signal ends the wait; forgetting the owner closes it", async () => {
  const fake = fakeServices();
  fake.add("app-a", "chat-1", "run-1");
  fake.add("app-a", "chat-1", "run-2");
  const runs = core();
  const controller = new AbortController();
  const aborted = runs.wait(fake.services, "app-a", "chat-1", "run-1", {
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  const closed = runs.wait(fake.services, "app-a", "chat-1", "run-2", {
    timeoutMs: 60_000,
    signal: never(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await aborted, { kind: "aborted" });
  runs.forget("app-a");
  assert.deepEqual(await closed, { kind: "closed" });
  assert.equal(fake.watching("run-1") + fake.watching("run-2"), 0);
});

test("a run in another chat or of another owner is untracked", async () => {
  const fake = fakeServices();
  fake.add("app-a", "chat-1", "run-1");
  const runs = core();
  await assert.rejects(runs.snapshot(fake.services, "app-a", "chat-2", "run-1"), Untracked);
  await assert.rejects(runs.snapshot(fake.services, "app-b", "chat-1", "run-1"), Untracked);
});

test("more than two runs go at once, each wait answering its own run", async () => {
  const fake = fakeServices();
  const runs = core();
  const ids = ["run-1", "run-2", "run-3", "run-4"];
  for (const id of ids) {
    fake.add("chat:lead", `chat-${id}`, id);
    runs.track("chat:lead", id);
  }
  assert.equal(runs.liveRuns(fake.services, "chat:lead"), 4);
  const waits = ids.map((id) =>
    runs.wait(fake.services, "chat:lead", `chat-${id}`, id, { timeoutMs: 60_000, signal: never() }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  fake.set("run-3", { state: "error" });
  fake.set("run-1", { state: "cancelled" });
  fake.set("run-4", { state: "interrupted" });
  fake.set("run-2", { question: true });
  const outcomes = await Promise.all(waits);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.kind === "snapshot" && outcome.snapshot),
    [
      { chatId: "chat-run-1", runId: "run-1", state: "done", outcome: "stopped" },
      {
        chatId: "chat-run-2",
        runId: "run-2",
        state: "waiting_for_input",
        answerIn: "Aiden on Studio",
      },
      { chatId: "chat-run-3", runId: "run-3", state: "failed", reason: "error" },
      { chatId: "chat-run-4", runId: "run-4", state: "failed", reason: "interrupted" },
    ],
  );
  assert.equal(runs.liveRuns(fake.services, "chat:lead"), 1, "finished runs stop counting");
});

test("a retried request joins the first; a failed one is not remembered", async () => {
  const runs = core();
  let started = 0;
  let admitted = 0;
  let finish!: (value: string) => void;
  const work = () => {
    started += 1;
    return new Promise<string>((resolve) => (finish = resolve));
  };
  const first = runs.request("app-a", "req-1", work, () => (admitted += 1));
  const retry = runs.request("app-a", "req-1", work, () => (admitted += 1));
  assert.deepEqual(runs.pendingRequests("app-a"), { owner: 1, total: 1 });
  assert.deepEqual(runs.pendingRequests("app-b"), { owner: 0, total: 1 });
  finish("answer");
  assert.deepEqual(await Promise.all([first, retry]), ["answer", "answer"]);
  assert.equal(started, 1);
  assert.equal(admitted, 1);
  assert.equal(await runs.request("app-a", "req-1", work), "answer", "an answered request replays");
  assert.deepEqual(runs.pendingRequests("app-a"), { owner: 0, total: 0 });

  await assert.rejects(
    runs.request("app-a", "req-2", () => Promise.reject(new Error("refused"))),
    /refused/,
  );
  assert.equal(await runs.request("app-a", "req-2", async () => "second try"), "second try");

  await assert.rejects(
    runs.request("app-a", "req-3", work, () => {
      throw new Error("over the cap");
    }),
    /over the cap/,
  );
  assert.equal(started, 1, "a refused admission never runs the work");

  runs.forget("app-a");
  assert.equal(
    await runs.request("app-a", "req-1", async () => "fresh"),
    "fresh",
    "a forgotten owner starts over",
  );
});
