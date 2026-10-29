// The "Lens" placeholder that holds a generated image's place in the chat
// while generate_image runs, then reveals the image when it arrives. Styles are
// the `.image-scan*` rules in styles.css; numbers come from IMAGE_SCAN_SPEC.

import * as React from "react";
import { APPEARANCE_CHANGE_EVENT } from "../lib/appearance-runtime";
import { observeOffscreen } from "../lib/offscreen-pause";
import type { Attachment } from "../lib/types";
import { inlineImageSource } from "./message-attachments";
import {
  reconcileImageGenerationSlots,
  type ImageGenerationSlot,
  type ImageGenerationSlotEntry,
} from "../lib/image-generation-slots";
import type { GenerationTimeline } from "../shared/generation-timeline";
import { imageAspectRatioValue } from "../shared/image-generation/aspect-ratio";
import {
  IMAGE_SCAN_SPEC,
  imageScanElapsedLabel,
  isLongImageScan,
} from "../shared/image-generation/placeholder-spec";

function reduceMotionActive(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.reduceMotion === "true";
}

function useReduceMotion(): boolean {
  const [reduce, setReduce] = React.useState(reduceMotionActive);
  React.useEffect(() => {
    const update = () => setReduce(reduceMotionActive());
    update();
    window.addEventListener(APPEARANCE_CHANGE_EVENT, update);
    return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, update);
  }, []);
  return reduce;
}

/** Pause while offscreen or while the window is hidden. */
function usePauseWhenUnseen(ref: React.RefObject<HTMLElement | null>): void {
  React.useEffect(() => {
    const node = ref.current;
    return node ? observeOffscreen(node) : undefined;
  }, [ref]);
}

function useElapsed(startedAt: number, running: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), IMAGE_SCAN_SPEC.captionTickMs);
    return () => window.clearInterval(timer);
  }, [running]);
  return Math.max(0, now - startedAt);
}

export interface ImageScanPlaceholderProps {
  slot: ImageGenerationSlot;
  /** Called once the arrival reveal has finished. */
  onRevealed?: (stepId: string) => void;
}

export function ImageScanPlaceholder({ slot, onRevealed }: ImageScanPlaceholderProps) {
  const slotRef = React.useRef<HTMLElement>(null);
  const reduceMotion = useReduceMotion();
  usePauseWhenUnseen(slotRef);
  const arriving = slot.arrived !== undefined;
  const elapsed = useElapsed(slot.startedAt, !arriving);
  const source = React.useMemo(
    () => (slot.arrived ? inlineImageSource(slot.arrived) : undefined),
    [slot.arrived],
  );

  const revealedRef = React.useRef(onRevealed);
  revealedRef.current = onRevealed;
  React.useEffect(() => {
    if (!arriving) return;
    const duration = reduceMotion ? IMAGE_SCAN_SPEC.arrivalFadeMs : IMAGE_SCAN_SPEC.arrivalSlideMs;
    const timer = window.setTimeout(() => revealedRef.current?.(slot.stepId), duration + 40);
    return () => window.clearTimeout(timer);
    // The reveal runs once per arrival; a Reduce Motion change mid-reveal keeps its timer.
  }, [arriving, slot.stepId]);

  const motion = reduceMotion ? "still" : "animate";
  const ratio = slot.aspectRatio;
  return (
    <figure
      ref={slotRef}
      className="image-scan-slot m-0 flex min-w-0 flex-col"
      style={{ "--image-scan-aspect": imageAspectRatioValue(ratio) } as React.CSSProperties}
      data-image-scan-slot={slot.stepId}
      data-arrival={arriving ? "reveal" : "pending"}
    >
      <div
        className="image-scan rounded-card"
        style={{ "--image-scan-ratio": ratio.replace(":", " / ") } as React.CSSProperties}
        role="img"
        aria-label={`Generating image, ${ratio}`}
        data-aspect-ratio={ratio}
        data-motion={motion}
        data-scan-period={isLongImageScan(elapsed) ? "long" : "normal"}
        data-arrival={arriving ? "reveal" : "pending"}
      >
        {source ? <img className="image-scan-result" src={source} alt="" decoding="async" /> : null}
        <div className="image-scan-cover" aria-hidden="true">
          <div className="image-scan-fill" />
          <div className="image-scan-dots" />
          <div className="image-scan-vignette" />
          <div className="image-scan-lens">
            <div className="image-scan-lens-glow" />
            <div className="image-scan-lens-dots" />
          </div>
          <div className="image-scan-edge" />
        </div>
        <span className="image-scan-chip" aria-hidden="true">
          {ratio}
        </span>
      </div>
      <figcaption
        className="image-scan-caption mt-1.5 flex min-h-7 min-w-0 items-center gap-1.5 px-1 text-mini text-tertiary tabular-nums"
        data-motion={motion}
      >
        <span className="image-scan-live" aria-hidden="true" />
        <span className="shrink-0">{imageScanElapsedLabel(elapsed)}</span>
        {slot.modelLabel ? <span className="min-w-0 truncate">· {slot.modelLabel}</span> : null}
      </figcaption>
    </figure>
  );
}

/**
 * Placeholders for a response's in-flight generate_image calls, and the image
 * attachments they are currently revealing (which the attachment grid hides
 * until the reveal ends).
 */
export function useImageGenerationSlots(
  timeline: GenerationTimeline | null | undefined,
  attachments: readonly Attachment[] | undefined,
  placements: ReadonlyMap<string, string>,
  active: boolean,
): {
  slots: ImageGenerationSlot[];
  hiddenAttachmentIds: ReadonlySet<string>;
  onRevealed: (stepId: string) => void;
} {
  const entriesRef = React.useRef<ReadonlyMap<string, ImageGenerationSlotEntry>>(new Map());
  const [revealed, setRevealed] = React.useState<ReadonlySet<string>>(() => new Set());
  const result = reconcileImageGenerationSlots(entriesRef.current, {
    timeline,
    attachments,
    placements,
    active,
    revealed,
    now: Date.now(),
  });
  entriesRef.current = result.entries;
  const onRevealed = React.useCallback((stepId: string) => {
    setRevealed((current) => (current.has(stepId) ? current : new Set(current).add(stepId)));
  }, []);
  return { slots: result.slots, hiddenAttachmentIds: result.hiddenAttachmentIds, onRevealed };
}
