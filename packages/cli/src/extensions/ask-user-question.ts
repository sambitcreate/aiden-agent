/**
 * Ask User Question in the terminal: reuses Aiden's desktop extension core
 * (main/services/ask-user-question-extension.ts) and implements the request
 * callback with pi's TUI dialogs — one select per question, multi-select
 * questions accumulate choices until Done. Escape cancels the questionnaire.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	ASK_USER_QUESTION_VERSION,
	type AskUserQuestionAnswerV1,
	type AskUserQuestionResponseV1,
	type AskUserQuestionV1,
} from "../../../../renderer/shared/ask-user-question.js";
import { createAskUserQuestionExtension } from "../../../../main/services/ask-user-question-extension.js";
import { aidenExtensionToInlineFactory, type AidenExtensionShape } from "../pi-bridge/adapt-aiden-extension.ts";
import type { CapturedContext } from "../pi-bridge/adapt-aiden-extension.ts";

export interface SelectUi {
	select(title: string, options: string[], opts?: { placeholder?: string }): Promise<string | undefined>;
}

/** Shared with the advisor extension, whose reviewer picker uses the same flow. */
export async function requestQuestionnaire(
	ui: SelectUi | undefined,
	questions: AskUserQuestionV1[],
	signal?: AbortSignal,
): Promise<AskUserQuestionResponseV1> {
	if (!ui) {
		return { version: ASK_USER_QUESTION_VERSION, promptId: randomUUID(), cancelled: true, answers: [] };
	}
	const answers: AskUserQuestionAnswerV1[] = [];
	for (const [index, question] of questions.entries()) {
		if (signal?.aborted) {
			return { version: ASK_USER_QUESTION_VERSION, promptId: randomUUID(), cancelled: true, answers };
		}
		const title = `(${index + 1}/${questions.length}) ${question.question}`;
		if (question.multiSelect === true) {
			const selected: string[] = [];
			for (;;) {
				const remaining = question.options.map((option) => option.label).filter((label) => !selected.includes(label));
				if (remaining.length === 0) break;
				const choice = await ui.select(`${title} — picked: ${selected.join(", ") || "none"}`, [
					"Done",
					"Skip question",
					...remaining,
				]);
				if (choice === undefined) {
					return { version: ASK_USER_QUESTION_VERSION, promptId: randomUUID(), cancelled: true, answers };
				}
				if (choice === "Skip question") break;
				if (choice === "Done") {
					if (selected.length > 0) answers.push({ questionIndex: index, kind: "multi", selected });
					break;
				}
				selected.push(choice);
			}
		} else {
			const choice = await ui.select(title, [...question.options.map((option) => option.label), "Skip question"]);
			if (choice === undefined) {
				return { version: ASK_USER_QUESTION_VERSION, promptId: randomUUID(), cancelled: true, answers };
			}
			if (choice !== "Skip question") {
				answers.push({ questionIndex: index, kind: "option", answer: choice });
			}
		}
	}
	return { version: ASK_USER_QUESTION_VERSION, promptId: randomUUID(), cancelled: false, answers };
}

export function createAskUserQuestionInlineExtension(context: {
	latestContext(): CapturedContext | undefined;
}): { name: string; factory: ExtensionFactory } {
	const extension = createAskUserQuestionExtension({
		request: async (_toolCallId, questions, signal) => {
			const ctx = context.latestContext();
			const ui = ctx?.hasUI ? (ctx.ui as { select?: SelectUi["select"] }) : undefined;
			const select = ui?.select?.bind(ui);
			return requestQuestionnaire(select ? { select } : undefined, questions, signal);
		},
	});
	return aidenExtensionToInlineFactory("aiden-ask-user-question", extension as AidenExtensionShape);
}
