import * as React from "react";
import type { ActivityMark } from "../../shared/activity-marks";
import { AidenActivityMark } from "../aiden-activity-mark";

export type AidenLiveMarkState =
  | "ready"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "acting"
  | "approval"
  | "error"
  | "unavailable";

/**
 * Live speaks the Helix family: one braid tuned per state, plus Glance while
 * it waits on an approval. Ready rests on a frozen Calm pose so an idle
 * session costs nothing.
 */
export function aidenLiveMark(state: AidenLiveMarkState): { mark: ActivityMark; active: boolean } {
  switch (state) {
    case "connecting":
      return { mark: "helix-twist", active: true };
    case "listening":
      return { mark: "helix-swell", active: true };
    case "thinking":
    case "speaking":
    case "acting":
      return { mark: "helix-duplex", active: true };
    case "approval":
      return { mark: "glance", active: true };
    case "error":
    case "unavailable":
      return { mark: "helix-flat", active: false };
    case "ready":
      return { mark: "helix-calm", active: false };
  }
}

export function AidenLiveMark({
  state,
  level = 0,
  className,
}: {
  state: AidenLiveMarkState;
  level?: number;
  className?: string;
}): React.ReactElement {
  const { mark, active } = aidenLiveMark(state);
  const boundedLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;

  return (
    <span
      className={`aiden-live-mark ${className ?? ""}`.trim()}
      data-state={state}
      data-mark={mark}
      style={{ "--aiden-live-level": boundedLevel } as React.CSSProperties}
      aria-hidden="true"
    >
      <AidenActivityMark key={mark} mark={mark} size={64} active={active} level={boundedLevel} />
    </span>
  );
}
