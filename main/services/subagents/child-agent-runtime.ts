import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildAgentRuntimeOptions } from "../generation-runtime.js";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import { isLocalProviderDeployment } from "../../../renderer/shared/provider-deployment.js";
import { SubagentConcurrencyGate, type SubagentDeployment } from "./concurrency-gate.js";
import type { SubagentHealthMetricsSink } from "./subagent-health-metrics-core.js";

const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export interface SubagentRuntimeAuthority {
  readonly generationId: string;
  readonly chatId: string;
  readonly workspaceId: string;
}

export interface SubagentChildSpec {
  authority: SubagentRuntimeAuthority;
  groupId: string;
  childId?: string;
  runtime: ResolvedModelRuntime;
  systemPrompt: string;
  tools: AgentTool[];
  onStarting?: () => void;
}

export interface SubagentRuntimeChild {
  childId: string;
  sessionId: string;
  agent: Agent;
  prompt(input: string): Promise<void>;
  cancel(reason?: Error): void;
}

interface RegisteredSubagentChild {
  agent: Agent;
  cancellation: AbortController;
  completion: Promise<void> | null;
  closed: boolean;
  providerResponseReceived: boolean;
  authority: SubagentRuntimeAuthority;
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
  private shuttingDown = false;

  constructor(private healthMetrics?: SubagentHealthMetricsSink) {
    this.concurrency = new SubagentConcurrencyGate();
  }

  setHealthMetrics(healthMetrics: SubagentHealthMetricsSink): void {
    this.healthMetrics = healthMetrics;
  }

  get activeCount(): number {
    return this.children.size;
  }

  create(spec: SubagentChildSpec): SubagentRuntimeChild {
    if (this.shuttingDown) throw new Error("Subagent runtime is shutting down.");
    if (!spec.authority.generationId || !spec.authority.chatId || !spec.authority.workspaceId) {
      throw new Error("Subagent runtime authority is incomplete.");
    }
    const { childId, sessionId } = childIdentity(spec.groupId, spec.childId);
    if (this.children.has(childId)) throw new Error("Subagent child identity was reused.");
    let entry!: RegisteredSubagentChild;
    const agent = new Agent({
      ...buildAgentRuntimeOptions(sessionId, spec.runtime),
      // This is the first point at which Pi has received an actual provider
      // response for this child. It deliberately carries no response content,
      // headers, model metadata, or identity beyond the already-owned entry.
      onResponse: () => {
        entry.providerResponseReceived = true;
      },
      initialState: {
        systemPrompt: spec.systemPrompt,
        model: spec.runtime.model,
        tools: spec.tools,
      },
      toolExecution: "sequential",
    });
    const deployment: SubagentDeployment = isLocalProviderDeployment(spec.runtime.provider)
      ? "local"
      : "hosted";
    entry = {
      agent,
      cancellation: new AbortController(),
      completion: null as Promise<void> | null,
      closed: false,
      providerResponseReceived: false,
      authority: { ...spec.authority },
    };
    this.children.set(childId, entry);

    const cancel = (reason = new Error("Subagent task cancelled.")) => {
      if (!entry.cancellation.signal.aborted) entry.cancellation.abort(reason);
      agent.abort();
      if (!entry.completion) this.children.delete(childId);
    };

    return {
      childId,
      sessionId,
      agent,
      prompt: async (input) => {
        if (this.shuttingDown || entry.closed || entry.cancellation.signal.aborted) {
          throw entry.cancellation.signal.reason instanceof Error
            ? entry.cancellation.signal.reason
            : new Error("Subagent runtime is shutting down.");
        }
        if (entry.completion) throw new Error("Subagent child has already started.");
        const completion = (async () => {
          let release: (() => void) | undefined;
          try {
            release = await this.concurrency.acquire(deployment, entry.cancellation.signal);
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
            await agent.prompt(input);
          } finally {
            release?.();
          }
        })();
        entry.completion = completion;
        try {
          await completion;
        } finally {
          this.children.delete(childId);
        }
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
    const settled = await boundedSettlement(
      entries.map(({ agent, completion }) => completion ?? agent.waitForIdle()),
      graceMs,
    );
    if (!settled) {
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

export const subagentRuntimeRegistry = new SubagentRuntimeRegistry();
