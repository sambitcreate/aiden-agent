import { isActiveStep } from "./agent-steps";
import {
  isToolStep,
  type AgentStep,
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

  // Exposed reasoning has one dedicated disclosure. Thinking milestones still
  // anchor and time the host timeline, but rendering them here would repeat the
  // same phase as a second "Thinking" / "Thought" activity row.
  const visibleSteps = timeline.steps.filter(isToolStep);

  const rows: AssistantPresentationRow[] = [];
  let cursor = 0;
  let stepIndex = 0;
  while (stepIndex < visibleSteps.length) {
    const offset = visibleSteps[stepIndex]?.contentOffset as number;
    const narrative = textRow(content, cursor, offset);
    if (narrative) rows.push(narrative);

    const steps: AgentStep[] = [];
    while (stepIndex < visibleSteps.length && visibleSteps[stepIndex]?.contentOffset === offset) {
      const step = visibleSteps[stepIndex];
      if (step) steps.push(step);
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
