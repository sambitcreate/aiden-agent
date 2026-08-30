import assert from "node:assert/strict";
import test from "node:test";
import {
  TODO_DETAILS_KIND,
  TodoSnapshotError,
  parseTodoToolDetails,
  sanitizeTodoText,
  validateTodoState,
} from "./contract.js";

test("sanitizes terminal controls, layout controls, and bidi overrides", () => {
  assert.equal(
    sanitizeTodoText("safe\u001b[31mred\u001b[0m\nnext\u202egfed\u202c"),
    "safered nextgfed",
  );
});

test("strict state validation accepts tombstoned dependencies but rejects graph corruption", () => {
  const valid = validateTodoState({
    tasks: [
      { id: 1, subject: "Dependency", status: "deleted" },
      { id: 2, subject: "Consumer", status: "pending", blockedBy: [1] },
    ],
    nextId: 3,
  });
  assert.deepEqual(valid.tasks[1]?.blockedBy, [1]);
  assert.throws(
    () =>
      validateTodoState({
        tasks: [
          { id: 1, subject: "A", status: "pending", blockedBy: [2] },
          { id: 2, subject: "B", status: "pending", blockedBy: [1] },
        ],
        nextId: 3,
      }),
    TodoSnapshotError,
  );
  assert.throws(
    () =>
      validateTodoState({
        tasks: [
          { id: 1, subject: "A", status: "in_progress" },
          { id: 2, subject: "B", status: "in_progress" },
        ],
        nextId: 3,
      }),
    TodoSnapshotError,
  );
});

test("snapshot parser rejects unknown versions, unknown fields, accessors, and unsafe next ids", () => {
  const base = {
    kind: TODO_DETAILS_KIND,
    version: 1,
    action: "list",
    tasks: [],
    nextId: 1,
  };
  assert.deepEqual(parseTodoToolDetails(base), base);
  assert.throws(() => parseTodoToolDetails({ ...base, version: 2 }), TodoSnapshotError);
  assert.throws(() => parseTodoToolDetails({ ...base, surprise: true }), TodoSnapshotError);
  assert.throws(
    () => parseTodoToolDetails({ ...base, tasks: [{ id: 2, subject: "x", status: "pending" }] }),
    TodoSnapshotError,
  );
  const accessor = Object.defineProperty({}, "kind", {
    enumerable: true,
    get: () => TODO_DETAILS_KIND,
  });
  assert.throws(() => parseTodoToolDetails(accessor), TodoSnapshotError);
});

test("snapshot parser rejects unsanitized persisted display text and non-JSON metadata", () => {
  const details = {
    kind: TODO_DETAILS_KIND,
    version: 1,
    action: "create",
    tasks: [{ id: 1, subject: "unsafe\u001b[31m", status: "pending" }],
    nextId: 2,
  };
  assert.throws(() => parseTodoToolDetails(details), TodoSnapshotError);
  assert.throws(
    () =>
      validateTodoState({
        tasks: [{ id: 1, subject: "x", status: "pending", metadata: { value: Infinity } }],
        nextId: 2,
      }),
    TodoSnapshotError,
  );
});
