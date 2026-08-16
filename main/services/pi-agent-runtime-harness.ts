import {
  Agent,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentEvent,
  type AgentMessage,
  type AgentOptions,
  type AgentState,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type Session,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import {
  needsImmediatePiCompaction,
  PiCompactionCoordinator as PiCompactionCoordinatorImpl,
  type PiCompactionCheckResult,
  type PiCompactionCoordinator,
  type PiCompactionCoordinatorOptions,
} from "./pi-compaction-core.js";
import { appendPiMessages } from "./pi-compaction-session-store.js";

export type PiHarnessFaultSource =
  | "extension_context"
  | "extension_before_tool"
  | "extension_after_tool"
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
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  /** Passive observers can report activity but cannot break a Pi run. */
  onEvent?: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;
}

export interface PiAgentRuntimeHarnessOptions extends Omit<AgentOptions, "toolExecution"> {
  extensions?: readonly PiAgentRuntimeExtension[];
  onFault?: (fault: PiHarnessFault) => void;
  /** Static extension prompt/tool contributions were already applied by the host. */
  staticContributionsApplied?: boolean;
  durability?: PiRuntimeSessionBinding;
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
  const tools = extension.tools?.map((tool) =>
    Object.freeze({
      ...tool,
      parameters: cloneAndDeepFreeze(tool.parameters),
    }),
  );
  return Object.freeze({
    id: extension.id,
    ...(extension.systemPrompt === undefined ? {} : { systemPrompt: extension.systemPrompt }),
    ...(tools === undefined ? {} : { tools: Object.freeze(tools) }),
    ...(extension.transformContext === undefined
      ? {}
      : { transformContext: extension.transformContext }),
    ...(extension.beforeToolCall === undefined ? {} : { beforeToolCall: extension.beforeToolCall }),
    ...(extension.afterToolCall === undefined ? {} : { afterToolCall: extension.afterToolCall }),
    ...(extension.onEvent === undefined ? {} : { onEvent: extension.onEvent }),
  });
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
  const tools = [...baseTools, ...extensions.flatMap((extension) => extension.tools ?? [])];
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
  return contributions.length > 0
    ? [basePrompt, ...contributions].filter(Boolean).join("\n\n")
    : basePrompt;
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
  private readonly agent: Agent;
  private readonly onFault: (fault: PiHarnessFault) => void;
  private readonly durability?: PiRuntimeSessionBinding;
  private sessionPromise?: Promise<Session>;
  private sessionSeedPromise?: Promise<void>;
  private compactionPromise?: Promise<PiCompactionCoordinator>;
  private pendingDurableMessages: AgentMessage[] = [];
  private capturedTurnMessages: AgentMessage[] = [];
  private turnHadToolExecution = false;
  private lastAssistantMessage: AssistantMessage | undefined;
  private criticalFault: Error | undefined;
  private policyFault: Error | undefined;
  private managedHostFault: PiRuntimeHostFaultKind | undefined;
  private managedProviderFailure: PiRuntimeFailureReason | undefined;
  private appCancelRequested = false;
  private managedAbortController: AbortController | undefined;
  private lastManagedOutcome: PiRuntimeTerminalOutcome | undefined;
  private managedRunning = false;
  private managedOperationSettlement: Promise<void> | undefined;
  private readonly detachedDurabilityOperations = new Set<Promise<void>>();
  private running = false;
  private operationSettlement: Promise<void> | undefined;
  private disposed = false;

