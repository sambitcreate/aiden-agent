/**
 * Core Auto Router routing engine.
 *
 * Lightweight, zero-latency local heuristic classifier and multi-objective scorer
 * balancing Artificial Analysis benchmark scores, cost per task (local models free),
 * inference speed, and modality requirements (vision, context length).
 *
 * Adheres strictly to offline security: never contacts external benchmark APIs
 * or sends prompts to benchmark endpoints.
 */

import type { AutoRouterPreset, AutoRouterSettings } from "./types.js";

export function parseAutoRouterSetting(value: unknown): AutoRouterSettings {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid autoRouter setting.");
  }
  const rawAuto = value as Record<string, unknown>;
  const preset =
    rawAuto.preset === "cost" || rawAuto.preset === "capability" || rawAuto.preset === "balanced"
      ? rawAuto.preset
      : "balanced";
  const excludedModels = Array.isArray(rawAuto.excludedModels)
    ? rawAuto.excludedModels.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    preset,
    ...(excludedModels ? { excludedModels } : {}),
  };
}

export type ComplexityTier = 1 | 2 | 3 | 4;

export interface TaskClassification {
  isCoding: boolean;
  tier: ComplexityTier;
  tierLabel: "Trivial" | "Moderate" | "High Complexity" | "Critical";
  requiresVision: boolean;
  estimatedTokens: {
    input: number;
    output: number;
  };
  signals: string[];
}

export interface AutoRouterCandidate {
  providerId: string;
  model: string;
  label?: string;
  providerLabel?: string;
  isLocal: boolean;
  isUsable: boolean;
  info?: {
    vision?: boolean;
    contextLength?: number;
    benchmark?: {
      intelligence?: number;
      coding?: number;
      agentic?: number;
    };
    ranking?: {
      capabilityPercentile?: number;
      responseTimePercentile?: number;
    };
    cost?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    inputModalities?: string[];
  };
  placement?: {
    x: number; // 0 = fast (left), 1 = deliberate (right)
    y: number; // 0 = everyday (bottom), 1 = advanced (top)
  };
}

export interface ScoringWeights {
  wBench: number;
  wCost: number;
  wSpeed: number;
}

export interface AutoRouteResolution {
  providerId: string;
  model: string;
  score: number;
  classification: TaskClassification;
  reason: string;
  candidateCount: number;
  scoresByModel?: Record<
    string,
    { total: number; bench: number; cost: number; speed: number }
  >;
}

const FAST_VARIANT_RE =
  /(?:^|[\s._/-])(nano|tiny|mini|small|haiku|flash|lite|instant)(?:$|[\s._/-])/i;
const DEEP_VARIANT_RE =
  /(?:^|[\s._/-])(reasoner|reasoning|thinking|think|deep|high|xhigh|opus)(?:$|[\s._/-])/i;

const CODING_KEYWORDS_RE =
  /\b(refactor|debug|debugging|implement|implementation|fix|bug|issue|error|exception|stack trace|stacktrace|typescript|javascript|python|rust|golang|react|redux|vue|angular|svelte|regex|regular expression|sql|query|database|endpoint|api|json|yaml|html|css|tailwind|function|method|class|component|hook|props|interface|type definition|enum|struct|async|await|promise|callback|git|diff|pull request|pr|merge|commit|compile|compiler|transpile|lint|eslint|unit test|integration test|mock|stub|segfault|segmentation fault|memory leak|heap|garbage collection|deadlock|race condition|mutex|concurrency|multithreading|thread|coroutine|algorithm|data structure|binary tree|recursion|big o|benchmark|optimization|profiling)\b/i;

const CRITICAL_KEYWORDS_RE =
  /\b(system architecture|architecture design|security audit|vulnerability|cve|penetration test|pen test|exploit|threat model|zero downtime|migration strategy|database migration|microservices|distributed system|raft|paxos|consensus|fault tolerance|sharding|cryptography|zero-knowledge|formal verification|high availability|disaster recovery|distributed lock)\b/i;

const HIGH_COMPLEXITY_KEYWORDS_RE =
  /\b(refactor|deadlock|race condition|memory leak|performance bottleneck|concurrency|multithread|async\/await|thread safety|recursive algorithm|dynamic programming|distributed|complex logic|stack trace|segmentation fault|null pointer|type error|reverse engineer|decompil)\b/i;

