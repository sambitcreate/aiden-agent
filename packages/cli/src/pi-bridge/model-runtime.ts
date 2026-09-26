/**
 * Shared bridge between Aiden's ResolvedModelRuntime consumers (advisor, btw)
 * and pi's extension context: model + credential resolution through the
 * extension ModelRegistry, and read-only live-message projection from the
 * session journal.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import type { ResolvedModelRuntime } from "../../../../main/services/model-runtime-core.js";
import type { StoredProvider } from "../../../../main/services/types.js";
import type { CapturedContext } from "./adapt-aiden-extension.ts";

export interface ModelRuntimeContext extends CapturedContext {
	scopedModels?: ReadonlyArray<{ model: Model<Api> }>;
	model?: Model<Api>;
	modelRegistry?: {
		getProvider?(providerId: string): Provider | undefined;
		find(providerId: string, modelId: string): Promise<Model<Api> | undefined> | Model<Api> | undefined;
		getApiKeyAndHeaders(model: Model<Api>): Promise<{
			ok: boolean;
			apiKey?: string;
			baseUrl?: string;
			headers?: import("@earendil-works/pi-ai").ProviderHeaders;
		}>;
	};
	sessionManager?: { getBranch?(): Array<Record<string, unknown>> };
}

export function asModelRuntimeContext(ctx: CapturedContext): ModelRuntimeContext {
	return ctx as unknown as ModelRuntimeContext;
}

/**
 * Minimal StoredProvider for a built-in pi provider; Aiden cores only read
 * identity, baseUrl, needsKey, and optional model metadata from it.
 */
function storedProvider(providerId: string, modelId: string, baseUrl: string): StoredProvider {
	return {
		id: providerId,
		kind: providerId,
		label: providerId,
		baseUrl,
		models: [modelId],
		needsKey: false,
	} as unknown as StoredProvider;
}

export async function resolveRuntimeFromContext(
	ctx: Pick<ModelRuntimeContext, "modelRegistry">,
	providerId: string,
	modelId: string,
): Promise<ResolvedModelRuntime> {
	const registry = ctx.modelRegistry;
	if (!registry) throw new Error("The model registry is unavailable.");
	const model = await registry.find(providerId, modelId);
	if (!model) throw new Error(`The model ${providerId}/${modelId} is not available.`);
	const auth = await registry.getApiKeyAndHeaders(model);
	if (auth.ok === false) throw new Error(`No credentials for ${providerId}.`);
	const models = createModels();
	const provider = registry.getProvider?.(providerId);
	if (provider) models.setProvider(provider);
	return {
		provider: storedProvider(providerId, modelId, model.baseUrl),
		model: auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
		models,
		apiKey: auth.apiKey,
		headers: (auth.headers ?? undefined) as ResolvedModelRuntime["headers"],
		streams: { streamSimple: models.streamSimple.bind(models) },
	};
}

export function liveMessages(ctx: ModelRuntimeContext): AgentMessage[] {
	const entries = ctx.sessionManager?.getBranch?.() ?? [];
	return entries
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message as AgentMessage)
		.filter(Boolean);
}
