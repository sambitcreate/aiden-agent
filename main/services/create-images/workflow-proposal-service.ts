import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ResolvedModelRuntime } from "../model-runtime.js";
import type { UsageRequestRecord } from "../usage-store-core.js";
import {
  assistantUsageRecord,
  isLocalModelProvider,
  unreportedUsageRecord,
} from "../usage-accounting.js";
import type { WorkflowDocumentV1 } from "../../../renderer/shared/create-images/schema.js";
import {
  normalizeCreateImagesWorkflowProposalRequest,
  parseCreateImagesWorkflowProposal,
  type CreateImagesWorkflowProposal,
} from "../../../renderer/shared/create-images/workflow-proposal.js";

const PROPOSAL_TIMEOUT_MS = 90_000;
const SYSTEM_PROMPT = `You propose inert Aiden Create Images workflow graphs.
Return exactly one JSON object and no markdown or commentary.
The exact top-level shape is {"version":1,"nodes":[],"edges":[]}.
Use at most 50 nodes and 200 edges. Every node must be a complete current Aiden workflow node with id, type, position, and data. Every edge must include id, source, sourcePort, target, and targetPort.
Allowed node types: image-input, prompt, prompt-list, generate-image, output, output-gallery, image-compare, annotation, group.
Image Input data must be {} so the user chooses local files after applying. Never invent an asset ID.
Generate Image must use providerId "gemini" and one of these model IDs: gemini-3.1-flash-lite-image, gemini-3.1-flash-image, gemini-3-pro-image. Use count 1. Use a supported aspect ratio, image size, and image/png or image/jpeg.
Create a connected acyclic graph with all required inputs connected. Prompt text must be useful and non-empty. A Prompt List may contain at most eight non-empty items.
Do not include credentials, secrets, paths, asset IDs, provider responses, executable code, tool calls, or instructions to run anything. The graph is only a proposal and must never execute itself.`;

export type CreateImagesWorkflowProposalServiceResult =
  | {
      status: "ready";
      proposal: CreateImagesWorkflowProposal;
      providerId: string;
      model: string;
    }
  | { status: "unavailable"; message: string };

export interface CreateImagesWorkflowProposalServiceDependencies {
  resolveRuntime?: (
    providerId: string,
    modelId: string,
    signal?: AbortSignal,
  ) => Promise<ResolvedModelRuntime>;
  recordUsage?: (record: UsageRequestRecord) => Promise<void>;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export class CreateImagesWorkflowProposalService {
  private readonly resolveRuntime: NonNullable<
    CreateImagesWorkflowProposalServiceDependencies["resolveRuntime"]
  >;
  private readonly recordUsage: NonNullable<
    CreateImagesWorkflowProposalServiceDependencies["recordUsage"]
  >;

  constructor(dependencies: CreateImagesWorkflowProposalServiceDependencies = {}) {
    this.resolveRuntime =
      dependencies.resolveRuntime ??
      (async (providerId, modelId, signal) =>
        (await import("../model-runtime.js")).resolveModelRuntime(providerId, modelId, signal));
    this.recordUsage =
      dependencies.recordUsage ??
      (async (record) => (await import("../usage-store.js")).usageStore.record(record));
  }

  async propose(input: {
    request: string;
    current: WorkflowDocumentV1;
    providerId: string;
    model: string;
    signal: AbortSignal;
  }): Promise<CreateImagesWorkflowProposalServiceResult> {
    const request = normalizeCreateImagesWorkflowProposalRequest(input.request);
    if (!request) return { status: "unavailable", message: "Describe the workflow in 4,000 characters or fewer." };
    let runtime: ResolvedModelRuntime;
    try {
      runtime = await this.resolveRuntime(input.providerId, input.model, input.signal);
    } catch {
      return {
        status: "unavailable",
        message: "The currently selected chat model is unavailable. Choose a connected chat model and try again.",
      };
    }
    let result: AssistantMessage;
    try {
      result = await runtime.streams
        .streamSimple(
          runtime.model,
          {
            systemPrompt: SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: request }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: runtime.apiKey,
            headers: runtime.headers,
            signal: input.signal,
            temperature: 0.1,
            maxTokens: 8_000,
            timeoutMs: PROPOSAL_TIMEOUT_MS,
            maxRetries: 0,
            cacheRetention: "none",
          },
        )
        .result();
      await this.recordUsage(
        assistantUsageRecord({
          message: result,
          provider: runtime.provider,
          model: runtime.model,
          source: "workflow-proposal",
        }),
      ).catch(() => {
        console.warn("[create-images] Workflow proposal usage could not be recorded.", {
          providerId: runtime.provider.id,
          modelId: runtime.model.id,
        });
      });
    } catch {
      await this.recordUsage(
        unreportedUsageRecord({
          source: "workflow-proposal",
          providerId: runtime.provider.id,
          providerLabel: runtime.provider.label,
          modelId: runtime.model.id,
          modelLabel: runtime.model.name,
          local: isLocalModelProvider(runtime.provider),
          status: input.signal.aborted ? "cancelled" : "failed",
        }),
      ).catch(() => undefined);
      return {
        status: "unavailable",
        message: input.signal.aborted
          ? "Workflow proposal generation was cancelled."
          : "The selected chat model could not prepare a workflow proposal.",
      };
    }
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      return {
        status: "unavailable",
        message: "The selected chat model did not complete the proposal.",
      };
    }
    const parsed = parseCreateImagesWorkflowProposal(assistantText(result), input.current);
    if (parsed.status !== "ready") {
      console.warn("[create-images] Workflow proposal rejected safely.", {
        providerId: runtime.provider.id,
        modelId: runtime.model.id,
        reason: parsed.message,
      });
      return {
        status: "unavailable",
        message: "The selected model returned an invalid or unsupported graph. The workflow was not changed.",
      };
    }
    return {
      status: "ready",
      proposal: parsed.proposal,
      providerId: runtime.provider.id,
      model: runtime.model.id,
    };
  }
}
