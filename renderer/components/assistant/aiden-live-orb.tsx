import * as React from "react";
import { useRive } from "@rive-app/react-webgl2";

const AIDEN_LIVE_ORB_URL = new URL(
  "../../assets/gemini-live-orb/aiden-gemini-live-orb.riv",
  import.meta.url,
).href;

export type AidenLiveOrbState =
  | "ready"
  | "connecting"
  | "listening"
  | "thinking"
  | "acting"
  | "approval"
  | "error"
  | "unavailable";

const ORB_STATE_VALUE: Record<AidenLiveOrbState, number> = {
  ready: 0,
  connecting: 1,
  listening: 2,
  thinking: 3,
  acting: 4,
  approval: 5,
  error: 6,
  unavailable: 7,
};

function reducedMotion(): boolean {
  return (
    document.documentElement.dataset.reduceMotion === "true" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
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
  const { rive, RiveComponent } = useRive(
    {
      src: AIDEN_LIVE_ORB_URL,
      artboard: "Aiden Orb",
      stateMachine: "Aiden Orb Machine",
      autoplay: true,
      autoBind: true,
      enableRiveAssetCDN: false,
      shouldDisableRiveListeners: true,
    },
    {
      shouldResizeCanvasToContainer: true,
      shouldUseIntersectionObserver: true,
    },
  );

  React.useEffect(() => {
    const instance = rive?.viewModelInstance;
    if (!rive || !instance) return;
    const stateProperty = instance.number("state");
    const levelProperty = instance.number("level");
    const reduceMotionProperty = instance.boolean("reduceMotion");
    if (!stateProperty || !levelProperty || !reduceMotionProperty) return;
    stateProperty.value = ORB_STATE_VALUE[state];
    levelProperty.value = Math.max(0, Math.min(1, level));
    reduceMotionProperty.value = reducedMotion();
    rive.play();
  }, [level, rive, state]);

  return (
    <span
      className={`aiden-live-rive-orb ${className ?? ""}`.trim()}
      data-state={state}
      style={{ "--aiden-live-level": Math.max(0, Math.min(1, level)) } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="aiden-live-rive-fallback" />
      <RiveComponent className="aiden-live-rive-canvas" />
    </span>
  );
}
