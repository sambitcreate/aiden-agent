// Prompt-prefix harness: drives the desktop chat runtime layer for several
// turns against a scripted provider, renders every request through the real
// Pi provider adapter offline, and returns section hashes so a test can name
// the first place one request stopped extending the one before it.
//
// The layer is the one llm-client builds a generation from: the
// `createInitialSystemMessage` head over a journaled history, the AGENTS.md
// and `mcp_servers` refreshers (applied to the initial context and again
// between tool turns through `createPiTurnContextPreparation`), the
// `createGenerationContextTransform` projection, and `PiAgentRuntimeHarness`.
// llm-client itself needs Electron, config stores and a durable journal, so it
// is not driven here; the journal is modelled as the non-system messages each
// run appended, which is what llm-client journals on `message_end`.
//
// Nothing here dispatches a request: the adapter's `onPayload` captures the
// payload and aborts before `fetch`, and `fetch` itself refuses.

import { createHash } from "node:crypto";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration, type Api, type Message, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createFauxCore, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createAgentsInstructionRefresher, type AgentsInstructionOptions } from "./agents-instructions.js";
import { createGenerationContextTransform, updateGenerationContextOptions, type GenerationContextOptions } from "./generation-context.js";
import { createMcpServersSectionRefresher } from "./mcp-server-instructions.js";
import { diffPromptPrefix, fingerprintPromptPrefix, type PromptPrefixDifference, type PromptPrefixFingerprint } from "./pi-cache-telemetry.js";
import { PiAgentRuntimeHarness } from "./pi-agent-runtime-harness.js";
import { convertToLlm } from "./pi-legacy-harness.js";
import { createPiTurnContextPreparation } from "./pi-turn-context.js";

export type PromptPrefixWire = "anthropic-messages" | "openai-responses";
export type PromptWireSegmentKind = "tools" | "system" | "messages";

export interface PromptWireSegment {
  kind: PromptWireSegmentKind;
  hash: string;
}

export interface PromptPrefixHarnessOptions {
  /** Provider adapter that renders the payload. Defaults to Anthropic Messages. */
  wire?: PromptPrefixWire;
  /** The model keeps later system messages in place (Pi `supportsMidConvoSystemMessages`). */
  midConversationSystem?: boolean;
  /** Roots for the real AGENTS.md refresher, created afresh each turn like llm-client does. */
  agentsInstructions?: Pick<AgentsInstructionOptions, "globalRoot" | "workspaceRoot" | "read">;
  /** Renders the `mcp_servers` section; a fresh refresher is created each turn. */
  mcpServersSection?: () => string;
}

export interface PromptPrefixTurnInput {
  prompt: string;
  systemPrompt: string;
  tools: AgentTool[];
  /** Scripted assistant steps for this turn, in order. */
  responses: FauxResponseStep[];
}

export interface RecordedPromptRequest {
  /** 1-based user turn. */
  turn: number;
  /** 1-based model request within the turn. */
  step: number;
  /** The normalized transcript's fingerprint, as the miss telemetry takes it. */
  fingerprint: PromptPrefixFingerprint;
  /** The rendered provider payload, cut into cache-ordered segments. */
  wire: PromptWireSegment[];
}

export interface PromptRequestComparison {
  /** First rendered segment that changed, or none when `current` extends `previous`. */
  wire?: { index: number; kind: PromptWireSegmentKind };
  /** The telemetry's attribution of the same change. */
  transcript?: PromptPrefixDifference;
}

export interface PromptPrefixHarness {
  turn(input: PromptPrefixTurnInput): Promise<RecordedPromptRequest[]>;
  readonly requests: readonly RecordedPromptRequest[];
  /** Requests that reached `fetch`; always 0 unless the capture broke. */
  readonly networkCalls: number;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 16);
}

/** Breakpoint markers move to the newest message each request; they are not prompt bytes. */
function withoutCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, entry]) => [key, withoutCacheMarkers(entry)]),
  );
}

function segment(kind: PromptWireSegmentKind, value: unknown): PromptWireSegment {
  return { kind, hash: hash(withoutCacheMarkers(value)) };
}

/** Cut a rendered payload into the segments a provider caches in order: tools, system, messages. */
export function promptWireSegments(payload: Record<string, unknown>): PromptWireSegment[] {
  const segments: PromptWireSegment[] = [];
  if (Array.isArray(payload.tools) && payload.tools.length) segments.push(segment("tools", payload.tools));
  if (typeof payload.instructions === "string") segments.push(segment("system", payload.instructions));
  if (Array.isArray(payload.system)) for (const block of payload.system) segments.push(segment("system", block));
  else if (typeof payload.system === "string") segments.push(segment("system", payload.system));
  const items = Array.isArray(payload.messages) ? payload.messages : Array.isArray(payload.input) ? payload.input : [];
  for (const item of items as Record<string, unknown>[]) {
    if (item?.type === "additional_tools") segments.push(segment("tools", item));
    else if (item?.role === "system" || item?.role === "developer") segments.push(segment("system", item));
    else segments.push(segment("messages", item));
  }
  return segments;
}

