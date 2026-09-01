import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemorySessionRepo,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { todoSnapshotForRenderer, type TodoSnapshotViewV1 } from "../../../renderer/shared/todo.js";
import { PiAgentRuntimeHarness } from "../pi-agent-runtime-harness.js";
import { appendPiMessages } from "../pi-compaction-session-store.js";
import { createPiSessionPort, type PiSessionPort } from "../pi-session-port.js";
import { createTodoExtensionRuntime } from "./extension.js";

async function todoHarness(input: {
  appendMessages: (session: PiSessionPort, messages: readonly AgentMessage[]) => Promise<void>;
  published: TodoSnapshotViewV1[];
}) {
  const core = createFauxCore({ provider: `todo-harness-${Math.random().toString(36).slice(2)}` });
  core.setResponses([
    fauxAssistantMessage([fauxToolCall("todo", { action: "create", subject: "Durable task" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const model = core.getModel();
  const session = createPiSessionPort(
    await new InMemorySessionRepo().create({
      id: `todo-session-${Math.random().toString(36).slice(2)}`,
    }),
  );
  const runtime = createTodoExtensionRuntime(
    { tasks: [], nextId: 1 },
    {
      onDurableSnapshot: (state) => {
        input.published.push(todoSnapshotForRenderer("chat-todo", state));
      },
    },
  );
  const harness = new PiAgentRuntimeHarness({
    extensions: [runtime.extension],
    identity: { runId: "todo-run", sessionId: "todo-session", lane: "foreground" },
    convertToLlm: (messages) =>
      messages.filter(
        (message) =>
          message.role === "user" || message.role === "assistant" || message.role === "toolResult",
      ),
    streamFn: core.streamSimple,
    initialState: {
      systemPrompt: "Todo integration test",
      thinkingLevel: "off",
      tools: [],
      messages: [],
      model,
    },
    durability: {
      session,
      appendMessages: input.appendMessages,
      compaction: { models: createModels(), model, thinkingLevel: "off" },
    },
  });
  return { harness, session };
}

test("harness publishes todo only after the tool result append resolves", async () => {
  const published: TodoSnapshotViewV1[] = [];
  let appendStarted!: () => void;
  const atAppend = new Promise<void>((resolve) => {
    appendStarted = resolve;
  });
  let releaseAppend!: () => void;
  const appendMayFinish = new Promise<void>((resolve) => {
    releaseAppend = resolve;
  });
  const { harness } = await todoHarness({
    published,
    appendMessages: async (session, messages) => {
      if (messages.some((message) => message.role === "toolResult")) {
        appendStarted();
        await appendMayFinish;
      }
      await appendPiMessages(session, messages);
    },
  });

  const running = harness.runManaged({
    kind: "append-and-run",
    message: { role: "user", content: "track the work", timestamp: 1 },
  });
  await atAppend;
  assert.equal(published.length, 0);

  releaseAppend();
  const outcome = await running;
  await harness.settleRuntimeObservers();
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(published.map((snapshot) => snapshot.tasks[0]?.subject), ["Durable task"]);
});

test("harness never publishes todo when the tool result append fails", async () => {
  const published: TodoSnapshotViewV1[] = [];
  const { harness } = await todoHarness({
    published,
    appendMessages: async (session, messages) => {
      if (messages.some((message) => message.role === "toolResult")) {
        throw new Error("PRIVATE_TODO_APPEND_FAILURE");
      }
      await appendPiMessages(session, messages);
    },
  });

  const outcome = await harness.runManaged({
    kind: "append-and-run",
    message: { role: "user", content: "track the work", timestamp: 1 },
  });
  await harness.settleRuntimeObservers();

  assert.equal(outcome.kind, "host_failed");
  assert.equal(outcome.kind === "host_failed" ? outcome.faultKind : undefined, "session");
  assert.deepEqual(published, []);
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_TODO_APPEND_FAILURE/u);
});
