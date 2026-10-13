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
// - The first image attachment that arrives after the placeholder appeared is
//   revealed inside it, then shown as an ordinary attachment. A step that
//   fails, is cancelled, or completes without an image drops its placeholder.
// - Settled (persisted) responses never show placeholders.

import type { Attachment } from "./types";
import { isToolStep, type AgentToolStep, type GenerationTimeline } from "../shared/generation-timeline";
import { placeholderAspectRatio, type ImageAspectRatio } from "../shared/image-generation/placeholder-spec";
import { CURATED_FAL_IMAGE_MODELS, CURATED_REPLICATE_IMAGE_MODELS } from "../shared/image-generation/catalog";
import {
  IMAGE_GENERATION_PROVIDER_NAMES,
  isImageGenerationProviderId,
} from "../shared/image-generation/types";

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

export interface ImageGenerationSlotEntry {
  /** When this transcript first saw the step running (local clock). */
  firstSeenAt: number;
  /** Image attachments already present then; they are never this call's result. */
  baseline: readonly string[];
  arrivedId?: string;
}

export interface ImageGenerationSlot {
  stepId: string;
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
  /** True only for the live, still-streaming response. */
  active: boolean;
  /** Steps whose reveal finished; their image now shows as an attachment. */
  revealed: ReadonlySet<string>;
  now: number;
}

export interface ImageGenerationSlots {
  entries: Map<string, ImageGenerationSlotEntry>;
  slots: ImageGenerationSlot[];
  /** Attachments shown inside a placeholder rather than in the attachment grid. */
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

/**
 * "Provider · Model" for a step whose `target` is `<provider>/<model id>` with
 * a known image provider; undefined otherwise.
 */
export function imageGenerationModelLabel(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const slash = target.indexOf("/");
  const provider = target.slice(0, slash);
  const id = target.slice(slash + 1);
  if (slash <= 0 || !id || !isImageGenerationProviderId(provider)) return undefined;
  const name = CURATED_NAMES.get(target) ?? id.split("/").pop() ?? id;
  return `${IMAGE_GENERATION_PROVIDER_NAMES[provider]} · ${name}`;
}

export function reconcileImageGenerationSlots(
  previous: ReadonlyMap<string, ImageGenerationSlotEntry>,
  input: ImageGenerationSlotsInput,
): ImageGenerationSlots {
  if (!input.active) return EMPTY;
  const steps = generateImageSteps(input.timeline);
  if (steps.length === 0) return EMPTY;
  const images = (input.attachments ?? []).filter((attachment) => attachment.kind === "image");
  const imageIds = images.map((attachment) => attachment.id);
  const entries = new Map<string, ImageGenerationSlotEntry>();
  const claimed = new Set<string>();
  for (const entry of previous.values()) if (entry.arrivedId) claimed.add(entry.arrivedId);

  const slots: ImageGenerationSlot[] = [];
  const hidden = new Set<string>();
  for (const step of steps) {
    if (input.revealed.has(step.id)) continue;
    let entry = previous.get(step.id);
    if (!entry) {
      // Only a running call opens a placeholder; one first seen already
      // finished (a reload, a fast provider) shows its image as usual.
      if (step.status !== "running") continue;
      entry = { firstSeenAt: input.now, baseline: imageIds };
    }
    if (!entry.arrivedId) {
      const baseline = new Set(entry.baseline);
      const arrived = imageIds.find((id) => !baseline.has(id) && !claimed.has(id));
      if (arrived) {
        claimed.add(arrived);
        entry = { ...entry, arrivedId: arrived };
      }
    }
    const keep = step.status === "running" || (entry.arrivedId !== undefined && step.status === "completed");
    if (!keep) continue;
    entries.set(step.id, entry);
    const arrived = entry.arrivedId ? images.find((image) => image.id === entry.arrivedId) : undefined;
    if (arrived) hidden.add(arrived.id);
    const modelLabel = imageGenerationModelLabel(step.target);
    slots.push({
      stepId: step.id,
      aspectRatio: placeholderAspectRatio(step.detail),
      startedAt: entry.firstSeenAt,
      ...(modelLabel ? { modelLabel } : {}),
      ...(arrived ? { arrived } : {}),
    });
  }
  return { entries, slots, hiddenAttachmentIds: hidden };
}
