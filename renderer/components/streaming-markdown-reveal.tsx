import * as React from "react";
import { CodeBlock } from "./code-block";
import { Markdown, MarkdownInline } from "./markdown";
import { APPEARANCE_CHANGE_EVENT } from "../lib/appearance-runtime";
import {
  parseStreamingReveal,
  revealDelayMs,
  type StreamingRevealBlock,
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

  React.useEffect(() => {
    if (reducedMotion || complete) {
      setRevealedCount(unitCount);
      return;
    }
    if (revealedCount >= unitCount) return;
    const pending = unitCount - revealedCount;
    const timer = window.setTimeout(
      () => setRevealedCount((current) => Math.min(current + 1, unitCount)),
      revealedCount === 0 ? 0 : revealDelayMs(pending, complete),
    );
    return () => window.clearTimeout(timer);
  }, [complete, reducedMotion, revealedCount, unitCount]);

  const visible = visibleBlocks(blocks, revealedCount);
  React.useEffect(() => {
    if (!complete || !reducedMotion || handoffNotified.current) return;
    handoffNotified.current = true;
    onHandoffComplete?.();
  }, [complete, onHandoffComplete, reducedMotion]);

  const notifyHandoffComplete = React.useCallback(() => {
    if (handoffNotified.current) return;
    handoffNotified.current = true;
    onHandoffComplete?.();
  }, [onHandoffComplete]);

  const streamingContent = (
    <div className="streaming-reveal select-text text-regular text-primary leading-relaxed">
      {visible.map((block) => {
        if (block.kind === "prose") {
          return (
            <p key={block.id} className="my-2 first:mt-0 last:mb-0 whitespace-pre-wrap">
              {block.units.map((unit) => (
                <span key={unit.id} className="streaming-reveal-unit">
                  <MarkdownInline content={unit.text} />
                </span>
              ))}
            </p>
          );
        }
        if (block.kind === "code") {
          const code = block.units.map((unit) => unit.text).join("");
          return (
            <CodeBlock
              key={block.id}
              code={code}
              lang={block.language}
              revealGroups={block.units}
            />
          );
        }
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List
              key={block.id}
              className={block.ordered ? "my-2 list-decimal pl-5" : "my-2 list-disc pl-5"}
            >
              {block.units.map((unit) => (
                <li key={unit.id} className="streaming-reveal-unit my-0.5">
                  <MarkdownInline content={unit.text} />
                </li>
              ))}
            </List>
          );
        }
        return block.units.map((unit) => (
          <div key={unit.id} className="streaming-reveal-unit">
            <Markdown content={unit.text} />
          </div>
        ));
      })}
    </div>
  );

  return (
    <div className="streaming-reveal-handoff">
      <div className="streaming-reveal-source" data-complete={complete ? "true" : "false"}>
        {streamingContent}
      </div>
      {complete ? (
        <div
          className="streaming-reveal-final"
          onAnimationEnd={(event) => {
            if (event.currentTarget === event.target) notifyHandoffComplete();
          }}
        >
          <Markdown content={content} />
        </div>
      ) : null}
    </div>
  );
}
