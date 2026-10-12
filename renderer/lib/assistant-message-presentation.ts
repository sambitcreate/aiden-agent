import { isActiveStep } from "./agent-steps";
import {
  isToolStep,
  type AgentStep,
  type AgentToolStep,
  type GenerationClaimCheck,
  type GenerationTimeline,
} from "../shared/generation-timeline";

/** A settled `ask_user_question` step that carries the owner's choices. */
export type QuestionnaireStep = AgentToolStep & {
  questionnaire: NonNullable<AgentToolStep["questionnaire"]>;
};

/**
 * Answered questionnaires read as their recap, not as an activity line, so
 * they leave the activity group and its tool-call tally.
 */
export function isQuestionnaireStep(step: AgentStep): step is QuestionnaireStep {
  return isToolStep(step) && step.questionnaire !== undefined;
}

export type AssistantPresentationRow =
  | {
      key: string;
      kind: "text";
      content: string;
      startOffset: number;
      endOffset: number;
    }
  | {
      key: string;
      kind: "activity";
      contentOffset: number;
      steps: AgentStep[];
    }
  | {
      key: string;
      kind: "reasoning";
      content: string;
      step: Extract<AgentStep, { kind: "thinking" }>;
    }
  | {
      key: string;
      kind: "questionnaire";
      step: QuestionnaireStep;
    };

function textRow(
  content: string,
  startOffset: number,
  endOffset: number,
): AssistantPresentationRow | undefined {
  const slice = content.slice(startOffset, endOffset);
  if (!slice.trim()) return undefined;
  return {
    // The tail end grows on every stream delta; key only by its stable boundary
    // so StreamingMarkdownReveal is not remounted for each token.
    key: `text-${startOffset}`,
    kind: "text",
    content: slice,
    startOffset,
    endOffset,
  };
}

/**
 * Rebuild the chronological visible response from renderer-safe text offsets.
 * Legacy or malformed timelines return null so callers can retain the prior
 * activity-first layout without guessing where private Pi events belonged.
 */
export function assistantPresentationRows(
  content: string,
  timeline: GenerationTimeline | null | undefined,
  reasoning = "",
): AssistantPresentationRow[] | null {
  if (!timeline?.steps.length) return null;
  const offsets = timeline.steps.map((step) => step.contentOffset);
  if (
    offsets.some(
      (offset, index) =>
        !Number.isSafeInteger(offset) ||
        (offset as number) < 0 ||
        (offset as number) > content.length ||
        (index > 0 && (offset as number) < (offsets[index - 1] as number)),
    )
  ) {
    return null;
  }

  let reasoningCursor = 0;
  let hasReasoningSpan = false;
  for (const step of timeline.steps) {
    if (isToolStep(step) || step.reasoningStartOffset === undefined) continue;
    const end = step.reasoningEndOffset ?? (step.finishedAt === undefined ? reasoning.length : undefined);
    if (
      !Number.isSafeInteger(step.reasoningStartOffset) ||
      !Number.isSafeInteger(end) ||
      step.reasoningStartOffset < reasoningCursor ||
      (end as number) < step.reasoningStartOffset ||
      (end as number) > reasoning.length ||
      reasoning.slice(reasoningCursor, step.reasoningStartOffset).trim()
    ) return null;
    reasoningCursor = end as number;
    hasReasoningSpan = true;
  }
  if (reasoning && (!hasReasoningSpan || reasoning.slice(reasoningCursor).trim())) return null;

  const visibleSteps = timeline.steps;
  const rows: AssistantPresentationRow[] = [];
  let cursor = 0;
  let stepIndex = 0;
  while (stepIndex < visibleSteps.length) {
    const step = visibleSteps[stepIndex]!;
    const offset = step.contentOffset as number;
    const narrative = textRow(content, cursor, offset);
    if (narrative) rows.push(narrative);
    if (!isToolStep(step)) {
      const start = step.reasoningStartOffset;
      const end = step.reasoningEndOffset ?? (step.finishedAt === undefined ? reasoning.length : undefined);
      rows.push({
        key: `reasoning-${step.id}`,
        kind: "reasoning",
        content: start !== undefined && end !== undefined ? reasoning.slice(start, end) : "",
        step,
      });
      stepIndex += 1;
      cursor = offset;
      continue;
    }
    if (isQuestionnaireStep(step)) {
      rows.push({ key: `questionnaire-${step.id}`, kind: "questionnaire", step });
      stepIndex += 1;
      cursor = offset;
      continue;
    }
    const steps: AgentStep[] = [];
    while (
      stepIndex < visibleSteps.length &&
      isToolStep(visibleSteps[stepIndex]!) &&
      !isQuestionnaireStep(visibleSteps[stepIndex]!) &&
      visibleSteps[stepIndex]!.contentOffset === offset
    ) steps.push(visibleSteps[stepIndex++]!);
    rows.push({
      key: `activity-${offset}-${steps[0]?.id ?? stepIndex}`,
      kind: "activity",
      contentOffset: offset,
      steps,
    });
    cursor = offset;
  }

  const tail = textRow(content, cursor, content.length);
  if (tail) rows.push(tail);
  return rows;
}

/** Limit one ActivityFeed instance to the steps rendered at a text boundary. */
export function activityTimelineFragment(
  timeline: GenerationTimeline,
  steps: AgentStep[],
): GenerationTimeline {
  const running = timeline.status === "running" && steps.some(isActiveStep);
  const stepIds = new Set(steps.map((step) => step.id));
  const claimStepIds = timeline.claimCheck?.stepIds.filter((id) => stepIds.has(id)) ?? [];
  const claimCheck: GenerationClaimCheck | undefined = claimStepIds.length
    ? { kind: "unverified_success", stepIds: claimStepIds }
    : undefined;
  return {
    ...timeline,
    status: running ? "running" : timeline.status === "running" ? "completed" : timeline.status,
    ...(running
      ? { finishedAt: undefined }
      : {
          finishedAt:
            timeline.finishedAt ?? steps[steps.length - 1]?.updatedAt ?? timeline.startedAt,
        }),
    steps,
    ...(claimCheck ? { claimCheck } : { claimCheck: undefined }),
  };
}
