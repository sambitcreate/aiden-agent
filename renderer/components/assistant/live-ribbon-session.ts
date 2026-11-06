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

/** After "bye", how long Live's spoken goodbye may take to start playing. */
export const LIVE_GOODBYE_START_MS = 1_500;
/** Quiet that must last before a reply counts as played, so a gap between chunks does not end it. */
export const LIVE_PLAYBACK_SETTLE_MS = 250;

export interface LivePlaybackProbe {
  playbackState(): { idle: boolean; bargeIns: number };
}

export interface LivePlaybackWaitOptions {
  /** The whole wait, start to end. */
  maxWaitMs?: number;
  /** When playback is quiet at first, wait this long for a reply to start. */
  replyStartMs?: number;
  settleMs?: number;
  pollMs?: number;
}

/**
 * Waits until Live's queued speech has played. "interrupted" means the user
 * talked over it (a resumption's flush does not count); "cancelled" means the
 * signal fired.
 */
export function waitForLivePlayback(
  probe: LivePlaybackProbe,
  signal: AbortSignal,
  options: LivePlaybackWaitOptions = {},
): Promise<LivePlaybackWait> {
  const maxWaitMs = options.maxWaitMs ?? LIVE_GOODBYE_MAX_WAIT_MS;
  const replyStartMs = options.replyStartMs ?? 0;
  const settleMs = options.settleMs ?? LIVE_PLAYBACK_SETTLE_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const started = Date.now();
  const deadline = started + maxWaitMs;
  const first = probe.playbackState();
  const startBargeIns = first.bargeIns;
  // Speech that has not started yet may still be on its way.
  let heard = !first.idle || replyStartMs <= 0;
  let quietSince: number | null = null;
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
      const now = Date.now();
      const state = probe.playbackState();
      if (state.bargeIns !== startBargeIns) return finish("interrupted");
      if (!state.idle) {
        heard = true;
        quietSince = null;
      } else if (!heard) {
        if (now - started >= replyStartMs) return finish("finished");
      } else {
        quietSince ??= now;
        if (now - quietSince >= settleMs || (first.idle && replyStartMs <= 0)) return finish("finished");
      }
      if (now >= deadline) return finish("timeout");
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

export interface LiveVoiceEndingOptions extends Omit<LivePlaybackWaitOptions, "replyStartMs"> {
  bus?: LiveSessionBus;
  activity?: Pick<LiveActivityStore, "get">;
  /** Another request waiting on the user, such as the dock's Computer Use approval. */
  answerPending?: () => boolean;
  /** After an end phrase, how long the goodbye may take to start. */
  goodbyeStartMs?: number;
}

/** The refusal Live gets when it tries to end with a request still waiting. */
export const LIVE_END_WHILE_WAITING = {
  ok: false,
  error: { code: "answer_pending", message: "Answer the waiting request first." },
} as const;

/**
 * While a session runs, lets Live's goodbye tool and the user's exact end
 * phrase end it. Neither ends Live while an approval or confirmation waits
 * on the user. Pass the bus and activity store only in tests.
 */
export function useLiveVoiceEnding(live: LiveVoiceEndingTarget, options: LiveVoiceEndingOptions = {}): void {
  const bus = options.bus ?? liveSessionBus;
  const activity = options.activity ?? liveActivity;
  const { maxWaitMs, settleMs, pollMs } = options;
  const goodbyeStartMs = options.goodbyeStartMs ?? LIVE_GOODBYE_START_MS;
  const liveRef = React.useRef(live);
  liveRef.current = live;
  const answerPendingRef = React.useRef(options.answerPending);
  answerPendingRef.current = options.answerPending;
  const { active } = live;

  React.useEffect(() => {
    if (!active) return;
    const ending = new AbortController();
    let ended = false;
    const awaitingAnswer = () => liveActivityAwaitsAnswer(activity) || answerPendingRef.current?.() === true;
    const endAfterGoodbye = async (
      signal: AbortSignal,
      replyStartMs: number,
    ): Promise<"ended" | "kept" | "waiting"> => {
      if (awaitingAnswer()) return "waiting";
      const result = await waitForLivePlayback(liveRef.current, signal, {
        replyStartMs,
        ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
        ...(settleMs !== undefined ? { settleMs } : {}),
        ...(pollMs !== undefined ? { pollMs } : {}),
      });
      if (ended || ending.signal.aborted || (result !== "finished" && result !== "timeout")) return "kept";
      // A request may have appeared while the goodbye played.
      if (awaitingAnswer()) return "waiting";
      ended = true;
      await liveRef.current.stop();
      return "ended";
    };

    const unregister = bus.registerTool(LIVE_END_SESSION_TOOL, async (_args, context) => {
      const outcome = await endAfterGoodbye(AbortSignal.any([context.signal, ending.signal]), 0);
      if (outcome === "ended") return { ok: true, ended: true };
      if (outcome === "waiting") return LIVE_END_WHILE_WAITING;
      return { ok: false, error: { code: "cancelled", message: "The user kept talking." } };
    });

    let phraseWait: AbortController | null = null;
    const unsubscribe = bus.onVoiceInput((input) => {
      // Anything the user says after an end phrase cancels the pending end.
      phraseWait?.abort();
      phraseWait = null;
      if (matchLiveVoicePhrase(input.text)?.kind !== "end") return;
      // "Bye" while an approval or confirmation is waiting is not an answer to it.
      if (awaitingAnswer()) return;
      const wait = new AbortController();
      phraseWait = wait;
      // Live's spoken goodbye has usually not arrived yet: let it start, then finish.
      void endAfterGoodbye(AbortSignal.any([wait.signal, ending.signal]), goodbyeStartMs);
    });

    return () => {
      ending.abort();
      phraseWait?.abort();
      unregister();
      unsubscribe();
    };
  }, [active, bus, activity, maxWaitMs, settleMs, pollMs, goodbyeStartMs]);
}
