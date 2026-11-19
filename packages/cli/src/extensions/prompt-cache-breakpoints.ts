/**
 * The desktop's cache breakpoints for `aiden serve`, through Pi's
 * `before_provider_request` hook: on Anthropic Messages, the system prompt
 * before this turn's always-on memory gets its own cached block (the fourth
 * breakpoint), so a memory change leaves the tools and the rest of the system
 * prompt cached; on Bedrock Converse with a Claude model, a cachePoint after
 * the tools. The rewrite is the desktop's own (main/services/
 * prompt-cache-breakpoints.ts) and changes nothing it cannot verify: no cache
 * marker on the request, four markers already, or a system text that does not
 * start with the head.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withPromptCacheBreakpointsPayload } from "../../../../main/services/prompt-cache-breakpoints.js";

export function createPromptCacheBreakpointsInlineExtension(stableHead: () => string | undefined): {
	name: string;
	factory: ExtensionFactory;
} {
	return {
		name: "aiden-prompt-cache-breakpoints",
		factory: (pi) => {
			pi.on("before_provider_request", (event, ctx) => {
				const model = ctx.model;
				if (!model) return undefined;
				return withPromptCacheBreakpointsPayload(event.payload, model.api, stableHead(), model);
			});
		},
	};
}
