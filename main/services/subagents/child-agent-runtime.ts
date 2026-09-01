import { randomUUID } from "node:crypto";
import { convertToLlm } from "@earendil-works/pi-agent-core";
import type {
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { writeDevLog } from "../dev-log.js";
import { buildAgentRuntimeOptions } from "../generation-runtime.js";
import {
  assertGenerationContextCapacity,
  createGenerationContextTransform,
} from "../generation-context.js";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import { isLocalProviderDeployment } from "../../../renderer/shared/provider-deployment.js";
import { SubagentConcurrencyGate, type SubagentDeployment } from "./concurrency-gate.js";
import type { SubagentHealthMetricsSink } from "./subagent-health-metrics-core.js";
import { createPiCompactionModels } from "../pi-compaction-core.js";
import {
  PiAgentRuntimeHarness,
  type PiRuntimeSessionBinding,
  type PiRuntimeTerminalOutcome,
} from "../pi-agent-runtime-harness.js";
import {
  ElectronSubagentInferenceIsolation,
  type SubagentInferenceIsolation,
} from "./subagent-inference-process.js";
import { piRuntimeEffectStore, type PiRuntimeEffectStore } from "../pi-runtime-effect-store.js";
import { createInMemoryPiSession } from "../pi-session-repository-port.js";

const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
export const MAX_REGISTERED_SUBAGENT_CHILDREN = 32;

export interface SubagentRuntimeAuthority {
  readonly generationId: string;
  readonly chatId: string;
  readonly workspaceId: string;
}

export interface SubagentChildSpec {
  authority: SubagentRuntimeAuthority;
  runId?: string;
  groupId: string;
  childId?: string;
  runtime: ResolvedModelRuntime;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  tools: AgentTool[];
  /** Already-sanitized, child-owned fork transcript. */
  initialMessages?: AgentMessage[];
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  onStarting?: () => void;
}

export interface SubagentRuntimeChild {
  childId: string;
  sessionId: string;
  agent: Pick<PiAgentRuntimeHarness, "state" | "signal" | "subscribe">;
  prompt(input: string): Promise<PiRuntimeTerminalOutcome>;
  /** Temporarily yield the real provider inference slot while a nested batch runs. */
  withoutInferenceLease?<T>(operation: () => Promise<T>): Promise<T>;
  /** Quarantine this deployment after cancellation grace expires. */
  markCleanupPending?(): void;
  cancel(reason?: Error): void;
}

interface RegisteredSubagentChild {
  agent: PiAgentRuntimeHarness;
  cancellation: AbortController;
  completion: Promise<PiRuntimeTerminalOutcome> | null;
  closed: boolean;
  providerResponseReceived: boolean;
  authority: SubagentRuntimeAuthority;
  deployment: SubagentDeployment;
  releaseInference?: () => void;
  yieldingInference: boolean;
  cleanupPending: boolean;
}

export interface SubagentRuntimeRegistryOptions {
  /** Failure-injection seam; production lets the shared facade own its default. */
  appendSessionMessages?: NonNullable<PiRuntimeSessionBinding["appendMessages"]>;
  onPiJournalError?: (error: unknown) => void;
  recordCompactionUsage?: (
    message: AssistantMessage,
    runtime: ResolvedModelRuntime,
  ) => void | Promise<void>;
  /** Production-only provider-request process boundary; tests may inject a fake. */
  inferenceIsolation?: SubagentInferenceIsolation;
  /** Separate crash-safe tool-effect journal; omitted by isolated unit registries. */
  effectStore?: PiRuntimeEffectStore;
}

function childIdentity(
  groupId: string,
  requestedChildId?: string,
): { childId: string; sessionId: string } {
  const nonce = requestedChildId?.replace(/^child-/u, "") || randomUUID();
  return {
    childId: `child-${nonce}`,
    sessionId: `subagent:${groupId}:${nonce}`,
  };
}

function boundedSettlement(
  promises: readonly Promise<unknown>[],
  graceMs: number,
): Promise<boolean> {
  if (promises.length === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, graceMs));
    void Promise.allSettled(promises).then(() => finish(true));
  });
}

/**
 * Owns every in-process child Agent so application shutdown has one complete,
 * inspectable cancellation boundary.
 */
