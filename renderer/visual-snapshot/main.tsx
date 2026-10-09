import "../styles.css";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AidenUiBlock } from "../components/aiden-ui/aiden-ui-block";
import { parseChatUiVisualV1 } from "../shared/aiden-ui/visual";

/**
 * Offscreen renderer for native visual snapshots. Main loads this page in a
 * hidden window, hands it one visual as JSON, and captures the result. It
 * draws with the app's default light tokens and has no preload or IPC.
 */

declare global {
  interface Window {
    __aidenSnapshot?: (json: string, width: number, padding: number) => Promise<number | null>;
  }
}

const CHART_WAIT_MS = 2500;
const container = document.getElementById("root")!;
const root = createRoot(container);
document.documentElement.style.background = "#f6f7f9";

function frames(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

async function chartsDrawn(): Promise<void> {
  const deadline = Date.now() + CHART_WAIT_MS;
  while (Date.now() < deadline) {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>("canvas[role='img']")];
    if (canvases.every((canvas) => canvas.dataset.chartReady === "true")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

window.__aidenSnapshot = async (json, width, padding) => {
  const visual = parseChatUiVisualV1(JSON.parse(json));
  if (!visual) return null;
  flushSync(() => {
    root.render(
      <div id="snapshot" style={{ width, padding, boxSizing: "content-box", background: "#f6f7f9" }}>
        <AidenUiBlock visual={visual} hideCaption />
      </div>,
    );
  });
  await frames();
  await chartsDrawn();
  await document.fonts.ready;
  await frames();
  const element = document.getElementById("snapshot");
  if (!element) return null;
  // The capture adds the padding back on each side.
  return Math.ceil(element.getBoundingClientRect().height - padding * 2);
};
