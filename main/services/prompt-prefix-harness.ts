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
// `PiAgentRuntimeHarness.runManaged` journaling into that session, with the
// chat's frozen state planned against that journal (`planChatTurnState`) the
// way llm-client plans it. llm-client
// itself needs Electron and config stores, so it is not driven here; each
// turn reads its history back from the in-memory journal the previous runs
// wrote, so the harness keeps exactly what llm-client would keep.
//
// Nothing here dispatches a request: the adapter's `onPayload` captures the
// payload and aborts before `fetch`, and `fetch` itself refuses. The Google
// adapter takes no custom `fetch`, so while it renders the global one refuses.

import { createHash } from "node:crypto";
import type { AgentContext, AgentMessage, AgentState, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage,
  createModels,
  toToolDeclaration,
  type Api,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createFauxCore, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { AgentsInstructionOptions } from "./agents-instructions.js";
import {
  chatHeadJournaling,
  chatStateRequestMessages,
  extensionChatState,
  journaledChatState,
  planChatTurnState,
  turnNoteMessage,
  withHeadChatState,
  withApprovedMemoryFacts,
  withoutForgottenFactsSession,
  type ChatTurnState,
  type JournaledChatState,
} from "./chat-frozen-state.js";
import type { ChatPromptAssembly } from "./chat-prompt-assembly.js";
import type { PiAgentRuntimeExtension } from "./pi-agent-runtime-harness.js";
import { createChatAgentsInstructions, createChatMcpServersSection, journaledMcpServersSection } from "./chat-prompt-sections.js";
import { createGenerationContextTransform, updateGenerationContextOptions, type GenerationContextOptions } from "./generation-context.js";
import { createMcpServersSectionRefresher } from "./mcp-server-instructions.js";
import { diffPromptPrefix, fingerprintPromptPrefix, type PromptPrefixDifference, type PromptPrefixFingerprint } from "./pi-cache-telemetry.js";
import { PiAgentRuntimeHarness } from "./pi-agent-runtime-harness.js";
import type { PiCompactionCoordinatorOptions } from "./pi-compaction-core.js";
import { convertToLlm } from "./pi-legacy-harness.js";
import { chatMessageToPiMessage } from "./generation-messages.js";
import { AIDEN_CHAT_MESSAGE_MARKER, syncChatMessagesToPiSession } from "./pi-compaction-session-store.js";
import { createPiSessionPort, type PiSessionPort } from "./pi-session-port.js";
import { InMemorySessionRepo } from "./pi-session-repository-port.js";
import { createPiTurnContextPreparation } from "./pi-turn-context.js";

export type PromptPrefixWire = "anthropic-messages" | "openai-responses" | "google-generative-ai";
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
  /**
   * Roots for the real AGENTS.md refresher, created afresh each turn through
   * the factory llm-client uses, with `userDataDir` standing in for the app
   * data folder that holds the device key. The harness is one chat.
   */
  agentsInstructions?: Pick<AgentsInstructionOptions, "globalRoot" | "workspaceRoot" | "read"> & { userDataDir: string };
  /** Renders the `mcp_servers` section; a fresh refresher is created each turn. */
  mcpServersSection?: () => string;
  /**
   * llm-client's late MCP discovery: tools admitted after the turn started,
   * read on every inventory lookup, and how many servers are still
   * connecting. When set, the `mcp_servers` section is built from the turn's
   * tools and the runtime's callable inventory through the factory llm-client
   * uses, instead of from `mcpServersSection`, and codemode turns can call the
   * late tools.
   */
  lateMcp?: { tools(): readonly AgentTool[]; pending(): number };
  /**
   * Wraps the stream every request goes through after it is recorded, as
   * llm-client wraps its provider stream (the side-call prefix ledger).
   */
  wrapStream?: (streamFn: StreamFn) => StreamFn;
  /**
   * Compaction options each turn's coordinator gets on top of the harness's
   * own, read when the turn starts (llm-client builds them per generation).
   * A `model` here stands for the chat's model changing between turns.
   */
  compaction?: () => Partial<Omit<PiCompactionCoordinatorOptions, "session">>;
}

