// The process-wide Bot question bridge. Waiting questions reach desktop windows
// through the live projection (`bots:live:event`) and Remote clients through the
// session projection, both driven by `onChange`.

import { createBotQuestions } from "./bot-questions.js";

export const botQuestions = createBotQuestions();
