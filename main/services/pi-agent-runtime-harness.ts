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
} from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";

export type PiHarnessFaultSource =
  | "extension_context"
  | "extension_before_tool"
  | "extension_after_tool"
  | "extension_observer"
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
  transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => Promise<AgentMessage[]>;
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

export interface PiAgentRuntimeHarnessOptions extends Omit<
  AgentOptions,
  "toolExecution"
> {
  extensions?: readonly PiAgentRuntimeExtension[];
  onFault?: (fault: PiHarnessFault) => void;
  /** Static extension prompt/tool contributions were already applied by the host. */
  staticContributionsApplied?: boolean;
}

export class PiAgentRuntimeHostError extends Error {
  readonly code = "pi_harness_host_failure";

  constructor(
    message: string,
    readonly faultKind: "lifecycle" | "policy",
  ) {
    super(message);
    this.name = "PiAgentRuntimeHostError";
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validateExtensions(
  extensions: readonly PiAgentRuntimeExtension[],
): void {
  const extensionIds = new Set<string>();
  for (const extension of extensions) {
    const id = extension.id.trim();
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(id) || extensionIds.has(id)) {
      throw new Error(
        "Pi runtime extension identities must be unique and non-empty.",
      );
    }
    extensionIds.add(id);
  }
}

function snapshotExtension(
  extension: PiAgentRuntimeExtension,
): PiAgentRuntimeExtension {
  const tools = extension.tools?.map((tool) =>
    Object.freeze({
      ...tool,
      parameters: cloneAndDeepFreeze(tool.parameters),
    }),
  );
  return Object.freeze({
    id: extension.id,
    ...(extension.systemPrompt === undefined
      ? {}
      : { systemPrompt: extension.systemPrompt }),
    ...(tools === undefined ? {} : { tools: Object.freeze(tools) }),
    ...(extension.transformContext === undefined
      ? {}
      : { transformContext: extension.transformContext }),
    ...(extension.beforeToolCall === undefined
      ? {}
      : { beforeToolCall: extension.beforeToolCall }),
    ...(extension.afterToolCall === undefined
      ? {}
      : { afterToolCall: extension.afterToolCall }),
    ...(extension.onEvent === undefined ? {} : { onEvent: extension.onEvent }),
  });
}

function cloneAndDeepFreeze<T>(value: T, seen = new Map<object, object>()): T {
  if (!value || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing) return existing as T;
  const clone: object = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value));
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
    ...baseTools,
    ...extensions.flatMap((extension) => extension.tools ?? []),
  ];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool.name || names.has(tool.name)) {
      throw new Error(
        `Pi runtime tool name is missing or duplicated: ${tool.name || "<empty>"}.`,
      );
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
  private criticalFault: Error | undefined;
  private policyFault: Error | undefined;
  private running = false;
  private operationSettlement: Promise<void> | undefined;
  private disposed = false;

  constructor(options: PiAgentRuntimeHarnessOptions = {}) {
    const {
      extensions: requestedExtensions = [],
      onFault,
      staticContributionsApplied = false,
      ...agentOptions
    } = options;
    const extensions = requestedExtensions.map(snapshotExtension);
    validateExtensions(extensions);
    this.onFault = onFault ?? (() => {});

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
        options.transformContext ||
        extensions.some((extension) => extension.transformContext)
          ? async (messages, signal) => {
              let current = messages;
              for (const extension of extensions) {
                if (!extension.transformContext) continue;
                try {
                  current = await extension.transformContext(current, signal);
                } catch (error) {
                  this.policyFault ??= toError(error);
                  reportExtensionFault(
                    "extension_context",
                    extension.id,
                    error,
                  );
                  throw new PiAgentRuntimeHostError(
                    "A Pi runtime context extension failed.",
                    "policy",
                  );
                }
              }
              // The host capacity/privacy transform is deliberately last so an
              // extension cannot re-expand an already bounded provider request.
              return options.transformContext
                ? options.transformContext(current, signal)
                : current;
            }
          : undefined,
      beforeToolCall:
        options.beforeToolCall ||
        extensions.some((extension) => extension.beforeToolCall)
          ? async (context, signal) => {
              const hostResult = await options.beforeToolCall?.(
                context,
                signal,
              );
              if (hostResult?.block) return hostResult;
              for (const extension of extensions) {
                if (!extension.beforeToolCall) continue;
                try {
                  const result = await extension.beforeToolCall(
                    context,
                    signal,
                  );
                  if (result?.block) return result;
                } catch (error) {
                  this.policyFault ??= toError(error);
                  reportExtensionFault(
                    "extension_before_tool",
                    extension.id,
                    error,
                  );
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
        options.afterToolCall ||
        extensions.some((extension) => extension.afterToolCall)
          ? async (context, signal) => {
              let current = context;
              let combined = await options.afterToolCall?.(current, signal);
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
                  reportExtensionFault(
                    "extension_after_tool",
                    extension.id,
                    error,
                  );
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
  }

  get state(): AgentState {
    return this.agent.state;
  }

  get signal(): AbortSignal | undefined {
    return this.agent.signal;
  }

  get prepareNextTurnWithContext(): Agent["prepareNextTurnWithContext"] {
    return this.agent.prepareNextTurnWithContext;
  }

  set prepareNextTurnWithContext(value: Agent["prepareNextTurnWithContext"]) {
    this.agent.prepareNextTurnWithContext = value;
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
    await this.run(() =>
      typeof input === "string"
        ? this.agent.prompt(input, images)
        : this.agent.prompt(input),
    );
  }

  /** Continue from a user/tool-result tail already committed to Aiden's Pi session. */
  async continueFromDurableTail(): Promise<void> {
    await this.run(() => this.agent.continue());
  }

  async continue(): Promise<void> {
    await this.continueFromDurableTail();
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
    this.agent.abort();
  }

  async cancelAndSettle(): Promise<void> {
    const operationSettlement = this.operationSettlement;
    this.agent.abort();
    await this.agent.waitForIdle();
    await operationSettlement;
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  reset(): void {
    if (this.running) throw new Error("Pi runtime harness is busy.");
    this.criticalFault = undefined;
    this.policyFault = undefined;
    this.agent.reset();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.cancelAndSettle();
    this.agent.reset();
  }

  private async run(operation: () => Promise<void>): Promise<void> {
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