export type PromptPrefixTurnInput = {
  prompt: string;
  /**
   * Host messages llm-client journals right after the prompt, built with the
   * production helpers (`hookContextMessage`); a frozen-state update follows them.
   */
  following?: (promptTimestamp: number) => AgentMessage[];
  /** Scripted assistant steps for this turn, in order. */
  responses: FauxResponseStep[];
  /**
   * An unattended follow-up that connects none of the chat's servers
   * (`lateMcp` only): the section is the one the journal recorded, and the
   * turn note saying so follows the prompt, as llm-client does.
   */
  connectorsWithheld?: boolean;
  /**
   * Regenerate the previous turn's reply: the journal returns to the held
   * prompt and llm-client runs it again as the same chat message, so the
   * sync skips it and everything journaled with it; `prompt` is ignored.
   */
  retry?: boolean;
} & (
  | {
      /** The generation head as llm-client assembles it; tools follow the journaled history. */
      assembly: ChatPromptAssembly;
    }
  | { systemPrompt: string; tools: AgentTool[] }
  | {
      /**
       * The chat state this turn reads. The harness plans it against the
       * journal as llm-client does and builds the head from the planned state.
       */
      chatState: PromptPrefixChatState;
    }
);

export interface PromptPrefixChatState {
  branch: string | null;
  permission: ChatTurnState["permission"];
  /** The turn's runtime extensions; the memory and canvas ones carry their current sections. */
  extensions: PiAgentRuntimeExtension[];
  /** Builds the head from the state system states, with the extensions frozen to it. */
  assembly(head: { branch: string | null; permission: ChatTurnState["permission"]; extensions: PiAgentRuntimeExtension[] }): Promise<ChatPromptAssembly>;
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
  /** Whether `text` reaches this request anywhere: system, tools, messages or tool results. */
  carries(text: string): boolean;
  /**
   * The request's message objects themselves, not copies, so a test can
   * check later that none of them was edited in place.
   */
  messages: PromptProviderContext["messages"];
  /**
   * The payload's fields other than tools, system and messages (output cap,
   * thinking, `tool_choice` and the like), as the adapter rendered them.
   */
  settings: Record<string, unknown>;
  /** Every cache breakpoint marker in the payload, in order. */
  cacheMarkers: unknown[];
}

export interface PromptRequestComparison {
  /** First rendered segment that changed, or none when `current` extends `previous`. */
  wire?: { index: number; kind: PromptWireSegmentKind };
  /** The telemetry's attribution of the same change. */
  transcript?: PromptPrefixDifference;
}

export interface PromptPrefixHarness {
  turn(input: PromptPrefixTurnInput): Promise<RecordedPromptRequest[]>;
  /** The scripted model every turn runs on. */
  readonly model: Model<Api>;
  /** Renders a context the way this harness records its own requests. */
  record: PromptRequestRecorder["record"];
  readonly requests: readonly RecordedPromptRequest[];
  /** Requests that reached `fetch`; always 0 unless the capture broke. */
  readonly networkCalls: number;
  /** The running turn's callable inventory, for a codemode tool a test builds. */
  callableTools(): readonly AgentTool[];
  /** The running turn's agent state, for a tool that reads the live transcript. */
  agentState(): AgentState | undefined;
  /** Runs a nested call in the running turn, for a codemode tool a test builds. */
  executeNestedToolCall: PiAgentRuntimeHarness["executeNestedToolCall"];
  /** The chat state the journal records (`journaledChatState` of its branch). */
  journaledChatState(): Promise<JournaledChatState>;
  /** The chat's journal, created by the first turn. */
  journal(): Promise<PiSessionPort>;
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

/** A Google payload's `config`, which carries its system instruction and tools. */
function googleConfig(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const config = payload.config;
  return Array.isArray(payload.contents) && config && typeof config === "object" && !Array.isArray(config)
    ? config as Record<string, unknown>
    : undefined;
}

/** Cut a rendered payload into the segments a provider caches in order: tools, system, messages. */
export function promptWireSegments(payload: Record<string, unknown>): PromptWireSegment[] {
  const segments: PromptWireSegment[] = [];
  const google = googleConfig(payload);
  const tools = google ? google.tools : payload.tools;
  if (Array.isArray(tools) && tools.length) segments.push(segment("tools", tools));
  if (typeof payload.instructions === "string") segments.push(segment("system", payload.instructions));
  if (google?.systemInstruction !== undefined) segments.push(segment("system", google.systemInstruction));
  if (Array.isArray(payload.system)) for (const block of payload.system) segments.push(segment("system", block));
  else if (typeof payload.system === "string") segments.push(segment("system", payload.system));
  const items = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input) ? payload.input : Array.isArray(payload.contents) ? payload.contents : [];
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

/** The request options that shape a rendered payload, without credentials or callbacks. */
export type PromptRenderOptions = Pick<
  SimpleStreamOptions,
  "reasoning" | "thinkingBudgets" | "maxTokens" | "toolChoice" | "cacheRetention" | "temperature" | "sessionId"
>;

const PROMPT_FIELDS = new Set(["tools", "system", "instructions", "messages", "input", "contents"]);

/** The payload's fields other than its prompt; a Google `config` keeps its own settings. */
function payloadSettings(payload: Record<string, unknown>): Record<string, unknown> {
  const settings = Object.fromEntries(Object.entries(payload).filter(([key]) => !PROMPT_FIELDS.has(key)));
  const google = googleConfig(payload);
  if (google) {
    settings.config = Object.fromEntries(Object.entries(google).filter(([key]) => key !== "systemInstruction" && key !== "tools"));
  }
  return settings;
}

function cacheMarkersIn(value: unknown, into: unknown[] = []): unknown[] {
  if (Array.isArray(value)) for (const entry of value) cacheMarkersIn(entry, into);
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "cache_control") into.push(entry);
      else cacheMarkersIn(entry, into);
    }
  }
  return into;
}

