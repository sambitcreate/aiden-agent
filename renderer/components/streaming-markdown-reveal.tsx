import * as React from "react";
import { MARKDOWN_CLASSNAME, MarkdownContent } from "./markdown";
import { APPEARANCE_CHANGE_EVENT } from "../lib/appearance-runtime";
import {
  advanceStreamingRevealSchedule,
  clampStreamingRevealSchedule,
  StreamingRevealParser,
  streamingRevealHandoffDelay,
  streamingRevealVisibleEnd,
  type StreamingRevealScheduleInput,
  type StreamingRevealScheduleState,
} from "../lib/streaming-reveal";

interface StreamingMarkdownRevealProps {
  content: string;
  complete?: boolean;
  onHandoffComplete?: () => void;
  richLinks?: boolean;
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

export function StreamingMarkdownReveal({
  content,
  complete = false,
  onHandoffComplete,
  richLinks = false,
}: StreamingMarkdownRevealProps) {
  const reducedMotion = useReducedMotion();
  const parserRef = React.useRef<StreamingRevealParser | null>(null);
  parserRef.current ??= new StreamingRevealParser();
  const parser = parserRef.current;
  const blocks = React.useMemo(() => parser.parse(content, complete), [parser, complete, content]);
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
    const clamped = clampStreamingRevealSchedule(scheduleRef.current, unitCount);
    if (clamped !== scheduleRef.current) {
      scheduleRef.current = clamped;
      setRevealedCount(unitCount);
    }
    if (scheduleRef.current.revealedCount >= unitCount) return;
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
      if (next.revealedCount < unitCount) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [unitCount, complete, reducedMotion]);

  const visibleCount = reducedMotion ? unitCount : revealedCount;
  const handoffReady = complete && visibleCount >= unitCount;
  // The revealed text renders as one document, exactly like a reply loaded
  // from history: reference links, footnotes, and loose lists resolve across
  // blocks. Blocks keep their elements as the text grows, so the finished
  // reply settles in place.
  const source = handoffReady
    ? content
    : content.slice(0, streamingRevealVisibleEnd(blocks, visibleCount));

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
    <div className={`streaming-reveal ${MARKDOWN_CLASSNAME}`} data-streaming={handoffReady ? undefined : ""}>
      <MarkdownContent content={source} richLinks={richLinks} streaming={!handoffReady} />
    </div>
  );
}
