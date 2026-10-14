// A turn's tool steps as the recap shows them (spec §6): merged repeats
// ("Read 6 files"), one deterministic sentence, and failed, refused and
// stopped steps that never look alike.

import {
  botDurationLabel,
  botPhaseWord,
  botStepInfinitive,
  botStepPhrase,
  type BotToolPhase,
} from "../../shared/bot-activity";
import type { BotToolResultStatus } from "../../shared/bot-live";

export type BotRecapStepStatus = BotToolResultStatus | "running";

export interface BotRecapStep {
  id: string;
  kind: BotToolPhase;
  /** Past tense: "Read 1 file". */
  label: string;
  /** Absent when the model gave no description of the action. */
  detail?: string;
  app?: string;
  status: BotRecapStepStatus;
  /** Set on a merged row. */
  count?: number;
}

/** Consecutive successful steps of the same kind (and app) become one row. */
export function mergeBotSteps(steps: readonly BotRecapStep[]): BotRecapStep[] {
  const merged: BotRecapStep[] = [];
  for (const step of steps) {
    const last = merged[merged.length - 1];
    if (last && last.status === "ok" && step.status === "ok" && last.kind === step.kind && last.app === step.app) {
      const { detail: _detail, ...rest } = last;
      const count = (last.count ?? 1) + 1;
      merged[merged.length - 1] = { ...rest, count, label: botStepPhrase(step.kind, count, step.app) };
      continue;
    }
    merged.push(step);
  }
  return merged;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** "read 2 files, searched the web, used Notion": successful steps, grouped in first-seen order. */
function botRecapSentence(steps: readonly BotRecapStep[]): string {
  const groups = new Map<string, { kind: BotToolPhase; app?: string; count: number }>();
  for (const step of steps) {
    if (step.status !== "ok" || step.kind === "waiting") continue;
    const key = `${step.kind}\u0000${step.app ?? ""}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { kind: step.kind, ...(step.app ? { app: step.app } : {}), count: 1 });
  }
  return [...groups.values()].map(({ kind, app, count }) => lowerFirst(botStepPhrase(kind, count, app))).join(", ");
}

export function botRecapHeader(steps: readonly BotRecapStep[], durationMs: number, live: boolean): string {
  const sentence = botRecapSentence(steps);
  const lead = live ? "Working" : `Worked for ${botDurationLabel(durationMs)}`;
  return sentence ? `${lead} · ${sentence}` : lead;
}

/** Failures and refusals are counted apart; a step the person stopped is neither. */
export function botRecapIssues(steps: readonly BotRecapStep[]): { failed: number; blocked: number } {
  return {
    failed: steps.filter((step) => step.status === "failed").length,
    blocked: steps.filter((step) => step.status === "blocked").length,
  };
}

export function botStepLine(step: BotRecapStep): {
  text: string;
  detail?: string;
  tone: "normal" | "warning" | "error";
  active: boolean;
} {
  const detail = step.detail ? { detail: step.detail } : {};
  switch (step.status) {
    case "running":
      return { text: botPhaseWord(step.kind, step.app), ...detail, tone: "normal", active: true };
    case "failed":
      return { text: `Couldn’t ${botStepInfinitive(step.kind, step.app)}`, ...detail, tone: "error", active: false };
    case "blocked":
      return { text: `Blocked: ${botStepInfinitive(step.kind, step.app)}`, ...detail, tone: "warning", active: false };
    case "stopped":
      return { text: `Stopped: ${botStepInfinitive(step.kind, step.app)}`, ...detail, tone: "normal", active: false };
    case "ok":
      return { text: step.label, ...detail, tone: "normal", active: false };
  }
}
