import { randomUUID } from "node:crypto";
import {
	ASK_USER_QUESTION_VERSION,
	type AskUserQuestionAnswerV1,
	type AskUserQuestionResponseV1,
	type AskUserQuestionV1,
} from "../../../../renderer/shared/ask-user-question.ts";

export interface SelectUi {
	select(
		title: string,
		options: string[],
		opts?: { placeholder?: string; signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
}

type Selection =
	| { kind: "selected"; choice: string }
	| { kind: "cancelled" }
	| { kind: "timedOut" };

function emptyResponse(
	answers: AskUserQuestionAnswerV1[],
	options: { cancelled: boolean; timedOut?: boolean },
): AskUserQuestionResponseV1 {
	return {
		version: ASK_USER_QUESTION_VERSION,
		promptId: randomUUID(),
		cancelled: options.cancelled,
		answers,
		...(options.timedOut ? { timedOut: true } : {}),
	};
}

/** Runs every terminal dialog under one deadline for the entire questionnaire. */
export async function requestQuestionnaire(
	ui: SelectUi | undefined,
	questions: AskUserQuestionV1[],
	signal?: AbortSignal,
	timeoutSeconds?: number,
): Promise<AskUserQuestionResponseV1> {
	const answers: AskUserQuestionAnswerV1[] = [];
	if (!ui) return emptyResponse(answers, { cancelled: true, timedOut: timeoutSeconds !== undefined });
	const deadline = timeoutSeconds === undefined ? undefined : Date.now() + timeoutSeconds * 1_000;
	const select = async (title: string, options: string[]): Promise<Selection> => {
		if (signal?.aborted) return { kind: "cancelled" };
		const remaining = deadline === undefined ? undefined : deadline - Date.now();
		if (remaining !== undefined && remaining <= 0) return { kind: "timedOut" };
		const choice = await ui.select(title, options, {
			...(signal ? { signal } : {}),
			...(remaining !== undefined ? { timeout: remaining } : {}),
		});
		if (signal?.aborted) return { kind: "cancelled" };
		if (deadline !== undefined && Date.now() >= deadline) return { kind: "timedOut" };
		return choice === undefined ? { kind: "cancelled" } : { kind: "selected", choice };
	};
	const interrupted = (selection: Exclude<Selection, { kind: "selected" }>) =>
		emptyResponse(answers, {
			cancelled: true,
			...(selection.kind === "timedOut" ? { timedOut: true } : {}),
		});

	for (const [index, question] of questions.entries()) {
		if (signal?.aborted) return interrupted({ kind: "cancelled" });
		const title = `(${index + 1}/${questions.length}) ${question.question}`;
		if (question.multiSelect === true) {
			const selected: string[] = [];
			for (;;) {
				const remaining = question.options
					.map((option) => option.label)
					.filter((label) => !selected.includes(label));
				if (remaining.length === 0) break;
				const selection = await select(
					`${title} — picked: ${selected.join(", ") || "none"}`,
					["Done", "Skip question", ...remaining],
				);
				if (selection.kind !== "selected") return interrupted(selection);
				if (selection.choice === "Skip question") break;
				if (selection.choice === "Done") {
					if (selected.length > 0) answers.push({ questionIndex: index, kind: "multi", selected });
					break;
				}
				selected.push(selection.choice);
			}
		} else {
			const selection = await select(title, [
				...question.options.map((option) => option.label),
				"Skip question",
			]);
			if (selection.kind !== "selected") return interrupted(selection);
			if (selection.choice !== "Skip question") {
				answers.push({ questionIndex: index, kind: "option", answer: selection.choice });
			}
		}
	}
	return emptyResponse(answers, { cancelled: false });
}

export function createTerminalAskUserQuestionRequest(
	resolveUi: () => SelectUi | undefined,
): (
	toolCallId: string,
	questions: AskUserQuestionV1[],
	signal?: AbortSignal,
	timeoutSeconds?: number,
) => Promise<AskUserQuestionResponseV1> {
	return (_toolCallId, questions, signal, timeoutSeconds) =>
		requestQuestionnaire(resolveUi(), questions, signal, timeoutSeconds);
}
