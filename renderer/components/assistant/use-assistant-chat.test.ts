import assert from "node:assert/strict";
import test from "node:test";
import { isModelSelectionAvailable } from "../../lib/use-model-selection.js";
import type { Provider } from "../../lib/types.js";
import {
  assistantGenerationIsActive,
  assistantGenerationPhaseAfterStop,
  canChangeAssistantThread,
  canSendAssistantMessage,
  rollbackOptimisticAssistantTurn,
  settleFailedAssistantMessages,
  settleAssistantMessages,
  type AssistantMessage,
} from "./use-assistant-chat.js";

test("blocks empty and whitespace-only sends", () => {
  assert.equal(canSendAssistantMessage("", { streaming: false, ready: true }), false);
  assert.equal(canSendAssistantMessage("   \n ", { streaming: false, ready: true }), false);
});

test("blocks while a response is streaming", () => {
  assert.equal(canSendAssistantMessage("hi", { streaming: true, ready: true }), false);
});

test("blocks until a provider and model are known", () => {
  assert.equal(canSendAssistantMessage("hi", { streaming: false, ready: false }), false);
});

test("allows a real message when idle and ready", () => {
  assert.equal(canSendAssistantMessage("hi", { streaming: false, ready: true }), true);
});

test("user stop remains active until the canceled generation settles", () => {
  const stopping = assistantGenerationPhaseAfterStop("streaming", true);
  assert.equal(stopping, "stopping");
  assert.equal(assistantGenerationIsActive(stopping), true);
  assert.equal(
    canSendAssistantMessage("follow-up", {
      streaming: assistantGenerationIsActive(stopping),
      ready: false,
    }),
    false,
  );

  assert.equal(assistantGenerationIsActive("idle"), false);
  assert.equal(
    canSendAssistantMessage("follow-up", {
      streaming: assistantGenerationIsActive("idle"),
      ready: true,
    }),
    true,
  );
});

test("thread changes stay blocked until generation persistence settles", () => {
  assert.equal(
    canChangeAssistantThread({
      conversationLoading: false,
      streaming: true,
      turnSaving: false,
    }),
    false,
  );
  assert.equal(
    canChangeAssistantThread({
      conversationLoading: false,
      streaming: false,
      turnSaving: true,
    }),
    false,
  );
  assert.equal(
    canChangeAssistantThread({
      conversationLoading: false,
      streaming: false,
      turnSaving: false,
    }),
    true,
  );
});

test("a terminal-only response fills the optimistic assistant row", () => {
  const messages: AssistantMessage[] = [
    { role: "user", content: "What changed?" },
    { role: "assistant", content: "" },
  ];
  assert.deepEqual(settleAssistantMessages(messages, "Here is the final response."), [
    { role: "user", content: "What changed?" },
    { role: "assistant", content: "Here is the final response." },
  ]);
});

test("the terminal response is authoritative over streamed deltas", () => {
  const messages: AssistantMessage[] = [
    { role: "user", content: "Summarize this." },
    { role: "assistant", content: "Partial respon" },
  ];
  assert.deepEqual(settleAssistantMessages(messages, "Partial response."), [
    { role: "user", content: "Summarize this." },
    { role: "assistant", content: "Partial response." },
  ]);
});

test("an error keeps its authoritative or not-yet-flushed partial reply", () => {
  const messages: AssistantMessage[] = [
    { role: "user", content: "Summarize this." },
    { role: "assistant", content: "Persisted " },
  ];
  assert.deepEqual(
    settleFailedAssistantMessages(messages, "Persisted partial response", "unflushed"),
    [
      { role: "user", content: "Summarize this." },
      { role: "assistant", content: "Persisted partial response" },
    ],
  );
  assert.deepEqual(settleFailedAssistantMessages(messages, undefined, "tail"), [
    { role: "user", content: "Summarize this." },
    { role: "assistant", content: "Persisted tail" },
  ]);
});

test("an error removes only an empty assistant placeholder when no partial exists", () => {
  const messages: AssistantMessage[] = [
    { role: "user", content: "Summarize this." },
    { role: "assistant", content: "" },
  ];
  assert.deepEqual(settleFailedAssistantMessages(messages, undefined, ""), [
    { role: "user", content: "Summarize this." },
  ]);
});

test("failed persistence removes the optimistic user turn and placeholder", () => {
  const existing: AssistantMessage[] = [{ role: "assistant", content: "Earlier reply" }];
  assert.deepEqual(
    rollbackOptimisticAssistantTurn(
      [...existing, { role: "user", content: "Please retry" }, { role: "assistant", content: "" }],
      "Please retry",
    ),
    existing,
  );
  assert.deepEqual(
    rollbackOptimisticAssistantTurn(
      [...existing, { role: "user", content: "Please retry" }],
      "Please retry",
    ),
    existing,
  );
});

test("readiness requires the selected model to exist on a usable live provider", () => {
  const provider: Provider = {
    id: "hosted",
    kind: "openai",
    label: "Hosted",
    baseUrl: "https://example.test/v1",
    models: ["model-a"],
    needsKey: true,
    hasKey: true,
  };
  assert.equal(
    isModelSelectionAvailable({ providerId: "hosted", model: "model-a" }, [provider]),
    true,
  );
  assert.equal(
    isModelSelectionAvailable({ providerId: "hosted", model: "removed-model" }, [provider]),
    false,
  );
  assert.equal(
    isModelSelectionAvailable({ providerId: "hosted", model: "model-a" }, [
      { ...provider, hasKey: false },
    ]),
    false,
  );
});
