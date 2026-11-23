/**
 * Reads the reviewer's answer. The reviewer is asked for one JSON object,
 * `{"verdict": ..., "reason": ...}`, optionally in a code fence; anything else
 * (prose only, an unknown verdict, an empty reason, `wait` when nothing is
 * running in the background) is no verdict.
 */
import { GOAL_REASON_MAX_CHARS } from "../../../renderer/shared/goal.js";

export const GOAL_VERDICTS = ["done", "blocked", "paused", "wait", "continue"] as const;
export type GoalVerdictKind = (typeof GOAL_VERDICTS)[number];

export interface GoalVerdict {
  verdict: GoalVerdictKind;
  reason: string;
}

export interface GoalVerdictOptions {
  /** `wait` is offered only while the chat's background jobs run. */
  allowWait: boolean;
}

export function parseGoalVerdict(text: string, options: GoalVerdictOptions): GoalVerdict | undefined {
  for (const candidate of verdictCandidates(text)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const verdict = readVerdict(value, options);
    if (verdict) return verdict;
  }
  return undefined;
}

function readVerdict(value: unknown, options: GoalVerdictOptions): GoalVerdict | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const verdict = typeof record.verdict === "string" ? record.verdict.trim().toLowerCase() : "";
  if (!(GOAL_VERDICTS as readonly string[]).includes(verdict)) return undefined;
  if (verdict === "wait" && !options.allowWait) return undefined;
  const reason = typeof record.reason === "string" ? cleanReason(record.reason) : "";
  if (!reason) return undefined;
  return { verdict: verdict as GoalVerdictKind, reason };
}

function cleanReason(value: string): string {
  const text = value.replace(/\s+/gu, " ").trim();
  const chars = [...text];
  return chars.length > GOAL_REASON_MAX_CHARS ? `${chars.slice(0, GOAL_REASON_MAX_CHARS - 1).join("")}…` : text;
}

/** Fenced blocks first, then the widest brace span of the whole answer. */
function verdictCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```[a-zA-Z]*[^\S\n]*\n([\s\S]*?)```/gu)) candidates.push(match[1]!.trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  return candidates;
}
