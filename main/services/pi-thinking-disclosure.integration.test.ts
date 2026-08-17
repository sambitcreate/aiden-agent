import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationTimeline } from "../../renderer/shared/generation-timeline.js";
import { GenerationTimelineProjector } from "./generation-timeline.js";
import {
  reconcileTerminalAssistantProjection,
  shouldExposeReasoning,
} from "./generation-runtime.js";

const canonicalMessage = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "Readable model thought." },
    { type: "thinking", thinking: "Opaque model state.", redacted: true },
    { type: "text", text: "Visible answer." },
  ],
};

test("Pi thinking projection is provider-neutral while local visibility remains presentation-only", () => {
  const original = structuredClone(canonicalMessage);
  for (const provider of [
    { id: "anthropic", deployment: "hosted" as const },
    { id: "openai-codex", deployment: "hosted" as const },
    { id: "google-vertex", deployment: "hosted" as const },
    { id: "amazon-bedrock", deployment: "hosted" as const },
    { id: "custom-local", deployment: "local" as const },
  ]) {
    const showLocal = provider.deployment === "local" ? undefined : false;
    const projection = reconcileTerminalAssistantProjection(
      { full: "", reasoning: "" },
      { full: 0, reasoning: 0 },
      canonicalMessage,
      shouldExposeReasoning(provider, showLocal),
    );
    assert.equal(projection.reasoning, "Readable model thought.");
    assert.equal(projection.reasoning.includes("Opaque model state."), false);
  }

  const hidden = reconcileTerminalAssistantProjection(
    { full: "", reasoning: "" },
    { full: 0, reasoning: 0 },
    canonicalMessage,
    shouldExposeReasoning({ id: "custom-local", deployment: "local" }, false),
  );
  assert.equal(hidden.full, "Visible answer.");
  assert.equal(hidden.reasoning, "");
  assert.deepEqual(canonicalMessage, original, "projection must not mutate private Pi content");
});

test("hidden local reasoning still records the provider-neutral thinking duration", () => {
  let now = 1_000;
  let latest: GenerationTimeline | undefined;
  const timeline = new GenerationTimelineProjector(
    "generation-1",
    (snapshot) => {
      latest = snapshot;
    },
    () => now,
  );

  timeline.thinkingStarted();
  now += 375;
  timeline.thinkingEnded();

  const thinking = latest?.steps.find((step) => step.kind === "thinking");
  assert.equal(thinking?.kind, "thinking");
  assert.equal(thinking?.durationMs, 375);
  assert.equal(shouldExposeReasoning({ id: "custom-local", deployment: "local" }, false), false);
});
