import assert from "node:assert/strict";
import test from "node:test";
import { TODO_DETAILS_KIND, TodoSnapshotError, type TodoToolDetailsV1 } from "./contract.js";
import { replayTodoState } from "./replay.js";

function details(subject: string, nextId = 2): TodoToolDetailsV1 {
  return {
    kind: TODO_DETAILS_KIND,
    version: 1,
    action: "create",
    tasks: [{ id: nextId - 1, subject, status: "pending" }],
    nextId,
  };
}

function result(snapshot: unknown) {
  return {
    type: "message",
    message: { role: "toolResult", toolName: "todo", details: snapshot },
  };
}

test("replays the newest todo result on the current branch across compaction entries", async () => {
  const state = await replayTodoState({
    getBranch: async () => [
      result(details("Old")),
      { type: "compaction", summary: "summary", firstKeptEntryId: "entry" },
      result(details("New", 3)),
    ],
  });
  assert.deepEqual(state, {
    tasks: [{ id: 2, subject: "New", status: "pending" }],
    nextId: 3,
  });
});

test("empty and unrelated branches start with isolated empty state", async () => {
  const first = await replayTodoState({
    getBranch: async () => [
      { type: "message", message: { role: "toolResult", toolName: "other", details: {} } },
    ],
  });
  const second = await replayTodoState({ getBranch: async () => [] });
  assert.deepEqual(first, { tasks: [], nextId: 1 });
  assert.deepEqual(second, first);
  assert.notStrictEqual(first.tasks, second.tasks);
});

test("a corrupt newest todo result fails closed instead of regressing to older state", async () => {
  await assert.rejects(
    replayTodoState({
      getBranch: async () => [result(details("Durable")), result({ tasks: "corrupt" })],
    }),
    TodoSnapshotError,
  );
});

test("schema-rejected todo calls are not mistaken for corrupt state checkpoints", async () => {
  const state = await replayTodoState({
    getBranch: async () => [
      result(details("Durable")),
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          isError: true,
          details: {},
        },
      },
    ],
  });
  assert.deepEqual(state, {
    tasks: [{ id: 1, subject: "Durable", status: "pending" }],
    nextId: 2,
  });
});

test("replay uses only the session-provided current branch", async () => {
  const abandoned = result(details("Abandoned"));
  const current = result(details("Current"));
  const state = await replayTodoState({ getBranch: async () => [current] });
  assert.equal(state.tasks[0]?.subject, "Current");
  assert.notDeepEqual(state.tasks, (abandoned.message.details as TodoToolDetailsV1).tasks);
});

test("only the last checkpoint is authoritative across adversarial snapshot orderings", async () => {
  const valid = result(details("Older", 8));
  const invalid = result({ tasks: "corrupt" });
  const newest = result(details("Authoritative", 3));
  const error = { ...invalid, message: { ...invalid.message, isError: true } };
  const unrelated = {
    type: "message",
    message: { role: "toolResult", toolName: "other", details: {} },
  };
  for (const branch of [
    [invalid, newest],
    [valid, invalid, newest],
    [invalid, valid, invalid, newest],
    [invalid, error, unrelated, valid, invalid, newest, error, unrelated],
  ]) {
    const state = await replayTodoState({ getBranch: async () => branch });
    assert.deepEqual(state, {
      tasks: [{ id: 2, subject: "Authoritative", status: "pending" }],
      nextId: 3,
    });
  }
  for (const branch of [
    [invalid],
    [invalid, valid, invalid],
    [valid, invalid, error, unrelated],
    [valid, result(undefined), error],
    [valid, result(null), unrelated],
  ]) {
    await assert.rejects(replayTodoState({ getBranch: async () => branch }), TodoSnapshotError);
  }
});

test("a newer full empty checkpoint supersedes corrupt and populated snapshots", async () => {
  const empty = { ...details("Unused"), action: "clear", tasks: [], nextId: 1 };
  assert.deepEqual(await replayTodoState({
    getBranch: async () => [result(details("Old")), result({}), result(empty)],
  }), { tasks: [], nextId: 1 });
});

test("error-only and non-checkpoint branches initialize empty state", async () => {
  const checkpoint = result(details("Ignored"));
  assert.deepEqual(await replayTodoState({
    getBranch: async () => [
      null,
      [],
      { type: "compaction", message: checkpoint.message },
      { type: "message", message: { ...checkpoint.message, role: "assistant" } },
      { type: "message", message: { ...checkpoint.message, isError: true } },
      { type: "message", message: { ...checkpoint.message, isError: true, details: {} } },
    ],
  }), { tasks: [], nextId: 1 });
});

test("branch read failures propagate unchanged", async () => {
  const failure = new Error("journal read failed");
  await assert.rejects(replayTodoState({
    getBranch: async () => { throw failure; },
  }), (error) => error === failure);
});

test("iterator failures propagate before interpreting any candidate checkpoint", async () => {
  for (const candidate of [undefined, result(details("Valid")), result({})]) {
    const failure = new Error("journal iteration failed");
    await assert.rejects(replayTodoState({
      getBranch: async () => ({
        *[Symbol.iterator]() {
          if (candidate) yield candidate;
          throw failure;
        },
      }),
    }), (error) => error === failure);
  }
});
