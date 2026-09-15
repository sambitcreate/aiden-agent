import * as React from "react";
import type { OrbState } from "thinking-orbs";
import { AidenOrb } from "../aiden-orb";

export type AidenLiveOrbState =
  | "ready"
  | "connecting"
  | "listening"
  | "thinking"
  | "acting"
  | "approval"
  | "error"
  | "unavailable";

const ORB_PRESENTATION: Record<
  AidenLiveOrbState,
  { state: OrbState; active: boolean }
> = {
  ready: { state: "breathing", active: false },
  connecting: { state: "connecting", active: true },
  // Listening deliberately uses Libraries.dev's calm breathing treatment.
  listening: { state: "breathing", active: true },
  thinking: { state: "solving", active: true },
  acting: { state: "working", active: true },
  approval: { state: "shaping", active: true },
  error: { state: "breathing", active: false },
  unavailable: { state: "breathing", active: false },
};

export function AidenLiveOrb({
  state,
  level = 0,
  className,
}: {
  state: AidenLiveOrbState;
  level?: number;
  className?: string;
}): React.ReactElement {
  const presentation = ORB_PRESENTATION[state];
  const boundedLevel = Math.max(0, Math.min(1, level));

  return (
    <span
      className={`aiden-live-orb ${className ?? ""}`.trim()}
      data-state={state}
      style={{ "--aiden-live-level": boundedLevel } as React.CSSProperties}
      aria-hidden="true"
    >
      <AidenOrb
        state={presentation.state}
        size={64}
        active={presentation.active}
        className="aiden-live-orb-canvas"
      />
    </span>
  );
}
