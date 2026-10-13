import * as React from "react";
import { MARKDOWN_CLASSNAME, MarkdownContent } from "./markdown";
import { APPEARANCE_CHANGE_EVENT } from "../lib/appearance-runtime";
import {
  advanceStreamingRevealGate,
  INITIAL_STREAMING_REVEAL_GATE,
  STREAMING_REVEAL_FADE_MS,
  StreamingRevealParser,
  streamingRevealHandoffDelay,
  streamingRevealVisibleEnd,
  type StreamingRevealGateInput,
} from "../lib/streaming-reveal";

interface StreamingMarkdownRevealProps {
  content: string;
  /** The turn ended: show everything now and hand over to the saved reply. */
  complete?: boolean;
  /** A tool step closed the text: it joins at the next release, still gated. */
  closed?: boolean;
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
  closed = false,
  onHandoffComplete,
  richLinks = false,
}: StreamingMarkdownRevealProps) {
  const reducedMotion = useReducedMotion();
  const gateRef = React.useRef(INITIAL_STREAMING_REVEAL_GATE);
  const [gate, setGate] = React.useState(INITIAL_STREAMING_REVEAL_GATE);
  const inputRef = React.useRef<StreamingRevealGateInput>({
    content,
    complete,
    closed,
    reducedMotion,
  });
  inputRef.current = { content, complete, closed, reducedMotion };

  // New text joins at whole-block boundaries, at most every few hundred ms;
  // the layout pass applies each release before paint so follow stays pinned.
  React.useLayoutEffect(() => {
    let timer = 0;
    const release = () => {
      const now = performance.now();
      const { gate: next, nextAt } = advanceStreamingRevealGate(
        gateRef.current,
        inputRef.current,
        now,
      );
      if (next.text !== gateRef.current.text) setGate(next);
      gateRef.current = next;
      if (nextAt !== null) timer = window.setTimeout(release, Math.max(0, nextAt - now));
    };
    release();
    return () => window.clearTimeout(timer);
  }, [content, complete, closed, reducedMotion]);

  // The end of the turn and reduced motion show everything in this render.
  const released =
    complete || reducedMotion ? content : content.startsWith(gate.text) ? gate.text : "";
  const parserRef = React.useRef<StreamingRevealParser | null>(null);
  parserRef.current ??= new StreamingRevealParser();
  const parser = parserRef.current;
  // Closed text that has fully joined has no unfinished tail to hold back.
  const parsedComplete = complete || (closed && released === content);
  const blocks = React.useMemo(
    () => parser.parse(released, parsedComplete),
    [parser, parsedComplete, released],
  );

  // New blocks keep fading in until the last release has finished its fade.
  const [fadeDone, setFadeDone] = React.useState(false);
  React.useEffect(() => {
    if (!complete) {
      setFadeDone(false);
      return;
    }
    const timer = window.setTimeout(() => setFadeDone(true), reducedMotion ? 0 : STREAMING_REVEAL_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [complete, reducedMotion]);

  // The released text renders as one document, exactly like a reply loaded
  // from history: reference links, footnotes, and loose lists resolve across
  // blocks. Blocks keep their elements as the text grows, so the finished
  // reply settles in place.
  const source = complete
    ? content
    : released.slice(0, streamingRevealVisibleEnd(blocks, Number.POSITIVE_INFINITY));

  const handoffNotified = React.useRef(false);
  const notifyHandoffComplete = React.useCallback(() => {
    if (handoffNotified.current) return;
    handoffNotified.current = true;
    onHandoffComplete?.();
  }, [onHandoffComplete]);

  React.useEffect(() => {
    // Only the turn's end hands over; text closed by a tool step waits for it.
    if (!complete || !onHandoffComplete || handoffNotified.current) return;
    const delay = streamingRevealHandoffDelay(reducedMotion);
    const timer = window.setTimeout(notifyHandoffComplete, delay);
    return () => window.clearTimeout(timer);
  }, [complete, notifyHandoffComplete, onHandoffComplete, reducedMotion]);

  return (
    <div
      className={`streaming-reveal ${MARKDOWN_CLASSNAME}`}
      data-streaming={fadeDone ? undefined : ""}
    >
      <MarkdownContent content={source} richLinks={richLinks} streaming={!complete} />
    </div>
  );
}
