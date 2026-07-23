import * as React from "react";
import { MARKDOWN_CLASSNAME, MarkdownContent, MarkdownInline } from "./markdown";
import { APPEARANCE_CHANGE_EVENT } from "../lib/appearance-runtime";
import {
  advanceStreamingRevealSchedule,
  parseStreamingReveal,
  splitStreamingRevealUnit,
  streamingRevealHandoffDelay,
  type StreamingRevealBlock,
  type StreamingRevealScheduleInput,
  type StreamingRevealScheduleState,
} from "../lib/streaming-reveal";

interface StreamingMarkdownRevealProps {
  content: string;
  complete?: boolean;
  onHandoffComplete?: () => void;
}

function readReducedMotion(): boolean {
  return (
    typeof document !== "undefined" && document.documentElement.dataset.reduceMotion === "true"
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(readReducedMotion);
  React.useEffect(() => {
    const update = () => setReduced(readReducedMotion());
    window.addEventListener(APPEARANCE_CHANGE_EVENT, update);
    return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, update);
  }, []);
  return reduced;
}

function visibleBlocks(
  blocks: StreamingRevealBlock[],
  revealedCount: number,
): StreamingRevealBlock[] {
  let remaining = revealedCount;
  const visible: StreamingRevealBlock[] = [];
  for (const block of blocks) {
    if (remaining <= 0) break;
    const units = block.units.slice(0, remaining);
    if (units.length) visible.push({ ...block, units });
    remaining -= units.length;
  }
  return visible;
}

export function StreamingMarkdownReveal({
  content,
  complete = false,
  onHandoffComplete,
}: StreamingMarkdownRevealProps) {
  const reducedMotion = useReducedMotion();
  const blocks = React.useMemo(() => parseStreamingReveal(content, complete), [complete, content]);
  const unitCount = React.useMemo(
    () => blocks.reduce((count, block) => count + block.units.length, 0),
    [blocks],
  );
  const [revealedCount, setRevealedCount] = React.useState(0);
  const handoffNotified = React.useRef(false);
  const scheduleRef = React.useRef<StreamingRevealScheduleState>({
    revealedCount: 0,
    dueAt: null,
  });
  const scheduleInputRef = React.useRef<StreamingRevealScheduleInput>({
    unitCount,
    complete,
    reducedMotion,
  });
  scheduleInputRef.current = { unitCount, complete, reducedMotion };

  React.useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      const next = advanceStreamingRevealSchedule(
        scheduleRef.current,
        scheduleInputRef.current,
        now,
      );
      if (next.revealedCount !== scheduleRef.current.revealedCount) {
        setRevealedCount(next.revealedCount);
      }
      scheduleRef.current = next;
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const visibleCount = reducedMotion ? unitCount : revealedCount;
  const visible = visibleBlocks(blocks, visibleCount);
  const handoffReady = complete && visibleCount >= unitCount;

  const notifyHandoffComplete = React.useCallback(() => {
    if (handoffNotified.current) return;
    handoffNotified.current = true;
    onHandoffComplete?.();
  }, [onHandoffComplete]);

  React.useEffect(() => {
    if (!handoffReady || handoffNotified.current) return;
    const delay = streamingRevealHandoffDelay(reducedMotion);
    const timer = window.setTimeout(notifyHandoffComplete, delay);
    return () => window.clearTimeout(timer);
  }, [handoffReady, notifyHandoffComplete, reducedMotion]);

  return (
    <div className={`streaming-reveal ${MARKDOWN_CLASSNAME}`}>
      {visible.map((block) => {
        if (block.kind === "prose") {
          return (
            <p key={block.id} className="my-2 first:mt-0 last:mb-0">
              {block.units.map((unit) => {
                const parts = splitStreamingRevealUnit(unit.text);
                return (
                  <span key={unit.id} className="streaming-reveal-unit">
                    {parts.leadingWhitespace}
                    {parts.markdown ? <MarkdownInline content={parts.markdown} /> : null}
                    {parts.trailingWhitespace}
                  </span>
                );
              })}
            </p>
          );
        }
        return block.units.map((unit) => (
          <div key={unit.id} className="streaming-reveal-block">
            <MarkdownContent content={unit.text} />
          </div>
        ));
      })}
    </div>
  );
}
