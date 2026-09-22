import assert from "node:assert/strict";
import test from "node:test";
import type { TodoState } from "./contract.js";
import { applyTodo } from "./reducer.js";

const empty = (): TodoState => ({ tasks: [], nextId: 1 });

test("create sanitizes display text and returns a complete versioned snapshot", () => {
  const result = applyTodo(empty(), {
    action: "create",
    subject: "  Write\n tests\u202e  ",
    activeForm: "writing\ttests",
    metadata: { lane: "backend" },
  });
  assert.equal(result.details.error, undefined);
  assert.equal(result.state.tasks[0]?.subject, "Write  tests");
  assert.equal(result.state.tasks[0]?.activeForm, "writing tests");
  assert.equal(result.details.tasks[0]?.metadata?.lane, "backend");
  assert.equal(result.details.nextId, 2);
});

test("rejections are in-band, preserve state exactly, and reject a second active task", () => {
  const initial: TodoState = {
    tasks: [
      { id: 1, subject: "First", status: "in_progress" },
      { id: 2, subject: "Second", status: "pending" },
    ],
    nextId: 3,
  };
  const result = applyTodo(initial, { action: "update", id: 2, status: "in_progress" });
  assert.match(result.content, /^Error:/u);
  assert.match(result.details.error ?? "", /already in_progress/u);
  assert.deepEqual(result.state, initial);
  assert.deepEqual(result.details.tasks, initial.tasks);
});

test("dependency updates reject dangling, deleted, self, and cyclic edges before mutation", () => {
  const initial: TodoState = {
    tasks: [
      { id: 1, subject: "One", status: "pending" },
      { id: 2, subject: "Two", status: "pending", blockedBy: [1] },
      { id: 3, subject: "Deleted", status: "deleted" },
    ],
    nextId: 4,
  };
  for (const [id, message] of [
    [99, /not found/u],
    [3, /deleted/u],
    [2, /itself/u],
  ] as const) {
    const result = applyTodo(initial, { action: "update", id: 2, addBlockedBy: [id] });
    assert.match(result.details.error ?? "", message);
    assert.deepEqual(result.state, initial);
  }
  const cycle = applyTodo(initial, { action: "update", id: 1, addBlockedBy: [2] });
  assert.match(cycle.details.error ?? "", /cycle/u);
  assert.deepEqual(cycle.state, initial);
});

test("delete preserves tombstone references and clear deliberately resets ids", () => {
  const initial: TodoState = {
    tasks: [
      { id: 1, subject: "Dependency", status: "pending" },
      { id: 2, subject: "Consumer", status: "pending", blockedBy: [1] },
    ],
    nextId: 3,
  };
  const deleted = applyTodo(initial, { action: "delete", id: 1 });
  assert.equal(deleted.details.error, undefined);
  assert.equal(deleted.state.tasks[0]?.status, "deleted");
  assert.deepEqual(deleted.state.tasks[1]?.blockedBy, [1]);
  const cleared = applyTodo(deleted.state, { action: "clear" });
  assert.deepEqual(cleared.state, { tasks: [], nextId: 1 });
});

test("metadata updates merge keys and null deletes an existing key", () => {
  const initial: TodoState = {
    tasks: [{ id: 1, subject: "Task", status: "pending", metadata: { a: 1, b: true } }],
    nextId: 2,
  };
  const result = applyTodo(initial, { action: "update", id: 1, metadata: { a: null, c: "x" } });
  assert.deepEqual(result.state.tasks[0]?.metadata, { b: true, c: "x" });
});

test("completed is one-way and identical updates report no change", () => {
  const initial: TodoState = {
    tasks: [{ id: 1, subject: "Done", status: "completed" }],
    nextId: 2,
  };
  assert.match(
    applyTodo(initial, { action: "update", id: 1, status: "in_progress" }).details.error ?? "",
    /illegal transition/u,
  );
  assert.match(
    applyTodo(initial, { action: "update", id: 1, status: "completed" }).content,
    /No change/u,
  );
});