const TRIVIAL_PATTERNS_RE =
  /^(hi|hello|hey|greetings|good morning|good afternoon|good evening|howdy|yo|sup|thanks|thank you|who are you|what can you do|what is 2\s*[\+\-\*\/]\s*2|tell me a joke|write a haiku|what is the capital of [a-z\s]+|explain [a-z\s]+ in simple terms|what does [a-z0-9]+ stand for)\??$/i;

/** Check if attachments require vision capability. */
export function promptRequiresVision(attachments?: readonly unknown[]): boolean {
  if (!attachments || attachments.length === 0) return false;
  return attachments.some((att) => {
    if (!att || typeof att !== "object") return false;
    const a = att as Record<string, unknown>;
    if (a.kind === "image") return true;
    const mime = typeof a.mimeType === "string" ? a.mimeType.toLowerCase() : "";
    if (mime.startsWith("image/")) return true;
    if (typeof a.data === "string" && a.data.length > 0 && !a.text) return true;
    return false;
  });
}

/**
 * Evaluates the prompt text and attachments to determine coding task importance,
 * required capabilities, and estimated token usage.
 */
export function classifyTask(
  prompt: string,
  attachments?: readonly unknown[],
): TaskClassification {
  const trimmed = (prompt ?? "").trim();
  const requiresVision = promptRequiresVision(attachments);
  const signals: string[] = [];

  if (requiresVision) {
    signals.push("image-attachments");
  }

  const hasCodeBlocks = /```[\s\S]*?```/u.test(trimmed);
  if (hasCodeBlocks) signals.push("code-blocks");

  const hasCodeSyntax =
    /\b(const|let|var|function|class|import|export|def|return|impl|fn|pub|async|await)\b/u.test(
      trimmed,
    ) || /=>|[{}\[\];]{2,}/u.test(trimmed);
  if (hasCodeSyntax) signals.push("code-syntax");

  const hasCodingKeywords = CODING_KEYWORDS_RE.test(trimmed);
  if (hasCodingKeywords) signals.push("coding-keywords");

  const hasCriticalKeywords = CRITICAL_KEYWORDS_RE.test(trimmed);
  if (hasCriticalKeywords) signals.push("critical-architecture-keywords");

  const hasHighComplexity = HIGH_COMPLEXITY_KEYWORDS_RE.test(trimmed);
  if (hasHighComplexity) signals.push("high-complexity-keywords");

  const isTrivialMatch = TRIVIAL_PATTERNS_RE.test(trimmed);
  if (isTrivialMatch && !hasCodeBlocks && !hasCodeSyntax) {
    signals.push("trivial-match");
  }

  const isCoding =
    hasCodeBlocks ||
    hasCodeSyntax ||
    hasCodingKeywords ||
    hasCriticalKeywords ||
    hasHighComplexity;

  let tier: ComplexityTier = 2;

  if (hasCriticalKeywords) {
    tier = 4;
  } else if (hasHighComplexity || (hasCodeBlocks && hasCodingKeywords)) {
    tier = 3;
  } else if (
    (isTrivialMatch && !isCoding) ||
    (!isCoding && trimmed.length < 120 && !trimmed.includes("\n"))
  ) {
    tier = 1;
  } else if (isCoding) {
    tier = 2;
  } else {
    // Non-coding general task
    tier = trimmed.length > 500 ? 2 : 1;
  }

  const tierLabels: Record<ComplexityTier, TaskClassification["tierLabel"]> = {
    1: "Trivial",
    2: "Moderate",
    3: "High Complexity",
    4: "Critical",
  };

  const baseInputTokens = Math.max(1, Math.ceil(trimmed.length / 4));
  const estimatedTokensByTier: Record<ComplexityTier, { input: number; output: number }> = {
    1: { input: Math.max(500, baseInputTokens), output: 250 },
    2: { input: Math.max(2000, baseInputTokens), output: 800 },
    3: { input: Math.max(6000, baseInputTokens), output: 2000 },
    4: { input: Math.max(15000, baseInputTokens), output: 4000 },
  };

  return {
    isCoding,
    tier,
    tierLabel: tierLabels[tier],
    requiresVision,
    estimatedTokens: estimatedTokensByTier[tier],
    signals,
  };
}

/**
 * Returns the multi-objective scoring weights based on complexity tier and strategy preset.
 */
