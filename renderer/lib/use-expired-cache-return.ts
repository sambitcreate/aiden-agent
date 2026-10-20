import * as React from "react";
import type { CompactionEngine } from "../shared/compaction";
import type { ChatContextPressureV1 } from "../shared/context-pressure";
import { expiredCacheReturns } from "./expired-cache-return";

interface ExpiredCacheReturnOptions {
  chatId: string;
  /** This chat's reading without the draft, or null while it loads. */
  pressure: ChatContextPressureV1 | null | undefined;
  /** The automatic compaction engine, once settings have loaded. */
  engine: CompactionEngine | undefined;
  idle: boolean;
  /** Start a compaction; `automatic` is true when the user did not ask for it. */
  compact(engine: CompactionEngine, automatic: boolean): void;
}

/**
 * Wires return signals to {@link expiredCacheReturns}: mounting (Composer is
 * keyed by chat, so this is opening the chat), the window coming back, and
 * the start of typing. Returns the LLM offer and the actions it needs.
 */
export function useExpiredCacheReturn({ chatId, pressure, engine, idle, compact }: ExpiredCacheReturnOptions) {
  const [returns, setReturns] = React.useState(0);
  const markReturned = React.useCallback(() => {
    expiredCacheReturns.returned(chatId, Date.now());
    setReturns((value) => value + 1);
  }, [chatId]);

  React.useEffect(() => {
    markReturned();
    const onVisibility = () => {
      if (document.visibilityState === "visible") markReturned();
    };
    window.addEventListener("focus", markReturned);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", markReturned);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [markReturned]);

  const compactRef = React.useRef(compact);
  compactRef.current = compact;
  React.useEffect(() => {
    if (!engine) return;
    if (expiredCacheReturns.takeAutomatic(chatId, { pressure, engine, idle, now: Date.now() })) {
      compactRef.current("vcc", true);
    }
  }, [chatId, engine, idle, pressure, returns]);

  const offer = engine ? expiredCacheReturns.offer(chatId, { pressure, engine, idle }) : undefined;
  const settle = React.useCallback(() => {
    expiredCacheReturns.settle(chatId, pressure, Date.now());
    setReturns((value) => value + 1);
  }, [chatId, pressure]);
  return {
    offer,
    markReturned,
    /** Any compaction in this window answers it, whoever started it. */
    settle,
    accept: React.useCallback(() => {
      settle();
      compactRef.current("llm", false);
    }, [settle]),
    dismiss: settle,
  };
}
