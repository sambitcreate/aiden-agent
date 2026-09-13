import { isActiveStep } from "./agent-steps";
import {
  isToolStep,
  type AgentStep,
  type AgentThinkingStep,
  type GenerationClaimCheck,
  type GenerationTimeline,
} from "../shared/generation-timeline";

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
      step: AgentThinkingStep;
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

  const rows: AssistantPresentationRow[] = [];
  let cursor = 0;
  let stepIndex = 0;
  while (stepIndex < timeline.steps.length) {
    const step = timeline.steps[stepIndex];
    const offset = step?.contentOffset as number;
    if (step && !isToolStep(step)) {
      const start = step.reasoningStartOffset;
      const end = step.reasoningEndOffset ?? reasoning.length;
      if (
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        (start as number) >= 0 &&
        (end as number) >= (start as number) &&
        (end as number) <= reasoning.length
      ) {
        const thought = reasoning.slice(start, end).trim();
        if (thought) {
          const narrative = textRow(content, cursor, offset);
          if (narrative) rows.push(narrative);
          rows.push({
            key: `reasoning-${step.id}`,
            kind: "reasoning",
            content: thought,
            step,
          });
          cursor = offset;
        }
      }
      stepIndex += 1;
      continue;
    }

    const narrative = textRow(content, cursor, offset);
    if (narrative) rows.push(narrative);
    const steps: AgentStep[] = [];
    while (
      stepIndex < timeline.steps.length &&
      timeline.steps[stepIndex]?.contentOffset === offset &&
      isToolStep(timeline.steps[stepIndex] as AgentStep)
    ) {
      const toolStep = timeline.steps[stepIndex];
      if (toolStep) steps.push(toolStep);
      stepIndex += 1;
    }
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
