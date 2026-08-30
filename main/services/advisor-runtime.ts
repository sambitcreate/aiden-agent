import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AskUserQuestionResponseV1,
  AskUserQuestionV1,
} from "../../renderer/shared/ask-user-question.js";
import {
  ASK_USER_MAX_LABEL_LENGTH,
  parseAskUserQuestions,
} from "../../renderer/shared/ask-user-question.js";
import {
  GENERATION_THINKING_LEVELS,
  type GenerationThinkingLevel,
} from "../../renderer/shared/generation-thinking.js";
import { parseAdvisorSelection, type AdvisorSelectionV1 } from "../../renderer/shared/advisor.js";
import { AdvisorAttemptStore, type AdvisorAttemptFailure } from "./advisor-attempt-store.js";
import { boundedAdvisorText, projectAdvisorContext } from "./advisor-context.js";
import { resolveGenerationThinkingLevel } from "./generation-runtime.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import type { PiAgentRuntimeExtension } from "./pi-agent-runtime-harness.js";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import { isNonChatModel } from "../../renderer/shared/model-eligibility.js";
import type { Provider } from "./types.js";

export const ADVISOR_EXTENSION_ID = "aiden.rpiv.advisor";
export const ADVISOR_TOOL_NAME = "advisor";
export const ADVISOR_TIMEOUT_MS = 90_000;
export const MAX_ADVISOR_CANDIDATES = 64;
export const MAX_ADVISOR_QUESTION_OPTIONS = 4;
export const MAX_ADVISOR_PROMPT_CANDIDATES = 12;

export const ADVISOR_REVIEWER_SYSTEM_PROMPT =
  "You are a tool-free advisor to another model that is executing the user's task. Read the surviving conversation and executor-tool evidence. Return exactly one concise, directive response: a concrete plan, a correction to the current approach, or a stop signal requiring user input. Never call tools, never address the user, never claim to have performed work, and do not reveal hidden reasoning. Ground guidance in the supplied evidence.";

export const ADVISOR_TRANSFER_NOTICE =
  "Advisor sends bounded surviving conversation, completed tool evidence, a sanitized tool inventory, and supported images to the selected provider in a separate tool-free request. Aiden never attaches provider credentials and applies best-effort credential redaction, but remaining content may still be sensitive.";

const ADVISOR_EXECUTOR_GUIDANCE =
  "An advisor tool is available for one optional second opinion during this response. Use it only when stronger judgment would materially reduce risk—for a consequential ambiguity, a non-converging approach, or before an irreversible decision. Never silently choose a reviewer. After a successful consultation, briefly attribute and restate both the material guidance and the Advisor transfer notice in your visible reply; never expose hidden reasoning or dump the raw advisor response.";

const THINKING_EFFORTS = GENERATION_THINKING_LEVELS.filter(
  (level): level is Exclude<GenerationThinkingLevel, "off"> => level !== "off",
);

export interface AdvisorCandidate {
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  efforts: readonly Exclude<GenerationThinkingLevel, "off">[];
}

function boundedLabel(
  value: string,
  fallback: string,
  maximum = ASK_USER_MAX_LABEL_LENGTH,
): string {
  const normalized = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const points = Array.from(normalized || fallback);
  return points.length <= maximum ? points.join("") : `${points.slice(0, maximum - 1).join("")}…`;
}

function normalizeAdvisorCandidate(candidate: AdvisorCandidate): AdvisorCandidate | undefined {
  const selection = parseAdvisorSelection({
    providerId: candidate.providerId,
    modelId: candidate.modelId,
  });
  if (!selection) return undefined;
  return {
    providerId: selection.providerId,
    providerLabel: boundedLabel(candidate.providerLabel, selection.providerId),
    modelId: selection.modelId,
    modelLabel: boundedLabel(candidate.modelLabel, selection.modelId),
    efforts: candidate.efforts.filter((effort) => THINKING_EFFORTS.includes(effort)),
  };
}