export class SubagentRuntimeRegistry {
  private readonly children = new Map<string, RegisteredSubagentChild>();
  private readonly concurrency: SubagentConcurrencyGate;
  private readonly appendSessionMessages?: NonNullable<PiRuntimeSessionBinding["appendMessages"]>;
  private readonly onPiJournalError: (error: unknown) => void;
  private readonly recordCompactionUsage?: SubagentRuntimeRegistryOptions["recordCompactionUsage"];
  private readonly inferenceIsolation?: SubagentInferenceIsolation;
  private readonly effectStore?: PiRuntimeEffectStore;
  private reportRuntimeFault: (source: string) => void = () => {};
  private shuttingDown = false;
  private readonly quarantinedDeployments = new Set<SubagentDeployment>();

  constructor(
    private healthMetrics?: SubagentHealthMetricsSink,
    private readonly maxChildren = MAX_REGISTERED_SUBAGENT_CHILDREN,
    options: SubagentRuntimeRegistryOptions = {},
  ) {
    if (!Number.isInteger(maxChildren) || maxChildren < 1 || maxChildren > 1_024) {
      throw new Error("Invalid subagent runtime child limit.");
    }
    this.concurrency = new SubagentConcurrencyGate();
    this.appendSessionMessages = options.appendSessionMessages;
    this.onPiJournalError =
      options.onPiJournalError ??
      ((error) => {
        writeDevLog("error", "subagents", ["Could not append child Pi session messages.", error]);
      });
    this.recordCompactionUsage = options.recordCompactionUsage;
    this.inferenceIsolation = options.inferenceIsolation;
    this.effectStore = options.effectStore;
  }

  setHealthMetrics(healthMetrics: SubagentHealthMetricsSink): void {
    this.healthMetrics = healthMetrics;
  }

  setRuntimeFaultReporter(reporter: (source: string) => void): void {
    this.reportRuntimeFault = reporter;
  }

  get activeCount(): number {
    return this.children.size;
  }

  isDeploymentQuarantined(deployment: SubagentDeployment): boolean {
    return this.quarantinedDeployments.has(deployment);
  }