/** Where `current` stopped extending `previous`, on the wire and in the telemetry's words. */
export function comparePromptRequests(previous: RecordedPromptRequest, current: RecordedPromptRequest): PromptRequestComparison {
  let wire: PromptRequestComparison["wire"];
  for (let index = 0; index < previous.wire.length; index += 1) {
    const after = current.wire[index];
    if (!after) break;
    if (after.hash !== previous.wire[index]!.hash || after.kind !== previous.wire[index]!.kind) {
      wire = { index, kind: after.kind };
      break;
    }
  }
  const transcript = diffPromptPrefix(previous.fingerprint, current.fingerprint);
  return { ...(wire ? { wire } : {}), ...(transcript ? { transcript } : {}) };
}

export function createPromptPrefixHarness(options: PromptPrefixHarnessOptions = {}): PromptPrefixHarness {
  const wireApi = options.wire ?? "anthropic-messages";
  const midConversationSystem = options.midConversationSystem ?? false;
  const core = createFauxCore({ provider: "prompt-prefix-harness" });
  const model = core.getModel();
  const streams: ProviderStreams = wireApi === "openai-responses" ? openAIResponsesApi() : anthropicMessagesApi();
  const renderModel = {
    ...model,
    api: wireApi,
    baseUrl: wireApi === "openai-responses" ? "https://offline.invalid/v1" : "https://offline.invalid",
    compat: wireApi === "openai-responses"
      ? { supportsMidConvoSystemMessages: midConversationSystem, supportsAdditionalTools: midConversationSystem }
      : { supportsMidConvoSystemMessages: midConversationSystem, supportsMidConvoToolChanges: midConversationSystem },
  } as Model<Api>;
  const journal: AgentMessage[] = [];
  const requests: RecordedPromptRequest[] = [];
  let networkCalls = 0;
  let turnNumber = 0;

  async function render(context: Parameters<ProviderStreams["streamSimple"]>[1]): Promise<Record<string, unknown>> {
    let payload: Record<string, unknown> | undefined;
    await streams.streamSimple(renderModel, context, {
      apiKey: "offline-noncredential",
      cacheRetention: "short",
      maxRetries: 0,
      env: {},
      onPayload: (value: unknown) => {
        payload = structuredClone(value) as Record<string, unknown>;
        throw new Error("Prompt prefix harness captured the payload before dispatch.");
      },
      fetch: async () => {
        networkCalls += 1;
        throw new Error("Prompt prefix harness never dispatches a request.");
      },
    } as Parameters<ProviderStreams["streamSimple"]>[2]).result();
    if (!payload) throw new Error(`The ${wireApi} adapter did not render a payload.`);
    return payload;
  }

  async function turn(input: PromptPrefixTurnInput): Promise<RecordedPromptRequest[]> {
    turnNumber += 1;
    const thisTurn = turnNumber;
    let step = 0;
    const recorded: RecordedPromptRequest[] = [];
    core.setResponses(input.responses);
    const agentsInstructions = options.agentsInstructions
      ? await createAgentsInstructionRefresher({ ...options.agentsInstructions, revalidate: async () => {} })
      : undefined;
    const mcpServersSection = options.mcpServersSection ? createMcpServersSectionRefresher(options.mcpServersSection) : undefined;
    const generationOptions: GenerationContextOptions = {
      contextWindow: model.contextWindow,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      supportsImages: true,
      providerId: model.provider,
      modelId: model.id,
      retainsSystemUpdates: midConversationSystem,
    };
    let initialMessages: AgentMessage[] = [...journal];
    const head = createInitialSystemMessage(input.systemPrompt, input.tools.map(toToolDeclaration));
    if (head) initialMessages = [head, ...initialMessages];
    const prepare = async <C extends { messages: AgentMessage[]; tools?: AgentTool[] }>(context: C): Promise<C> => {
      let prepared = context;
      if (agentsInstructions) prepared = (await agentsInstructions.apply(prepared as never)) as unknown as C;
      if (mcpServersSection) prepared = mcpServersSection.apply(prepared);
      return prepared;
    };
    {
      const prepared = await prepare({ messages: initialMessages, tools: [...input.tools] });
      if (prepared.messages !== initialMessages) {
        initialMessages = prepared.messages;
        updateGenerationContextOptions(generationOptions, prepared);
      }
    }
    const runtime = new PiAgentRuntimeHarness({
      convertToLlm,
      initialState: { systemPrompt: input.systemPrompt, thinkingLevel: "off", tools: [...input.tools], messages: initialMessages, model },
      transformContext: createGenerationContextTransform(generationOptions),
      prepareNextTurnWithContext: createPiTurnContextPreparation({
        generationOptions,
        attended: false,
        prepareContext: (context) => prepare(context),
        onRecovery: () => {},
      }),
      streamFn: async (requestModel, context, streamOptions) => {
        step += 1;
        const messages = context.messages as Message[];
        const request: RecordedPromptRequest = {
          turn: thisTurn,
          step,
          fingerprint: fingerprintPromptPrefix({ messages, model: requestModel, cacheRetention: "short" }),
          wire: promptWireSegments(await render(context)),
        };
        recorded.push(request);
        requests.push(request);
        return core.streamSimple(requestModel, context, streamOptions);
      },
    });
    await runtime.prompt(input.prompt);
    const error = runtime.state.errorMessage;
    if (error) throw new Error(`Prompt prefix harness turn ${thisTurn} failed: ${error}`);
    journal.push(...runtime.state.messages.slice(initialMessages.length).filter((message) => message.role !== "system"));
    return recorded;
  }

  return {
    turn,
    get requests() { return requests; },
    get networkCalls() { return networkCalls; },
  };
}
