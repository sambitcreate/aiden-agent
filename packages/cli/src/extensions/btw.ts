/**
 * btw ("by the way") in the terminal: bounded, read-only side questions about
 * the current conversation, reusing Aiden's pure context builder
 * (main/services/rpiv-btw/context.ts — same retention bounds and sanitization
 * as the desktop) streamed through the shared pi model-runtime adapter.
 * Follow-up history is ephemeral for this CLI session, like the desktop's
 * ephemeral follow-ups.
 */

import { normalizeContext } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { recordUsage } from "../usage-ledger.ts";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	BTW_SYSTEM_PROMPT,
	boundedContextMessages,
	buildBtwContext,
	type BtwHistoryTurn,
} from "../../../../main/services/rpiv-btw/context.js";
import {
	asModelRuntimeContext,
	liveMessages,
	resolveRuntimeFromContext,
} from "../pi-bridge/model-runtime.ts";

const BTW_TIMEOUT_MS = 60_000;
const MAX_HISTORY_TURNS = 4;

function textOf(message: { content: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

export function createBtwInlineExtension(_context: {
	latestContext(): import("../pi-bridge/adapt-aiden-extension.ts").CapturedContext | undefined;
}): { name: string; factory: ExtensionFactory } {
	// Session-scoped (the factory runs once per CLI process): ephemeral
	// follow-up history, exactly like the desktop's ephemeral btw follow-ups.
	const history: BtwHistoryTurn[] = [];

	return {
		name: "aiden-btw",
		factory: (pi) => {
			pi.on("session_start", async () => { history.length = 0; });
			pi.registerCommand("btw", {
				description: "Ask a bounded read-only side question about this conversation",
				handler: async (args, ctx) => {
					const question = args.trim();
					if (question.length === 0) {
						ctx.ui.notify("Usage: /btw <question> — asks a side question without touching the main thread.", "warning");
						return;
					}
					const model = ctx.model;
					if (!model) {
						ctx.ui.notify("btw needs a model. Select one first.", "warning");
						return;
					}
					const runtimeContext = asModelRuntimeContext(ctx);
					// Session journal messages are pi-ai Messages in practice;
					// CustomMessages (not valid btw prose) are filtered by the
					// context builder's sanitizer.
					const branch = boundedContextMessages(
						liveMessages(runtimeContext) as unknown as Parameters<typeof boundedContextMessages>[0],
					);
					if (branch.length === 0) {
						ctx.ui.notify("Nothing to ask about yet — the conversation is empty.", "warning");
						return;
					}
					const { messages } = buildBtwContext({
						branch,
						history: history.slice(-MAX_HISTORY_TURNS),
						question,
						model,
					});
					ctx.ui.setStatus("aiden-btw", "asking…");
					try {
						const runtime = await resolveRuntimeFromContext(runtimeContext, model.provider, model.id);
						const response = await runtime.streams.streamSimple(
							runtime.model,
							normalizeContext({ systemPrompt: BTW_SYSTEM_PROMPT, messages, tools: [] }),
							{
								signal: undefined,
								apiKey: runtime.apiKey,
								cacheRetention: "none",
								timeoutMs: BTW_TIMEOUT_MS,
								maxRetries: 0,
								maxRetryDelayMs: 0,
								...(runtime.headers ? { headers: runtime.headers } : {}),
							},
						).result();
						await recordUsage(getAgentDir(), "btw", response);
						const answer = textOf(response).trim();
						if (response.stopReason === "aborted") {
							ctx.ui.notify("btw was cancelled.", "warning");
							return;
						}
						if (!answer) {
							ctx.ui.notify("btw could not get an answer for that.", "error");
							return;
						}
						history.push({ question, answer, timestamp: Date.now() });
						ctx.ui.notify(`btw — ${answer}`, "info");
					} catch (error) {
						ctx.ui.notify(`btw failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					} finally {
						ctx.ui.setStatus("aiden-btw", undefined);
					}
				},
			});
		},
	};
}
