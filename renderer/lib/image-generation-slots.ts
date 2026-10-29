// Where a chat's in-flight generate_image call shows its "Lens" placeholder,
// and which arriving image it reveals. Pure: the transcript keeps the returned
// entries between renders.
//
// Contract (shared with the iOS and Android transcripts):
// - A placeholder exists only for a live (streaming) response's timeline tool
//   step with `toolName === "generate_image"` and `status === "running"`. A
//   `pending` step is still receiving its arguments and an `awaiting_approval`
//   step shows the approval card instead; neither shows a placeholder.
// - Its shape comes from the step's `detail`, which carries the call's
//   `aspectRatio` argument when it is one of IMAGE_ASPECT_RATIOS; anything else
//   (or none) is 1:1.
// - A placeholder claims only images placed on its own call: the host sends
//   each image with the public `call-N` id of the call that produced it
//   (`placements`, attachment id → toolCallId). display_image and share_image
//   images carry their own call's id, so no placeholder ever claims them. The first such image is
//   revealed inside the placeholder; the call's other images stay hidden until
//   the reveal ends, then all show as ordinary attachments at the call's row.
// - Once an image arrived the placeholder never returns to scanning, even if
//   the attachment list briefly drops it during the stream handoff. A step
//   that fails, is cancelled, or completes without an image drops it.
// - Settled (persisted) responses never show placeholders.

import type { Attachment } from "./types";
import type { AssistantPresentationRow } from "./assistant-message-presentation";
import { isToolStep, type AgentToolStep, type GenerationTimeline } from "../shared/generation-timeline";
import { placeholderAspectRatio, type ImageAspectRatio } from "../shared/image-generation/placeholder-spec";
import { CURATED_FAL_IMAGE_MODELS, CURATED_REPLICATE_IMAGE_MODELS } from "../shared/image-generation/catalog";
import {
  IMAGE_GENERATION_PROVIDER_NAMES,
  isImageGenerationProviderId,
} from "../shared/image-generation/types";

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

export interface ImageGenerationSlotEntry {
  /** When this transcript first saw the step running (local clock); a fallback start. */
  firstSeenAt: number;
  /** The image being revealed. Kept so a handoff gap never resumes scanning. */
  arrived?: Attachment;
}

export interface ImageGenerationSlot {
  stepId: string;
  /** The timeline's public call id, which anchors the slot at its activity row. */
  toolCallId: string;
  aspectRatio: ImageAspectRatio;
  /** "fal · Nano Banana Pro" when the step names its model. */
  modelLabel?: string;
  startedAt: number;
  /** The generated image being revealed; absent while generating. */
  arrived?: Attachment;
}

export interface ImageGenerationSlotsInput {
  timeline: GenerationTimeline | null | undefined;
  attachments: readonly Attachment[] | undefined;
  /** Generated image attachment id → the public id of the call that produced it. */
  placements: ReadonlyMap<string, string>;
  /** True only for the live, still-streaming response. */
  active: boolean;
  /** Steps whose reveal finished; their images now show as attachments. */
  revealed: ReadonlySet<string>;
  now: number;
}

export interface ImageGenerationSlots {
  entries: Map<string, ImageGenerationSlotEntry>;
  slots: ImageGenerationSlot[];
  /** Attachments shown inside, or held back by, a placeholder rather than in the grid. */
  hiddenAttachmentIds: ReadonlySet<string>;
}

const EMPTY: ImageGenerationSlots = Object.freeze({
  entries: new Map(),
  slots: [],
  hiddenAttachmentIds: new Set<string>(),
}) as ImageGenerationSlots;

function generateImageSteps(timeline: GenerationTimeline | null | undefined): AgentToolStep[] {
  if (!timeline) return [];
  return timeline.steps.filter(
    (step): step is AgentToolStep => isToolStep(step) && step.toolName === GENERATE_IMAGE_TOOL_NAME,
  );
}

const CURATED_NAMES = new Map(
  [...CURATED_REPLICATE_IMAGE_MODELS, ...CURATED_FAL_IMAGE_MODELS].map((entry) => [
    `${entry.provider}/${entry.id}`,
    entry.name,
  ]),
);

function imageModelParts(target: string | undefined): { provider: string; name: string } | undefined {
  if (!target) return undefined;
  const slash = target.indexOf("/");
  const provider = target.slice(0, slash);
  const id = target.slice(slash + 1);
  if (slash <= 0 || !id || !isImageGenerationProviderId(provider)) return undefined;
  const name = CURATED_NAMES.get(target) ?? id.split("/").pop() ?? id;
  return { provider: IMAGE_GENERATION_PROVIDER_NAMES[provider], name };
}

/**
 * "Provider · Model" for a step whose `target` is `<provider>/<model id>` with
 * a known image provider; undefined otherwise.
 */
