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
 * True when every thinking step carries valid, ordered, non-overlapping
 * `reasoningStart`/`reasoningEnd` bounds into the reasoning buffer and those
 * bounds cover all of the buffer's non-whitespace text. Anything partial —
 * missing bounds, out-of-order starts, uncovered reasoning — fails closed so
 * the caller renders the legacy single ReasoningBlock instead of mis-slicing
 * or dropping provider-exposed reasoning.
 */
export function hasValidReasoningSegments(
  timeline: GenerationTimeline | null | undefined,
  reasoning: string | null | undefined,
): boolean {
  if (!timeline) return false;
  const thinkingSteps = timeline.steps.filter(
    (step): step is AgentThinkingStep => !isToolStep(step),
  );
  if (!thinkingSteps.length) return false;
  const buffer = reasoning ?? "";
  let cursor = 0;
  for (const step of thinkingSteps) {
    const start = step.reasoningStart;
    const end = step.reasoningEnd;
    if (
      !Number.isSafeInteger(start) ||
      (start as number) < 0 ||
      (start as number) > buffer.length
    ) {
      return false;
    }
    if (end !== undefined && (!Number.isSafeInteger(end) || (end as number) < (start as number))) {
      return false;
    }
    if ((end as number | undefined) !== undefined && (end as number) > buffer.length) return false;
    if ((start as number) < cursor) return false;
    // Reasoning between segments must be whitespace separators only — real
    // text outside every segment belongs to the legacy single block.
    if (buffer.slice(cursor, start).trim()) return false;
    // An open stretch anchors at its start and covers the streamed tail.
    cursor = end === undefined ? buffer.length : end;
  }
  return !buffer.slice(cursor).trim();
}

/**
 * Slice one thinking segment out of the canonical reasoning buffer. Returns
 * undefined for missing or invalid bounds rather than guessing at text.
 */
export function reasoningSegmentText(
  reasoning: string | null | undefined,
  step: AgentThinkingStep,
): string | undefined {
  const start = step.reasoningStart;
  if (!Number.isSafeInteger(start) || (start as number) < 0) return undefined;
  const buffer = reasoning ?? "";
  const end = step.reasoningEnd ?? buffer.length;
  if (
    !Number.isSafeInteger(end) ||
    (end as number) < (start as number) ||
    (end as number) > buffer.length
  ) {
    return undefined;
  }
  return buffer.slice(start as number, end as number);
}

/**
 * Rebuild the chronological visible response from renderer-safe text offsets.
 * Legacy or malformed timelines return null so callers can retain the prior
 * activity-first layout without guessing where private Pi events belonged.
 *
 * When the timeline's thinking steps carry valid reasoning segment bounds
 * (`hasValidReasoningSegments`), thinking stays in step order inside the
 * activity rows so the transcript reads think → tool → think. Otherwise the
 * steps collapse back to tools-only, and the message-level reasoning block
 * keeps legacy messages identical to before.
 */
export function assistantPresentationRows(
  content: string,
  reasoning: string | null | undefined,
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

  const segmented = hasValidReasoningSegments(timeline, reasoning);
  // Exposed reasoning without segment bounds keeps one dedicated disclosure.
  // Thinking milestones still anchor and time the host timeline, but rendering
  // them as separate rows would repeat the same phase as extra "Thinking" /
  // "Thought" activity entries.
  const visibleSteps = segmented ? timeline.steps : timeline.steps.filter(isToolStep);

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
