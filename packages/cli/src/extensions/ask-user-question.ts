/**
 * Ask User Question in the terminal: reuses Aiden's desktop extension core
 * (main/services/ask-user-question-extension.ts) and implements the request
 * callback with pi's TUI dialogs — one select per question, multi-select
 * questions accumulate choices until Done. Escape cancels the questionnaire.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAskUserQuestionExtension } from "../../../../main/services/ask-user-question-extension.js";
import { aidenExtensionToInlineFactory, type AidenExtensionShape } from "../pi-bridge/adapt-aiden-extension.ts";
import type { CapturedContext } from "../pi-bridge/adapt-aiden-extension.ts";
import { createTerminalAskUserQuestionRequest, type SelectUi } from "./ask-user-question-core.ts";
export { requestQuestionnaire, type SelectUi } from "./ask-user-question-core.ts";

export function createAskUserQuestionInlineExtension(context: {
	latestContext(): CapturedContext | undefined;
}): { name: string; factory: ExtensionFactory } {
	const extension = createAskUserQuestionExtension({
		request: createTerminalAskUserQuestionRequest(() => {
			const ctx = context.latestContext();
			const ui = ctx?.hasUI ? (ctx.ui as { select?: SelectUi["select"] }) : undefined;
			const select = ui?.select?.bind(ui);
			return select ? { select } : undefined;
		}),
	});
	return aidenExtensionToInlineFactory("aiden-ask-user-question", extension as AidenExtensionShape);
}
