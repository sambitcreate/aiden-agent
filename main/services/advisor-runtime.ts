import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import type { GenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import { parseAdvisorSelection, type AdvisorSelectionV1 } from "../../renderer/shared/advisor.js";
import { AdvisorAttemptStore, type AdvisorAttemptFailure } from "./advisor-attempt-store.js";
import { boundedAdvisorText, projectAdvisorContext } from "./advisor-context.js";
import { AdvisorSettingsStore } from "./advisor-settings-store.js";
import { resolveGenerationThinkingLevel } from "./generation-runtime.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import type { PiAgentRuntimeExtension } from "./pi-agent-runtime-harness.js";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import { isNonChatModel } from "../../renderer/shared/model-eligibility.js";

export const ADVISOR_EXTENSION_ID = "aiden.rpiv.advisor";
export const ADVISOR_TOOL_NAME = "advisor";
export const ADVISOR_TIMEOUT_MS = 90_000;

export const ADVISOR_REVIEWER_SYSTEM_PROMPT =
  "You are a tool-free advisor to another model that is executing the user's task. Read the surviving conversation and executor-tool evidence. Return exactly one concise, directive response: a concrete plan, a correction to the current approach, or a stop signal requiring user input. Never call tools, never address the user, never claim to have performed work, and do not reveal hidden reasoning. Ground guidance in the supplied evidence.";

export const ADVISOR_EXECUTOR_PROMPT =
  "An advisor tool is available for one optional second opinion during this response. Use it only when stronger judgment would materially reduce risk—for a consequential ambiguity, a non-converging approach, or before an irreversible decision. It takes no parameters and forwards the surviving conversation and tool evidence to the reviewer selected by the user. Do not call it routinely. After a successful consultation, briefly attribute and restate any material guidance in your visible reply; never expose hidden reasoning or dump the raw advisor response.";

const EFFORT_ORDER: readonly GenerationThinkingLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface AdvisorGenerationScope {
  usageSource?: string;
  interactionSurface?: string;
  mode?: "assistant" | "assistant-unattended" | "assistant-automation";
  bot: boolean;
  child: boolean;
  rendererOwner: boolean;
  excluded: boolean;
}

export function advisorAllowedForGeneration(scope: AdvisorGenerationScope): boolean {
  return (
    scope.usageSource === "chat" &&
    scope.interactionSurface !== "telegram" &&
    scope.mode !== "assistant-unattended" &&
    scope.mode !== "assistant-automation" &&
    !scope.bot &&
    !scope.child &&
    scope.rendererOwner &&
    !scope.excluded
  );
}

async function preflightAdvisorRuntimeAuth(
  runtime: ResolvedModelRuntime,
  signal?: AbortSignal,
): Promise<void> {
  // Custom runtimes carry their resolved key. Codex owns a stronger isolated
  // stream preflight. Other Pi-native providers must prove current auth here;
  // their owning Models stream resolves and applies the full auth payload
  // again at the actual request boundary.
  if (runtime.apiKey || !runtime.provider.needsKey || runtime.prepareIsolatedStream) return;
  if (signal?.aborted) throw signal.reason;
  const auth = await runtime.models.getAuth(runtime.model);
  if (!auth) throw new Error("The selected advisor provider is not authenticated.");
  if (signal?.aborted) throw signal.reason;
}

export function advisorBlockedForExecutor(
  selection: AdvisorSelectionV1,
  executor: { providerId: string; modelId: string; effort?: GenerationThinkingLevel },
): boolean {
  const actualEffort = EFFORT_ORDER.indexOf(executor.effort ?? "off");
  return selection.disabledForExecutors.some((rule) => {
    if (rule.providerId !== executor.providerId || rule.modelId !== executor.modelId) return false;
    if (rule.minEffort === undefined) return true;
    const threshold = EFFORT_ORDER.indexOf(rule.minEffort);
    return threshold >= 0 && actualEffort >= threshold;
  });
}

export interface AdvisorRuntimeDependencies {
  settings: AdvisorSettingsStore;
  attempts: AdvisorAttemptStore;
  resolveRuntime(
    providerId: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelRuntime>;
  recordUsage(message: AssistantMessage, runtime: ResolvedModelRuntime): Promise<void>;
  recordUnreportedUsage(
    runtime: ResolvedModelRuntime,
    status: "failed" | "cancelled",
  ): Promise<void>;
  reportFailure?(area: string, error: unknown): void;
}

export interface AdvisorExtensionInput {
  scope: AdvisorGenerationScope;
  executor: { providerId: string; modelId: string; effort?: GenerationThinkingLevel };
  executorTools: readonly AgentTool[];
  getLiveMessages(toolCallId: string): readonly AgentMessage[];
}

export interface AdvisorToolDetails {
  status: "running" | "completed" | "failed" | "cancelled" | "blocked";
  advisorModel?: string;
  effort?: string;
}

function textFrom(response: AssistantMessage): string {
  return boundedAdvisorText(
    response.content
      .filter(
        (part): part is Extract<(typeof response.content)[number], { type: "text" }> =>
          part.type === "text",
      )
      .map((part) => part.text)
      .join("\n"),
  );
}

function normalResult(
  text: string,
  details: AdvisorToolDetails,
): AgentToolResult<AdvisorToolDetails> {
  return { content: [{ type: "text", text }], details };
}

function abortReason(signal: AbortSignal | undefined, timedOut: boolean): AdvisorAttemptFailure {
  return timedOut ? "timeout" : signal?.aborted ? "cancelled" : "provider";
}

function assertAdvisorRuntimeSelection(
  selection: AdvisorSelectionV1,
  runtime: ResolvedModelRuntime,
): void {
  if (
    runtime.provider.id !== selection.providerId ||
    runtime.model.id !== selection.modelId
  ) {
    throw new Error("The resolved advisor identity does not match the selection.");
  }
  if (
    isNonChatModel({
      model: selection.modelId,
      metadataType: runtime.provider.modelMetadata?.[selection.modelId]?.type,
    })
  ) {
    throw new Error("Advisor requires a chat model.");
  }
  if (selection.effort) {
    const resolved = resolveGenerationThinkingLevel(
      runtime.provider.id,
      runtime.model,
      selection.effort,
    );
    if (resolved !== selection.effort) {
      throw new Error("The selected advisor model does not support that effort level.");
    }
  }
}

async function withRequestSignal<T>(
  parent: AbortSignal | undefined,
  operation: (signal: AbortSignal, timedOut: () => boolean) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout = false;
  const abort = () => controller.abort(parent?.reason ?? new Error("Advisor call cancelled."));
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error("Advisor call timed out."));
  }, ADVISOR_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await operation(controller.signal, () => timeout);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

export class AdvisorRuntime {
  private settingsInitializePromise: Promise<void> | undefined;
  private attemptsInitializePromise: Promise<void> | undefined;

  constructor(private readonly dependencies: AdvisorRuntimeDependencies) {}

  initialize(): Promise<void> {
    return Promise.all([this.initializeSettings(), this.initializeAttempts()]).then(
      () => undefined,
    );
  }

  private initializeSettings(): Promise<void> {
    this.settingsInitializePromise ??= this.dependencies.settings.initialize();
    return this.settingsInitializePromise;
  }

  private initializeAttempts(): Promise<void> {
    this.attemptsInitializePromise ??= this.dependencies.attempts.initialize();
    return this.attemptsInitializePromise;
  }

  async configuration() {
    await this.initializeSettings();
    return this.dependencies.settings.get();
  }

  async setSelection(
    value: unknown,
    assertCurrent: () => void = () => undefined,
  ): Promise<Awaited<ReturnType<AdvisorSettingsStore["get"]>>> {
    await this.initializeSettings();
    if (value === null) {
      assertCurrent();
      return this.dependencies.settings.setSelection(null, assertCurrent);
    }
    // Validate provider/model/effort before publishing the new selection.
    const selection = parseAdvisorSelection(value);
    if (!selection) throw new Error("Invalid advisor selection.");
    const runtime = await this.dependencies.resolveRuntime(selection.providerId, selection.modelId);
    assertAdvisorRuntimeSelection(selection, runtime);
    await preflightAdvisorRuntimeAuth(runtime);
    // Provider/auth resolution is asynchronous. Revalidate the initiating
    // renderer document immediately before publishing its selection.
    assertCurrent();
    return this.dependencies.settings.replaceSelection(selection, assertCurrent);
  }

  async extensionForGeneration(
    input: AdvisorExtensionInput,
  ): Promise<PiAgentRuntimeExtension | null> {
    if (!advisorAllowedForGeneration(input.scope)) {
      return null;
    }
    let selection: AdvisorSelectionV1 | null;
    try {
      await this.initializeSettings();
      ({ selection } = await this.dependencies.settings.get());
    } catch (error) {
      this.dependencies.reportFailure?.("settings", error);
      return null;
    }
    if (!selection || advisorBlockedForExecutor(selection, input.executor)) return null;
    try {
      await this.initializeAttempts();
    } catch (error) {
      this.dependencies.reportFailure?.("journal", error);
      return null;
    }

    let used = false;
    const tool = declarePiRuntimeReplay(
      {
        name: ADVISOR_TOOL_NAME,
        label: "Advisor",
        description:
          "Request one tool-free second opinion from the reviewer model selected by the user. Takes no parameters. Aiden forwards the surviving conversation and executor tool evidence automatically. Use only when stronger judgment would materially change the approach.",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential" as const,
        execute: async (
          toolCallId: string,
          _parameters: unknown,
          signal?: AbortSignal,
          onUpdate?: AgentToolUpdateCallback<AdvisorToolDetails>,
        ): Promise<AgentToolResult<AdvisorToolDetails>> => {
          if (used) {
            return normalResult("The advisor is limited to one consultation in this response.", {
              status: "blocked",
            });
          }
          used = true;
          const advisorLabel = `${selection.providerId}/${selection.modelId}`;
          onUpdate?.(
            normalResult(`Consulting ${selection.modelId}…`, {
              status: "running",
              advisorModel: advisorLabel,
              ...(selection.effort ? { effort: selection.effort } : {}),
            }),
          );

          let runtime: ResolvedModelRuntime;
          try {
            runtime = await this.dependencies.resolveRuntime(
              selection.providerId,
              selection.modelId,
              signal,
            );
            assertAdvisorRuntimeSelection(selection, runtime);
            await preflightAdvisorRuntimeAuth(runtime, signal);
          } catch (error) {
            this.dependencies.reportFailure?.("resolve", error);
            return normalResult(
              "The configured advisor model is unavailable. Continue without it and tell the user they may need to reconnect or choose another reviewer.",
              { status: "failed", advisorModel: advisorLabel },
            );
          }

          let projection;
          try {
            projection = projectAdvisorContext({
              liveMessages: input.getLiveMessages(toolCallId),
              inflightToolCallId: toolCallId,
              executorTools: input.executorTools,
              reviewerContextWindow: runtime.model.contextWindow,
              reviewerSupportsImages: runtime.model.input.includes("image"),
              reviewerSystemPrompt: ADVISOR_REVIEWER_SYSTEM_PROMPT,
            });
          } catch (error) {
            this.dependencies.reportFailure?.("context", error);
            return normalResult(
              "Aiden could not safely prepare the advisor context. Continue without a consultation.",
              { status: "failed", advisorModel: advisorLabel },
            );
          }

          const attemptId = randomUUID();
          try {
            await this.dependencies.attempts.prepare(
              attemptId,
              runtime.provider.id,
              runtime.model.id,
            );
            await this.dependencies.attempts.markDispatchStarted(attemptId);
          } catch (error) {
            this.dependencies.reportFailure?.("journal", error);
            return normalResult(
              "Aiden could not durably begin the advisor consultation, so no reviewer request was sent.",
              { status: "failed", advisorModel: advisorLabel },
            );
          }

          let response: AssistantMessage | undefined;
          let state: "completed" | "failed" | "cancelled" = "failed";
          let failure: AdvisorAttemptFailure = "provider";
          try {
            response = await withRequestSignal(signal, async (requestSignal, timedOut) => {
              try {
                return await runtime.streams
                  .streamSimple(
                    runtime.model,
                    {
                      systemPrompt: ADVISOR_REVIEWER_SYSTEM_PROMPT,
                      messages: projection.messages,
                      tools: [],
                    },
                    {
                      signal: requestSignal,
                      apiKey: runtime.apiKey,
                      cacheRetention: "none",
                      timeoutMs: ADVISOR_TIMEOUT_MS,
                      maxRetries: 0,
                      maxRetryDelayMs: 0,
                      ...(selection.effort ? { reasoning: selection.effort } : {}),
                      ...(runtime.headers ? { headers: runtime.headers } : {}),
                    },
                  )
                  .result();
              } catch (error) {
                failure = abortReason(requestSignal, timedOut());
                throw error;
              }
            });
            if (response.stopReason === "aborted") {
              state = "cancelled";
              failure = signal?.aborted ? "cancelled" : "timeout";
            } else if (response.stopReason === "error" || response.stopReason === "length") {
              state = "failed";
              failure = "provider";
            } else if (!textFrom(response)) {
              state = "failed";
              failure = "provider";
            } else {
              state = "completed";
              failure = "none";
            }
          } catch (error) {
            this.dependencies.reportFailure?.("dispatch", error);
            state = failure === "cancelled" || failure === "timeout" ? "cancelled" : "failed";
          }

          try {
            await this.dependencies.attempts.settle(attemptId, state, failure);
          } catch (error) {
            this.dependencies.reportFailure?.("settle", error);
          }
          try {
            if (response) await this.dependencies.recordUsage(response, runtime);
            else
              await this.dependencies.recordUnreportedUsage(
                runtime,
                state === "cancelled" ? "cancelled" : "failed",
              );
            await this.dependencies.attempts.markUsageRecorded(attemptId);
          } catch (error) {
            this.dependencies.reportFailure?.("usage", error);
          }

          if (state === "completed" && response) {
            return normalResult(textFrom(response), {
              status: "completed",
              advisorModel: advisorLabel,
              ...(selection.effort ? { effort: selection.effort } : {}),
            });
          }
          if (state === "cancelled") {
            return normalResult("The advisor consultation was cancelled before it completed.", {
              status: "cancelled",
              advisorModel: advisorLabel,
            });
          }
          return normalResult(
            "The advisor could not return usable guidance. Continue without it.",
            {
              status: "failed",
              advisorModel: advisorLabel,
            },
          );
        },
      },
      "never",
    );

    return {
      id: ADVISOR_EXTENSION_ID,
      systemPrompt: ADVISOR_EXECUTOR_PROMPT,
      tools: [tool],
    };
  }
}