export function getRoutingWeights(
  tier: ComplexityTier,
  preset: AutoRouterPreset = "balanced",
): ScoringWeights {
  if (preset === "cost") {
    switch (tier) {
      case 1:
        return { wBench: 0.1, wCost: 0.7, wSpeed: 0.2 };
      case 2:
        return { wBench: 0.25, wCost: 0.55, wSpeed: 0.2 };
      case 3:
        return { wBench: 0.45, wCost: 0.45, wSpeed: 0.1 };
      case 4:
        return { wBench: 0.6, wCost: 0.35, wSpeed: 0.05 };
    }
  }

  if (preset === "capability") {
    switch (tier) {
      case 1:
        return { wBench: 0.4, wCost: 0.3, wSpeed: 0.3 };
      case 2:
        return { wBench: 0.75, wCost: 0.15, wSpeed: 0.1 };
      case 3:
        return { wBench: 0.9, wCost: 0.05, wSpeed: 0.05 };
      case 4:
        return { wBench: 0.95, wCost: 0.025, wSpeed: 0.025 };
    }
  }

  // Default: balanced
  switch (tier) {
    case 1:
      return { wBench: 0.2, wCost: 0.5, wSpeed: 0.3 };
    case 2:
      return { wBench: 0.5, wCost: 0.3, wSpeed: 0.2 };
    case 3:
      return { wBench: 0.75, wCost: 0.15, wSpeed: 0.1 };
    case 4:
      return { wBench: 0.9, wCost: 0.05, wSpeed: 0.05 };
  }
}

/** Calculate normalized benchmark score S_bench in [0, 1]. */
export function computeBenchmarkScore(
  candidate: AutoRouterCandidate,
  isCoding: boolean,
): number {
  const info = candidate.info;
  const benchmark = info?.benchmark;

  if (isCoding) {
    if (typeof benchmark?.coding === "number" && Number.isFinite(benchmark.coding)) {
      const codingNorm = Math.max(0, Math.min(100, benchmark.coding)) / 100;
      const intellNorm =
        typeof benchmark?.intelligence === "number" && Number.isFinite(benchmark.intelligence)
          ? Math.max(0, Math.min(100, benchmark.intelligence)) / 100
          : codingNorm;
      return 0.7 * codingNorm + 0.3 * intellNorm;
    }
    if (typeof benchmark?.intelligence === "number" && Number.isFinite(benchmark.intelligence)) {
      return Math.max(0, Math.min(100, benchmark.intelligence)) / 100;
    }
  } else {
    if (typeof benchmark?.intelligence === "number" && Number.isFinite(benchmark.intelligence)) {
      return Math.max(0, Math.min(100, benchmark.intelligence)) / 100;
    }
    if (typeof benchmark?.coding === "number" && Number.isFinite(benchmark.coding)) {
      return Math.max(0, Math.min(100, benchmark.coding)) / 100;
    }
  }

  // Fallback to capability ranking or Model Pad y-coordinate (capability axis: 0 everyday -> 1 advanced)
  if (typeof candidate.info?.ranking?.capabilityPercentile === "number") {
    return Math.max(0, Math.min(1, candidate.info.ranking.capabilityPercentile));
  }

  if (typeof candidate.placement?.y === "number") {
    return Math.max(0, Math.min(1, candidate.placement.y));
  }

  return 0.5;
}

/** Calculate normalized cost score S_cost in [0, 1]. Local models receive 1.0 (free). */
export function computeCostScore(
  candidate: AutoRouterCandidate,
  estimatedTokens: { input: number; output: number },
): number {
  if (candidate.isLocal) {
    return 1.0;
  }

  const cost = candidate.info?.cost;
  if (!cost) {
    return 0.5; // neutral for unpriced hosted models
  }

  const inputRate =
    typeof cost.input === "number" && Number.isFinite(cost.input) && cost.input >= 0
      ? cost.input
      : 0;
  const outputRate =
    typeof cost.output === "number" && Number.isFinite(cost.output) && cost.output >= 0
      ? cost.output
      : 0;
  const inputCost = (estimatedTokens.input * inputRate) / 1_000_000;
  const outputCost = (estimatedTokens.output * outputRate) / 1_000_000;
  const totalCostUsd = inputCost + outputCost;

  if (totalCostUsd <= 0) return 1.0;

  // S_cost = 1 / (1 + log10(1 + 100 * costUsd)), smoothly mapping cost to [0.05, 1.0]
  const score = 1 / (1 + Math.log10(1 + 100 * totalCostUsd));
  return Math.max(0.05, Math.min(1.0, score));
}

