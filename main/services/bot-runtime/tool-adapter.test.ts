import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  ToolResultEntry,
  type Conversation,
} from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { adaptAidenTool } from "./tool-adapter.js";
import { blockingUntilAborted, countingTool } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor } from "./test-support/faux.js";

const ctx = BACKGROUND_CONTEXT;

async function harnessWith(tool: ReturnType<typeof adaptAidenTool>, responses: Parameters<typeof createFauxModels>[0]) {
  const fauxModels = createFauxModels(responses);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "adapter-test", tools: [tool] }));
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  return { harness, root, fauxModels };
}

async function toolResults(root: Conversation) {
  const view = await root.context(ctx);
  return view.entries
    .filter((entry) => entry.kind === ToolResultEntry.kind)
    .map((entry) => (entry as unknown as { model: Array<{ isError: boolean; content: Array<{ text?: string }> }> }).model[0]!);
}

test("an adapted tool receives its validated arguments and its result reaches the model", async () => {
  const echo = countingTool("echo");
  const { harness, root, fauxModels } = await harnessWith(adaptAidenTool(echo, { replay: "unsafe" }), [
    fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  try {
    const settled = await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    assert.deepEqual(echo.executions, [{ text: "hello" }]);
    const [result] = await toolResults(root);
    assert.equal(result!.isError, false);
    assert.equal(result!.content[0]!.text, "ran hello");
    assert.equal(fauxModels.calls(), 2);
  } finally {
    await harness.close(ctx);
  }
});

test("arguments that fail the TypeBox schema never reach the Aiden tool", async () => {
  const echo = countingTool("echo");
  const { harness, root } = await harnessWith(adaptAidenTool(echo, { replay: "unsafe" }), [
    fauxAssistantMessage([fauxToolCall("echo", { text: { nested: true } })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  try {
    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    assert.deepEqual(echo.executions, []);
    const [result] = await toolResults(root);
    assert.equal(result!.isError, true);
  } finally {
    await harness.close(ctx);
  }
});

test("onUpdate snapshots stream into the live tool output", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const streaming = countingTool("stream", async (_params, _signal, onUpdate) => {
    onUpdate?.({ content: [{ type: "text", text: "line one\n" }], details: { step: 1 } });
    onUpdate?.({ content: [{ type: "text", text: "line one\nline two\n" }], details: { step: 2 } });
    await gate;
    return "finished";
  });
  const { harness, root } = await harnessWith(adaptAidenTool(streaming, { replay: "unsafe" }), [
    fauxAssistantMessage([fauxToolCall("stream", { text: "x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  try {
    const submission = await root.submit({ type: "input", content: "go" }, ctx);
    const view = await root.viewState(ctx);
    const slot = () => (view.value.docs["pi.live"] as { tools?: Array<{ output?: string; details?: unknown }> } | undefined)?.tools?.[0];
    await waitFor(() => slot()?.output === "line one\nline two\n" && JSON.stringify(slot()?.details) === '{"step":2}', {
      what: "streamed tool output",
    });
    release();
    assert.equal((await submission.wait(ctx)).status, "done");
    view.dispose();
  } finally {
    await harness.close(ctx);
  }
});

test("stopping the conversation aborts the signal the Aiden tool received", async () => {
  let seen: AbortSignal | undefined;
  const hanging = countingTool("hang", async (_params, signal) => {
    seen = signal;
    return blockingUntilAborted(signal);
  });
  const { harness, root } = await harnessWith(adaptAidenTool(hanging, { replay: "unsafe" }), [
    fauxAssistantMessage([fauxToolCall("hang", { text: "x" })], { stopReason: "toolUse" }),
  ]);
  try {
    const submission = await root.submit({ type: "input", content: "go" }, ctx);
    await waitFor(() => seen !== undefined, { what: "tool start" });
    assert.equal(seen!.aborted, false);
    await root.abort(ctx);
    assert.equal(seen!.aborted, true);
    const settled = await submission.wait(ctx);
    assert.equal(settled.status, "unanswered");
  } finally {
    await harness.close(ctx);
  }
});
