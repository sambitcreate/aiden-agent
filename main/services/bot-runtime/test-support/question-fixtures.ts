// Fixtures for the Bot `ask_user_question` tests: the tool's arguments, a
// valid composer answer, and the tool entries a Bot turn would offer.

import type { AskUserQuestionResponseV1 } from "../../../../renderer/shared/ask-user-question.js";
import type { BotToolEntry } from "../bot-extension.js";
import { botQuestionCandidate } from "../bot-question-tool.js";
import type { BotQuestions } from "../bot-questions.js";

export const QUESTION_TOOL_NAME = "ask_user_question";

export const QUESTION_ARGS = {
  questions: [
    {
      question: "Which colour should the banner use?",
      header: "Colour",
      options: [
        { label: "Blue", description: "Calm and cool." },
        { label: "Red", description: "Loud and warm." },
        { label: "Green", description: "Fresh." },
      ],
    },
  ],
};

/** The composer's answer for one single-choice question. */
export function optionAnswer(promptId: string, label: string): AskUserQuestionResponseV1 {
  return {
    version: 1,
    promptId,
    cancelled: false,
    answers: [{ questionIndex: 0, kind: "option", answer: label }],
  };
}

/** The question tool as a Bot turn offers it, answered through `questions`. */
export function questionEntries(questions: BotQuestions, botId = "bot-q"): BotToolEntry[] {
  const candidate = botQuestionCandidate(botId, questions);
  return [{ tool: candidate.tool, replay: candidate.replay ?? "safe", ...(candidate.bind ? { bind: candidate.bind } : {}) }];
}
