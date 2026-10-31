// The process-wide Bot hand-off bridge. Waiting cards reach desktop windows
// through the live projection (`bots:live:event`), "Needs you" through
// `bots:attention`, and a Mac notification when no Aiden window is focused,
// all driven by `onChange`. Answers arrive over `bots:answerHandoff`.

import { createBotHandoffs } from "./bot-handoffs.js";

export const botHandoffs = createBotHandoffs();
