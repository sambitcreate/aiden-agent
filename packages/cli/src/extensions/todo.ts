/**
 * Todo for daemon chats: reuses Aiden's journal-replayed todo core
 * (main/services/rpiv-todo) and restores its state from the session branch on
 * every session start or tree change.
 */

import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createTodoExtensionRuntime } from "../../../../main/services/rpiv-todo/extension.js";
import type { TodoState } from "../../../../main/services/rpiv-todo/contract.js";
import { replayTodoState } from "../../../../main/services/rpiv-todo/replay.js";
import { aidenExtensionToInlineFactory, type AidenExtensionShape, type CapturedContext } from "../pi-bridge/adapt-aiden-extension.ts";

export function createTodoInlineExtension(_context: {
	latestContext(): CapturedContext | undefined;
}): { name: string; factory: ExtensionFactory; snapshot(): TodoState } {
	const template = createTodoExtensionRuntime({ tasks: [], nextId: 1 });
	let runtime: ReturnType<typeof createTodoExtensionRuntime> | undefined;
	let restoreEpoch = 0;
	const current = () => {
		if (!runtime) throw new Error("Todo is unavailable until the current session's checkpoint state can be restored.");
		return runtime;
	};
	const tool: AgentTool = {
		...template.extension.tools![0]!,
		execute: async (...args) => current().extension.tools![0]!.execute(...args),
	};
	const { factory } = aidenExtensionToInlineFactory("aiden-todo", {
		...template.extension, tools: [tool],
	} as AidenExtensionShape);
	const wrapped: ExtensionFactory = (pi) => {
		factory(pi);
		const restore = async (_event: unknown, ctx: ExtensionContext) => {
			const epoch = ++restoreEpoch;
			runtime = undefined;
			try {
				const state = await replayTodoState({ getBranch: async () => ctx.sessionManager.getBranch() });
				if (epoch !== restoreEpoch) return;
				runtime = createTodoExtensionRuntime(state);
			} catch {
				// Never replace an unreadable checkpoint with empty or older tasks.
				if (epoch !== restoreEpoch) return;
			}
		};
		pi.on("session_start", restore);
		pi.on("session_tree", restore);
		pi.on("session_shutdown", () => {
			++restoreEpoch;
			runtime = undefined;
		});
	};
	return { name: "aiden-todo", factory: wrapped, snapshot: () => current().snapshot() };
}
