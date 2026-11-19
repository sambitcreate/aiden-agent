// Prompt-prefix harness: drives the desktop chat runtime layer for several
// turns against a scripted provider, renders every request through the real
// Pi provider adapter offline, and returns section hashes so a test can name
// the first place one request stopped extending the one before it.
//
// The layer is the one llm-client builds a generation from: the system
// prompt and tools from `assembleChatPrompt` (or given directly), the
// `createInitialSystemMessage` head over the history a durable Pi session
// journal rebuilds, the AGENTS.md and `mcp_servers` refreshers and on-demand
// tool loading (applied to the initial context and again between tool turns
// through `createPiTurnContextPreparation`), the
// `createGenerationContextTransform` projection, and
// `PiAgentRuntimeHarness.runManaged` journaling into that session. llm-client
// itself needs Electron and config stores, so it is not driven here; each
// turn reads its history back from the in-memory journal the previous runs
// wrote, so the harness keeps exactly what llm-client would keep.
//
// Nothing here dispatches a request: the adapter's `onPayload` captures the
// payload and aborts before `fetch`, and `fetch` itself refuses.

import { createHash } from "node:crypto";
import type { AgentContext, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, createModels, toToolDeclaration, type Api, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createFauxCore, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createAgentsInstructionRefresher, type AgentsInstructionOptions } from "./agents-instructions.js";
import type { ChatPromptAssembly } from "./chat-prompt-assembly.js";
import { createGenerationContextTransform, updateGenerationContextOptions, type GenerationContextOptions } from "./generation-context.js";
import { createMcpServersSectionRefresher } from "./mcp-server-instructions.js";
import { diffPromptPrefix, fingerprintPromptPrefix, type PromptPrefixDifference, type PromptPrefixFingerprint } from "./pi-cache-telemetry.js";
import { PiAgentRuntimeHarness } from "./pi-agent-runtime-harness.js";
import { convertToLlm } from "./pi-legacy-harness.js";
import { createPiSessionPort, type PiSessionPort } from "./pi-session-port.js";
import { InMemorySessionRepo } from "./pi-session-repository-port.js";
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

export type PromptPrefixTurnInput = {
  prompt: string;
  /** Scripted assistant steps for this turn, in order. */
  responses: FauxResponseStep[];
} & (
  | {
      /** The generation head as llm-client assembles it; tools follow the journaled history. */
      assembly: ChatPromptAssembly;
    }
  | { systemPrompt: string; tools: AgentTool[] }
);