  create(spec: SubagentChildSpec): SubagentRuntimeChild {
    if (this.shuttingDown) throw new Error("Subagent runtime is shutting down.");
    if (this.children.size >= this.maxChildren) {
      throw new Error("The app-wide subagent runtime limit was reached.");
    }
    if (!spec.authority.generationId || !spec.authority.chatId || !spec.authority.workspaceId) {
      throw new Error("Subagent runtime authority is incomplete.");
    }
    const deployment: SubagentDeployment = isLocalProviderDeployment(spec.runtime.provider)
      ? "local"
      : "hosted";
    if (this.quarantinedDeployments.has(deployment)) {
      throw new Error(
        `The ${deployment} subagent runtime is waiting for an unresponsive request to settle.`,
      );
    }
    const { childId, sessionId } = childIdentity(spec.groupId, spec.childId);
    if (this.children.has(childId)) throw new Error("Subagent child identity was reused.");
    let entry!: RegisteredSubagentChild;
    const contextOptions = {
      contextWindow: spec.runtime.model.contextWindow,
      systemPrompt: spec.systemPrompt,
      tools: spec.tools,
      supportsImages: spec.runtime.model.input.includes("image"),
      providerId: spec.runtime.model.provider,
      modelId: spec.runtime.model.id,
    };
    assertGenerationContextCapacity(contextOptions);
    const sessionPromise = createInMemoryPiSession(sessionId);
    const cancellation = new AbortController();
    const childRuntime =
      this.inferenceIsolation?.wrap(spec.runtime, {
        runId: spec.runId ?? childId,
        generationId: spec.authority.generationId,
        childId,
      }) ?? spec.runtime;
    const compactionOptions = {
      models: createPiCompactionModels(childRuntime, (message) =>
        this.recordCompactionUsage?.(message, spec.runtime),
      ),
      model: spec.runtime.model,
      thinkingLevel: spec.thinkingLevel,
      signal: cancellation.signal,
      consumeHostFailure: childRuntime.consumeIsolatedHostFailure,
    };
    const agent = new PiAgentRuntimeHarness({
      models: childRuntime.models,
      identity: {
        runId: spec.runId ?? childId,
        sessionId,
        lane: "child",
        parentRunId: spec.authority.generationId,
      },
      onFault: ({ source, extensionId }) => {
        this.reportRuntimeFault(source);
        if (extensionId) {
          writeDevLog("error", "subagents", [
            `Pi child extension fault (${source}:${extensionId}).`,
          ]);
        }
      },
      ...buildAgentRuntimeOptions(sessionId, childRuntime),
      convertToLlm,
      transformContext: createGenerationContextTransform(contextOptions),
      durability: {
        session: sessionPromise,
        initialMessages: spec.initialMessages,
        compaction: compactionOptions,
        ...(this.appendSessionMessages ? { appendMessages: this.appendSessionMessages } : {}),
        signal: cancellation.signal,
        ...(this.effectStore
          ? { effects: { store: this.effectStore, chatId: spec.authority.chatId } }
          : {}),
        onJournalError: (error) => this.onPiJournalError(error),
      },
      // This is the first point at which Pi has received an actual provider
      // response for this child. It deliberately carries no response content,
      // headers, model metadata, or identity beyond the already-owned entry.
      onResponse: () => {
        entry.providerResponseReceived = true;
      },
      beforeToolCall: spec.beforeToolCall,
      initialState: {
        systemPrompt: spec.systemPrompt,
        model: spec.runtime.model,
        thinkingLevel: spec.thinkingLevel,
        tools: spec.tools,
        messages: spec.initialMessages ?? [],
      },
    });
    entry = {
      agent,
      cancellation,
      completion: null,
      closed: false,
      providerResponseReceived: false,
      authority: { ...spec.authority },
      deployment,
      yieldingInference: false,
      cleanupPending: false,
    };
    this.children.set(childId, entry);

    const cancel = (reason = new Error("Subagent task cancelled.")) => {
      if (!entry.cancellation.signal.aborted) entry.cancellation.abort(reason);
      agent.abort();
      if (!entry.completion) this.children.delete(childId);
    };
    const publicAgent: SubagentRuntimeChild["agent"] = {
      get state() {
        return agent.state;
      },
      get signal() {
        return agent.signal;
      },
      subscribe: (listener) => agent.subscribe(listener),
    };

    return {
      childId,
      sessionId,
      agent: publicAgent,
      prompt: async (input) => {
        if (this.shuttingDown || entry.closed || entry.cancellation.signal.aborted) {
          throw entry.cancellation.signal.reason instanceof Error
            ? entry.cancellation.signal.reason
            : new Error("Subagent runtime is shutting down.");
        }
        if (entry.completion) throw new Error("Subagent child has already started.");
        const completion = (async (): Promise<PiRuntimeTerminalOutcome> => {
          try {
            const userMessage: AgentMessage = {
              role: "user",
              content: [{ type: "text", text: input }],
              timestamp: Date.now(),
            };
            entry.releaseInference = await this.concurrency.acquire(
              deployment,
              entry.cancellation.signal,
            );
            if (this.shuttingDown || entry.closed || entry.cancellation.signal.aborted) {
              throw entry.cancellation.signal.reason instanceof Error
                ? entry.cancellation.signal.reason
                : new Error("Subagent runtime is shutting down.");
            }
            try {
              this.healthMetrics?.started(this.concurrency.activeCount);
            } catch {
              // Aggregate health evidence cannot affect child execution.
            }
            spec.onStarting?.();
            return await agent.runManaged({
              kind: "append-and-run",
              message: userMessage,
            });
          } finally {
            entry.releaseInference?.();
            entry.releaseInference = undefined;
          }
        })();
        entry.completion = completion;
        try {
          return await completion;
        } finally {
          this.children.delete(childId);
          if (
            entry.cleanupPending &&
            ![...this.children.values()].some(
              (candidate) => candidate.cleanupPending && candidate.deployment === deployment,
            )
          ) {
            this.quarantinedDeployments.delete(deployment);
          }
        }
      },
      withoutInferenceLease: async <T>(operation: () => Promise<T>): Promise<T> => {
        if (
          !entry.completion ||
          entry.closed ||
          entry.cancellation.signal.aborted ||
          !entry.releaseInference ||
          entry.yieldingInference
        ) {
          throw new Error("Subagent inference capacity cannot be yielded in this state.");
        }
        entry.yieldingInference = true;
        entry.releaseInference();
        entry.releaseInference = undefined;
        try {
          return await operation();
        } finally {
          try {
            if (!entry.closed && !entry.cancellation.signal.aborted && !this.shuttingDown) {
              entry.releaseInference = await this.concurrency.acquire(
                entry.deployment,
                entry.cancellation.signal,
              );
            }
          } finally {
            entry.yieldingInference = false;
          }
        }
      },
      markCleanupPending: () => {
        if (entry.closed || !entry.completion) return;
        entry.cleanupPending = true;
        this.quarantinedDeployments.add(deployment);
      },
      cancel,
    };
  }