export function advisorCandidatesFromProviders(providers: readonly Provider[]): AdvisorCandidate[] {
  const candidates: AdvisorCandidate[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (provider.needsKey && !provider.hasKey) continue;
    const models = [...provider.models].sort((left, right) => {
      if (left === provider.defaultModel) return -1;
      if (right === provider.defaultModel) return 1;
      return 0;
    });
    for (const modelId of models) {
      const selection = parseAdvisorSelection({ providerId: provider.id, modelId });
      if (!selection) continue;
      const key = advisorCandidateKey(selection);
      if (seen.has(key)) continue;
      const metadata = provider.modelMetadata?.[modelId];
      if (isNonChatModel({ model: modelId, metadataType: metadata?.type })) continue;
      seen.add(key);
      const efforts = (metadata?.thinkingLevels ?? []).filter(
        (level): level is Exclude<GenerationThinkingLevel, "off"> => level !== "off",
      );
      const candidate = normalizeAdvisorCandidate({
        providerId: provider.id,
        providerLabel: provider.label,
        modelId,
        modelLabel: metadata?.name?.trim() || modelId,
        efforts,
      });
      if (!candidate) continue;
      candidates.push(candidate);
      if (candidates.length >= MAX_ADVISOR_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

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

export interface AdvisorRuntimeDependencies {
  attempts: AdvisorAttemptStore;
  listCandidates(): Promise<readonly AdvisorCandidate[]>;
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
  requestQuestionnaire?(
    toolCallId: string,
    questions: AskUserQuestionV1[],
    signal?: AbortSignal,
  ): Promise<AskUserQuestionResponseV1>;
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
  if (runtime.provider.id !== selection.providerId || runtime.model.id !== selection.modelId) {
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

function boundedUniqueLabel(
  value: string,
  suffix: string,
  maximum = ASK_USER_MAX_LABEL_LENGTH,
): string {
  const suffixPoints = Array.from(suffix);
  const available = Math.max(1, maximum - suffixPoints.length);
  return `${Array.from(value).slice(0, available).join("")}${suffix}`;
}

function advisorCandidateKey(candidate: Pick<AdvisorCandidate, "providerId" | "modelId">): string {
  return JSON.stringify([candidate.providerId, candidate.modelId]);
}

function candidateShorthand(candidate: AdvisorCandidate): string {
  return `${candidate.providerId}/${candidate.modelId}`;
}

function candidateDescriptor(candidate: Pick<AdvisorCandidate, "providerId" | "modelId">): string {
  return `providerId=${JSON.stringify(candidate.providerId)} modelId=${JSON.stringify(candidate.modelId)}`;
}

export function advisorCandidateShortlist(
  candidates: readonly AdvisorCandidate[],
  executor: AdvisorExtensionInput["executor"],
  partial: { providerId?: string; modelId?: string } = {},
): AdvisorCandidate[] {
  const seen = new Set<string>();
  const matching = candidates.filter((candidate) => {
    if (partial.providerId && candidate.providerId !== partial.providerId) return false;
    if (partial.modelId && candidate.modelId !== partial.modelId) return false;
    const key = advisorCandidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const alternatives = matching.filter(
    (candidate) =>
      candidate.providerId !== executor.providerId || candidate.modelId !== executor.modelId,
  );
  const current = matching.filter(
    (candidate) =>
      candidate.providerId === executor.providerId && candidate.modelId === executor.modelId,
  );
  return [...alternatives, ...current].slice(0, MAX_ADVISOR_QUESTION_OPTIONS);
}

function questionnaireSelection(
  response: AskUserQuestionResponseV1,
  choices: ReadonlyMap<string, AdvisorCandidate>,
  candidates: readonly AdvisorCandidate[],
  effort: AdvisorSelectionV1["effort"],
): AdvisorSelectionV1 | null {
  if (response.cancelled) return null;
  const answer = response.answers.find((entry) => entry.questionIndex === 0);
  if (!answer || answer.kind === "multi") return null;
  if (answer.kind === "option") {
    const candidate = choices.get(answer.answer);
    return candidate
      ? {
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          ...(effort ? { effort } : {}),
        }
      : null;
  }
  const custom = answer.answer.trim();
  const shorthandMatches = candidates.filter(
    (candidate) =>
      custom.localeCompare(candidateShorthand(candidate), undefined, {
        sensitivity: "accent",
      }) === 0,
  );
  if (shorthandMatches.length === 1) {
    const candidate = shorthandMatches[0]!;
    return {
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      ...(effort ? { effort } : {}),
    };
  }
  if (shorthandMatches.length > 1) return null;
  try {
    const tuple = JSON.parse(custom) as unknown;
    if (Array.isArray(tuple) && tuple.length === 2) {
      return (
        parseAdvisorSelection({
          providerId: tuple[0],
          modelId: tuple[1],
          ...(effort ? { effort } : {}),
        }) ?? null
      );
    }
  } catch {
    // Preserve the convenient provider/model shorthand below.
  }
  const slash = custom.indexOf("/");
  return slash > 0 && slash === custom.lastIndexOf("/")
    ? (parseAdvisorSelection({
        providerId: custom.slice(0, slash).trim(),
        modelId: custom.slice(slash + 1).trim(),
        ...(effort ? { effort } : {}),
      }) ?? null)
    : null;
}

async function chooseAdvisorSelection(
  parameters: unknown,
  candidates: readonly AdvisorCandidate[],
  input: AdvisorExtensionInput,
  toolCallId: string,
  signal?: AbortSignal,
): Promise<AdvisorSelectionV1 | null> {
  const direct = parseAdvisorSelection(parameters);
  if (direct) return direct;
  const partial =
    parameters && typeof parameters === "object" && !Array.isArray(parameters)
      ? (parameters as { providerId?: unknown; modelId?: unknown; effort?: unknown })
      : {};
  const hasProviderId = partial.providerId !== undefined;
  const hasModelId = partial.modelId !== undefined;
  // A malformed or partial exact request must fail closed. The chooser is only
  // for calls that omitted both identity fields.
  if (hasProviderId || hasModelId || !input.requestQuestionnaire) return null;
  const providerId = typeof partial.providerId === "string" ? partial.providerId : undefined;
  const modelId = typeof partial.modelId === "string" ? partial.modelId : undefined;
  const effort = THINKING_EFFORTS.find((candidate) => candidate === partial.effort);
  const shortlist = advisorCandidateShortlist(candidates, input.executor, { providerId, modelId });
  if (shortlist.length === 0) return null;
  const labels = new Set<string>(["Continue without Advisor", "Other", "Type something.", "Next"]);
  const choices = new Map<string, AdvisorCandidate>();
  const options = shortlist.map((candidate, index) => {
    const baseLabel = boundedLabel(
      `${candidate.providerLabel} · ${candidate.modelLabel}`,
      candidateDescriptor(candidate),
    );
    let label = baseLabel;
    let suffix = index + 2;
    while (labels.has(label)) {
      label = boundedUniqueLabel(baseLabel, ` · ${suffix}`);
      suffix += 1;
    }
    labels.add(label);
    choices.set(label, candidate);
    return {
      label,
      description: `${candidateDescriptor(candidate)} · One tool-free reviewer request.`,
    };
  });
  if (options.length === 1) {
    options.push({
      label: "Continue without Advisor",
      description: "Skip this consultation and let the active model continue on its own.",
    });
  }
  const questions = parseAskUserQuestions([
    {
      question: `Which provider and model should Aiden use for this one Advisor consultation? ${ADVISOR_TRANSFER_NOTICE}`,
      header: "Advisor model",
      multiSelect: false,
      options,
    },
  ]);
  if (!questions) return null;
  const response = await input.requestQuestionnaire(toolCallId, questions, signal);
  return questionnaireSelection(response, choices, candidates, effort);
}

function executorPrompt(candidates: readonly AdvisorCandidate[], canAskUser: boolean): string {
  const catalog = candidates
    .slice(0, MAX_ADVISOR_PROMPT_CANDIDATES)
    .map((candidate) => `- ${candidateDescriptor(candidate)}`)
    .join("\n");
  const selectionGuidance = canAskUser
    ? "If the latest user request explicitly names an available reviewer provider and model, first state the Advisor transfer notice visibly, then pass both exact IDs to advisor. Otherwise call advisor without either ID: Aiden will pause and use Ask User Question so the user chooses for this consultation."
    : "This surface cannot show the Advisor model chooser. Call advisor only when the latest user request explicitly names both exact reviewer IDs; first state the Advisor transfer notice visibly, then pass both IDs. Otherwise do not call advisor.";
  const omitted = Math.max(0, candidates.length - MAX_ADVISOR_PROMPT_CANDIDATES);
  const omittedNotice = omitted > 0 ? `\n- …and ${omitted} more configured targets` : "";
  return `${ADVISOR_EXECUTOR_GUIDANCE}\n\nAdvisor transfer notice: ${ADVISOR_TRANSFER_NOTICE}\n\n${selectionGuidance}\n\nConfigured reviewer targets (exact provider/model IDs):\n${catalog}${omittedNotice}`;
}

export class AdvisorRuntime {
  private attemptsInitializePromise: Promise<void> | undefined;

  constructor(private readonly dependencies: AdvisorRuntimeDependencies) {}

  initialize(): Promise<void> {
    this.attemptsInitializePromise ??= this.dependencies.attempts.initialize();
    return this.attemptsInitializePromise;
  }

  async extensionForGeneration(
    input: AdvisorExtensionInput,
  ): Promise<PiAgentRuntimeExtension | null> {
    if (!advisorAllowedForGeneration(input.scope)) return null;
    let candidates: readonly AdvisorCandidate[];
    try {
      const seen = new Set<string>();
      candidates = (await this.dependencies.listCandidates())
        .map(normalizeAdvisorCandidate)
        .filter((candidate): candidate is AdvisorCandidate => {
          if (!candidate) return false;
          const key = advisorCandidateKey(candidate);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, MAX_ADVISOR_CANDIDATES);
    } catch (error) {
      this.dependencies.reportFailure?.("catalog", error);
      return null;
    }
    if (candidates.length === 0) return null;
    try {
      await this.initialize();
    } catch (error) {
      this.dependencies.reportFailure?.("journal", error);
      return null;
    }

    let used = false;
    const effortSchema = Type.Union(THINKING_EFFORTS.map((effort) => Type.Literal(effort)));
    const tool = declarePiRuntimeReplay(
      {
        name: ADVISOR_TOOL_NAME,
        label: "Advisor",
        description:
          "Request one tool-free second opinion. Pass providerId and modelId only when the user explicitly named the reviewer; otherwise omit them and Aiden will ask the user to choose through Ask User Question.",
        parameters: Type.Object(
          {
            providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
            modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
            effort: Type.Optional(effortSchema),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential" as const,
        execute: async (
          toolCallId: string,
          parameters: unknown,
          signal?: AbortSignal,
          onUpdate?: AgentToolUpdateCallback<AdvisorToolDetails>,
        ): Promise<AgentToolResult<AdvisorToolDetails>> => {
          if (used) {
            return normalResult("The advisor is limited to one consultation in this response.", {
              status: "blocked",
            });
          }
          used = true;
          const selection = await chooseAdvisorSelection(
            parameters,
            candidates,
            input,
            toolCallId,
            signal,
          );
          if (!selection) {
            return normalResult(
              "The user did not choose an advisor provider and model. Continue without a consultation and do not ask again in this response.",
              { status: signal?.aborted ? "cancelled" : "blocked" },
            );
          }
          const advisorLabel = candidateDescriptor(selection);
          onUpdate?.(
            normalResult(`Consulting ${selection.modelId}… ${ADVISOR_TRANSFER_NOTICE}`, {
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
              "The selected advisor model is unavailable. Continue without it and tell the user they may need to reconnect or choose another reviewer.",
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
            else {
              await this.dependencies.recordUnreportedUsage(
                runtime,
                state === "cancelled" ? "cancelled" : "failed",
              );
            }
            await this.dependencies.attempts.markUsageRecorded(attemptId);
          } catch (error) {
            this.dependencies.reportFailure?.("usage", error);
          }

          if (state === "completed" && response) {
            return normalResult(
              `Advisor transfer notice for the visible reply: ${ADVISOR_TRANSFER_NOTICE}\n\nAdvisor guidance:\n${textFrom(response)}`,
              {
                status: "completed",
                advisorModel: advisorLabel,
                ...(selection.effort ? { effort: selection.effort } : {}),
              },
            );
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
      systemPrompt: executorPrompt(candidates, input.requestQuestionnaire !== undefined),
      tools: [tool],
    };
  }
}
