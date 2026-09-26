/**
 * Advisor in the terminal: reuses Aiden's AdvisorRuntime core (vendored at
 * src/vendor/advisor — byte-identical to main/services/advisor-runtime.ts
 * modulo import specifiers, see the vendored file's header) — the same
 * one-consultation-per-response, tool-free second opinion as the desktop —
 * with the model runtime resolved through pi's extension ModelRegistry
 * instead of the Electron provider stores. The desktop builds one runtime per
 * response; the CLI registers one delegating tool and refreshes the
 * underlying consultation at every turn boundary (before_agent_start),
 * preserving the once-per-response semantics.
 */

import { recordUsage } from "../usage-ledger.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import { AdvisorAttemptStore } from "../vendor/advisor/advisor-attempt-store.ts";
import type {
	AdvisorCandidate,
	AdvisorExtensionInput,
	AdvisorGenerationScope,
} from "../vendor/advisor/advisor-runtime.ts";
import { GENERATION_THINKING_LEVELS } from "../../../../renderer/shared/generation-thinking.js";
import {
	asModelRuntimeContext,
	liveMessages as projectLiveMessages,
	resolveRuntimeFromContext,
	type ModelRuntimeContext,
} from "../pi-bridge/model-runtime.ts";
import type { CapturedContext } from "../pi-bridge/adapt-aiden-extension.ts";
import { requestQuestionnaire, type SelectUi } from "./ask-user-question.ts";

const DEFAULT_EFFORTS = GENERATION_THINKING_LEVELS.filter((level) => level !== "off");

function candidatesFromContext(ctx: ModelRuntimeContext): AdvisorCandidate[] {
	const scoped = (ctx.scopedModels ?? []).map((scopedModel) => scopedModel.model);
	const models = [...(scoped.length > 0 ? scoped : ctx.model ? [ctx.model] : [])];
	const unique = new Map<string, Model<Api>>();
	for (const model of models) {
		if (model) unique.set(`${model.provider}/${model.id}`, model);
	}
	return [...unique.values()].map((model) => ({
		providerId: model.provider,
		providerLabel: model.provider,
		modelId: model.id,
		modelLabel: model.name || model.id,
		efforts: DEFAULT_EFFORTS,
	}));
}

/** Structural surface the CLI needs from the prebundled AdvisorRuntime. */
interface VendorAdvisorRuntime {
	extensionForGeneration(input: AdvisorExtensionInput): Promise<{
		id: string;
		systemPrompt?: string;
		tools?: ReadonlyArray<{ execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }>;
	} | null>;
}

export function createAdvisorInlineExtension(context: {
	latestContext(): CapturedContext | undefined;
	agentDir: string;
}): { name: string; factory: ExtensionFactory } {
	const attempts = new AdvisorAttemptStore({ root: () => join(context.agentDir, "advisor") });
	let runtime: VendorAdvisorRuntime | undefined;
	// The TUI captures the extension context through the pi-bridge; headless
	// daemon sessions have no capture, so each turn's before_agent_start ctx is
	// retained as the fallback resolution source.
	let turnContext: ModelRuntimeContext | undefined;
	const runtimeContext = () => context.latestContext() ?? turnContext;
	const ensureRuntime = async (): Promise<VendorAdvisorRuntime> => {
		if (runtime) return runtime;
		// The vendor bundle (dist/app/advisor-runtime.vendor.mjs) is built by
		// scripts/build.mjs ahead of the main bundle and kept external.
		const module = (await import("../../dist/app/advisor-runtime.vendor.mjs")) as {
			AdvisorRuntime: new (dependencies: Record<string, unknown>) => VendorAdvisorRuntime;
		};
		runtime = new module.AdvisorRuntime({
			attempts,
			listCandidates: async () => {
				const ctx = runtimeContext();
				return ctx ? candidatesFromContext(asModelRuntimeContext(ctx)) : [];
			},
			resolveRuntime: async (providerId: string, modelId: string) => {
				const ctx = runtimeContext();
				if (!ctx) throw new Error("The session context is unavailable.");
				return resolveRuntimeFromContext(asModelRuntimeContext(ctx), providerId, modelId);
			},
			recordUsage: async (message: AssistantMessage) => recordUsage(context.agentDir, "advisor", message),
			recordUnreportedUsage: async () => {},
		});
		return runtime;
	};

	const scope: AdvisorGenerationScope = {
		usageSource: "chat",
		bot: false,
		child: false,
		rendererOwner: true,
		excluded: false,
	};

	let currentTurn:
		| { tool: { execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }; prompt: string }
		| undefined;

	const factory: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", async (event, ctx) => {
			const advisorContext = asModelRuntimeContext(ctx);
			turnContext = advisorContext;
			const ui = advisorContext.hasUI ? (advisorContext.ui as unknown as SelectUi) : undefined;
			const input: AdvisorExtensionInput = {
				scope,
				executor: advisorContext.model
					? { providerId: advisorContext.model.provider, modelId: advisorContext.model.id }
					: { providerId: "", modelId: "" },
				executorTools: [],
				getLiveMessages: () => projectLiveMessages(advisorContext),
				requestQuestionnaire:
					ui?.select
						? (toolCallId, questions, signal) =>
								requestQuestionnaire({ select: ui.select.bind(ui) }, questions, signal)
						: undefined,
			};
			const extension = await (await ensureRuntime()).extensionForGeneration(input);
			const advisorTool = extension?.tools?.[0] as
				| { execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }
				| undefined;
			if (!extension || !advisorTool) {
				currentTurn = undefined;
				return;
			}
			currentTurn = { tool: advisorTool, prompt: extension.systemPrompt ?? "" };
			const promptBlock = currentTurn.prompt.trim();
			return promptBlock ? { systemPrompt: `${event.systemPrompt}\n\n${promptBlock}` } : undefined;
		});
		pi.registerTool({
			name: "advisor",
			label: "Advisor",
			description:
				"Request one tool-free second opinion from another model. Pass providerId and modelId only when the user explicitly named the reviewer; otherwise omit them and Aiden will ask the user to choose.",
			parameters: Type.Object({
				providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
				modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
				// Same literal union as the desktop tool: enables constrained
				// sampling on providers that support it; the runtime filters
				// unknown efforts to its default, matching desktop behavior.
				effort: Type.Optional(Type.Union(DEFAULT_EFFORTS.map((effort) => Type.Literal(effort)))),
			}),
			executionMode: "sequential" as const,
			execute: async (toolCallId, params, signal) => {
				const turn = currentTurn;
				if (!turn) {
					return {
						content: [{ type: "text" as const, text: "The advisor is unavailable for this response." }],
						details: { status: "blocked" },
					};
				}
				return turn.tool.execute(toolCallId, params, signal) as Promise<{
					content: Array<{ type: "text"; text: string }>;
					details: unknown;
				}>;
			},
		});
	};

	// Not built via the bridge: the advisor tool is per-turn dynamic, so this
	// factory manages registration itself while keeping the InlineExtension shape.
	return { name: "aiden-advisor", factory };
}