  abortAll(): void {
    for (const [childId, entry] of this.children) {
      if (!entry.cancellation.signal.aborted) {
        entry.cancellation.abort(new Error("Subagent task cancelled."));
      }
      entry.agent.abort();
      if (!entry.completion) this.children.delete(childId);
    }
  }

  private abortMatching(
    matches: (authority: SubagentRuntimeAuthority) => boolean,
    reason: Error,
  ): void {
    for (const [childId, entry] of this.children) {
      if (!matches(entry.authority)) continue;
      if (!entry.cancellation.signal.aborted) entry.cancellation.abort(reason);
      entry.agent.abort();
      if (!entry.completion) this.children.delete(childId);
    }
  }

  private hasMatching(matches: (authority: SubagentRuntimeAuthority) => boolean): boolean {
    return [...this.children.values()].some((entry) => matches(entry.authority));
  }

  abortWorkspace(workspaceId: string): void {
    this.abortMatching(
      (authority) => authority.workspaceId === workspaceId,
      new Error("The subagent workspace is changing."),
    );
  }

  hasWorkspaceChildren(workspaceId: string): boolean {
    return this.hasMatching((authority) => authority.workspaceId === workspaceId);
  }

  abortChat(chatId: string): void {
    this.abortMatching(
      (authority) => authority.chatId === chatId,
      new Error("The subagent chat is being deleted."),
    );
  }

  hasChatChildren(chatId: string): boolean {
    return this.hasMatching((authority) => authority.chatId === chatId);
  }

  /** True only once a child has crossed Pi's actual provider-response boundary. */
  hasChatProviderResponse(chatId: string): boolean {
    return [...this.children.values()].some(
      (entry) => entry.authority.chatId === chatId && entry.providerResponseReceived,
    );
  }

  hasGenerationChildren(generationId: string): boolean {
    return this.hasMatching((authority) => authority.generationId === generationId);
  }

  abortGeneration(generationId: string): void {
    this.abortMatching(
      (authority) => authority.generationId === generationId,
      new Error("The parent generation was cancelled."),
    );
  }

  async shutdown(graceMs = DEFAULT_SHUTDOWN_GRACE_MS): Promise<boolean> {
    this.shuttingDown = true;
    const entries = [...this.children.values()];
    this.concurrency.close();
    for (const entry of entries) {
      entry.closed = true;
      if (!entry.cancellation.signal.aborted) {
        entry.cancellation.abort(new Error("Subagent runtime is shutting down."));
      }
      entry.agent.abort();
    }
    let isolationClean = true;
    const isolationShutdown = this.inferenceIsolation
      ? this.inferenceIsolation.shutdown().then((clean) => {
          isolationClean = clean;
        })
      : undefined;
    const settled = await boundedSettlement(
      [
        ...entries.map(({ agent, completion }) => completion ?? agent.waitForIdle()),
        ...(isolationShutdown ? [isolationShutdown] : []),
      ],
      graceMs,
    );
    if (!settled || !isolationClean) {
      try {
        this.healthMetrics?.cleanupFailed();
      } catch {
        // Aggregate health evidence cannot affect shutdown authority.
      }
      return false;
    }
    for (const { agent } of entries) agent.reset();
    this.children.clear();
    return true;
  }
}

export const subagentRuntimeRegistry = new SubagentRuntimeRegistry(undefined, undefined, {
  inferenceIsolation: new ElectronSubagentInferenceIsolation(),
  effectStore: piRuntimeEffectStore,
  recordCompactionUsage: async (message, runtime) => {
    const [{ assistantUsageRecord }, { usageStore }] = await Promise.all([
      import("../usage-accounting.js"),
      import("../usage-store.js"),
    ]);
    await usageStore.record(
      assistantUsageRecord({
        message,
        provider: runtime.provider,
        model: runtime.model,
        source: "compaction",
      }),
    );
  },
});
