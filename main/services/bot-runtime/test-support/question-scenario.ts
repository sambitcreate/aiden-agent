// Child-process half of the Bot question crash test (run through
// kill-harness.mjs `scenario`). It starts a Bot turn that asks a quick-reply
// question and announces the question's wait id, so the parent can SIGKILL the
// process while the question waits.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createBotRegistry } from "../bot-extension.js";
import { createBotHarnessHost } from "../harness-host.js";
import { createBotQuestions } from "../bot-questions.js";
import { recordingDeps } from "./fixtures.js";
import { createFauxModels, FAUX_MODEL_REF } from "./faux.js";
import { QUESTION_ARGS, QUESTION_TOOL_NAME, questionEntries } from "./question-fixtures.js";

type Emit = (tag: string, value: unknown) => void;

export interface QuestionScenarioArgs {
  profileDir: string;
  botId: string;
}

export async function run(args: QuestionScenarioArgs, emit: Emit): Promise<void> {
  const ctx = BACKGROUND_CONTEXT;
  const questions = createBotQuestions();
  questions.onChange((botId) => {
    const [prompt] = questions.pending(botId);
    if (prompt) emit("QUESTION", prompt.waitId);
  });
  const deps = recordingDeps({ tools: questionEntries(questions, args.botId) });
  const { models } = createFauxModels([
    fauxAssistantMessage([fauxToolCall(QUESTION_TOOL_NAME, QUESTION_ARGS)], { stopReason: "toolUse" }),
  ]);
  const registries = new Map<string, ReturnType<typeof createBotRegistry>>();
  const host = await createBotHarnessHost({
    profileDir: args.profileDir,
    models,
    buildRegistry: (botId) => {
      const registry = createBotRegistry(botId, deps);
      registries.set(botId, registry);
      return registry;
    },
  });
  if ("unavailable" in host) throw new Error("profile locked");
  const { conversation } = await host.open(args.botId);
  await registries.get(args.botId)!.refresh();
  await conversation.configure({ model: FAUX_MODEL_REF }, ctx);
  const submission = await conversation.submit({ type: "input", content: "pick", requestId: "question" }, ctx);
  emit("SUBMITTED", String(submission.id));
}
