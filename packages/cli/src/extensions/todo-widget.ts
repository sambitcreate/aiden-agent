/**
 * Pure rendering for the todo widget (no runtime dependencies beyond Aiden's
 * todo contract types, so it is unit-testable under Node's TypeScript
 * stripping).
 */

import type { TodoState, TodoTask } from "../../../../main/services/rpiv-todo/contract.js";

const STATUS_GLYPHS: Record<string, string> = {
	pending: "○",
	in_progress: "◉",
	completed: "✓",
	deleted: "⊘",
};

function taskLabel(task: TodoTask): string {
	const label = task.activeForm || task.subject;
	return task.status === "in_progress" ? `${label}…` : label;
}

/** Compact widget rendering of the todo snapshot; mirrors the desktop chip's content. */
export function renderTodoWidget(state: TodoState): string[] | undefined {
	const tasks = state.tasks.filter((task) => task.status !== "deleted");
	if (tasks.length === 0) return undefined;
	const completed = tasks.filter((task) => task.status === "completed").length;
	const lines = [`todos ${completed}/${tasks.length}`];
	for (const task of tasks) {
		const blocked = task.blockedBy && task.blockedBy.length > 0 ? ` (blocked by ${task.blockedBy.join(", ")})` : "";
		lines.push(`  ${STATUS_GLYPHS[task.status] ?? "○"} ${taskLabel(task)}${blocked}`);
	}
	return lines;
}
