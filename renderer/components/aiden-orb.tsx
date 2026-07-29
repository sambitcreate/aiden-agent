import * as React from "react";
import { ThinkingOrb, type OrbSize, type OrbState, type OrbTheme } from "thinking-orbs";
import { APPEARANCE_CHANGE_EVENT } from "../lib/appearance-runtime";

interface OrbAppearance {
  paused: boolean;
  theme: OrbTheme;
}

function readOrbAppearance(): OrbAppearance {
  if (typeof document === "undefined") return { paused: true, theme: "light" };
  return {
    paused: document.documentElement.dataset.reduceMotion === "true",
    theme: document.documentElement.dataset.appearanceScheme === "dark" ? "dark" : "light",
  };
}

function useOrbAppearance(): OrbAppearance {
  const [appearance, setAppearance] = React.useState(readOrbAppearance);

  React.useEffect(() => {
    const update = () => setAppearance(readOrbAppearance());
    window.addEventListener(APPEARANCE_CHANGE_EVENT, update);
    return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, update);
  }, []);

  return appearance;
}

export interface AidenOrbProps {
  state: OrbState;
  size?: OrbSize;
  active?: boolean;
  className?: string;
  "data-subagent-orb-state"?: "active" | "terminal";
}

/**
 * Aiden's shared animated activity mark. Reduced Motion and terminal consumers
 * pause the same orb rather than substituting a second icon language.
 */
export function AidenOrb({
  state,
  size = 20,
  active = true,
  className,
  ...dataAttributes
}: AidenOrbProps) {
  const appearance = useOrbAppearance();

  return (
    <ThinkingOrb
      aria-hidden="true"
      state={state}
      size={size}
      theme={appearance.theme}
      paused={appearance.paused || !active}
      className={className}
      data-aiden-orb-state={state}
      {...dataAttributes}
    />
  );
}
