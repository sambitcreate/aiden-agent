import {
  Agent,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentEvent,
  type AgentMessage,
  type AgentOptions,
  type AgentState,
  type AgentTool,
  type AgentHarnessResources,
  type AgentHarnessStreamOptions,
  type AgentHarnessStreamOptionsPatch,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type CustomEntryContextMessageProjector,
  formatSkillsForSystemPrompt,
  Session,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type ImageContent,
  type Model,
  type Models,
  type ProviderResponse,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import {
  needsImmediatePiCompaction,
  PiCompactionCoordinator as PiCompactionCoordinatorImpl,
  type PiCompactionCheckResult,
  type PiCompactionCoordinator,
  type PiCompactionCoordinatorOptions,
} from "./pi-compaction-core.js";
import { appendPiMessages } from "./pi-compaction-session-store.js";
import {
  PiRuntimeEventChannel,
  projectPiRuntimeAgentEvent,
  type PiRuntimeEventObserver,
  type PiRuntimeEventState,
  type PiRuntimeIdentity,
} from "./pi-runtime-events.js";
import {
  piRuntimeTerminalDigest,
  type DurablePiRuntimeEffectOwner,
  type DurablePiRuntimeOperationState,
} from "./pi-runtime-effect-core.js";
import type { PiRuntimeEffectStore } from "./pi-runtime-effect-store.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";

export type PiHarnessFaultSource =
  | "extension_context"
  | "extension_before_tool"
  | "extension_after_tool"
  | "extension_before_provider"
  | "extension_provider_payload"
  | "extension_after_provider"
  | "extension_runtime_observer"
  | "extension_observer"
  | "host_context"
  | "host_before_tool"
  | "host_after_tool"
  | "host_prepare_turn"
  | "session"
  | "compaction"
  | "lifecycle_subscriber";

export interface PiHarnessFault {
  source: PiHarnessFaultSource;
  extensionId?: string;
  error: Error;
}

export interface PiAgentRuntimeExtension {
  /** Stable identity used for diagnostics and future trusted-plugin loading. */
  id: string;
  /** Static prompt contribution snapshotted when the harness is created. */
  systemPrompt?: string;
  /** Pi-native tools contributed to this one runtime. */
  tools?: readonly AgentTool[];
  /** Pi-compatible skills/templates snapshotted with the runtime. */
  resources?: AgentHarnessResources;
  /** Custom durable entry projection into provider context. */
  entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  beforeProviderRequest?: (
    context: PiProviderRequestContext,
    signal?: AbortSignal,
  ) => Promise<PiProviderRequestPatch | undefined>;
  beforeProviderPayload?: (
    context: PiProviderPayloadContext,
    signal?: AbortSignal,
  ) => Promise<unknown | undefined>;
  afterProviderResponse?: (
    context: PiProviderResponseContext,
    signal?: AbortSignal,
  ) => Promise<void> | void;
  /** Ordered best-effort canonical events; never part of critical durability. */
  onRuntimeEvent?: PiRuntimeEventObserver;
  /** Passive observers can report activity but cannot break a Pi run. */
  onEvent?: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;
}

export interface PiAgentRuntimeHarnessOptions extends Omit<AgentOptions, "toolExecution"> {
  extensions?: readonly PiAgentRuntimeExtension[];
  /** Fully resolved immutable contributions for one foreground operation. */
  contributions?: PiRuntimeContributionSnapshot;
  /** Owning Pi collection retained for native Harness-compatible operations. */
  models?: Models;
  resources?: AgentHarnessResources;
  identity?: PiRuntimeIdentity;
  onFault?: (fault: PiHarnessFault) => void;
  durability?: PiRuntimeSessionBinding;
}

export interface PiRuntimeContributionSnapshot {
  revision: number;
  extensions: readonly PiAgentRuntimeExtension[];
  systemPrompt: string;
  tools: readonly AgentTool[];
  resources: AgentHarnessResources;
}

export interface PiProviderRequestContext {
  model: Model<any>;
  sessionId?: string;
  /** Secret-free curated options. Auth, callbacks, and the live signal are never exposed. */
  options: Readonly<AgentHarnessStreamOptions>;
}

export type PiProviderRequestPatch = AgentHarnessStreamOptionsPatch;

export interface PiProviderPayloadContext {
  model: Model<any>;
  payload: unknown;
}

export interface PiProviderResponseContext {
  model: Model<any>;
  response: ProviderResponse;
}

export type PiRuntimeFailureReason =
  | "request-failed"
  | "context-overflow"
  | "compaction-failed"
  | "output-limit"
  | "interrupted";

export type PiRuntimeHostFaultKind =
  | "session"
  | "compaction"
  | "lifecycle"
  | "policy"
  | "invariant";

export type PiRuntimeTerminalOutcome =
  | {
      kind: "completed";
      finalMessage: AssistantMessage;
      finalMessageWasAbandoned?: false;
      attempts: 1 | 2;
    }
  | {
      kind: "app_cancelled";
      finalMessage?: AssistantMessage;
      finalMessageWasAbandoned?: boolean;
      attempts: 0 | 1 | 2;
    }
  | {
      kind: "provider_failed";
      reason: PiRuntimeFailureReason;
      finalMessage?: AssistantMessage;
      /** True only when recovery removed finalMessage from the Pi branch. */
      finalMessageWasAbandoned?: boolean;
      attempts: 0 | 1 | 2;
    }
  | {
      kind: "host_failed";
      faultKind: PiRuntimeHostFaultKind;
      finalMessage?: AssistantMessage;
      finalMessageWasAbandoned?: boolean;
      attempts: 0 | 1 | 2;
    };

export interface PiRuntimeSessionBinding {
  session: Session | Promise<Session>;
  initialMessages?: readonly AgentMessage[];
  compaction: Omit<PiCompactionCoordinatorOptions, "session">;
  appendMessages?: (session: Session, messages: readonly AgentMessage[]) => Promise<void>;
  /** Host adapter for atomically journaling a visible user plus its sync marker. */
  appendInput?: (session: Session, message: AgentMessage) => Promise<void>;
  signal?: AbortSignal;
  /** Foreground continue() does not emit its already-journaled user tail. */
  journalUserMessages?: boolean;
  forcePostRunCompaction?: () => boolean;
  clearForcePostRunCompaction?: () => void;
  onJournalError?: (error: unknown) => void;
  /** Separate, non-rollbackable evidence for tool effects that may escape the chat journal. */
  effects?: {
    store: PiRuntimeEffectStore;
    chatId: string;
  };
}

export type PiRuntimeRunInput =
  | { kind: "continue-durable-tail" }
  | { kind: "append-and-run"; message: AgentMessage };

export interface PiRuntimeRunOptions {
  /** Opens the host's visible-turn transaction after prior-tail repair. */
  beforeDurableTurn?: (signal: AbortSignal) => Promise<void> | void;
  onRetry?: (event: {
    attempt: 2;
    reason: "provider" | "overflow";
    delayMs: number;
  }) => Promise<void> | void;
}

export type PiRuntimeQueueReceipt =
  | { accepted: true; queue: "steer" | "follow-up" }
  | {
      accepted: false;
      reason: "not-active" | "cancelled" | "invalid-message" | "capacity";
    };

export class PiAgentRuntimeHostError extends Error {
  readonly code = "pi_harness_host_failure";

  constructor(
    message: string,
    readonly faultKind: PiRuntimeHostFaultKind,
  ) {
    super(message);
    this.name = "PiAgentRuntimeHostError";
  }
}

class PiManagedCancellationError extends Error {
  constructor() {
    super("The app cancelled the managed Pi runtime operation.");
    this.name = "PiManagedCancellationError";
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function closedFailureMessage(message: AssistantMessage, errorMessage: string): AssistantMessage {
  const { diagnostics: _diagnostics, ...safe } = message;
  return {
    ...structuredClone(safe),
    errorMessage,
  };
}

function validateExtensions(extensions: readonly PiAgentRuntimeExtension[]): void {
  const extensionIds = new Set<string>();
  for (const extension of extensions) {
    const id = extension.id.trim();
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(id) || extensionIds.has(id)) {
      throw new Error("Pi runtime extension identities must be unique and non-empty.");
    }
    extensionIds.add(id);
  }
}

function snapshotExtension(extension: PiAgentRuntimeExtension): PiAgentRuntimeExtension {
  const tools = extension.tools?.map(snapshotAgentTool);
  return Object.freeze({
    id: extension.id.trim(),
    ...(extension.systemPrompt === undefined ? {} : { systemPrompt: extension.systemPrompt }),
    ...(tools === undefined ? {} : { tools: Object.freeze(tools) }),
    ...(extension.resources === undefined
      ? {}
      : { resources: snapshotResources(extension.resources) }),
    ...(extension.entryProjectors === undefined
      ? {}
      : { entryProjectors: Object.freeze({ ...extension.entryProjectors }) }),
    ...(extension.transformContext === undefined
      ? {}
      : { transformContext: extension.transformContext }),
    ...(extension.beforeToolCall === undefined ? {} : { beforeToolCall: extension.beforeToolCall }),
    ...(extension.afterToolCall === undefined ? {} : { afterToolCall: extension.afterToolCall }),
    ...(extension.beforeProviderRequest === undefined
      ? {}
      : { beforeProviderRequest: extension.beforeProviderRequest }),
    ...(extension.beforeProviderPayload === undefined
      ? {}
      : { beforeProviderPayload: extension.beforeProviderPayload }),
    ...(extension.afterProviderResponse === undefined
      ? {}
      : { afterProviderResponse: extension.afterProviderResponse }),
    ...(extension.onRuntimeEvent === undefined ? {} : { onRuntimeEvent: extension.onRuntimeEvent }),
    ...(extension.onEvent === undefined ? {} : { onEvent: extension.onEvent }),
  });
}

function snapshotAgentTool(tool: AgentTool): AgentTool {
  return Object.freeze({
    ...tool,
    parameters: cloneAndDeepFreeze(tool.parameters),
  });
}

function snapshotResources(resources: AgentHarnessResources): AgentHarnessResources {
  return Object.freeze({
    ...(resources.skills
      ? { skills: Object.freeze(resources.skills.map((skill) => cloneAndDeepFreeze(skill))) }
      : {}),
    ...(resources.promptTemplates
      ? {
          promptTemplates: Object.freeze(
            resources.promptTemplates.map((template) => cloneAndDeepFreeze(template)),
          ),
        }
      : {}),
  }) as AgentHarnessResources;
}

function cloneAndDeepFreeze<T>(value: T, seen = new Map<object, object>()): T {
  if (!value || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing) return existing as T;
  const clone: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    Object.defineProperty(
      clone,
      key,
      "value" in descriptor
        ? {
            ...descriptor,
            value: cloneAndDeepFreeze(descriptor.value, seen),
          }
        : descriptor,
    );
  }
  return Object.freeze(clone) as T;
}

function composeTools(
  baseTools: readonly AgentTool[],
  extensions: readonly PiAgentRuntimeExtension[],
): AgentTool[] {
  const tools = [
    ...baseTools.map(snapshotAgentTool),
    ...extensions.flatMap((extension) => extension.tools?.map(snapshotAgentTool) ?? []),
  ];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool.name || names.has(tool.name)) {
      throw new Error(`Pi runtime tool name is missing or duplicated: ${tool.name || "<empty>"}.`);
    }
    names.add(tool.name);
  }
  return tools;
}

