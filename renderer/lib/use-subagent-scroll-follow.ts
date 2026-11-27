import * as React from "react";
import {
  subagentDetailGrowthAction,
  subagentDetailIsAwayFromLatest,
} from "./subagent-panel-state";

export interface UseSubagentScrollFollowOptions {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  runId: string;
  revision: number;
  /** Initial mount and runId switch policy: `"top"` (detail) or `"follow"` (helper chat). */
  onReset: "top" | "follow";
}

export interface SubagentScrollFollow {
  awayFromLatest: boolean;
  updateScrollPosition: () => void;
  markUserNavigation: () => void;
  jumpToLatest: (behavior: ScrollBehavior) => void;
}

export function useSubagentScrollFollow({
  scrollRef,
  runId,
  revision,
  onReset,
}: UseSubagentScrollFollowOptions): SubagentScrollFollow {
  const userNavigatedRef = React.useRef(false);
  const followGrowthRef = React.useRef(false);
  const previousRunRef = React.useRef<{ runId: string; revision: number } | null>(null);
  const [awayFromLatest, setAwayFromLatest] = React.useState(false);

  const updateScrollPosition = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const away = subagentDetailIsAwayFromLatest(
      element.scrollHeight,
      element.clientHeight,
      element.scrollTop,
    );
    if (!away && userNavigatedRef.current) {
      userNavigatedRef.current = false;
      followGrowthRef.current = true;
    }
    setAwayFromLatest(userNavigatedRef.current && away);
  }, [scrollRef]);

  React.useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof window === "undefined") return;
    const next = { runId, revision };
    const action = subagentDetailGrowthAction(
      previousRunRef.current,
      next,
      userNavigatedRef.current,
    );
    previousRunRef.current = next;
    if (action === "reset") {
      userNavigatedRef.current = false;
      followGrowthRef.current = onReset === "follow";
      element.scrollTop = onReset === "follow" ? element.scrollHeight : 0;
      setAwayFromLatest(false);
    } else if (action === "follow") {
      followGrowthRef.current = true;
      element.scrollTop = element.scrollHeight;
      setAwayFromLatest(false);
    } else {
      updateScrollPosition();
    }
    const frame = window.requestAnimationFrame(updateScrollPosition);
    return () => window.cancelAnimationFrame(frame);
  }, [onReset, revision, runId, scrollRef, updateScrollPosition]);

  React.useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followGrowthRef.current && !userNavigatedRef.current) {
        element.scrollTop = element.scrollHeight;
        setAwayFromLatest(false);
        return;
      }
      updateScrollPosition();
    });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [scrollRef, updateScrollPosition]);

  const markUserNavigation = () => {
    userNavigatedRef.current = true;
    followGrowthRef.current = false;
  };

  const jumpToLatest = (behavior: ScrollBehavior) => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    userNavigatedRef.current = false;
    followGrowthRef.current = true;
    setAwayFromLatest(false);
  };

  return { awayFromLatest, updateScrollPosition, markUserNavigation, jumpToLatest };
}