export interface PromptRequestRecorder {
  /**
   * Render `context` through the wire's real adapter, offline, and cut it into
   * segments. With `options`, the request's own output cap, reasoning,
   * `tool_choice` and retention are rendered (on a reasoning model); without
   * them, short retention and no reasoning.
   */
  record(context: PromptProviderContext, at: { turn: number; step: number }, options?: PromptRenderOptions): Promise<RecordedPromptRequest>;
  /** Requests that reached `fetch`; always 0 unless the capture broke. */
  readonly networkCalls: number;
}

/**
 * Renders any runtime's provider context the way the chosen wire would send
 * it. The workspace harness below and the Bot runtime's Pi Durable cases both
 * record through it.
 */
function pickRenderOptions(request: PromptRenderOptions): PromptRenderOptions {
  const picked: PromptRenderOptions = {};
  if (request.reasoning) picked.reasoning = request.reasoning;
  if (request.thinkingBudgets) picked.thinkingBudgets = request.thinkingBudgets;
  if (request.maxTokens !== undefined) picked.maxTokens = request.maxTokens;
  if (request.toolChoice !== undefined) picked.toolChoice = request.toolChoice;
  if (request.temperature !== undefined) picked.temperature = request.temperature;
  if (request.sessionId !== undefined) picked.sessionId = request.sessionId;
  return picked;
}

