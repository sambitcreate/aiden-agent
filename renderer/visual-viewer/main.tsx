import "../styles.css";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { AidenUiBlock } from "../components/aiden-ui/aiden-ui-block";
import { Toaster } from "../components/ui";
import { ExternalLinkOpenerProvider } from "../lib/link-opener";
import { readGenerativeUiTheme } from "../lib/generative-ui-theme-snapshot";
import {
  createDefaultAppearanceConfig,
  getPresetVariant,
  resolveThemeTokens,
  uiFontStack,
  codeFontStack,
  type AppearanceScheme,
  type ThemePresetId,
} from "../shared/appearance";
import { parseChatUiVisualV1 } from "../shared/aiden-ui/visual";
import {
  GENERATIVE_UI_THEME_MESSAGE,
  admitGuestPrompt,
  parseGuestBridgeMessage,
} from "../shared/generative-ui-bridge";
import { GENERATIVE_UI_IFRAME_SANDBOX } from "../shared/generative-ui";
import {
  VISUAL_VIEWER_PAYLOAD_ELEMENT_ID,
  isViewerOpenableUrl,
  postVisualViewerMessage,
  type VisualViewerPayload,
} from "../shared/visual-viewer";

/**
 * The phone visual viewer. The Mac builds this page with its payload inline
 * and iOS or Android loads it into a locked-down web view. It has no preload,
 * no storage and no network; it reaches its host only through
 * `postVisualViewerMessage`.
 */

const MIN_GUEST_HEIGHT = 64;
const MAX_GUEST_HEIGHT = 20_000;
const CHART_WAIT_MS = 2500;

function readPayload(): VisualViewerPayload | undefined {
  const element = document.getElementById(VISUAL_VIEWER_PAYLOAD_ELEMENT_ID);
  if (!element?.textContent) return undefined;
  try {
    return JSON.parse(element.textContent) as VisualViewerPayload;
  } catch {
    return undefined;
  }
}

/** The preset's tokens for one scheme, applied without the app's storage-backed runtime. */
function applyViewerTheme(scheme: AppearanceScheme, preset: ThemePresetId): void {
  const defaults = createDefaultAppearanceConfig();
  const variant = getPresetVariant(preset, scheme);
  const root = document.documentElement;
  root.classList.toggle("dark", scheme === "dark");
  root.style.colorScheme = scheme;
  root.dataset.appearanceScheme = scheme;
  root.dataset.theme = variant.preset;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  root.dataset.reduceMotion = String(reduceMotion);
  root.style.setProperty("--font-ui-family", uiFontStack(variant.uiFont));
  root.style.setProperty("--font-code-family", codeFontStack(variant.codeFont));
  root.style.setProperty("--ui-font-size", `${defaults.uiFontSize}px`);
  root.style.setProperty("--code-font-size", `${defaults.codeFontSize}px`);
  for (const [name, token] of Object.entries(resolveThemeTokens(variant, scheme))) {
    root.style.setProperty(name, token);
  }
}

const openExternal = (url: string): boolean =>
  isViewerOpenableUrl(url) && postVisualViewerMessage({ type: "openUrl", url });

function UiViewer({ payload }: { payload: Extract<VisualViewerPayload, { kind: "ui" }> }) {
  const visual = React.useMemo(() => parseChatUiVisualV1(payload.visual), [payload.visual]);
  React.useEffect(() => {
    let live = true;
    // Ready once every chart has drawn (or the wait runs out).
    const deadline = Date.now() + CHART_WAIT_MS;
    const check = () => {
      if (!live) return;
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>("canvas[role='img']")];
      if (canvases.every((canvas) => canvas.dataset.chartReady === "true") || Date.now() > deadline) {
        postVisualViewerMessage({ type: "ready" });
        return;
      }
      setTimeout(check, 50);
    };
    requestAnimationFrame(() => requestAnimationFrame(check));
    return () => {
      live = false;
    };
  }, []);
  if (!visual) return <p className="m-0 text-small text-secondary">{payload.title}</p>;
  return (
    <ExternalLinkOpenerProvider openExternal={openExternal}>
      <AidenUiBlock
        visual={visual}
        attachments={payload.attachments}
        hideCaption
        onFollowUp={(text) => postVisualViewerMessage({ type: "prompt", text })}
      />
    </ExternalLinkOpenerProvider>
  );
}

function HtmlViewer({ payload }: { payload: Extract<VisualViewerPayload, { kind: "html" }> }) {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = React.useState(MIN_GUEST_HEIGHT);
  // Hidden until the guest has the phone's theme, so a dark viewer never flashes light.
  const [themed, setThemed] = React.useState(false);
  const lastPrompt = React.useRef<number | undefined>(undefined);
  const announced = React.useRef(false);

  // A layout effect, so the listener is in place before the srcdoc guest parses
  // and posts its first messages.
  React.useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const guest = frame.current?.contentWindow;
      if (!guest || event.source !== guest) return;
      const message = parseGuestBridgeMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case "ready": {
          const theme = readGenerativeUiTheme();
          guest.postMessage({ type: GENERATIVE_UI_THEME_MESSAGE, colorScheme: theme.colorScheme, vars: theme.vars }, "*");
          requestAnimationFrame(() => setThemed(true));
          return;
        }
        case "resize": {
          if (!Number.isFinite(message.height)) return;
          setHeight(Math.min(MAX_GUEST_HEIGHT, Math.max(MIN_GUEST_HEIGHT, Math.ceil(message.height))));
          return;
        }
        case "prompt": {
          const now = performance.now();
          const decision = admitGuestPrompt({ text: message.text, now, lastAcceptedAt: lastPrompt.current });
          if (decision.action !== "confirm") return;
          lastPrompt.current = now;
          postVisualViewerMessage({ type: "prompt", text: decision.text });
          return;
        }
        case "escape":
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  React.useEffect(() => {
    if (!themed || announced.current) return;
    announced.current = true;
    postVisualViewerMessage({ type: "ready" });
  }, [themed]);

  return (
    <iframe
      ref={frame}
      title={payload.title}
      sandbox={GENERATIVE_UI_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={payload.guest}
      data-themed={themed ? "true" : "false"}
      style={{
        display: "block",
        width: "100%",
        height,
        border: 0,
        background: "transparent",
        opacity: themed ? 1 : 0,
      }}
    />
  );
}

function Viewer({ payload }: { payload: VisualViewerPayload }) {
  return (
    <main
      aria-label={payload.title}
      style={{ boxSizing: "border-box", minHeight: "100vh", padding: "16px", background: "var(--theme-canvas)" }}
      className="text-primary"
    >
      {payload.kind === "ui" ? <UiViewer payload={payload} /> : <HtmlViewer payload={payload} />}
      <Toaster />
    </main>
  );
}

const payload = readPayload();
if (payload && (payload.kind === "ui" || payload.kind === "html")) {
  applyViewerTheme(payload.scheme, payload.preset);
  document.body.style.margin = "0";
  document.body.style.background = "var(--theme-canvas)";
  const container = document.getElementById("root") ?? document.body.appendChild(document.createElement("div"));
  // The desktop stylesheet pins html, body and #root to the viewport with
  // overflow hidden. The viewer scrolls inside its own full-viewport surface.
  Object.assign(container.style, { position: "fixed", inset: "0", overflowX: "hidden", overflowY: "auto", overscrollBehavior: "contain" });
  createRoot(container).render(<Viewer payload={payload} />);
}
