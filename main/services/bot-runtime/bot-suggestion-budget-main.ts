// Production wiring of the shared budget on a Bot's own suggestions.

import { app } from "../../platform.js";
import { createBotSuggestionBudget } from "./bot-suggestion-budget.js";

export const botSuggestionBudget = createBotSuggestionBudget({ profileDir: () => app.getPath("userData"), now: Date.now });