  constructor(options: PiAgentRuntimeHarnessOptions = {}) {
    const {
      extensions: requestedExtensions = [],
      onFault,
      staticContributionsApplied = false,
      durability,
      ...agentOptions
    } = options;
    const extensions = requestedExtensions.map(snapshotExtension);
    validateExtensions(extensions);
    this.onFault = onFault ?? (() => {});
    this.durability = durability;

    const baseState = agentOptions.initialState ?? {};
    const initialState = {
      ...baseState,
      systemPrompt: staticContributionsApplied
        ? (baseState.systemPrompt ?? "")
        : composeSystemPrompt(baseState.systemPrompt ?? "", extensions),
      tools: staticContributionsApplied
        ? [...(baseState.tools ?? [])]
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

    this.agent = new Agent({
      ...agentOptions,
      initialState,
      // Aiden tools share workspace, scheduler, and external-service state.
      // Pi defaults to parallel execution, so the host must state this policy.
      toolExecution: "sequential",
      transformContext:
        options.transformContext || extensions.some((extension) => extension.transformContext)
          ? async (messages, signal) => {
              let current = messages;
              for (const extension of extensions) {
                if (!extension.transformContext) continue;
                try {
                  current = await extension.transformContext(current, signal);
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
        options.beforeToolCall || extensions.some((extension) => extension.beforeToolCall)
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
                  const result = await extension.beforeToolCall(context, signal);
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
              return hostResult;
            }
          : undefined,
      afterToolCall:
        options.afterToolCall || extensions.some((extension) => extension.afterToolCall)
          ? async (context, signal) => {
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
                  const patch = await extension.afterToolCall(current, signal);
                  if (!patch) continue;
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

    for (const extension of extensions) {
      const observer = extension.onEvent;
      if (!observer) continue;
      this.agent.subscribe((event, signal) => {
        let snapshot: AgentEvent;
        try {
          snapshot = structuredClone(event) as AgentEvent;
        } catch (error) {
          reportExtensionFault("extension_observer", extension.id, error);
          return;
        }
        // Passive observers never participate in Pi's serial lifecycle or
        // receive mutable references used to construct the next model turn.
        void Promise.resolve()
          .then(() => observer(snapshot, signal))
          .catch((error: unknown) =>
            reportExtensionFault("extension_observer", extension.id, error),
          );
      });
    }

    if (durability) {
      this.agent.subscribe(async (event) => {
        if (event.type === "tool_execution_start") {
          this.turnHadToolExecution = true;
          return;
        }
        if (event.type !== "message_end") return;
        if (event.message.role !== "user" || durability.journalUserMessages === true) {
          this.pendingDurableMessages.push(event.message);
          this.capturedTurnMessages.push(structuredClone(event.message));
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
            this.managedHostFault ??= "session";
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
  }

  get state(): AgentState {
    return this.agent.state;
  }

  get signal(): AbortSignal | undefined {
    return this.agent.signal;
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
    const finish = (outcome: PiRuntimeTerminalOutcome) => {
      const closed =
        outcome.kind === "completed" || !outcome.finalMessage
          ? outcome
          : {
              ...outcome,
              finalMessage: closedFailureMessage(
                outcome.finalMessage,
                outcome.kind === "app_cancelled"
                  ? "The app cancelled the model operation."
                  : outcome.kind === "host_failed"
                    ? "The local agent runtime failed."
                    : "The provider did not complete the model operation.",
              ),
            };
      this.lastManagedOutcome = closed;
      return closed;
    };
    try {
      if (this.appCancelRequested) {
        return finish({ kind: "app_cancelled", attempts });
      }
      const sessionResult = await waitForManagedPromise(
        this.resolveSession(),
        abortController.signal,
      );
      if (sessionResult.kind === "cancelled") {
        return finish({ kind: "app_cancelled", attempts });
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
        return finish({ kind: "host_failed", faultKind: "session", attempts });
      }
      const session = sessionResult.value;
      if (cancelled()) return finish({ kind: "app_cancelled", attempts });
      try {
        const seedOperation = this.ensureSessionSeeded(session);
        const seeded = await waitForManagedPromise(seedOperation, abortController.signal);
        if (seeded.kind === "cancelled") {
          this.trackDetachedDurability(seedOperation);
          return finish({ kind: "app_cancelled", attempts });
        }
        if (seeded.kind === "failed") throw seeded.error;
      } catch (error) {
        try {
          durability.onJournalError?.(error);
        } catch {
          // Diagnostics cannot widen a closed session failure.
        }
        this.reportFault({ source: "session", error: toError(error) });
        return finish({ kind: "host_failed", faultKind: "session", attempts });
      }
      if (cancelled()) return finish({ kind: "app_cancelled", attempts });
      let coordinator: PiCompactionCoordinator;
      try {
        const resolved = await waitForManagedPromise(
          this.resolveCompaction(),
          abortController.signal,
        );
        if (resolved.kind === "cancelled") {
          return finish({ kind: "app_cancelled", attempts });
        }
        if (resolved.kind === "failed") throw resolved.error;
        coordinator = resolved.value;
      } catch (error) {
        this.reportFault({ source: "compaction", error: toError(error) });
        return finish({
          kind: "host_failed",
          faultKind: "compaction",
          attempts,
        });
      }
      if (cancelled()) return finish({ kind: "app_cancelled", attempts });

      try {
        const repairOperation = coordinator.prepareForPrompt();
        const repaired = await waitForManagedPromise(repairOperation, abortController.signal);
        if (repaired.kind === "cancelled") {
          this.trackDetachedDurability(repairOperation);
          return finish({ kind: "app_cancelled", attempts });
        }
        if (repaired.kind === "failed") throw repaired.error;
        if (
          repaired.value.failureCode === "unsafe-rollback" ||
          repaired.value.failureCode === "session-failed"
        ) {
          return finish({ kind: "host_failed", faultKind: "session", attempts });
        }
        if (repaired.value.errorMessage) {
          return finish({
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
        return finish({ kind: "host_failed", faultKind: "session", attempts });
      }
      if (cancelled()) return finish({ kind: "app_cancelled", attempts });

      const turnBoundaryOperation = Promise.resolve().then(() =>
        options.beforeDurableTurn?.(abortController.signal),
      );
      const turnBoundary = await waitForManagedHook(turnBoundaryOperation, abortController.signal);
      if (turnBoundary.cancelled || cancelled()) {
        this.trackDetachedDurability(turnBoundaryOperation);
        return finish({ kind: "app_cancelled", attempts });
      }
      if (turnBoundary.error) {
        this.reportFault({
          source: "session",
          error: toError(turnBoundary.error),
        });
        return finish({ kind: "host_failed", faultKind: "session", attempts });
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
            return finish({ kind: "app_cancelled", attempts });
          }
          if (appended.kind === "failed") throw appended.error;
        } catch (error) {
          try {
            durability.onJournalError?.(error);
          } catch {
            // Diagnostics cannot widen a durable session failure.
          }
          this.reportFault({ source: "session", error: toError(error) });
          return finish({ kind: "host_failed", faultKind: "session", attempts });
        }
        if (cancelled()) return finish({ kind: "app_cancelled", attempts });
      }
      coordinator.beginPrompt();
      let preflight: PiCompactionCheckResult;
      try {
        const preflightOperation = coordinator.checkContextPressure();
        const checked = await waitForManagedPromise(preflightOperation, abortController.signal);
        if (checked.kind === "cancelled") {
          this.trackDetachedDurability(preflightOperation);
          return finish({ kind: "app_cancelled", attempts });
        }
        if (checked.kind === "failed") throw checked.error;
        preflight = checked.value;
        if (preflight.failureCode === "session-failed") {
          return finish({ kind: "host_failed", faultKind: "session", attempts });
        }
        if (preflight.errorMessage) {
          return finish({
            kind: "provider_failed",
            reason: "compaction-failed",
            attempts,
          });
        }
      } catch (error) {
        this.reportFault({ source: "compaction", error: toError(error) });
        return finish({
          kind: "host_failed",
          faultKind: "compaction",
          attempts,
        });
      }
      if (cancelled()) return finish({ kind: "app_cancelled", attempts });
      let preparedMessages: AgentMessage[];
      try {
        if (preflight.messages) {
          preparedMessages = preflight.messages;
        } else {
          const built = await waitForManagedPromise(session.buildContext(), abortController.signal);
          if (built.kind === "cancelled") {
            return finish({ kind: "app_cancelled", attempts });
          }
          if (built.kind === "failed") throw built.error;
          preparedMessages = built.value.messages;
        }
      } catch (error) {
        this.reportFault({ source: "session", error: toError(error) });
        return finish({ kind: "host_failed", faultKind: "session", attempts });
      }
      this.agent.state.messages = [...preparedMessages];
      if (cancelled()) return finish({ kind: "app_cancelled", attempts });

      for (;;) {
        if (cancelled()) {
          return finish({
            kind: "app_cancelled",
            finalMessage: this.lastAssistantMessage,
            attempts,
          });
        }
        attempts = (attempts + 1) as 1 | 2;
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
            return finish({
              kind: "host_failed",
              faultKind: error.faultKind,
              attempts,
            });
          }
          if (this.managedHostFault) {
            return finish({
              kind: "host_failed",
              faultKind: this.managedHostFault,
              attempts,
            });
          }
          if (cancelled() || error instanceof PiManagedCancellationError) {
            return finish({
              kind: "app_cancelled",
              finalMessage: this.lastAssistantMessage,
              attempts,
            });
          }
          this.reportFault({
            source: "lifecycle_subscriber",
            error: toError(error),
          });
          return finish({
            kind: "host_failed",
            faultKind: "lifecycle",
            attempts,
          });
        }

        if (this.managedHostFault) {
          return finish({
            kind: "host_failed",
            faultKind: this.managedHostFault,
            finalMessage: this.lastAssistantMessage,
            attempts,
          });
        }
        if (this.managedProviderFailure) {
          return finish({
            kind: "provider_failed",
            reason: this.managedProviderFailure,
            finalMessage: this.lastAssistantMessage,
            attempts,
          });
        }

        try {
          await this.flushDurableMessages();
        } catch {
          return finish({
            kind: "host_failed",
            faultKind: this.managedHostFault ?? "session",
            attempts,
          });
        }
        const assistant = this.lastAssistantMessage as AssistantMessage | undefined;
        if (!assistant) {
          return finish(
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
            return finish({
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
          return finish({
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
            return finish({
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
            return finish({
              kind: "host_failed",
              faultKind: "lifecycle",
              finalMessage: assistant,
              ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
              attempts,
            });
          }
          if (retryHook.cancelled || cancelled()) {
            return finish({
              kind: "app_cancelled",
              finalMessage: assistant,
              ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
              attempts,
            });
          }
          await waitForManagedDelay(delayMs, abortController.signal);
          if (cancelled()) {
            return finish({
              kind: "app_cancelled",
              finalMessage: assistant,
              ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
              attempts,
            });
          }
          continue;
        }

        if (cancelled()) {
          return finish({
            kind: "app_cancelled",
            finalMessage: assistant,
            ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
            attempts,
          });
        }
        if (compactionResult.failureCode === "session-failed") {
          return finish({
            kind: "host_failed",
            faultKind: "session",
            finalMessage: assistant,
            ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
            attempts,
          });
        }
        if (assistant.stopReason === "error") {
          if (compactionResult.failureCode === "unsafe-rollback") {
            return finish({
              kind: "host_failed",
              faultKind: "session",
              attempts,
            });
          }
          return finish({
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
          return finish({
            kind: "provider_failed",
            reason: "interrupted",
            finalMessage: assistant,
            ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
            attempts,
          });
        }
        if (assistant.stopReason === "length") {
          return finish({
            kind: "provider_failed",
            reason: "output-limit",
            finalMessage: assistant,
            ...(compactionResult.assistantAbandoned ? { finalMessageWasAbandoned: true } : {}),
            attempts,
          });
        }
        return finish({ kind: "completed", finalMessage: assistant, attempts });
      }
    } finally {
      parentSignal?.removeEventListener("abort", abortFromParent);
      if (this.managedAbortController === abortController) {
        this.managedAbortController = undefined;
      }
      this.managedRunning = false;
      settleManagedOperation();
      if (this.managedOperationSettlement === managedOperationSettlement) {
        this.managedOperationSettlement = undefined;
      }
    }
  }

  steer(message: AgentMessage): void {
    this.assertUsable();
    this.agent.steer(message);
  }

  followUp(message: AgentMessage): void {
    this.assertUsable();
    this.agent.followUp(message);
  }

  abort(): void {
    this.appCancelRequested = true;
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
    this.lastManagedOutcome = undefined;
    this.pendingDurableMessages = [];
    this.lastAssistantMessage = undefined;
    this.capturedTurnMessages = [];
    this.turnHadToolExecution = false;
    this.agent.reset();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.cancelAndSettle();
    this.agent.reset();
  }

  private async runLegacy(operation: () => Promise<void>): Promise<void> {
    if (this.managedRunning) throw new Error("Pi runtime harness is busy.");
    await this.executeAgentAttempt(operation);
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
    this.sessionPromise ??= Promise.resolve(durability.session);
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

  register(extension: PiAgentRuntimeExtension): () => void {
    validateExtensions([...this.extensions.values(), extension]);
    this.extensions.set(extension.id, extension);
    return () => {
      if (this.extensions.get(extension.id) === extension) {
        this.extensions.delete(extension.id);
      }
    };
  }

  snapshot(): readonly PiAgentRuntimeExtension[] {
    return Object.freeze([...this.extensions.values()].map(snapshotExtension));
  }
}

/** Process-owned trusted contribution registry snapshotted by every new run. */
export const piAgentRuntimeExtensions = new PiAgentRuntimeExtensionRegistry();