/** Calculate normalized speed score S_speed in [0, 1]. */
export function computeSpeedScore(candidate: AutoRouterCandidate): number {
  // Placement x represents pace: 0 = fast, 1 = deliberate
  const x =
    typeof candidate.placement?.x === "number" && Number.isFinite(candidate.placement.x)
      ? Math.max(0, Math.min(1, candidate.placement.x))
      : 0.5;
  let speed = 1 - x;

  if (FAST_VARIANT_RE.test(candidate.model)) {
    speed += 0.15;
  } else if (DEEP_VARIANT_RE.test(candidate.model)) {
    speed -= 0.15;
  }

  return Math.max(0, Math.min(1, speed));
}

/**
 * Filter candidates to eligible active models:
 * - Provider is authenticated and active (isUsable)
 * - Model is not excluded
 * - Vision supported if prompt has image attachments
 * - Context length accommodates estimated input tokens
 */
export function filterEligibleCandidates(
  candidates: readonly AutoRouterCandidate[],
  classification: TaskClassification,
  excludedModels: readonly string[] = [],
): AutoRouterCandidate[] {
  const excludedSet = new Set(excludedModels);

  return candidates.filter((candidate) => {
    if (!candidate.isUsable) return false;

    const selectionKey = `${candidate.providerId}::${candidate.model}`;
    if (excludedSet.has(selectionKey)) return false;

    if (classification.requiresVision) {
      const supportsVision =
        candidate.info?.vision === true ||
        candidate.info?.inputModalities?.includes("image");
      if (!supportsVision) return false;
    }

    if (
      candidate.info?.contextLength &&
      candidate.info.contextLength < classification.estimatedTokens.input
    ) {
      return false;
    }

    return true;
  });
}

/**
 * Resolve the optimal model for an incoming prompt text and attachments
 * using multi-objective scoring.
 */
export function resolveAutoRoute(input: {
  prompt: string;
  attachments?: readonly unknown[];
  candidates: readonly AutoRouterCandidate[];
  preset?: AutoRouterPreset;
  excludedModels?: readonly string[];
  defaultSelection?: { providerId: string; model: string };
}): AutoRouteResolution {
  const classification = classifyTask(input.prompt, input.attachments);
  const eligible = filterEligibleCandidates(
    input.candidates,
    classification,
    input.excludedModels,
  );

  const defaultResult: AutoRouteResolution = {
    providerId: input.defaultSelection?.providerId ?? "",
    model: input.defaultSelection?.model ?? "",
    score: 0,
    classification,
    reason: "Default fallback (no eligible Model Pad candidate)",
    candidateCount: 0,
  };

  if (eligible.length === 0) {
    return defaultResult;
  }

  const weights = getRoutingWeights(classification.tier, input.preset ?? "balanced");
  const scoresByModel: Record<
    string,
    { total: number; bench: number; cost: number; speed: number }
  > = {};

  let winningCandidate = eligible[0];
  let winningScore = -1;

  for (const candidate of eligible) {
    const sBench = computeBenchmarkScore(candidate, classification.isCoding);
    const sCost = computeCostScore(candidate, classification.estimatedTokens);
    const sSpeed = computeSpeedScore(candidate);

    const total = weights.wBench * sBench + weights.wCost * sCost + weights.wSpeed * sSpeed;

    const modelKey = `${candidate.providerId}::${candidate.model}`;
    scoresByModel[modelKey] = {
      total,
      bench: sBench,
      cost: sCost,
      speed: sSpeed,
    };

    if (total > winningScore) {
      winningScore = total;
      winningCandidate = candidate;
    } else if (Math.abs(total - winningScore) < 0.001) {
      // Tie-breaking: prefer local free model, then higher benchmark score
      if (candidate.isLocal && !winningCandidate.isLocal) {
        winningScore = total;
        winningCandidate = candidate;
      } else if (
        sBench >
        computeBenchmarkScore(winningCandidate, classification.isCoding)
      ) {
        winningScore = total;
        winningCandidate = candidate;
      }
    }
  }

  let reason = `Auto-routed (${classification.tierLabel}`;
  if (classification.isCoding) {
    reason += " Coding";
  }
  if (winningCandidate.isLocal) {
    reason += " · Local Free";
  }
  reason += ")";

  return {
    providerId: winningCandidate.providerId,
    model: winningCandidate.model,
    score: winningScore,
    classification,
    reason,
    candidateCount: eligible.length,
    scoresByModel,
  };
}
