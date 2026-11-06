// Ending Aiden Live by voice. Two paths end the session: Live's `end_session`
// tool after it says goodbye, and the user saying an exact end phrase ("bye",
// "tschüss", …). Both let whatever Live is saying finish first (bounded), and
// both give up if the user talks over the goodbye.

import * as React from "react";
import { liveActivity, type LiveActivityStore } from "../../lib/live-activity";
import { liveSessionBus, type LiveSessionBus } from "../../lib/live-session-bus";
import { matchLiveVoicePhrase } from "../../shared/live-voice-phrases";

/** The renderer-side name of Live's end tool (matches main's declaration). */
export const LIVE_END_SESSION_TOOL = "end_session";
/** The longest a goodbye may keep the session open. */
export const LIVE_GOODBYE_MAX_WAIT_MS = 4_000;
const POLL_MS = 100;

export type LivePlaybackWait = "finished" | "timeout" | "interrupted" | "cancelled";

export interface LivePlaybackProbe {
  playbackState(): { idle: boolean; flushes: number };
}

/**
 * Waits until Live's queued speech has played. "interrupted" means playback
 * was flushed (the user talked over it); "cancelled" means the signal fired.
 */
export function waitForLivePlayback(
  probe: LivePlaybackProbe,
  signal: AbortSignal,
  maxWaitMs = LIVE_GOODBYE_MAX_WAIT_MS,
  pollMs = POLL_MS,
): Promise<LivePlaybackWait> {
  const startFlushes = probe.playbackState().flushes;
  const deadline = Date.now() + maxWaitMs;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: LivePlaybackWait) => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish("cancelled");
    const check = () => {
      timer = null;
      if (signal.aborted) return finish("cancelled");
      const state = probe.playbackState();
      if (state.flushes !== startFlushes) return finish("interrupted");
      if (state.idle) return finish("finished");
      if (Date.now() >= deadline) return finish("timeout");
      timer = setTimeout(check, pollMs);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

/** True while the ribbon is asking the user to decide something by voice or tap. */
export function liveActivityAwaitsAnswer(store: Pick<LiveActivityStore, "get"> = liveActivity): boolean {
  const kind = store.get()?.kind;
  return kind === "approval" || kind === "confirm";
}

export interface LiveVoiceEndingTarget extends LivePlaybackProbe {
  active: boolean;
  stop(): Promise<void>;
}

/**
 * While a session runs, lets Live's goodbye tool and the user's exact end
 * phrase end it. Pass the bus and activity store only in tests.
 */
export function useLiveVoiceEnding(
  live: LiveVoiceEndingTarget,
  options: { bus?: LiveSessionBus; activity?: Pick<LiveActivityStore, "get">; maxWaitMs?: number } = {},
): void {
  const bus = options.bus ?? liveSessionBus;
  const activity = options.activity ?? liveActivity;
  const maxWaitMs = options.maxWaitMs ?? LIVE_GOODBYE_MAX_WAIT_MS;
  const liveRef = React.useRef(live);
  liveRef.current = live;
  const { active } = live;

  React.useEffect(() => {
    if (!active) return;
    const ending = new AbortController();
    let ended = false;
    const endAfterGoodbye = async (signal: AbortSignal): Promise<boolean> => {
      const result = await waitForLivePlayback(liveRef.current, signal, maxWaitMs);
      if (ended || ending.signal.aborted || (result !== "finished" && result !== "timeout")) return false;
      ended = true;
      await liveRef.current.stop();
      return true;
    };

    const unregister = bus.registerTool(LIVE_END_SESSION_TOOL, async (_args, context) => {
      const signal = AbortSignal.any([context.signal, ending.signal]);
      const done = await endAfterGoodbye(signal);
      return done ? { ok: true, ended: true } : { ok: false, error: { code: "cancelled", message: "The user kept talking." } };
    });

    let phraseWait: AbortController | null = null;
    const unsubscribe = bus.onVoiceInput((input) => {
      // Anything the user says after an end phrase cancels the pending end.
      phraseWait?.abort();
      phraseWait = null;
      if (matchLiveVoicePhrase(input.text)?.kind !== "end") return;
      // "Bye" while an approval or confirmation is showing is not an answer to it.
      if (liveActivityAwaitsAnswer(activity)) return;
      const wait = new AbortController();
      phraseWait = wait;
      void endAfterGoodbye(AbortSignal.any([wait.signal, ending.signal]));
    });

    return () => {
      ending.abort();
      phraseWait?.abort();
      unregister();
      unsubscribe();
    };
  }, [active, bus, activity, maxWaitMs]);
}
