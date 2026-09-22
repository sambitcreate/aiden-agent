import assert from "node:assert/strict";
import test from "node:test";
import { loadDurableTodoSnapshot } from "./snapshot.js";
import { createTodoExtension } from "./extension.js";

test("missing durable storage never supplies state from which to admit the task tool", async () => {
  for (let turn = 0; turn < 2; turn += 1) {
    const result = await loadDurableTodoSnapshot("chat", undefined);
    assert.equal(result.state, undefined);
    assert.deepEqual(result.snapshot, {
      version: 1, chatId: "chat", availability: "unavailable",
      unavailableReason: "storage_not_enabled", tasks: [],
    });
  }
});

test("durable empty storage can admit tasks and replay them on the next turn", async () => {
  const branch: unknown[] = [];
  const session = { getBranch: async () => branch };
  const initial = await loadDurableTodoSnapshot("chat", session);
  assert.equal(initial.snapshot.availability, "ready");
  assert.ok(initial.state);
  const tool = createTodoExtension(initial.state).tools![0]!;
  const result = await tool.execute("call", { action: "create", subject: "Persist work" });
  branch.push({ type: "message", message: { role: "toolResult", toolName: "todo", details: result.details } });
  const resumed = await loadDurableTodoSnapshot("chat", session);
  assert.equal(resumed.snapshot.tasks[0]?.subject, "Persist work");
  assert.equal(resumed.state?.nextId, 2);
});

test("invalid newest snapshots stay empty and distinct from missing storage", async () => {
  const result = await loadDurableTodoSnapshot("chat", {
    getBranch: async () => [{ type: "message", message: {
      role: "toolResult", toolName: "todo", details: { private: "never export" },
    } }],
  });
  assert.equal(result.state, undefined);
  assert.equal(result.snapshot.unavailableReason, "invalid_snapshot");
  assert.deepEqual(result.snapshot.tasks, []);
  assert.doesNotMatch(JSON.stringify(result), /private|never export/u);
});

test("storage read errors propagate rather than being reported as snapshot corruption", async () => {
  const error = new Error("read failure");
  await assert.rejects(loadDurableTodoSnapshot("chat", {
    getBranch: async () => { throw error; },
  }), (actual) => actual === error);
});
