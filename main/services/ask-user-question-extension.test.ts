import assert from "node:assert/strict";
import test from "node:test";
import {
  createAskUserQuestionExtension,
  shouldEnableAskUserQuestionExtension,
} from "./ask-user-question-extension.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";

test("Ask User Question is limited to attended desktop workspace chat", () => {
  const base = {
    usageSource: "chat",
    interactionSurface: "desktop",
    assistantMode: false,
    botBound: false,
    rendererOwner: true,
    excluded: false,
  };
  assert.equal(shouldEnableAskUserQuestionExtension(base), true);
  assert.equal(shouldEnableAskUserQuestionExtension({ ...base, rendererOwner: false }), false);
  assert.equal(
    shouldEnableAskUserQuestionExtension({ ...base, interactionSurface: "telegram" }),
    false,
  );
  assert.equal(shouldEnableAskUserQuestionExtension({ ...base, assistantMode: true }), false);
  assert.equal(shouldEnableAskUserQuestionExtension({ ...base, botBound: true }), false);
});

test("tool returns selected and skipped answers without replaying an interruption", async () => {
  const extension = createAskUserQuestionExtension({
    request: async (_toolCallId, questions) => ({
      version: 1,
      promptId: "q-one",
      cancelled: false,
      answers: [{ questionIndex: 0, kind: "option", answer: questions[0]!.options[0]!.label }],
    }),
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  assert.equal(tool.executionMode, "sequential");
  assert.equal(piRuntimeReplayPolicy(tool), "never");
  const result = await tool.execute("call-one", {
    questions: [
      {
        question: "Which approach?",
        header: "Approach",
        options: [
          { label: "Direct", description: "Implement it now." },
          { label: "Guided", description: "Explain each step." },
        ],
      },
      {
        question: "How detailed?",
        header: "Detail",
        options: [
          { label: "Concise", description: "Only the essentials." },
          { label: "Detailed", description: "Include edge cases." },
        ],
      },
    ],
  });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /Answer: Direct/u);
  assert.match(text, /Answer: Skipped/u);
});