export function imageGenerationModelLabel(target: string | undefined): string | undefined {
  const parts = imageModelParts(target);
  return parts ? `${parts.provider} · ${parts.name}` : undefined;
}

/** Just the model's display name (curated name or the id's last segment). */
export function imageGenerationModelName(target: string | undefined): string | undefined {
  return imageModelParts(target)?.name;
}

export function reconcileImageGenerationSlots(
  previous: ReadonlyMap<string, ImageGenerationSlotEntry>,
  input: ImageGenerationSlotsInput,
): ImageGenerationSlots {
  if (!input.active) return EMPTY;
  const steps = generateImageSteps(input.timeline);
  if (steps.length === 0) return EMPTY;
  const images = (input.attachments ?? []).filter((attachment) => attachment.kind === "image");
  const entries = new Map<string, ImageGenerationSlotEntry>();
  // An image a step already revealed (or is revealing) stays that step's.
  const claimedBy = new Map<string, string>();
  for (const [stepId, entry] of previous) if (entry.arrived) claimedBy.set(entry.arrived.id, stepId);

  const slots: ImageGenerationSlot[] = [];
  const hidden = new Set<string>();
  for (const step of steps) {
    let entry = previous.get(step.id);
    if (input.revealed.has(step.id)) {
      // Keep the claim so no later placeholder can take this image.
      if (entry) entries.set(step.id, entry);
      continue;
    }
    if (!entry) {
      // Only a running call opens a placeholder; one first seen already
      // finished (a reload, a fast provider) shows its image as usual.
      if (step.status !== "running") continue;
      entry = { firstSeenAt: input.now };
    }
    const own = images.filter((image) => {
      if (input.placements.get(image.id) !== step.toolCallId) return false;
      const owner = claimedBy.get(image.id);
      return owner === undefined || owner === step.id;
    });
    if (!entry.arrived && own[0]) {
      entry = { ...entry, arrived: own[0] };
      claimedBy.set(own[0].id, step.id);
    }
    const arrived = entry.arrived;
    const keep = step.status === "running" || (arrived !== undefined && step.status === "completed");
    if (!keep) continue;
    entries.set(step.id, entry);
    if (arrived) {
      hidden.add(arrived.id);
      // A call's other images wait for the reveal, so none shows above it.
      for (const image of own) hidden.add(image.id);
    }
    const modelLabel = imageGenerationModelLabel(step.target);
    slots.push({
      stepId: step.id,
      toolCallId: step.toolCallId,
      aspectRatio: placeholderAspectRatio(step.detail),
      startedAt: Number.isFinite(step.startedAt) && step.startedAt > 0 ? step.startedAt : entry.firstSeenAt,
      ...(modelLabel ? { modelLabel } : {}),
      ...(arrived ? { arrived } : {}),
    });
  }
  return { entries, slots, hiddenAttachmentIds: hidden };
}

export interface ImageGenerationRowSlots<Slot> {
  /** Placeholders and generated images after the activity row that holds their call. */
  byRowKey: Map<string, { slots: Slot[]; attachments: Attachment[] }>;
  trailingSlots: Slot[];
  trailingAttachments: Attachment[];
}

/**
 * Anchor each placeholder and each placed image at the activity row holding
 * its producing call, the way visuals anchor at their call's row. Anything
 * without a matching row (no timeline, no placement) keeps the trailing
 * position after all rows.
 */
export function imageGenerationRowSlots<Slot extends { toolCallId: string }>(
  rows: readonly AssistantPresentationRow[] | null,
  slots: readonly Slot[],
  attachments: readonly Attachment[],
  placements: ReadonlyMap<string, string>,
): ImageGenerationRowSlots<Slot> {
  const rowKeyByCall = new Map<string, string>();
  for (const row of rows ?? []) {
    if (row.kind !== "activity") continue;
    for (const step of row.steps) if (isToolStep(step)) rowKeyByCall.set(step.toolCallId, row.key);
  }
  const byRowKey = new Map<string, { slots: Slot[]; attachments: Attachment[] }>();
  const at = (rowKey: string) => {
    let bucket = byRowKey.get(rowKey);
    if (!bucket) {
      bucket = { slots: [], attachments: [] };
      byRowKey.set(rowKey, bucket);
    }
    return bucket;
  };
  const trailingSlots: Slot[] = [];
  const trailingAttachments: Attachment[] = [];
  for (const slot of slots) {
    const rowKey = rowKeyByCall.get(slot.toolCallId);
    if (rowKey) at(rowKey).slots.push(slot);
    else trailingSlots.push(slot);
  }
  for (const attachment of attachments) {
    const call = placements.get(attachment.id);
    const rowKey = call ? rowKeyByCall.get(call) : undefined;
    if (rowKey) at(rowKey).attachments.push(attachment);
    else trailingAttachments.push(attachment);
  }
  return { byRowKey, trailingSlots, trailingAttachments };
}
