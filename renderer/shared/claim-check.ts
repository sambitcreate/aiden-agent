import {
  isToolStep,
  type AgentToolStep,
  type GenerationClaimCheck,
  type GenerationTimeline,
} from "./generation-timeline.js";

type ConsequentialStepKind = "file" | "command" | "computer" | "schedule" | "connector";
type SuccessClaimKind = ConsequentialStepKind | "generic";

interface SuccessClaim {
  index: number;
  kind: SuccessClaimKind;
}

const SUCCESS_PATTERNS: Array<{ kind: SuccessClaimKind; pattern: RegExp }> = [
  { kind: "generic", pattern: /^(?:[-*]\s*)?(?:all\s+)?done\b/gimu },
  {
    kind: "generic",
    pattern:
      /\b(?:the\s+)?(?:task|request|work|fix|implementation)\s+(?:is|was|has been)\s+(?:now\s+)?(?:done|complete|completed|finished|fixed|implemented|resolved)\b/giu,
  },
  {
    kind: "generic",
    pattern:
      /\b(?:i|we)(?:['’]ve| have)?\s+(?:successfully\s+)?(?:completed|finished|fixed|implemented|resolved)\s+(?:the\s+)?(?:task|request|work|change|fix|issue|implementation)\b/giu,
  },
  {
    kind: "file",
    pattern:
      /\b(?:i|we)(?:['’]ve| have)?\s+(?:successfully\s+)?(?:updated|created|saved|applied|wrote|edited|fixed|implemented)\s+(?:it|them|(?:the\s+)?(?:files?|changes?|fix|docs?|code|config(?:uration)?))\b/giu,
  },
  {
    kind: "file",
    pattern:
      /^(?:[-*]\s*)?(?:changes?|files?|docs?|code|config(?:uration)?)\s+(?:successfully\s+)?(?:updated|created|saved|fixed|applied|completed)\b/gimu,
  },
  {
    kind: "command",
    pattern:
      /\b(?:tests?|checks?|build|lint|type[- ]?check|command)\s+(?:all\s+)?(?:pass(?:ed|es)?|succeeded|completed|finished)\b/giu,
  },
  {
    kind: "command",
    pattern:
      /\b(?:i|we)(?:['’]ve| have)?\s+(?:successfully\s+)?ran\s+(?:the\s+)?(?:tests?|checks?|build|lint|type[- ]?check|command)\b/giu,
  },
  {
    kind: "schedule",
    pattern:
      /\b(?:i|we)(?:['’]ve| have)?\s+(?:successfully\s+)?(?:scheduled|created|paused|resumed|removed)\s+(?:the\s+)?(?:scheduled\s+)?task\b/giu,
  },
  {
    kind: "computer",
    pattern:
      /\b(?:i|we)(?:['’]ve| have)?\s+(?:successfully\s+)?(?:opened|clicked|typed|selected|dragged|scrolled)\s+(?:it|the\s+(?:app|button|field|window|item|page))\b/giu,
  },
];

const FAILURE_MARKER = String.raw`(?:fail(?:ed|ure)?|blocked|denied|cancelled|canceled|unable to|could not|couldn't|did not|didn't|not)`;

const ACKNOWLEDGEMENT_ACTIONS: Record<ConsequentialStepKind, string> = {
  file: String.raw`(?:edit(?:ed|ing)?|writ(?:e|ten|ing)|updat(?:e|ed|ing)|sav(?:e|ed|ing)|appl(?:y|ied|ying)|files?|changes?|docs?|code|config(?:uration)?)`,
  command: String.raw`(?:tests?|checks?|build|lint|type[- ]?check|commands?|run|execution)`,
  computer: String.raw`(?:computer|mac|app|button|field|window|click|typ(?:e|ed|ing)|drag|scroll|selection?)`,
  schedule: String.raw`(?:schedul(?:e|ed|ing)|tasks?|cron|run)`,
  connector: String.raw`(?:mcp|connector|tools?|calls?)`,
};

const acknowledgementPatterns = new Map<ConsequentialStepKind, RegExp[]>();

function patternsForAcknowledgement(kind: ConsequentialStepKind): RegExp[] {
  const existing = acknowledgementPatterns.get(kind);
  if (existing) return existing;
  const action = ACKNOWLEDGEMENT_ACTIONS[kind];
  const patterns = [
    new RegExp(String.raw`\b${action}\b(?:\s+\w+){0,3}\s+\b${FAILURE_MARKER}\b`, "giu"),
    new RegExp(String.raw`\b${FAILURE_MARKER}\b(?:\s+\w+){0,3}\s+\b${action}\b`, "giu"),
    new RegExp(
      String.raw`\bno\s+(?:\w+\s+){0,3}${action}\b[^.!?\n]{0,32}\b(?:succeeded|completed|finished|updated|saved|applied|ran)\b`,
      "giu",
    ),
  ];
  acknowledgementPatterns.set(kind, patterns);
  return patterns;
}

function successClaims(text: string): SuccessClaim[] {
  const claims: SuccessClaim[] = [];
  for (const { kind, pattern } of SUCCESS_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      claims.push({ index: match.index, kind });
    }
  }
  return claims;
}

function consequentialStepKind(step: AgentToolStep): ConsequentialStepKind | undefined {
  if (step.status !== "failed" && step.status !== "blocked" && step.status !== "cancelled") {
    return undefined;
  }
  switch (step.toolName) {
    case "write_file":
    case "edit_file":
      return "file";
    case "run_command":
      return "command";
    case "computer_use":
      return "computer";
    case "schedule_task":
      return "schedule";
    default:
      return step.toolName.includes("__") ? "connector" : undefined;
  }
}

function lastAcknowledgementIndex(text: string, kind: ConsequentialStepKind): number {
  let latest = -1;
  for (const pattern of patternsForAcknowledgement(kind)) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      latest = Math.max(latest, match.index);
    }
  }
  return latest;
}

/**
 * Detect narrow false-success cases from renderer-safe evidence only.
 * A later acknowledgement suppresses only the failed action it actually names.
 */
export function detectUnverifiedSuccessClaim(
  assistantText: string,
  timeline: GenerationTimeline,
): GenerationClaimCheck | undefined {
  if (timeline.status === "running") return undefined;
  const claims = successClaims(assistantText);
  const stepIds: string[] = [];

  for (const step of timeline.steps) {
    if (!isToolStep(step)) continue;
    const kind = consequentialStepKind(step);
    if (!kind) continue;
    const latestRelevantClaim = claims.reduce(
      (latest, claim) =>
        claim.kind === "generic" || claim.kind === kind ? Math.max(latest, claim.index) : latest,
      -1,
    );
    if (
      latestRelevantClaim >= 0 &&
      lastAcknowledgementIndex(assistantText, kind) <= latestRelevantClaim
    ) {
      stepIds.push(step.id);
      if (stepIds.length === 20) break;
    }
  }

  return stepIds.length
    ? {
        kind: "unverified_success",
        stepIds,
      }
    : undefined;
}

export function attachClaimCheck(
  timeline: GenerationTimeline,
  assistantText: string,
): GenerationTimeline {
  const claimCheck = detectUnverifiedSuccessClaim(assistantText, timeline);
  return claimCheck ? { ...timeline, claimCheck } : timeline;
}
