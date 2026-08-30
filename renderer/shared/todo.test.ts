import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseTodoSnapshotView,
  TodoSnapshotReadFence,
  todoSnapshotForRenderer,
  type TodoSnapshotViewV1,
} from "./todo.js";

test("renderer projection allowlists task display fields", () => {
  const privateTask = {
    id: 1,
    subject: "Implement",
    status: "pending" as const,
    activeForm: "Implementing",
    blockedBy: [],
    description: "private detail",
    owner: "private owner",
    metadata: { secret: "never cross" },
  };
  const projected = todoSnapshotForRenderer("chat-1", {
    tasks: [privateTask],
  });
  assert.deepEqual(projected.tasks[0], {
    id: 1,
    subject: "Implement",
    status: "pending",
    activeForm: "Implementing",
    blockedBy: [],
  });
  assert.doesNotMatch(JSON.stringify(projected), /private|secret|owner|metadata/u);
});

test("renderer parser rejects dangling dependencies and malformed unavailable state", () => {
  assert.equal(
    parseTodoSnapshotView({
      version: 1,
      chatId: "chat-1",
      availability: "ready",
      tasks: [{ id: 1, subject: "x", status: "pending", blockedBy: [2] }],
    }),
    undefined,
  );
  assert.equal(
    parseTodoSnapshotView({
      version: 1,
      chatId: "chat-1",
      availability: "unavailable",
      tasks: [{ id: 1, subject: "x", status: "pending" }],
    }),
    undefined,
  );
});

test("a slow initial read cannot overwrite a newer live snapshot", async () => {
  const fence = new TodoSnapshotReadFence();
  fence.reset("chat-1");
  const ticket = fence.beginInitialRead("chat-1");
  let resolveRead!: (snapshot: TodoSnapshotViewV1) => void;
  const slowRead = new Promise<TodoSnapshotViewV1>((resolve) => {
    resolveRead = resolve;
  });
  const applied: TodoSnapshotViewV1[] = [];
  const settling = slowRead.then((snapshot) => {
    if (fence.canApplyInitial(ticket)) applied.push(snapshot);
  });

  assert.equal(fence.markLive("chat-1"), true);
  resolveRead({
    version: 1,
    chatId: "chat-1",
    availability: "ready",
    tasks: [{ id: 1, subject: "Stale initial state", status: "pending" }],
  });
  await settling;

  assert.deepEqual(applied, []);
  assert.equal(fence.markLive("another-chat"), false);
});

test("chat pane connects initial reads and live notifications through the todo fence", () => {
  const source = readFileSync(new URL("../main/chat-pane.tsx", import.meta.url), "utf8");
  assert.match(source, /todoSnapshotReadFence\.reset\(chatId\)/u);
  assert.match(source, /beginInitialRead\(chatId\)/u);
  assert.match(source, /canApplyInitial\(ticket\)/u);
  assert.match(source, /markLive\(snapshot\.chatId\)/u);
});
