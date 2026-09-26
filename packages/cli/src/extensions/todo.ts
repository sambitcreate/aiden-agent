/**
 * Todo in the terminal: reuses Aiden's journal-replayed todo core
 * (main/services/rpiv-todo) and mirrors the desktop's floating progress chip
 * with a pi widget above the editor, refreshed after every todo tool result.
 * Widget rendering lives in todo-widget.ts (pure, unit-testable).
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createTodoExtensionRuntime } from "../../../../main/services/rpiv-todo/extension.js";
import type { TodoState } from "../../../../main/services/rpiv-todo/contract.js";
import { aidenExtensionToInlineFactory, type AidenExtensionShape, type CapturedContext } from "../pi-bridge/adapt-aiden-extension.ts";
import { renderTodoWidget } from "./todo-widget.ts";

export function createTodoInlineExtension(_context: {
	latestContext(): CapturedContext | undefined;
}): { name: string; factory: ExtensionFactory; snapshot(): TodoState } {
	const runtime = createTodoExtensionRuntime({ tasks: [], nextId: 1 });
	const { factory } = aidenExtensionToInlineFactory("aiden-todo", runtime.extension as AidenExtensionShape);
	const wrapped: ExtensionFactory = (pi) => {
		factory(pi);
		pi.on("tool_execution_end", (event, ctx) => {
			if (event.toolName !== "todo" || !ctx.hasUI || ctx.mode !== "tui") return;
			ctx.ui.setWidget("aiden-todo", renderTodoWidget(runtime.snapshot()));
		});
	};
	return { name: "aiden-todo", factory: wrapped, snapshot: runtime.snapshot };
}
