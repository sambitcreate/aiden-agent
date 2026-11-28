// Bot bubbles inside the Aiden window, where heads can't float over other apps
// (Linux, or Float over other apps switched off). Mounted once by the main
// window; it draws nothing unless main says heads live in this window.

import * as React from "react";
import { useBotBubbles } from "../lib/bot-bubbles-api";
import { BotBubbleHeads } from "./bot-bubble-heads";
import type { BubbleArea } from "./head-layout";

function readViewport(): BubbleArea {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** The window's size, kept current on resize. */
export function useViewportArea(): BubbleArea {
  const [area, setArea] = React.useState(readViewport);
  React.useEffect(() => {
    const update = () =>
      setArea((current) => {
        const next = readViewport();
        return next.width === current.width && next.height === current.height ? current : next;
      });
    window.addEventListener("resize", update);
    update();
    return () => window.removeEventListener("resize", update);
  }, []);
  return area;
}

export function BotBubbleWindowHost() {
  const state = useBotBubbles();
  const area = useViewportArea();
  if (state.host !== "window" || state.bubbles.length === 0) return null;
  return (
    <BotBubbleHeads bubbles={state.bubbles} openBotId={state.openBotId} area={area} host="window" />
  );
}
