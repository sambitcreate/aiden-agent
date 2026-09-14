/**
 * Bridge between Aiden desktop extension cores and pi's ExtensionAPI.
 *
 * Aiden's PiAgentRuntimeExtension shape ({ id, systemPrompt, tools, ... }) is
 * structurally pi-native: tools are pi-agent-core AgentTools whose execute
 * signature (toolCallId, params, signal) is a prefix of pi's extension tool
 * execute (toolCallId, params, signal, onUpdate, ctx), and system prompt
 * contributions map onto pi's chainable before_agent_start replacement.
 *
 * Type-only imports keep the desktop module graph out of the CLI bundle; only
 * the pure cores imported by each feature extension are bundled.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Minimal structural mirror of Aiden's PiAgentRuntimeExtension
 * (main/services/pi-agent-runtime-harness.ts) — the members the CLI consumes.
 */
export interface AidenExtensionShape {
	/** Stable identity used for diagnostics. */
	id: string;
	/** Static prompt contribution appended after the engine's system prompt. */
	systemPrompt?: string;
	/** Pi-native tools contributed to this session. */
	tools?: readonly unknown[];
}

/**
 * Converts an Aiden desktop extension into a pi inline extension factory.
 * Tools are registered as-is (the execute signatures are structurally
 * compatible); system prompt contributions chain onto before_agent_start.
 */
export function aidenExtensionToInlineFactory(
	name: string,
	extension: AidenExtensionShape,
): { name: string; factory: ExtensionFactory } {
	return {
		name,
		factory: (pi) => {
			for (const tool of extension.tools ?? []) {
				pi.registerTool(tool as Parameters<typeof pi.registerTool>[0]);
			}
			const promptBlock = extension.systemPrompt?.trim();
			if (promptBlock) {
				pi.on("before_agent_start", (event) => {
					// Aiden prompt blocks are cache-stable contributions; append at
					// the end so the engine prompt (and its provider cache prefix)
					// stays intact.
					return { systemPrompt: `${event.systemPrompt}\n\n${promptBlock}` };
				});
			}
		},
	};
}

/** Latest ExtensionContext captured from session lifecycle events. */
export interface CapturedContext {
	hasUI: boolean;
	mode: "tui" | "rpc" | "json" | "print";
	ui: unknown;
}

/**
 * Creates a stasher that tracks the most recent ExtensionContext. Extension
 * event handlers receive ctx, but tool executes in Aiden cores do not, so
 * feature extensions use this to reach ctx.ui from inside tool callbacks.
 */
export function createContextCapture(): {
	register(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI): void;
	latest(): CapturedContext | undefined;
} {
	let current: CapturedContext | undefined;
	return {
		register(pi) {
			const capture = (_event: unknown, ctx: CapturedContext): void => {
				current = ctx;
			};
			pi.on("session_start", capture);
			pi.on("before_agent_start", capture);
		},
		latest: () => current,
	};
}
