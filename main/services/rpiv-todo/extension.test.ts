import assert from "node:assert/strict";
import test from "node:test";
import { piRuntimeReplayPolicy } from "../pi-runtime-tool.js";
import type { PiRuntimeEventEnvelope } from "../pi-runtime-events.js";
import { createTodoExtensionRuntime, shouldEnableTodoExtension } from "./extension.js";

test("todo is admitted only to attended renderer-owned ordinary desktop chat", () => {
  const base = {
    usageSource: "chat",
    interactionSurface: "desktop",
    assistantMode: false,
    botBound: false,
    rendererOwner: true,
    excluded: false,
  };
  assert.equal(shouldEnableTodoExtension(base), true);
  assert.equal(shouldEnableTodoExtension({ ...base, rendererOwner: false }), false);
  assert.equal(shouldEnableTodoExtension({ ...base, interactionSurface: "telegram" }), false);
  assert.equal(shouldEnableTodoExtension({ ...base, assistantMode: true }), false);
  assert.equal(shouldEnableTodoExtension({ ...base, botBound: true }), false);
  assert.equal(shouldEnableTodoExtension({ ...base, excluded: true }), false);
  assert.equal(shouldEnableTodoExtension({ ...base, usageSource: "scheduled" }), false);
  assert.equal(shouldEnableTodoExtension({ ...base, usageSource: undefined }), false);
});

test("extension contributes a replay-safe native tool and durable snapshots", async () => {
  const runtime = createTodoExtensionRuntime({ tasks: [], nextId: 1 });
  const tool = runtime.extension.tools?.[0];
  assert.ok(tool);
  assert.equal(tool.name, "todo");
  assert.equal(piRuntimeReplayPolicy(tool), "safe");
  assert.match(runtime.extension.systemPrompt ?? "", /at most one task in_progress/u);
  const created = await tool.execute("create", { action: "create", subject: "Write tests" });
  assert.equal(created.details.tasks[0]?.subject, "Write tests");
  assert.equal(runtime.snapshot().nextId, 2);
  const listed = await tool.execute("list", { action: "list" });
  assert.match(listed.content[0]?.type === "text" ? listed.content[0].text : "", /Write tests/u);
});

test("per-generation factories never share mutable task state", async () => {
  const first = createTodoExtensionRuntime({ tasks: [], nextId: 1 });
  const second = createTodoExtensionRuntime({ tasks: [], nextId: 1 });
  await first.extension.tools?.[0]?.execute("create", { action: "create", subject: "Only first" });
  assert.equal(first.snapshot().tasks.length, 1);
  assert.deepEqual(second.snapshot(), { tasks: [], nextId: 1 });
});

test("cancellation happens before generation-local mutation", async () => {
  const runtime = createTodoExtensionRuntime({ tasks: [], nextId: 1 });
  const tool = runtime.extension.tools?.[0];
  assert.ok(tool);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tool.execute("cancel", { action: "create", subject: "Never stored" }, controller.signal),
    /cancelled/u,
  );
  assert.deepEqual(runtime.snapshot(), { tasks: [], nextId: 1 });
});

test("renderer publication waits for a durable tool-result journal event", async () => {
  const published: unknown[] = [];
  const runtime = createTodoExtensionRuntime(
    { tasks: [], nextId: 1 },
    {
      onDurableSnapshot: (snapshot) => {
        published.push(snapshot);
      },
    },
  );
  const tool = runtime.extension.tools?.[0];
  assert.ok(tool);
  await tool.execute("create", { action: "create", subject: "Durable only" });

  const envelope = (
    durable: boolean,
    messageRole: "assistant" | "toolResult",
  ): PiRuntimeEventEnvelope => ({
    version: 1,
    identity: { runId: "run-1", sessionId: "session-1", lane: "foreground" },
    sequence: 1,
    attempt: 1,
    turn: { id: "turn-1", index: 0 },
    timestamp: 1,
    payload: {
      type: "agent_event",
      durable,
      event: { type: "message_end", messageRole },
    },
  });

  await runtime.extension.onRuntimeEvent?.(
    envelope(false, "toolResult"),
    new AbortController().signal,
  );
  await runtime.extension.onRuntimeEvent?.(
    envelope(true, "assistant"),
    new AbortController().signal,
  );
  assert.deepEqual(published, []);

  await runtime.extension.onRuntimeEvent?.(
    envelope(true, "toolResult"),
    new AbortController().signal,
  );
  assert.deepEqual(published, [
    {
      tasks: [{ id: 1, subject: "Durable only", status: "pending" }],
      nextId: 2,
    },
  ]);
});