export interface RecordedPromptRequest {
  /** 1-based user turn. */
  turn: number;
  /** 1-based model request within the turn. */
  step: number;
  /** The normalized transcript's fingerprint, as the miss telemetry takes it. */
  fingerprint: PromptPrefixFingerprint;
  /** The rendered provider payload, cut into cache-ordered segments. */
  wire: PromptWireSegment[];
  /** Whether `text` reaches this request anywhere: system, tools, messages or tool results. */
  carries(text: string): boolean;
  /**
   * The request's message objects themselves, not copies, so a test can
   * check later that none of them was edited in place.
   */
  messages: PromptProviderContext["messages"];
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

/**
 * Anthropic Messages takes a string `content` as shorthand for one text block,
 * and the adapter spells the newest user message as a block so it can carry
 * the breakpoint. Both spellings are the same prompt, so they hash the same.
 */
function withTextBlockContent(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  return typeof item.content === "string" && (item.role === "user" || item.role === "assistant")
    ? { ...item, content: [{ type: "text", text: item.content }] }
    : value;
}

function segment(kind: PromptWireSegmentKind, value: unknown): PromptWireSegment {
  return { kind, hash: hash(withoutCacheMarkers(withTextBlockContent(value))) };
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

/** The context a provider adapter renders. */
export type PromptProviderContext = Parameters<ProviderStreams["streamSimple"]>[1];

export interface PromptRequestRecorder {
  /** Render `context` through the wire's real adapter, offline, and cut it into segments. */
  record(context: PromptProviderContext, at: { turn: number; step: number }): Promise<RecordedPromptRequest>;
  /** Requests that reached `fetch`; always 0 unless the capture broke. */
  readonly networkCalls: number;
}

/**
 * Renders any runtime's provider context the way the chosen wire would send
 * it. The workspace harness below and the Bot runtime's Pi Durable cases both
 * record through it.
 */
export function createPromptRequestRecorder(
  options: Pick<PromptPrefixHarnessOptions, "wire" | "midConversationSystem"> & { model: Model<Api> },
): PromptRequestRecorder {
  const wireApi = options.wire ?? "anthropic-messages";
  const midConversationSystem = options.midConversationSystem ?? false;
  const streams: ProviderStreams = wireApi === "openai-responses" ? openAIResponsesApi() : anthropicMessagesApi();
  const renderModel = {
    ...options.model,
    api: wireApi,
    baseUrl: wireApi === "openai-responses" ? "https://offline.invalid/v1" : "https://offline.invalid",
    compat: wireApi === "openai-responses"
      ? { supportsMidConvoSystemMessages: midConversationSystem, supportsAdditionalTools: midConversationSystem }
      : { supportsMidConvoSystemMessages: midConversationSystem, supportsMidConvoToolChanges: midConversationSystem },
  } as Model<Api>;
  let networkCalls = 0;

  async function render(context: PromptProviderContext): Promise<Record<string, unknown>> {
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

  return {
    async record(context, at) {
      const payload = await render(context);
      const rendered = JSON.stringify(payload);
      return {
        ...at,
        fingerprint: fingerprintPromptPrefix({ messages: context.messages, model: options.model, cacheRetention: "short" }),
        wire: promptWireSegments(payload),
        carries: (text) => rendered.includes(JSON.stringify(text).slice(1, -1)),
        messages: context.messages,
      };
    },
    get networkCalls() { return networkCalls; },
  };
}

export function createPromptPrefixHarness(options: PromptPrefixHarnessOptions = {}): PromptPrefixHarness {
  const midConversationSystem = options.midConversationSystem ?? false;
  const core = createFauxCore({ provider: "prompt-prefix-harness" });
  const model = core.getModel();
  const recorder = createPromptRequestRecorder({ ...options, model });
  let journal: Promise<PiSessionPort> | undefined;
  const requests: RecordedPromptRequest[] = [];
  let turnNumber = 0;

  async function turn(input: PromptPrefixTurnInput): Promise<RecordedPromptRequest[]> {
    turnNumber += 1;
    const thisTurn = turnNumber;
    let step = 0;
    const recorded: RecordedPromptRequest[] = [];
    core.setResponses(input.responses);
    journal ??= new InMemorySessionRepo().create({ id: "prompt-prefix-harness" }).then((native) => createPiSessionPort(native));
    const session = await journal;
    // llm-client reads the chat so far back from its Pi journal each turn.
    const history = (await session.buildContext()).messages;
    const systemPrompt = "assembly" in input ? input.assembly.systemPrompt : input.systemPrompt;
    const tools = "assembly" in input ? input.assembly.toolsFor(history) : input.tools;
    const onDemandTools = "assembly" in input ? input.assembly.onDemandTools : undefined;
    const agentsInstructions = options.agentsInstructions
      ? await createAgentsInstructionRefresher({ ...options.agentsInstructions, revalidate: async () => {} })
      : undefined;
    const mcpServersSection = options.mcpServersSection ? createMcpServersSectionRefresher(options.mcpServersSection) : undefined;
    const generationOptions: GenerationContextOptions = {
      contextWindow: model.contextWindow,
      systemPrompt,
      tools,
      supportsImages: true,
      providerId: model.provider,
      modelId: model.id,
      retainsSystemUpdates: midConversationSystem,
    };
    let initialMessages: AgentMessage[] = [...history];
    const head = createInitialSystemMessage(systemPrompt, tools.map(toToolDeclaration));
    if (head) initialMessages = [head, ...initialMessages];
    const prepare = async <C extends { messages: AgentMessage[]; tools?: AgentTool[] }>(context: C): Promise<C> => {
      let prepared = context;
      if (agentsInstructions) prepared = (await agentsInstructions.apply(prepared as never)) as unknown as C;
      if (mcpServersSection) prepared = mcpServersSection.apply(prepared);
      return prepared;
    };
    {
      const prepared = await prepare({ messages: initialMessages, tools: [...tools] });
      if (prepared.messages !== initialMessages) {
        initialMessages = prepared.messages;
        updateGenerationContextOptions(generationOptions, prepared);
      }
    }
    const runtime = new PiAgentRuntimeHarness({
      convertToLlm,
      initialState: { systemPrompt, thinkingLevel: "off", tools: [...tools], messages: initialMessages, model },
      transformContext: createGenerationContextTransform(generationOptions),
      prepareNextTurnWithContext: createPiTurnContextPreparation({
        generationOptions,
        attended: false,
        // The order llm-client prepares a step in: instruction sections, then tools a step loaded.
        prepareContext: async (context) => {
          const prepared = await prepare(context);
          return onDemandTools ? (await onDemandTools.prepare(prepared as AgentContext)) as typeof prepared : prepared;
        },
        onRecovery: () => {},
      }),
      durability: {
        session,
        compaction: { models: createModels(), model, thinkingLevel: "off" },
      },
      streamFn: async (requestModel, context, streamOptions) => {
        step += 1;
        const request = await recorder.record(context, { turn: thisTurn, step });
        recorded.push(request);
        requests.push(request);
        return core.streamSimple(requestModel, context, streamOptions);
      },
    });
    const outcome = await runtime.runManaged({
      kind: "append-and-run",
      message: { role: "user", content: input.prompt, timestamp: Date.now() },
    });
    if (outcome.kind !== "completed") throw new Error(`Prompt prefix harness turn ${thisTurn} ended ${outcome.kind}.`);
    return recorded;
  }

  return {
    turn,
    get requests() { return requests; },
    get networkCalls() { return recorder.networkCalls; },
  };
}