function composeSystemPrompt(
  basePrompt: string,
  extensions: readonly PiAgentRuntimeExtension[],
): string {
  const contributions = extensions
    .map((extension) => extension.systemPrompt?.trim())
    .filter((value): value is string => Boolean(value));
  const extensionSkills = extensions.flatMap((extension) => extension.resources?.skills ?? []);
  const skillsPrompt = formatSkillsForSystemPrompt(extensionSkills);
  return [basePrompt, ...contributions, skillsPrompt].filter(Boolean).join("\n\n");
}

function composeResources(
  baseResources: AgentHarnessResources,
  extensions: readonly PiAgentRuntimeExtension[],
): AgentHarnessResources {
  const skills = [
    ...(baseResources.skills ?? []),
    ...extensions.flatMap((extension) => extension.resources?.skills ?? []),
  ];
  const promptTemplates = [
    ...(baseResources.promptTemplates ?? []),
    ...extensions.flatMap((extension) => extension.resources?.promptTemplates ?? []),
  ];
  for (const [kind, resources] of [
    ["skill", skills],
    ["prompt template", promptTemplates],
  ] as const) {
    const names = new Set<string>();
    for (const resource of resources) {
      if (!resource.name.trim() || names.has(resource.name)) {
        throw new Error(`Pi runtime ${kind} name is missing or duplicated: ${resource.name}.`);
      }
      names.add(resource.name);
    }
  }
  return snapshotResources({ skills, promptTemplates });
}

function composeEntryProjectors(
  extensions: readonly PiAgentRuntimeExtension[],
  onError: (extensionId: string, error: unknown) => never,
): Readonly<Record<string, CustomEntryContextMessageProjector>> {
  const projectors: Record<string, CustomEntryContextMessageProjector> = {};
  for (const extension of extensions) {
    for (const [customType, projector] of Object.entries(extension.entryProjectors ?? {})) {
      if (!customType.trim() || customType.startsWith("aiden.") || projectors[customType]) {
        throw new Error(
          `Pi runtime custom entry projector is reserved, missing, or duplicated: ${customType || "<empty>"}.`,
        );
      }
      projectors[customType] = (entry, index, entries) => {
        try {
          const visibleEntries = entries.filter(
            (candidate) =>
              !(candidate.type === "custom" || candidate.type === "custom_message") ||
              candidate.customType === customType,
          );
          const visibleIndex = visibleEntries.findIndex((candidate) => candidate.id === entry.id);
          const projected = projector(
            structuredClone(entry),
            visibleIndex < 0 ? index : visibleIndex,
            structuredClone(visibleEntries),
          );
          return projected === undefined ? undefined : structuredClone(projected);
        } catch (error) {
          return onError(extension.id, error);
        }
      };
    }
  }
  return Object.freeze(projectors);
}

const PRIVATE_PROVIDER_HEADERS = new Set([
  "authorization",
  "authentication-info",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-authentication-info",
  "set-cookie",
  "cookie",
  "api-key",
  "x-api-key",
  "x-auth-token",
  "x-goog-api-key",
  "x-goog-user-project",
  "ocp-apim-subscription-key",
  "cf-access-client-id",
  "cf-access-client-secret",
  "cf-aig-authorization",
]);

function isPrivateProviderHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return PRIVATE_PROVIDER_HEADERS.has(lower) || lower.startsWith("x-amz-");
}

function publicProviderResponseHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const lower = name.toLowerCase();
      return (
        lower === "content-length" ||
        lower === "content-type" ||
        lower === "date" ||
        lower === "request-id" ||
        lower === "retry-after" ||
        lower === "server-timing" ||
        lower === "traceparent" ||
        lower === "x-correlation-id" ||
        lower === "x-request-id" ||
        lower.startsWith("ratelimit-") ||
        lower.startsWith("x-ratelimit-")
      );
    }),
  );
}

function cloneAgentMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages)) {
    throw new Error("Pi runtime context extension returned an invalid message list.");
  }
  const cloned = structuredClone(messages) as AgentMessage[];
  if (
    cloned.some(
      (message) =>
        message === null || typeof message !== "object" || typeof message.role !== "string",
    )
  ) {
    throw new Error("Pi runtime context extension returned an invalid message.");
  }
  return cloned;
}

function cloneAfterToolPatch(patch: AfterToolCallResult): AfterToolCallResult {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Pi runtime tool-result extension returned an invalid patch.");
  }
  return structuredClone(patch);
}

function snapshotQueuedMessage(
  message: AgentMessage,
): { message: AgentMessage; fingerprint: string } | undefined {
  try {
    const snapshot = structuredClone(message);
    return { message: snapshot, fingerprint: JSON.stringify(snapshot) };
  } catch {
    return undefined;
  }
}

export function resolvePiAgentRuntimeStaticContributions(
  systemPrompt: string,
  tools: readonly AgentTool[],
  extensions: readonly PiAgentRuntimeExtension[],
): { systemPrompt: string; tools: AgentTool[] } {
  validateExtensions(extensions);
  return {
    systemPrompt: composeSystemPrompt(systemPrompt, extensions),
    tools: composeTools(tools, extensions),
  };
}

export function resolvePiAgentRuntimeResources(
  resources: AgentHarnessResources,
  extensions: readonly PiAgentRuntimeExtension[],
): AgentHarnessResources {
  validateExtensions(extensions);
  return composeResources(resources, extensions);
}

export function resolvePiAgentRuntimeContributionSnapshot(
  systemPrompt: string,
  tools: readonly AgentTool[],
  resources: AgentHarnessResources,
  extensions: readonly PiAgentRuntimeExtension[],
  revision = 0,
): PiRuntimeContributionSnapshot {
  const extensionSnapshot = Object.freeze(extensions.map(snapshotExtension));
  validateExtensions(extensionSnapshot);
  return Object.freeze({
    revision,
    extensions: extensionSnapshot,
    systemPrompt: composeSystemPrompt(systemPrompt, extensionSnapshot),
    tools: Object.freeze(composeTools(tools, extensionSnapshot)),
    resources: composeResources(resources, extensionSnapshot),
  });
}

