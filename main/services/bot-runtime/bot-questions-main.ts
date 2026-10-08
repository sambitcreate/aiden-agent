// The process-wide Bot question bridge. Waiting questions reach desktop windows
// through the live projection (`bots:live:event`) and Remote clients through the
// session projection, both driven by `onChange`. Answers arrive over
// `bots:answerQuestion` and `POST /bots/{id}/questions/{waitId}/answer`.

import { createBotQuestions } from "./bot-questions.js";

export const botQuestions = createBotQuestions();
