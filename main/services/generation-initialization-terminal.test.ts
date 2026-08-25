import assert from "node:assert/strict";
import test from "node:test";
import {
  persistGenerationInitializationTerminal,
  type GenerationInitializationTerminalMessage,
  type GenerationInitializationTerminalMeta,
} from "./generation-initialization-terminal.js";

test("initialization terminal persistence is ordered, exact, and once-only", async () => {
  const events: string[] = [];
  const messages: GenerationInitializationTerminalMessage[] = [];
  const metas: GenerationInitializationTerminalMeta[] = [];
  const state = { attempted: false };
  const append = async (message: GenerationInitializationTerminalMessage, meta: GenerationInitializationTerminalMeta) => {
    events.push("append-start");
    await Promise.resolve();
    messages.push(message);
    metas.push(meta);
    events.push("append-durable");
  };
  const common = {
    state,
    hasAuthoritativeChat: true,
    workspaceId: "workspace-1",
    streamId: "stream-1",
    providerId: "provider-1",
    model: "model-1",
    isCurrent: () => true,
    append,
    onUnknownOutcome: () => assert.fail("unexpected unknown persistence outcome"),
  };
  assert.equal(await persistGenerationInitializationTerminal({
    ...common,
    status: "cancelled",
    cancellationOrigin: "user_stop",
  }), "persisted");
  events.push("ownership-release");
  assert.deepEqual(events, ["append-start", "append-durable", "ownership-release"]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.timeline.status, "cancelled");
  assert.equal(messages[0]?.timeline.cancellationOrigin, "user_stop");
  assert.equal(metas[0]?.expectedWorkspaceId, "workspace-1");
  assert.equal(await persistGenerationInitializationTerminal({
    ...common,
    status: "failed",
  }), "skipped");
  assert.equal(messages.length, 1);
});

test("initialization terminal persistence is authority gated and unknown outcomes never retry", async () => {
  let appends = 0;
  assert.equal(await persistGenerationInitializationTerminal({
    state: { attempted: false },
    hasAuthoritativeChat: true,
    workspaceId: undefined,
    streamId: "stream-2",
    providerId: "provider-1",
    model: "model-1",
    status: "failed",
    isCurrent: () => true,
    append: async () => { appends += 1; },
    onUnknownOutcome: () => assert.fail("unexpected unknown persistence outcome"),
  }), "skipped");
  const state = { attempted: false };
  let unknowns = 0;
  const options = {
    state,
    hasAuthoritativeChat: true,
    workspaceId: "workspace-1",
    streamId: "stream-3",
    providerId: "provider-1",
    model: "model-1",
    status: "failed" as const,
    isCurrent: () => true,
    append: async () => { appends += 1; throw new Error("unknown append outcome"); },
    onUnknownOutcome: () => { unknowns += 1; },
  };
  assert.equal(await persistGenerationInitializationTerminal(options), "unknown");
  assert.equal(await persistGenerationInitializationTerminal(options), "skipped");
  assert.equal(appends, 1);
  assert.equal(unknowns, 1);
});