function applyProviderRequestPatch(
  options: SimpleStreamOptions,
  patch: PiProviderRequestPatch,
): SimpleStreamOptions {
  if (
    patch.transport !== undefined &&
    !["sse", "websocket", "websocket-cached", "auto"].includes(patch.transport)
  ) {
    throw new Error("Pi provider request patch transport is invalid.");
  }
  if (
    patch.cacheRetention !== undefined &&
    !["none", "short", "long"].includes(patch.cacheRetention)
  ) {
    throw new Error("Pi provider request patch cache retention is invalid.");
  }
  for (const [name, value] of [
    ["timeoutMs", patch.timeoutMs],
    ["maxRetries", patch.maxRetries],
    ["maxRetryDelayMs", patch.maxRetryDelayMs],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Pi provider request patch ${name} must be a finite non-negative number.`);
    }
  }
  const hasOwn = (key: keyof PiProviderRequestPatch) =>
    Object.prototype.hasOwnProperty.call(patch, key);
  const headers = hasOwn("headers")
    ? patch.headers === undefined
      ? undefined
      : { ...options.headers }
    : options.headers;
  if (headers && patch.headers) {
    for (const [name, value] of Object.entries(patch.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(name)) {
        throw new Error("Pi provider request patch header name is invalid.");
      }
      if (value !== undefined && (typeof value !== "string" || /[\r\n]/u.test(value))) {
        throw new Error("Pi provider request patch header value is invalid.");
      }
      if (isPrivateProviderHeader(name)) {
        throw new Error("Pi provider request patch cannot replace host authentication headers.");
      }
      if (value === undefined) delete headers[name];
      else headers[name] = value;
    }
  }
  const metadata = hasOwn("metadata")
    ? patch.metadata === undefined
      ? undefined
      : { ...options.metadata }
    : options.metadata;
  if (metadata && patch.metadata) {
    for (const [name, value] of Object.entries(patch.metadata)) {
      if (value === undefined) delete metadata[name];
      else metadata[name] = structuredClone(value);
    }
  }
  return {
    ...options,
    ...(patch.transport === undefined ? {} : { transport: patch.transport }),
    ...(patch.cacheRetention === undefined ? {} : { cacheRetention: patch.cacheRetention }),
    ...(patch.timeoutMs === undefined ? {} : { timeoutMs: patch.timeoutMs }),
    ...(patch.maxRetries === undefined ? {} : { maxRetries: patch.maxRetries }),
    ...(patch.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: patch.maxRetryDelayMs }),
    ...(hasOwn("headers") ? { headers } : {}),
    ...(hasOwn("metadata") ? { metadata } : {}),
  };
}

function applyAfterToolPatch(
  context: AfterToolCallContext,
  patch: AfterToolCallResult,
): AfterToolCallContext {
  return {
    ...context,
    result: {
      ...context.result,
      ...(patch.content === undefined ? {} : { content: patch.content }),
      ...(patch.details === undefined ? {} : { details: patch.details }),
      ...(patch.terminate === undefined ? {} : { terminate: patch.terminate }),
    },
    isError: patch.isError ?? context.isError,
  };
}

async function waitForManagedDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, Math.max(0, delayMs));
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function waitForManagedHook(
  hook: Promise<void> | void,
  signal: AbortSignal,
): Promise<{ cancelled: boolean; error?: unknown }> {
  if (signal.aborted) return { cancelled: true };
  let removeAbort = () => {};
  const aborted = new Promise<{ cancelled: true }>((resolve) => {
    const onAbort = () => resolve({ cancelled: true });
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  const settled = Promise.resolve(hook).then(
    () => ({ cancelled: false as const }),
    (error: unknown) => ({ cancelled: false as const, error }),
  );
  try {
    return await Promise.race([settled, aborted]);
  } finally {
    removeAbort();
  }
}

async function waitForManagedPromise<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<
  { kind: "completed"; value: T } | { kind: "cancelled" } | { kind: "failed"; error: unknown }
> {
  if (signal.aborted) return { kind: "cancelled" };
  let removeAbort = () => {};
  const aborted = new Promise<{ kind: "cancelled" }>((resolve) => {
    const onAbort = () => resolve({ kind: "cancelled" });
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  const settled = operation.then(
    (value) => ({ kind: "completed" as const, value }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  try {
    return await Promise.race([settled, aborted]);
  } finally {
    removeAbort();
  }
}

/**
 * Aiden's Pi-shaped runtime boundary.
 *
 * Pi 0.80.10's public AgentHarness owns a different session lifecycle and
 * silently falls back to parallel tool execution. This adapter keeps Aiden's
 * durable journal/compaction protocol while centralizing the stable Pi Agent
 * surface that both foreground and child runs need. It is deliberately the
 * only place future trusted Pi extension adapters should contribute tools,
 * prompt resources, hooks, and passive events.
 */
export class PiAgentRuntimeHarness {
  private static readonly MAX_ACCEPTED_QUEUE_MESSAGES = 32;
  private readonly agent: Agent;
  private readonly onFault: (fault: PiHarnessFault) => void;
  private readonly durability?: PiRuntimeSessionBinding;
  private readonly identity: PiRuntimeIdentity;
  readonly models?: Models;
  private readonly resources: AgentHarnessResources;
  private readonly contributionRevision: number;
  private readonly entryProjectors: Readonly<Record<string, CustomEntryContextMessageProjector>>;
  private readonly runtimeEvents?: PiRuntimeEventChannel;
  private readonly passiveObserverAbort = new AbortController();
  private providerObserverSettlement = Promise.resolve();
  private readonly passiveAgentObservers = new Set<Promise<void>>();
  private sessionPromise?: Promise<Session>;
  private sessionSeedPromise?: Promise<void>;
  private compactionPromise?: Promise<PiCompactionCoordinator>;
  private pendingDurableMessages: AgentMessage[] = [];
  private acceptedQueuedMessages: Array<{ message: AgentMessage; fingerprint: string }> = [];
  private capturedTurnMessages: AgentMessage[] = [];
  private turnHadToolExecution = false;
  private activeEffectOperation:
    | {
        operationId: string;
        nextEffectOrdinal: number;
        effects: Map<
          string,
          {
            owner: DurablePiRuntimeEffectOwner;
            replay: "safe" | "never";
            state: "prepared" | "dispatch_started";
          }
        >;
      }
    | undefined;
  private lastAssistantMessage: AssistantMessage | undefined;
  private criticalFault: Error | undefined;
  private policyFault: Error | undefined;
  private managedHostFault: PiRuntimeHostFaultKind | undefined;
  private managedProviderFailure: PiRuntimeFailureReason | undefined;
  private appCancelRequested = false;
  private managedAbortController: AbortController | undefined;
  private lastManagedOutcome: PiRuntimeTerminalOutcome | undefined;
  private managedRunning = false;
  private managedQueueOpen = false;
  private managedOperationSettlement: Promise<void> | undefined;
  private readonly detachedDurabilityOperations = new Set<Promise<void>>();
  private running = false;
  private operationSettlement: Promise<void> | undefined;
  private disposed = false;

  constructor(options: PiAgentRuntimeHarnessOptions = {}) {
    const {
      extensions: requestedExtensions = [],
      contributions,
      onFault,
      durability,
      models,
      resources: requestedResources = {},
      identity,
      ...agentOptions
    } = options;
    if (contributions && requestedExtensions.length > 0) {
      throw new Error(
        "Pi runtime extensions must be supplied directly or as one contribution snapshot.",
      );
    }
    const extensions = (contributions?.extensions ?? requestedExtensions).map(snapshotExtension);
    validateExtensions(extensions);
    this.onFault = onFault ?? (() => {});
    this.durability = durability;
    this.models = models;
    this.identity = identity ?? {
      runId: agentOptions.sessionId ?? "pi-runtime",
      sessionId: agentOptions.sessionId ?? "pi-runtime",
      lane: "foreground",
    };
    this.contributionRevision = contributions?.revision ?? 0;
    this.resources = contributions
      ? snapshotResources(contributions.resources)
      : composeResources(requestedResources, extensions);
    this.entryProjectors = composeEntryProjectors(extensions, (extensionId, error) => {
      this.policyFault ??= toError(error);
      this.reportFault({ source: "extension_context", extensionId, error: toError(error) });
      throw new PiAgentRuntimeHostError("A Pi runtime entry projector failed.", "policy");
    });

    const baseState = agentOptions.initialState ?? {};
    const initialState = {
      ...baseState,
      systemPrompt:
        contributions?.systemPrompt ??
        composeSystemPrompt(baseState.systemPrompt ?? "", extensions),
      tools: contributions
        ? [...contributions.tools]
        : composeTools(baseState.tools ?? [], extensions),
    };
    const reportExtensionFault = (
      source: Exclude<PiHarnessFaultSource, "lifecycle_subscriber">,
      extensionId: string,
      error: unknown,
    ) => {
      this.reportFault({
        source,
        extensionId,
        error: toError(error),
      });
    };
    const runtimeObservers = extensions.flatMap((extension) =>
      extension.onRuntimeEvent ? [{ id: extension.id, observer: extension.onRuntimeEvent }] : [],
    );
    if (identity || runtimeObservers.length > 0) {
      this.runtimeEvents = new PiRuntimeEventChannel(this.identity);
      for (const { id, observer } of runtimeObservers) {
        this.runtimeEvents.observe(async (event, signal) => {
          try {
            await observer(event, signal);
          } catch (error) {
            reportExtensionFault("extension_runtime_observer", id, error);
          }
        });
      }
    }
    const hasProviderHooks = extensions.some(
      (extension) =>
        extension.beforeProviderRequest ||
        extension.beforeProviderPayload ||
        extension.afterProviderResponse,
    );
    const baseStreamFn = agentOptions.streamFn ?? models?.streamSimple.bind(models);
    if (hasProviderHooks && !baseStreamFn) {
      throw new Error("Pi provider hooks require an owning Models collection or stream function.");
    }
    const providerStreamFn: AgentOptions["streamFn"] = hasProviderHooks
      ? async (model, context, requestedOptions = {}) => {
          let streamOptions = { ...requestedOptions };
          for (const extension of extensions) {
            if (!extension.beforeProviderRequest) continue;
            try {
              const patch = await extension.beforeProviderRequest(
                {
                  model: cloneAndDeepFreeze(model),
                  sessionId: requestedOptions.sessionId ?? agentOptions.sessionId,
                  options: cloneAndDeepFreeze({
                    ...(streamOptions.transport === undefined
                      ? {}
                      : { transport: streamOptions.transport }),
                    ...(streamOptions.cacheRetention === undefined
                      ? {}
                      : { cacheRetention: streamOptions.cacheRetention }),
                    ...(streamOptions.timeoutMs === undefined
                      ? {}
                      : { timeoutMs: streamOptions.timeoutMs }),
                    ...(streamOptions.maxRetries === undefined
                      ? {}
                      : { maxRetries: streamOptions.maxRetries }),
                    ...(streamOptions.maxRetryDelayMs === undefined
                      ? {}
                      : { maxRetryDelayMs: streamOptions.maxRetryDelayMs }),
                    ...(streamOptions.headers === undefined
                      ? {}
                      : {
                          headers: Object.fromEntries(
                            Object.entries(streamOptions.headers).filter(
                              (entry): entry is [string, string] => typeof entry[1] === "string",
                            ),
                          ),
                        }),
                    ...(streamOptions.metadata === undefined
                      ? {}
                      : { metadata: structuredClone(streamOptions.metadata) }),
                  }),
                },
                requestedOptions.signal,
              );
              if (patch) streamOptions = applyProviderRequestPatch(streamOptions, patch);
            } catch (error) {
              this.policyFault ??= toError(error);
              reportExtensionFault("extension_before_provider", extension.id, error);
              throw new PiAgentRuntimeHostError(
                "A Pi runtime provider request extension failed.",
                "policy",
              );
            }
          }
          const hostOnPayload = streamOptions.onPayload;
          const hostOnResponse = streamOptions.onResponse;
          return baseStreamFn!(model, context, {
            ...streamOptions,
            onPayload: extensions.some((extension) => extension.beforeProviderPayload)
              ? async (payload, payloadModel) => {
                  let current = payload;
                  for (const extension of extensions) {
                    if (!extension.beforeProviderPayload) continue;
                    try {
                      const replacement = await extension.beforeProviderPayload(
                        {
                          model: cloneAndDeepFreeze(payloadModel),
                          payload: cloneAndDeepFreeze(current),
                        },
                        requestedOptions.signal,
                      );
                      if (replacement !== undefined) current = structuredClone(replacement);
                    } catch (error) {
                      this.policyFault ??= toError(error);
                      reportExtensionFault("extension_provider_payload", extension.id, error);
                      throw new PiAgentRuntimeHostError(
                        "A Pi runtime provider payload extension failed.",
                        "policy",
                      );
                    }
                  }
                  const hostReplacement = await hostOnPayload?.(current, payloadModel);
                  return hostReplacement ?? current;
                }
              : hostOnPayload,
            onResponse: extensions.some((extension) => extension.afterProviderResponse)
              ? async (response, responseModel) => {
                  await hostOnResponse?.(response, responseModel);
                  const modelSnapshot = cloneAndDeepFreeze(responseModel);
                  const responseSnapshot = cloneAndDeepFreeze({
                    status: response.status,
                    headers: publicProviderResponseHeaders(response.headers),
                  });
                  this.providerObserverSettlement = this.providerObserverSettlement.then(
                    async () => {
                      if (this.passiveObserverAbort.signal.aborted) return;
                      for (const extension of extensions) {
                        if (!extension.afterProviderResponse) continue;
                        try {
                          await extension.afterProviderResponse(
                            {
                              model: cloneAndDeepFreeze(modelSnapshot),
                              response: responseSnapshot,
                            },
                            this.passiveObserverAbort.signal,
                          );
                        } catch (error) {
                          reportExtensionFault("extension_after_provider", extension.id, error);
                        }
                      }
                    },
                  );
                  void this.providerObserverSettlement.catch((error: unknown) => {
                    if (!this.passiveObserverAbort.signal.aborted) {
                      this.reportFault({
                        source: "extension_after_provider",
                        error: toError(error),
                      });
                    }
                  });
                }
              : hostOnResponse,
          });
        }
      : agentOptions.streamFn;

    this.agent = new Agent({
      ...agentOptions,
      ...(providerStreamFn ? { streamFn: providerStreamFn } : {}),
      initialState,
      // Aiden tools share workspace, scheduler, and external-service state.
      // Pi defaults to parallel execution, so the host must state this policy.
      toolExecution: "sequential",
      transformContext:
        options.transformContext || extensions.some((extension) => extension.transformContext)
          ? async (messages, signal) => {
              let current = cloneAgentMessages(messages);
              for (const extension of extensions) {
                if (!extension.transformContext) continue;
                try {
                  current = cloneAgentMessages(
                    await extension.transformContext(cloneAndDeepFreeze(current), signal),
                  );
                } catch (error) {
                  this.policyFault ??= toError(error);
                  reportExtensionFault("extension_context", extension.id, error);
                  throw new PiAgentRuntimeHostError(
                    "A Pi runtime context extension failed.",
                    "policy",
                  );
                }
              }
              // The host capacity/privacy transform is deliberately last so an
              // extension cannot re-expand an already bounded provider request.
              if (!options.transformContext) return current;
              try {
                return await options.transformContext(current, signal);
              } catch (error) {
                this.policyFault ??= toError(error);
                this.reportFault({
                  source: "host_context",
                  error: toError(error),
                });
                throw new PiAgentRuntimeHostError("The host context policy failed.", "policy");
              }
            }
          : undefined,
      beforeToolCall:
        options.beforeToolCall ||
        durability?.effects ||
        extensions.some((extension) => extension.beforeToolCall)
          ? async (context, signal) => {
              let hostResult: BeforeToolCallResult | undefined;
              try {
                hostResult = await options.beforeToolCall?.(context, signal);
              } catch (error) {
                this.policyFault ??= toError(error);
                this.reportFault({
                  source: "host_before_tool",
                  error: toError(error),
                });
                // A blocked tool result is normally non-terminal in Pi. Abort
                // here so a broken approval/policy boundary cannot trigger a
                // second context-bearing provider request.
                this.agent.abort();
                return {
                  block: true,
                  reason: "The host could not safely prepare this tool call.",
                };
              }
              if (hostResult?.block) return hostResult;
              for (const extension of extensions) {
                if (!extension.beforeToolCall) continue;
                try {
                  const result = await extension.beforeToolCall(
                    cloneAndDeepFreeze(context),
                    signal,
                  );
                  if (result?.block) return result;
                } catch (error) {
                  this.policyFault ??= toError(error);
                  reportExtensionFault("extension_before_tool", extension.id, error);
                  this.agent.abort();
                  return {
                    block: true,
                    reason: `Extension ${extension.id} could not safely prepare this tool call.`,
                  };
                }
              }
              try {
                await this.prepareDurableEffect(context, signal);
              } catch (error) {
                if (error instanceof PiManagedCancellationError) {
                  this.agent.abort();
                  return { block: true, reason: "The tool operation was cancelled." };
                }
                this.managedHostFault ??= "session";
                this.reportFault({ source: "session", error: toError(error) });
                this.agent.abort();
                return {
                  block: true,
                  reason: "The tool effect could not be prepared durably.",
                };
              }
              return hostResult;
            }
          : undefined,
      afterToolCall:
        options.afterToolCall ||
        durability?.effects ||
        extensions.some((extension) => extension.afterToolCall)
          ? async (context, signal) => {
              try {
                await this.finishDurableEffect(context);
              } catch (error) {
                this.managedHostFault ??= "session";
                this.reportFault({ source: "session", error: toError(error) });
                this.agent.abort();
                return {
                  content: [
                    {
                      type: "text",
                      text: "The tool effect completed, but its durable outcome could not be recorded.",
                    },
                  ],
                  details: {},
                  isError: true,
                  terminate: true,
                };
              }
              let current = context;
              let combined: AfterToolCallResult | undefined;
              try {
                combined = await options.afterToolCall?.(current, signal);
              } catch (error) {
                this.policyFault ??= toError(error);
                this.reportFault({
                  source: "host_after_tool",
                  error: toError(error),
                });
                return {
                  content: [
                    {
                      type: "text",
                      text: "The host could not safely finalize this tool result.",
                    },
                  ],
                  details: {},
                  isError: true,
                  terminate: true,
                };
              }
              if (combined) current = applyAfterToolPatch(current, combined);
              for (const extension of extensions) {
                if (!extension.afterToolCall) continue;
                try {
                  const extensionPatch = await extension.afterToolCall(
                    cloneAndDeepFreeze(current),
                    signal,
                  );
                  if (!extensionPatch) continue;
                  const patch = cloneAfterToolPatch(extensionPatch);
                  combined = { ...combined, ...patch };
                  current = applyAfterToolPatch(current, patch);
                } catch (error) {
                  this.policyFault ??= toError(error);
                  reportExtensionFault("extension_after_tool", extension.id, error);
                  return {
                    content: [
                      {
                        type: "text",
                        text: "A runtime extension could not safely finalize this tool result.",
                      },
                    ],
                    details: {},
                    isError: true,
                    terminate: true,
                  };
                }
              }
              return current === context
                ? undefined
                : {
                    content: current.result.content,
                    details: current.result.details,
                    isError: current.isError,
                    terminate: current.result.terminate,
                  };
            }
          : undefined,
    });

    this.agent.subscribe((event) => {
      if (event.type === "agent_start" && this.managedRunning && !this.appCancelRequested) {
        this.managedQueueOpen = true;
      } else if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason !== "stop" &&
        event.message.stopReason !== "toolUse"
      ) {
        // Pi does not drain steer/follow-up queues after an error, abort, or
        // output-limit terminal. Close admission before external subscribers
        // can observe the later turn_end event and enqueue work that cannot run.
        this.managedQueueOpen = false;
      } else if (event.type === "agent_end") {
        this.managedQueueOpen = false;
      }
    });

    for (const extension of extensions) {
      const observer = extension.onEvent;
      if (!observer) continue;
      this.agent.subscribe((event) => {
        let snapshot: AgentEvent;
        try {
          snapshot = structuredClone(event) as AgentEvent;
        } catch (error) {
          reportExtensionFault("extension_observer", extension.id, error);
          return;
        }
        // Passive observers never participate in Pi's serial lifecycle or
        // receive mutable references used to construct the next model turn.
        if (this.passiveAgentObservers.size >= 128) return;
        const observation = Promise.resolve()
          .then(() => observer(snapshot, this.passiveObserverAbort.signal))
          .catch((error: unknown) =>
            reportExtensionFault("extension_observer", extension.id, error),
          );
        this.passiveAgentObservers.add(observation);
        void observation.finally(() => this.passiveAgentObservers.delete(observation));
      });
    }

    if (durability) {
      this.agent.subscribe(async (event) => {
        if (event.type === "tool_execution_start") {
          this.turnHadToolExecution = true;
          return;
        }
        if (event.type !== "message_end") return;
        // The managed initial input is already durable and Agent.continue()
        // does not re-emit it. Any emitted user is queued steer/follow-up input.
        this.pendingDurableMessages.push(event.message);
        this.capturedTurnMessages.push(structuredClone(event.message));
        if (event.message.role === "user") {
          const emittedFingerprint = snapshotQueuedMessage(event.message)?.fingerprint;
          const acceptedIndex = this.acceptedQueuedMessages.findIndex(
            (accepted) =>
              accepted.message === event.message || accepted.fingerprint === emittedFingerprint,
          );
          if (acceptedIndex >= 0) this.acceptedQueuedMessages.splice(acceptedIndex, 1);
        }
        if (event.message.role === "assistant") {
          this.lastAssistantMessage = event.message;
        }
        // Pi emits an assistant tool plan before executing its tools and emits
        // tool results before the next provider step. Awaiting here makes both
        // boundaries durable before any external effect or continuation.
        await this.flushDurableMessages();
      });

      const hostPrepare = options.prepareNextTurnWithContext;
      this.agent.prepareNextTurnWithContext = async (input, signal) => {
        if (this.managedHostFault) {
          this.agent.abort();
          throw new PiAgentRuntimeHostError(
            "The active Pi runtime host boundary failed before the next model turn.",
            this.managedHostFault,
          );
        }
        if (this.policyFault) {
          this.agent.abort();
          throw new PiAgentRuntimeHostError(
            "The active Pi runtime policy failed before the next model turn.",
            "policy",
          );
        }
        let hostPrepared: Awaited<ReturnType<NonNullable<typeof hostPrepare>>> | undefined;
        try {
          hostPrepared = await hostPrepare?.(input, signal);
        } catch (error) {
          this.managedHostFault ??= "policy";
          this.reportFault({
            source: "host_prepare_turn",
            error: toError(error),
          });
          this.agent.abort();
          throw new PiAgentRuntimeHostError(
            "The host could not safely prepare the next model turn.",
            "policy",
          );
        }
        const context = hostPrepared?.context ?? input.context;
        try {
          await this.flushDurableMessages();
          const coordinator = await this.resolveCompaction();
          const immediate = needsImmediatePiCompaction(
            input.toolResults,
            this.agent.state.model?.contextWindow ?? 0,
          );
          const forced = durability.forcePostRunCompaction?.() === true;
          const operation = coordinator.checkContextPressure({
            forceThreshold: immediate || forced,
            sealCurrentTurnIfNeeded: immediate,
          });
          const managedSignal = this.managedAbortController?.signal;
          const result = managedSignal
            ? await waitForManagedPromise(operation, managedSignal).then((settled) => {
                if (settled.kind === "cancelled") {
                  this.trackDetachedDurability(operation);
                  throw new PiManagedCancellationError();
                }
                if (settled.kind === "failed") throw settled.error;
                return settled.value;
              })
            : await operation;
          durability.clearForcePostRunCompaction?.();
          if (this.appCancelRequested || signal?.aborted) {
            this.agent.abort();
            return hostPrepared;
          }
          if (result.failureCode === "session-failed") {
            this.managedHostFault ??= this.policyFault ? "policy" : "session";
            this.agent.abort();
            return hostPrepared;
          }
          if (result.errorMessage && (immediate || forced)) {
            this.managedProviderFailure ??= "compaction-failed";
            this.agent.abort();
            return hostPrepared;
          }
          if (!result.messages) return hostPrepared;
          this.agent.state.messages = [...result.messages];
          return {
            ...hostPrepared,
            context: { ...context, messages: [...result.messages] },
          };
        } catch (error) {
          if (error instanceof PiManagedCancellationError) {
            this.agent.abort();
            throw error;
          }
          this.managedHostFault ??=
            error instanceof PiAgentRuntimeHostError ? error.faultKind : "compaction";
          this.reportFault({ source: "compaction", error: toError(error) });
          this.agent.abort();
          throw new PiAgentRuntimeHostError(
            "The durable Pi turn could not be prepared.",
            this.managedHostFault,
          );
        }
      };
    }
    this.agent.subscribe((event) => {
      this.runtimeEvents?.emit({
        type: "agent_event",
        event: projectPiRuntimeAgentEvent(event),
        durable: Boolean(this.durability && event.type === "message_end"),
      });
    });
  }

  get state(): AgentState {
    return this.agent.state;
  }

  get signal(): AbortSignal | undefined {
    return this.agent.signal;
  }

  /** Immutable per-runtime resource snapshot used by prompt and explicit invocation adapters. */
  getResources(): AgentHarnessResources {
    return this.resources;
  }

  getContributionRevision(): number {
    return this.contributionRevision;
  }

  observeRuntime(observer: PiRuntimeEventObserver): () => void {
    if (!this.runtimeEvents) throw new Error("Pi runtime canonical events are not configured.");
    return this.runtimeEvents.observe(observer);
  }

  runtimeEventState(): PiRuntimeEventState | undefined {
    return this.runtimeEvents?.snapshot();
  }

  settleRuntimeObservers(): Promise<void> {
    return Promise.all([
      this.runtimeEvents?.settleObservers() ?? Promise.resolve(),
      this.providerObserverSettlement,
      ...this.passiveAgentObservers,
    ]).then(() => undefined);
  }

  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    return this.agent.subscribe(async (event, signal) => {
      try {
        await listener(event, signal);
      } catch (error) {
        const fault = toError(error);
        this.criticalFault ??= fault;
        if (this.managedRunning) this.managedHostFault ??= "lifecycle";
        this.reportFault({ source: "lifecycle_subscriber", error: fault });
        // Finish the current event, then prevent another provider/tool step.
        this.agent.abort();
      }
    });
  }

  prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  prompt(input: string, images?: ImageContent[]): Promise<void>;
  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<void> {
    await this.runLegacy(() =>
      typeof input === "string" ? this.agent.prompt(input, images) : this.agent.prompt(input),
    );
  }

  /** Continue from a user/tool-result tail already committed to Aiden's Pi session. */
  async continueFromDurableTail(): Promise<void> {
    await this.runLegacy(() => this.agent.continue());
  }

  async continue(): Promise<void> {
    await this.continueFromDurableTail();
  }

  /**
   * Execute one durable Pi operation, including preflight compaction, every
   * journal flush, checkpoint installation, and the single recovery retry.
   */
  async runManaged(
    input: PiRuntimeRunInput,
    options: PiRuntimeRunOptions = {},
  ): Promise<PiRuntimeTerminalOutcome> {
    const durability = this.durability;
    if (!durability) {
      throw new Error("Pi runtime durability is not configured.");
    }
    this.assertUsable();
    if (this.running || this.managedRunning) {
      throw new Error("Pi runtime harness is busy.");
    }
    this.managedRunning = true;
    this.managedQueueOpen = false;
    let settleManagedOperation!: () => void;
    const managedOperationSettlement = new Promise<void>((resolve) => {
      settleManagedOperation = resolve;
    });
    this.managedOperationSettlement = managedOperationSettlement;
    this.appCancelRequested = false;
    this.managedHostFault = undefined;
    this.managedProviderFailure = undefined;
    this.lastManagedOutcome = undefined;
    this.pendingDurableMessages = [];
    this.acceptedQueuedMessages = [];
    this.capturedTurnMessages = [];
    this.turnHadToolExecution = false;
    this.lastAssistantMessage = undefined;
    const abortController = new AbortController();
    this.managedAbortController = abortController;
    const parentSignal = durability.signal;
    const abortFromParent = () => {
      this.appCancelRequested = true;
      abortController.abort(parentSignal?.reason);
      this.agent.abort();
    };
    if (parentSignal?.aborted) abortFromParent();
    else
      parentSignal?.addEventListener("abort", abortFromParent, {
        once: true,
      });

    let attempts: 0 | 1 | 2 = 0;
    const cancelled = () => this.appCancelRequested || abortController.signal.aborted;
    const finish = async (outcome: PiRuntimeTerminalOutcome): Promise<PiRuntimeTerminalOutcome> => {
      let finalized = outcome;
      try {
        await this.finishEffectOperation(
          outcome.kind === "completed"
            ? "completed"
            : outcome.kind === "app_cancelled"
              ? "app_cancelled"
              : outcome.kind === "provider_failed"
                ? "provider_failed"
                : "host_failed",
        );
      } catch (error) {
        this.managedHostFault ??= "session";
        this.reportFault({ source: "session", error: toError(error) });
        finalized = {
          kind: "host_failed",
          faultKind: "session",
          attempts: outcome.attempts,
          ...(outcome.finalMessage ? { finalMessage: outcome.finalMessage } : {}),
          ...(outcome.finalMessageWasAbandoned ? { finalMessageWasAbandoned: true } : {}),
        };
      }
      const closed =
        finalized.kind === "completed" || !finalized.finalMessage
          ? finalized
          : {
              ...finalized,
              finalMessage: closedFailureMessage(
                finalized.finalMessage,
                finalized.kind === "app_cancelled"
                  ? "The app cancelled the model operation."
                  : finalized.kind === "host_failed"
                    ? "The local agent runtime failed."
                    : "The provider did not complete the model operation.",
              ),
            };
      this.lastManagedOutcome = closed;
      this.runtimeEvents?.emit({
        type: "run_end",
        outcome: closed.kind,
        attempts: closed.attempts,
        ...(closed.kind === "provider_failed"
          ? { reason: closed.reason }
          : closed.kind === "host_failed"
            ? { reason: closed.faultKind }
            : {}),
      });
      return closed;
    };
    this.runtimeEvents?.setAttempt(0);
    this.runtimeEvents?.emit({ type: "run_start", input: input.kind });
    try {
      if (this.appCancelRequested) {
        return await finish({ kind: "app_cancelled", attempts });
      }
      const sessionResult = await waitForManagedPromise(
        this.resolveSession(),
        abortController.signal,
      );
      if (sessionResult.kind === "cancelled") {
        return await finish({ kind: "app_cancelled", attempts });
      }
      if (sessionResult.kind === "failed") {
        try {
          durability.onJournalError?.(sessionResult.error);
        } catch {
          // Diagnostics cannot widen a closed session failure.
        }
        this.reportFault({
          source: "session",
          error: toError(sessionResult.error),
        });
        return await finish({ kind: "host_failed", faultKind: "session", attempts });
      }
      const session = sessionResult.value;
      if (cancelled()) return await finish({ kind: "app_cancelled", attempts });
      try {
        await this.startEffectOperation();
      } catch (error) {
        this.managedHostFault ??= "session";
        this.reportFault({ source: "session", error: toError(error) });
        return await finish({ kind: "host_failed", faultKind: "session", attempts });
      }
      if (cancelled()) return await finish({ kind: "app_cancelled", attempts });
      try {
        const seedOperation = this.ensureSessionSeeded(session);
        const seeded = await waitForManagedPromise(seedOperation, abortController.signal);
        if (seeded.kind === "cancelled") {
          this.trackDetachedDurability(seedOperation);
          return await finish({ kind: "app_cancelled", attempts });
        }
        if (seeded.kind === "failed") throw seeded.error;
      } catch (error) {
        try {
          durability.onJournalError?.(error);
        } catch {
          // Diagnostics cannot widen a closed session failure.
        }
        this.reportFault({ source: "session", error: toError(error) });
        return await finish({ kind: "host_failed", faultKind: "session", attempts });
      }
      if (cancelled()) return await finish({ kind: "app_cancelled", attempts });
      let coordinator: PiCompactionCoordinator;
      try {
        const resolved = await waitForManagedPromise(
          this.resolveCompaction(),
          abortController.signal,
        );
        if (resolved.kind === "cancelled") {
          return await finish({ kind: "app_cancelled", attempts });
        }
        if (resolved.kind === "failed") throw resolved.error;
        coordinator = resolved.value;
      } catch (error) {
        this.reportFault({ source: "compaction", error: toError(error) });
        return await finish({
          kind: "host_failed",
          faultKind: "compaction",
          attempts,
        });
      }
      if (cancelled()) return await finish({ kind: "app_cancelled", attempts });

      try {
        const repairOperation = coordinator.prepareForPrompt();
        const repaired = await waitForManagedPromise(repairOperation, abortController.signal);
        if (repaired.kind === "cancelled") {
          this.trackDetachedDurability(repairOperation);
          return await finish({ kind: "app_cancelled", attempts });
        }
        if (repaired.kind === "failed") throw repaired.error;
        if (
          repaired.value.failureCode === "unsafe-rollback" ||
          repaired.value.failureCode === "session-failed"
        ) {
          return await finish({
            kind: "host_failed",
            faultKind: this.policyFault ? "policy" : "session",
            attempts,
          });
        }
        if (repaired.value.errorMessage) {
          return await finish({
            kind: "provider_failed",
            reason: "compaction-failed",
            attempts,
          });
        }
        if (repaired.value.messages) {
          this.agent.state.messages = [...repaired.value.messages];
        }
      } catch (error) {
        this.reportFault({ source: "session", error: toError(error) });
        return await finish({ kind: "host_failed", faultKind: "session", attempts });
      }
      if (cancelled()) return await finish({ kind: "app_cancelled", attempts });

      const turnBoundaryOperation = Promise.resolve().then(() =>
        options.beforeDurableTurn?.(abortController.signal),
      );
      const turnBoundary = await waitForManagedHook(turnBoundaryOperation, abortController.signal);
      if (turnBoundary.cancelled || cancelled()) {
        this.trackDetachedDurability(turnBoundaryOperation);
        return await finish({ kind: "app_cancelled", attempts });
      }
      if (turnBoundary.error) {
        this.reportFault({
          source: "session",
          error: toError(turnBoundary.error),
        });
        return await finish({ kind: "host_failed", faultKind: "session", attempts });
      }

      if (input.kind === "append-and-run") {
        try {
          const appendOperation = durability.appendInput
            ? durability.appendInput(session, input.message)
            : (durability.appendMessages ?? appendPiMessages)(session, [input.message]);
          const appended = await waitForManagedPromise(appendOperation, abortController.signal);
          if (appended.kind === "cancelled") {
            this.trackDetachedDurability(appendOperation);
            try {
              durability.onJournalError?.(new PiManagedCancellationError());
            } catch {
              // Diagnostics cannot alter app-cancellation precedence.
            }
            return await finish({ kind: "app_cancelled", attempts });
          }
          if (appended.kind === "failed") throw appended.error;
        } catch (error) {
          try {
            durability.onJournalError?.(error);
          } catch {
            // Diagnostics cannot widen a durable session failure.
          }
          this.reportFault({ source: "session", error: toError(error) });
          return await finish({ kind: "host_failed", faultKind: "session", attempts });
        }
        if (cancelled()) return await finish({ kind: "app_cancelled", attempts });
      }
      coordinator.beginPrompt();
      let preflight: PiCompactionCheckResult;
      try {
        const preflightOperation = coordinator.checkContextPressure();
        const checked = await waitForManagedPromise(preflightOperation, abortController.signal);
        if (checked.kind === "cancelled") {
          this.trackDetachedDurability(preflightOperation);
          return await finish({ kind: "app_cancelled", attempts });
        }
        if (checked.kind === "failed") throw checked.error;
        preflight = checked.value;
        if (preflight.failureCode === "session-failed") {
          return await finish({
            kind: "host_failed",
            faultKind: this.policyFault ? "policy" : "session",
            attempts,
          });
        }
        if (preflight.errorMessage) {
          return await finish({
            kind: "provider_failed",
            reason: "compaction-failed",
            attempts,
          });
        }
      } catch (error) {
        this.reportFault({ source: "compaction", error: toError(error) });
        return await finish({
          kind: "host_failed",
          faultKind: "compaction",
          attempts,
        });
      }
      if (cancelled()) return await finish({ kind: "app_cancelled", attempts });
      let preparedMessages: AgentMessage[];
      try {
        if (preflight.messages) {
          preparedMessages = preflight.messages;
        } else {
          const built = await waitForManagedPromise(session.buildContext(), abortController.signal);
          if (built.kind === "cancelled") {
            return await finish({ kind: "app_cancelled", attempts });
          }
          if (built.kind === "failed") throw built.error;
          preparedMessages = built.value.messages;
        }
      } catch (error) {
        this.reportFault({ source: "session", error: toError(error) });
        return await finish({
          kind: "host_failed",
          faultKind: this.policyFault ? "policy" : "session",
          attempts,
        });
      }
      this.agent.state.messages = [...preparedMessages];
      if (cancelled()) return await finish({ kind: "app_cancelled", attempts });

      for (;;) {
        if (cancelled()) {
          return await finish({
            kind: "app_cancelled",
            finalMessage: this.lastAssistantMessage,
            attempts,
          });
        }
        attempts = (attempts + 1) as 1 | 2;
        this.runtimeEvents?.setAttempt(attempts);
        this.lastAssistantMessage = undefined;
        try {
          // The operation input is already durable and installed in state, so
          // continue() is the sole provider entry point and cannot duplicate it.
          await this.executeAgentAttempt(() => this.agent.continue());
        } catch (error) {
          try {
            await this.flushDurableMessages();
          } catch {
            // The flush method already records the closed host-fault kind.
          }
          if (error instanceof PiAgentRuntimeHostError) {
            return await finish({
              kind: "host_failed",
              faultKind: error.faultKind,
              attempts,
            });
          }
          if (this.managedHostFault) {
            return await finish({
              kind: "host_failed",
              faultKind: this.managedHostFault,
              attempts,
            });
          }
          if (cancelled() || error instanceof PiManagedCancellationError) {
            return await finish({
              kind: "app_cancelled",
              finalMessage: this.lastAssistantMessage,
              attempts,
            });
          }
          this.reportFault({
            source: "lifecycle_subscriber",
            error: toError(error),
          });
          return await finish({
            kind: "host_failed",
            faultKind: "lifecycle",
            attempts,
          });
        }

        if (this.managedHostFault) {
          return await finish({
            kind: "host_failed",
            faultKind: this.managedHostFault,
            finalMessage: this.lastAssistantMessage,
            attempts,
          });
        }
        if (this.managedProviderFailure) {
          return await finish({
            kind: "provider_failed",
            reason: this.managedProviderFailure,
            finalMessage: this.lastAssistantMessage,
            attempts,
          });
        }

        try {
          await this.flushDurableMessages();
        } catch {
          return await finish({
            kind: "host_failed",
            faultKind: this.managedHostFault ?? "session",
            attempts,
          });
        }
        const assistant = this.lastAssistantMessage as AssistantMessage | undefined;
        if (!assistant) {
          return await finish(
            this.appCancelRequested
              ? { kind: "app_cancelled", attempts }
              : { kind: "host_failed", faultKind: "invariant", attempts },
          );
        }

        let compactionResult: PiCompactionCheckResult;
        try {
          const compactionOperation = coordinator.check(assistant, {
            forceThreshold: durability.forcePostRunCompaction?.() === true,
          });
          const checked = await waitForManagedPromise(compactionOperation, abortController.signal);
          if (checked.kind === "cancelled") {
            this.trackDetachedDurability(compactionOperation);
            return await finish({
              kind: "app_cancelled",
              finalMessage: assistant,
              attempts,
            });
          }
          if (checked.kind === "failed") throw checked.error;
          compactionResult = checked.value;
          durability.clearForcePostRunCompaction?.();
        } catch (error) {
          this.reportFault({ source: "compaction", error: toError(error) });
          return await finish({
            kind: "host_failed",
            faultKind: "compaction",
            attempts,
          });
        }
        if (compactionResult.messages) {
          this.agent.state.messages = [...compactionResult.messages];
        }
        if (compactionResult.shouldRetry) {
          const capturedTail = this.capturedTurnMessages[this.capturedTurnMessages.length - 1];
          if (
            capturedTail?.role === "assistant" &&
            capturedTail.timestamp === assistant.timestamp
          ) {
            this.capturedTurnMessages.pop();
          }
          if (attempts >= 2) {
            if (
              !cancelled() &&
              compactionResult.failureCode !== "session-failed" &&
              compactionResult.failureCode !== "unsafe-rollback" &&
              this.requeueAcceptedMessagesAfterTerminal()
            ) {
              attempts = 0;
              this.lastAssistantMessage = undefined;
              continue;
            }
            return await finish({
              kind: "provider_failed",
              reason:
                compactionResult.failureCode === "context-overflow"
                  ? "context-overflow"
                  : "request-failed",
              finalMessage: assistant,
              ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
              attempts,
            });
          }
          const delayMs = compactionResult.retryDelayMs ?? 0;
          this.runtimeEvents?.emit({
            type: "retry",
            attempt: 2,
            reason: compactionResult.compacted === true ? "overflow" : "provider",
            delayMs,
          });
          const retryHook = await waitForManagedHook(
            Promise.resolve().then(() =>
              options.onRetry?.({
                attempt: 2,
                reason: compactionResult.compacted === true ? "overflow" : "provider",
                delayMs,
              }),
            ),
            abortController.signal,
          );
          if (retryHook.error) {
            this.reportFault({
              source: "lifecycle_subscriber",
              error: toError(retryHook.error),
            });
            return await finish({
              kind: "host_failed",
              faultKind: "lifecycle",
              finalMessage: assistant,
              ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
              attempts,
            });
          }
          if (retryHook.cancelled || cancelled()) {
            return await finish({
              kind: "app_cancelled",
              finalMessage: assistant,
              ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
              attempts,
            });
          }
          await waitForManagedDelay(delayMs, abortController.signal);
          if (cancelled()) {
            return await finish({
              kind: "app_cancelled",
              finalMessage: assistant,
              ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
              attempts,
            });
          }
          continue;
        }

        if (cancelled()) {
          return await finish({
            kind: "app_cancelled",
            finalMessage: assistant,
            ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
            attempts,
          });
        }
        if (compactionResult.failureCode === "session-failed") {
          return await finish({
            kind: "host_failed",
            faultKind: this.policyFault ? "policy" : "session",
            finalMessage: assistant,
            ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
            attempts,
          });
        }
        if (compactionResult.failureCode === "unsafe-rollback") {
          return await finish({
            kind: "host_failed",
            faultKind: "session",
            finalMessage: assistant,
            ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
            attempts,
          });
        }
        if (
          assistant.stopReason !== "stop" &&
          assistant.stopReason !== "toolUse" &&
          this.requeueAcceptedMessagesAfterTerminal()
        ) {
          attempts = 0;
          this.lastAssistantMessage = undefined;
          continue;
        }
        if (assistant.stopReason === "error") {
          return await finish({
            kind: "provider_failed",
            reason:
              compactionResult.failureCode === "context-overflow"
                ? "context-overflow"
                : compactionResult.failureCode === "compaction-failed"
                  ? "compaction-failed"
                  : "request-failed",
            finalMessage: assistant,
            ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
            attempts,
          });
        }
        if (assistant.stopReason === "aborted") {
          return await finish({
            kind: "provider_failed",
            reason: "interrupted",
            finalMessage: assistant,
            ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
            attempts,
          });
        }
        if (assistant.stopReason === "length") {
          return await finish({
            kind: "provider_failed",
            reason: "output-limit",
            finalMessage: assistant,
            ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
            attempts,
          });
        }
        return await finish({ kind: "completed", finalMessage: assistant, attempts });
      }
    } finally {
      parentSignal?.removeEventListener("abort", abortFromParent);
      if (this.activeEffectOperation) {
        try {
          await this.finishEffectOperation("host_failed");
        } catch (error) {
          this.reportFault({ source: "session", error: toError(error) });
        }
      }
      if (this.managedAbortController === abortController) {
        this.managedAbortController = undefined;
      }
      this.managedRunning = false;
      this.managedQueueOpen = false;
      settleManagedOperation();
      if (this.managedOperationSettlement === managedOperationSettlement) {
        this.managedOperationSettlement = undefined;
      }
    }
  }

  queueSteer(message: AgentMessage): PiRuntimeQueueReceipt {
    const rejected = this.rejectedQueueReceipt(message);
    if (rejected) return rejected;
    const queued = snapshotQueuedMessage(message);
    if (!queued) return { accepted: false, reason: "invalid-message" };
    this.acceptedQueuedMessages.push(queued);
    this.agent.steer(queued.message);
    return { accepted: true, queue: "steer" };
  }

  queueFollowUp(message: AgentMessage): PiRuntimeQueueReceipt {
    const rejected = this.rejectedQueueReceipt(message);
    if (rejected) return rejected;
    const queued = snapshotQueuedMessage(message);
    if (!queued) return { accepted: false, reason: "invalid-message" };
    this.acceptedQueuedMessages.push(queued);
    this.agent.followUp(queued.message);
    return { accepted: true, queue: "follow-up" };
  }

  abort(): void {
    this.appCancelRequested = true;
    this.managedQueueOpen = false;
    this.managedAbortController?.abort(new Error("The app cancelled the Pi runtime operation."));
    void this.compactionPromise?.then((coordinator) => coordinator.abort()).catch(() => undefined);
    this.agent.abort();
  }

  async cancelAndSettle(): Promise<PiRuntimeTerminalOutcome | undefined> {
    const operationSettlement = this.operationSettlement;
    const managedOperationSettlement = this.managedOperationSettlement;
    const hadActiveOperation = Boolean(operationSettlement || managedOperationSettlement);
    this.abort();
    await this.agent.waitForIdle();
    await operationSettlement;
    await managedOperationSettlement;
    return hadActiveOperation ? this.lastManagedOutcome : undefined;
  }

  /**
   * A non-abortable host storage callback can outlive app cancellation. The
   * caller must quarantine its session until this snapshot settles and then
   * run transaction recovery before allowing another turn.
   */
  pendingDurabilitySettlement(): Promise<void> | undefined {
    const operations = [...this.detachedDurabilityOperations];
    return operations.length > 0 ? Promise.allSettled(operations).then(() => undefined) : undefined;
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  /**
   * Rebuild effect evidence after the visible-turn lease rolls back a failed
   * generated-message transaction. This is intentionally unavailable while a
   * run is active and emits a private user safety boundary before visible-chat
   * reconciliation appends its terminal assistant.
   */
  async reconcileDurableEvidenceAfterRollback(): Promise<boolean> {
    if (this.running || this.managedRunning) {
      throw new Error("Pi runtime harness is busy.");
    }
    if (!this.durability || !this.turnHadToolExecution) return false;
    const messages = this.capturedTurnMessages.filter((message) => message.role !== "user");
    if (messages.length === 0) return false;
    const session = await this.resolveSession();
    await (this.durability.appendMessages ?? appendPiMessages)(session, [
      ...messages,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "A prior tool effect crossed the execution boundary before its turn could be finalized. Treat the preceding tool evidence as authoritative and do not repeat that effect unless the user explicitly asks.",
          },
        ],
        timestamp: Date.now(),
      },
    ]);
    return true;
  }

  reset(): void {
    if (this.running || this.managedRunning) {
      throw new Error("Pi runtime harness is busy.");
    }
    this.criticalFault = undefined;
    this.policyFault = undefined;
    this.managedHostFault = undefined;
    this.managedProviderFailure = undefined;
    this.appCancelRequested = false;
    this.managedQueueOpen = false;
    this.lastManagedOutcome = undefined;
    this.pendingDurableMessages = [];
    this.acceptedQueuedMessages = [];
    this.lastAssistantMessage = undefined;
    this.capturedTurnMessages = [];
    this.turnHadToolExecution = false;
    this.agent.reset();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.cancelAndSettle();
    this.passiveObserverAbort.abort(new Error("Pi runtime observation ended."));
    this.runtimeEvents?.close();
    this.agent.reset();
  }

  private async runLegacy(operation: () => Promise<void>): Promise<void> {
    if (this.durability) {
      throw new Error("Durable Pi runtimes must use runManaged().");
    }
    if (this.managedRunning) throw new Error("Pi runtime harness is busy.");
    await this.executeAgentAttempt(operation);
  }

  private async startEffectOperation(): Promise<void> {
    const effects = this.durability?.effects;
    if (!effects) return;
    if (this.activeEffectOperation) {
      throw new Error("A Pi runtime effect operation is already active.");
    }
    const operationId = randomUUID();
    await effects.store.startOperation({
      operationId,
      runId: this.identity.runId,
      sessionId: this.identity.sessionId,
      chatId: effects.chatId,
      lane: this.identity.lane,
      contributionRevision: this.contributionRevision,
    });
    this.activeEffectOperation = { operationId, nextEffectOrdinal: 0, effects: new Map() };
  }

  private async prepareDurableEffect(
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const binding = this.durability?.effects;
    const operation = this.activeEffectOperation;
    if (!binding && !operation) return;
    if (!binding || !operation) {
      throw new Error("The Pi runtime effect operation is unavailable.");
    }
    if (operation.effects.has(context.toolCall.id)) {
      throw new Error("The Pi runtime tool-call identity was reused.");
    }
    const tool = context.context.tools?.find(({ name }) => name === context.toolCall.name);
    if (!tool) throw new Error("The Pi runtime tool metadata is unavailable.");
    const effectId = randomUUID();
    const replay = piRuntimeReplayPolicy(tool);
    const prepared = await binding.store.prepareEffect({
      operationId: operation.operationId,
      runId: this.identity.runId,
      sessionId: this.identity.sessionId,
      chatId: binding.chatId,
      lane: this.identity.lane,
      contributionRevision: this.contributionRevision,
      effectId,
      turnId: `turn-${operation.nextEffectOrdinal++}`,
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      replay,
      arguments: context.args,
    });
    const owner: DurablePiRuntimeEffectOwner = {
      effectId: prepared.effectId,
      operationId: prepared.operationId,
      runId: prepared.runId,
      chatId: prepared.chatId,
    };
    operation.effects.set(context.toolCall.id, { owner, replay, state: "prepared" });
    if (signal?.aborted || this.appCancelRequested) {
      await binding.store.cancelEffectBeforeDispatch(owner);
      operation.effects.delete(context.toolCall.id);
      throw new PiManagedCancellationError();
    }
    await binding.store.markEffectDispatchStarted(owner);
    const tracked = operation.effects.get(context.toolCall.id);
    if (tracked) tracked.state = "dispatch_started";
  }

  private async finishDurableEffect(context: AfterToolCallContext): Promise<void> {
    const binding = this.durability?.effects;
    const operation = this.activeEffectOperation;
    if (!binding && !operation) return;
    if (!binding || !operation) {
      throw new Error("The Pi runtime effect operation is unavailable.");
    }
    const tracked = operation.effects.get(context.toolCall.id);
    if (!tracked || tracked.state !== "dispatch_started") {
      throw new Error("The Pi runtime effect dispatch evidence is unavailable.");
    }
    const state = context.isError ? "remote_error" : "completed";
    await binding.store.finishEffect({
      ...tracked.owner,
      state,
      terminalDigest: piRuntimeTerminalDigest(state),
    });
    operation.effects.delete(context.toolCall.id);
  }

  private async finishEffectOperation(
    state: Exclude<DurablePiRuntimeOperationState, "running" | "interrupted">,
  ): Promise<void> {
    const binding = this.durability?.effects;
    const operation = this.activeEffectOperation;
    if (!binding || !operation) return;
    let failure: unknown;
    for (const tracked of operation.effects.values()) {
      try {
        if (tracked.state === "prepared") {
          await binding.store.cancelEffectBeforeDispatch(tracked.owner);
        } else {
          const terminalState = tracked.replay === "safe" ? "interrupted" : "unknown";
          await binding.store.finishEffect({
            ...tracked.owner,
            state: terminalState,
            terminalDigest: piRuntimeTerminalDigest(terminalState),
          });
        }
      } catch (error) {
        failure ??= error;
      }
    }
    operation.effects.clear();
    try {
      await binding.store.finishOperation(operation.operationId, failure ? "host_failed" : state);
    } catch (error) {
      failure ??= error;
    } finally {
      if (this.activeEffectOperation === operation) this.activeEffectOperation = undefined;
    }
    if (failure) throw failure;
  }

  private async executeAgentAttempt(operation: () => Promise<void>): Promise<void> {
    this.assertUsable();
    if (this.running) throw new Error("Pi runtime harness is busy.");
    this.running = true;
    let settleOperation!: () => void;
    const operationSettlement = new Promise<void>((resolve) => {
      settleOperation = resolve;
    });
    this.operationSettlement = operationSettlement;
    this.criticalFault = undefined;
    this.policyFault = undefined;
    try {
      await operation();
      await this.agent.waitForIdle();
      const criticalFault = this.criticalFault;
      const fault = criticalFault ?? this.policyFault;
      if (fault) {
        this.managedHostFault ??= criticalFault ? "lifecycle" : "policy";
        throw new PiAgentRuntimeHostError(
          criticalFault
            ? "A critical Pi harness lifecycle subscriber failed."
            : "An active Pi runtime extension policy failed.",
          criticalFault ? "lifecycle" : "policy",
        );
      }
    } finally {
      this.criticalFault = undefined;
      this.policyFault = undefined;
      this.running = false;
      settleOperation();
      if (this.operationSettlement === operationSettlement) {
        this.operationSettlement = undefined;
      }
    }
  }

  private async flushDurableMessages(): Promise<void> {
    const durability = this.durability;
    if (!durability || this.pendingDurableMessages.length === 0) return;
    const batch = this.pendingDurableMessages;
    this.pendingDurableMessages = [];
    try {
      const operation = (durability.appendMessages ?? appendPiMessages)(
        await this.resolveSession(),
        batch,
      );
      const signal = this.managedAbortController?.signal;
      if (!signal) {
        await operation;
      } else {
        const appended = await waitForManagedPromise(operation, signal);
        if (appended.kind === "cancelled") {
          this.trackDetachedDurability(operation);
          throw new PiManagedCancellationError();
        }
        if (appended.kind === "failed") throw appended.error;
      }
    } catch (error) {
      if (error instanceof PiManagedCancellationError) {
        this.pendingDurableMessages = [...batch, ...this.pendingDurableMessages];
        try {
          durability.onJournalError?.(error);
        } catch {
          // Diagnostics cannot alter app-cancellation precedence.
        }
        this.agent.abort();
        throw error;
      }
      this.pendingDurableMessages = [...batch, ...this.pendingDurableMessages];
      this.managedHostFault ??= "session";
      try {
        durability.onJournalError?.(error);
      } catch {
        // Diagnostics cannot widen or replace the closed session fault.
      }
      this.reportFault({ source: "session", error: toError(error) });
      this.agent.abort();
      throw new PiAgentRuntimeHostError("The durable Pi journal could not be updated.", "session");
    }
  }

  private requeueAcceptedMessagesAfterTerminal(): boolean {
    if (this.acceptedQueuedMessages.length === 0 || !this.agent.hasQueuedMessages()) return false;
    // Pi does not drain either queue after an error/aborted terminal. Convert
    // every already-accepted item to steering so the next continuation emits
    // and journals it before making another provider request.
    this.agent.clearAllQueues();
    for (const accepted of this.acceptedQueuedMessages) this.agent.steer(accepted.message);
    return true;
  }

  private resolveCompaction(): Promise<PiCompactionCoordinator> {
    const durability = this.durability;
    if (!durability) {
      return Promise.reject(new Error("Pi runtime durability is not configured."));
    }
    this.compactionPromise ??= this.resolveSession().then(
      (session) =>
        new PiCompactionCoordinatorImpl({
          ...durability.compaction,
          session,
        }),
    );
    return this.compactionPromise;
  }

  private resolveSession(): Promise<Session> {
    const durability = this.durability;
    if (!durability) {
      return Promise.reject(new Error("Pi runtime durability is not configured."));
    }
    this.sessionPromise ??= Promise.resolve(durability.session).then((session) =>
      Object.keys(this.entryProjectors).length === 0
        ? session
        : new Session(session.getStorage(), { entryProjectors: this.entryProjectors }),
    );
    return this.sessionPromise;
  }

  private ensureSessionSeeded(session: Session): Promise<void> {
    const durability = this.durability;
    if (!durability?.initialMessages?.length) return Promise.resolve();
    this.sessionSeedPromise ??= (durability.appendMessages ?? appendPiMessages)(
      session,
      durability.initialMessages,
    );
    return this.sessionSeedPromise;
  }

  private trackDetachedDurability(operation: Promise<unknown>): void {
    const settlement = operation.then(
      () => undefined,
      () => undefined,
    );
    this.detachedDurabilityOperations.add(settlement);
    void settlement.then(() => {
      this.detachedDurabilityOperations.delete(settlement);
    });
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Pi runtime harness is disposed.");
  }

  private rejectedQueueReceipt(
    message: AgentMessage,
  ): Extract<PiRuntimeQueueReceipt, { accepted: false }> | undefined {
    if (this.disposed || !this.managedRunning || !this.managedQueueOpen) {
      return { accepted: false, reason: "not-active" };
    }
    if (this.appCancelRequested) return { accepted: false, reason: "cancelled" };
    if (message.role !== "user") return { accepted: false, reason: "invalid-message" };
    if (this.acceptedQueuedMessages.length >= PiAgentRuntimeHarness.MAX_ACCEPTED_QUEUE_MESSAGES) {
      return { accepted: false, reason: "capacity" };
    }
    return undefined;
  }

  private reportFault(fault: PiHarnessFault): void {
    try {
      this.onFault(fault);
    } catch {
      // Diagnostics must never become another harness failure.
    }
  }
}

/** Host-owned registry. Loading executable extension files is a separate trust decision. */
export class PiAgentRuntimeExtensionRegistry {
  private readonly extensions = new Map<string, PiAgentRuntimeExtension>();
  private revision = 0;

  register(extension: PiAgentRuntimeExtension): () => void {
    const registered = snapshotExtension(extension);
    validateExtensions([...this.extensions.values(), registered]);
    const key = registered.id;
    this.extensions.set(key, registered);
    this.revision += 1;
    return () => {
      if (this.extensions.get(key) === registered) {
        this.extensions.delete(key);
        this.revision += 1;
      }
    };
  }

  /** Atomic trusted-extension reload; stale disposers cannot remove the replacement. */
  replace(extension: PiAgentRuntimeExtension): () => void {
    const registered = snapshotExtension(extension);
    const key = registered.id;
    validateExtensions([
      ...[...this.extensions.entries()].filter(([id]) => id !== key).map(([, value]) => value),
      registered,
    ]);
    this.extensions.set(key, registered);
    this.revision += 1;
    return () => {
      if (this.extensions.get(key) === registered) {
        this.extensions.delete(key);
        this.revision += 1;
      }
    };
  }

  snapshot(): readonly PiAgentRuntimeExtension[] {
    return Object.freeze([...this.extensions.values()].map(snapshotExtension));
  }

  snapshotWithRevision(): {
    revision: number;
    extensions: readonly PiAgentRuntimeExtension[];
  } {
    return Object.freeze({
      revision: this.revision,
      extensions: this.snapshot(),
    });
  }
}

/** Process-owned trusted contribution registry snapshotted by every new run. */
export const piAgentRuntimeExtensions = new PiAgentRuntimeExtensionRegistry();