export function createPromptRequestRecorder(
  options: Pick<PromptPrefixHarnessOptions, "wire" | "midConversationSystem"> & { model: Model<Api> },
): PromptRequestRecorder {
  const wireApi = options.wire ?? "anthropic-messages";
  const midConversationSystem = options.midConversationSystem ?? false;
  const streams: ProviderStreams = wireApi === "openai-responses"
    ? openAIResponsesApi()
    : wireApi === "google-generative-ai" ? googleGenerativeAIApi() : anthropicMessagesApi();
  const renderModel = {
    ...options.model,
    api: wireApi,
    baseUrl: wireApi === "openai-responses" ? "https://offline.invalid/v1" : "https://offline.invalid",
    compat: wireApi === "openai-responses"
      ? { supportsMidConvoSystemMessages: midConversationSystem, supportsAdditionalTools: midConversationSystem }
      : { supportsMidConvoSystemMessages: midConversationSystem, supportsMidConvoToolChanges: midConversationSystem },
  } as Model<Api>;
  let networkCalls = 0;

  async function render(context: PromptProviderContext, request?: PromptRenderOptions): Promise<Record<string, unknown>> {
    let payload: Record<string, unknown> | undefined;
    const model = request?.reasoning ? ({ ...renderModel, reasoning: true } as Model<Api>) : renderModel;
    const refuse: typeof globalThis.fetch = async () => {
      networkCalls += 1;
      throw new Error("Prompt prefix harness never dispatches a request.");
    };
    // The Google adapter rejects a custom fetch, so its client would use the global one.
    const globalFetch = wireApi === "google-generative-ai" ? globalThis.fetch : undefined;
    if (globalFetch) globalThis.fetch = refuse;
    try {
      await streams.streamSimple(model, context, {
        ...(request ? pickRenderOptions(request) : {}),
        apiKey: "offline-noncredential",
        cacheRetention: request?.cacheRetention ?? "short",
        maxRetries: 0,
        env: {},
        onPayload: (value: unknown) => {
          payload = structuredClone(value) as Record<string, unknown>;
          throw new Error("Prompt prefix harness captured the payload before dispatch.");
        },
        ...(globalFetch ? {} : { fetch: refuse }),
      } as Parameters<ProviderStreams["streamSimple"]>[2]).result();
    } finally {
      if (globalFetch && globalThis.fetch === refuse) globalThis.fetch = globalFetch;
    }
    if (!payload) throw new Error(`The ${wireApi} adapter did not render a payload.`);
    return payload;
  }

  return {
    async record(context, at, request) {
      const payload = await render(context, request);
      const rendered = JSON.stringify(payload);
      return {
        settings: payloadSettings(payload),
        cacheMarkers: cacheMarkersIn(payload),
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

const HARNESS_CHAT_ID = "prompt-prefix-harness";

export function createPromptPrefixHarness(options: PromptPrefixHarnessOptions = {}): PromptPrefixHarness {
  const midConversationSystem = options.midConversationSystem ?? false;
  const core = createFauxCore({ provider: "prompt-prefix-harness" });
  const model = core.getModel();
  const recorder = createPromptRequestRecorder({ ...options, model });
  let journal: Promise<PiSessionPort> | undefined;
  const requests: RecordedPromptRequest[] = [];
  let turnNumber = 0;
  let runtime: PiAgentRuntimeHarness | undefined;
  let lastPrompt: { id: string; content: string; createdAt: number } | undefined;
  const scripted: StreamFn = (requestModel, context, streamOptions) => core.streamSimple(requestModel, context, streamOptions);
  const stream = options.wrapStream ? options.wrapStream(scripted) : scripted;

  async function turn(input: PromptPrefixTurnInput): Promise<RecordedPromptRequest[]> {
    turnNumber += 1;
    const thisTurn = turnNumber;
    let step = 0;
    const recorded: RecordedPromptRequest[] = [];
    core.setResponses(input.responses);
    journal ??= new InMemorySessionRepo().create({ id: "prompt-prefix-harness" }).then((native) => createPiSessionPort(native));
    let session = await journal;
    if (input.retry && !lastPrompt) throw new Error("Prompt prefix harness has no earlier prompt to retry.");
    const prompt = input.retry && lastPrompt
      ? lastPrompt
      : { id: `prompt-${thisTurn}`, content: input.prompt, createdAt: Date.now() };
    lastPrompt = prompt;
    if (input.retry) {
      // A regenerate: the journal returns to the held prompt, dropping the reply it got.
      const marker = (await session.getBranch()).find((entry) =>
        entry.type === "custom" &&
        entry.customType === AIDEN_CHAT_MESSAGE_MARKER &&
        (entry.data as { chatMessageId?: unknown } | undefined)?.chatMessageId === prompt.id);
      if (!marker) throw new Error("Prompt prefix harness journal does not hold the prompt to retry.");
      await session.moveTo(marker.id);
    }
    let following = input.following;
    let precedingEntries: Array<{ customType: string; data: unknown }> = [];
    let prepareMessages: GenerationContextOptions["prepareMessages"];
    let resolved: { assembly: ChatPromptAssembly } | { systemPrompt: string; tools: AgentTool[] };
    if ("chatState" in input) {
      const { chatState } = input;
      const branch = await session.getBranch();
      const current: ChatTurnState = await withApprovedMemoryFacts(
        { branch: chatState.branch, permission: chatState.permission, ...extensionChatState(chatState.extensions) },
        branch,
        chatState.extensions,
      );
      const plan = planChatTurnState({
        journaled: journaledChatState(branch),
        current,
        prompt: true,
      });
      // As llm-client: the head goes in the prompt's append, and the turn
      // reads the journal and sends requests without removed memory facts.
      precedingEntries = chatHeadJournaling(plan, { journaled: true, prompt: true }).withPrompt;
      session = withoutForgottenFactsSession(session, current);
      prepareMessages = chatStateRequestMessages(plan.head, current);
      resolved = {
        assembly: await chatState.assembly({
          branch: plan.head.branch,
          permission: plan.head.permission,
          extensions: withHeadChatState(chatState.extensions, plan.head),
        }),
      };
      const given = input.following;
      const update = plan.update;
      if (update) following = (timestamp) => [...(given?.(timestamp) ?? []), update(timestamp)];
    } else {
      resolved = input;
    }
    // llm-client reads the chat so far back from its Pi journal each turn.
    const history = (await session.buildContext()).messages;
    const systemPrompt = "assembly" in resolved ? resolved.assembly.systemPrompt : resolved.systemPrompt;
    const tools = "assembly" in resolved ? resolved.assembly.toolsFor(history) : resolved.tools;
    const onDemandTools = "assembly" in resolved ? resolved.assembly.onDemandTools : undefined;
    const agentsInstructions = options.agentsInstructions
      ? await createChatAgentsInstructions({ ...options.agentsInstructions, chatId: HARNESS_CHAT_ID, revalidate: async () => {} })
      : undefined;
    const deferredTools = "assembly" in resolved ? resolved.assembly.deferredTools : [];
    const codemode = tools.some((tool) => tool.name === "codemode");
    runtime = undefined;
    const lateMcp = options.lateMcp;
    // llm-client: the turn's admitted tools until the runtime exists, then its callable inventory.
    const chatMcpSection = lateMcp
      ? createChatMcpServersSection({
          inventory: () => runtime?.getCallableTools() ?? ("assembly" in resolved ? resolved.assembly.contributions.tools : tools),
          declared: new Set(tools.map((tool) => tool.name)),
          latePending: () => lateMcp.pending(),
          journaled: journaledMcpServersSection(await session.getBranch()),
          connectorsWithheld: input.connectorsWithheld === true,
        })
      : undefined;
    const mcpServersSection = chatMcpSection
      ?? (options.mcpServersSection ? createMcpServersSectionRefresher(options.mcpServersSection) : undefined);
    const generationOptions: GenerationContextOptions = {
      contextWindow: model.contextWindow,
      systemPrompt,
      tools,
      supportsImages: true,
      providerId: model.provider,
      modelId: model.id,
      retainsSystemUpdates: midConversationSystem,
      ...(prepareMessages ? { prepareMessages } : {}),
    };
    let initialMessages: AgentMessage[] = [...history];
    // llm-client: the head declares the chat's fixed tools, the journal the loaded ones.
    const head = createInitialSystemMessage(systemPrompt, (onDemandTools && "assembly" in resolved ? resolved.assembly.headTools : tools).map(toToolDeclaration));
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
      await chatMcpSection?.record(session);
    }
    const connectorNote = chatMcpSection?.turnNote ?? "";
    if (connectorNote) {
      const given = following;
      following = (timestamp) => [
        ...(given?.(timestamp) ?? []),
        ...[turnNoteMessage([connectorNote], timestamp)].filter((note): note is AgentMessage => note !== undefined),
      ];
    }
    runtime = new PiAgentRuntimeHarness({
      convertToLlm,
      initialState: { systemPrompt, thinkingLevel: "off", tools: [...tools], messages: initialMessages, model },
      ...(lateMcp ? { deferredTools, ...(codemode ? { lateDeferredTools: () => lateMcp.tools() } : {}) } : {}),
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
        compaction: { models: createModels(), model, thinkingLevel: "off", ...options.compaction?.() },
        // llm-client's sync: the prompt, its following messages and the head
        // entry in one append, skipped together when the journal holds it.
        appendInput: async (journalSession, _message, followingMessages) => {
          await syncChatMessagesToPiSession(
            journalSession,
            [{ id: prompt.id, role: "user", content: prompt.content, createdAt: prompt.createdAt }],
            model,
            true,
            new Map(),
            new Map([[prompt.id, followingMessages]]),
            new Map([[prompt.id, precedingEntries]]),
          );
        },
      },
      streamFn: async (requestModel, context, streamOptions) => {
        step += 1;
        const request = await recorder.record(context, { turn: thisTurn, step });
        recorded.push(request);
        requests.push(request);
        return stream(requestModel, context, streamOptions);
      },
    });
    const message = chatMessageToPiMessage({ id: prompt.id, role: "user", content: prompt.content, createdAt: prompt.createdAt }, model, true);
    const outcome = await runtime.runManaged({
      kind: "append-and-run",
      message,
      ...(following ? { following: following(prompt.createdAt) } : {}),
    });
    if (outcome.kind !== "completed") throw new Error(`Prompt prefix harness turn ${thisTurn} ended ${outcome.kind}.`);
    return recorded;
  }

  return {
    turn,
    model,
    record: (context, at, request) => recorder.record(context, at, request),
    get requests() { return requests; },
    get networkCalls() { return recorder.networkCalls; },
    callableTools: () => runtime?.getCallableTools() ?? [],
    agentState: () => runtime?.state,
    journaledChatState: async () => journaledChatState(journal ? await (await journal).getBranch() : []),
    journal: () => {
      if (!journal) throw new Error("No prompt prefix harness turn has run.");
      return journal;
    },
    executeNestedToolCall: (...args) => {
      if (!runtime) throw new Error("No prompt prefix harness turn is running.");
      return runtime.executeNestedToolCall(...args);
    },
  };
}
