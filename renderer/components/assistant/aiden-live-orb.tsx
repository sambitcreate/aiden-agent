import * as React from "react";
import { AidenOrb } from "../aiden-orb";

export type AidenLiveOrbState =
  | "ready"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "acting"
  | "approval"
  | "error"
  | "unavailable";

export function aidenLiveOrbVisual(state: AidenLiveOrbState): "duplex" | "connecting" | "rest" {
  if (["listening", "thinking", "speaking", "acting"].includes(state)) return "duplex";
  return state === "connecting" ? "connecting" : "rest";
}

export function AidenLiveOrb({
  state,
  level = 0,
  className,
}: {
  state: AidenLiveOrbState;
  level?: number;
  className?: string;
}): React.ReactElement {
  const visual = aidenLiveOrbVisual(state);
  const boundedLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;

  return (
    <span
      className={`aiden-live-orb ${className ?? ""}`.trim()}
      data-state={state}
      data-visual={visual}
      style={{ "--aiden-live-level": boundedLevel } as React.CSSProperties}
      aria-hidden="true"
    >
      {/* Stable layers preserve animation phase across simultaneous voice/tool events. */}
      <span className="aiden-live-orb-layer" data-layer="rest">
        <AidenOrb state="breathing" size={64} active={false} className="aiden-live-orb-canvas" />
      </span>
      <span className="aiden-live-orb-layer" data-layer="connecting">
        <AidenOrb state="connecting" size={64} active={visual === "connecting"} className="aiden-live-orb-canvas" />
      </span>
      <span className="aiden-live-orb-layer" data-layer="duplex">
        <span className="aiden-live-duplex-listening"><AidenOrb state="listening" size={64} active={visual === "duplex"} className="aiden-live-orb-canvas" /></span>
        <span className="aiden-live-duplex-weaving"><AidenOrb state="weaving" size={64} active={visual === "duplex"} className="aiden-live-orb-canvas" /></span>
      </span>
    </span>
  );
}
