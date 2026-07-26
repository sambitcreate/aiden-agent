import assert from "node:assert/strict";
import test from "node:test";
import { isModelSelectionAvailable } from "../../lib/use-model-selection.js";
import type { Provider } from "../../lib/types.js";
import {
  canSendAssistantMessage,
  rollbackOptimisticAssistantTurn,
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
