// A route of the workspace's running web app, live on the canvas (design mode
// v2 Phase 3a, D16). Main decides the origin: before the iframe exists, the
// node asks `designCanvas:appFrameMount` with a fresh one-use token and frames
// exactly the origin main answers, plus the frame's route. The iframe can run
// scripts and forms on its own origin, but has no modals, popups, downloads or
// top navigation, a Permissions Policy that grants nothing, and is `inert`
// until the person enters it; a document-level focus guard keeps a page's
// `focus()` from pulling keys out of Aiden (S75). Not running, the frame
// shows its last picture under an overlay that follows the app's phase.
// Everything the page's bridge says is untrusted (S11): it is bounded, rate
// limited, shown escaped, and decides nothing. Blocked counts, refused
// navigations and dialog notices come from main.

import type { NodeProps } from "@xyflow/react";
import * as React from "react";
import { CanvasNodeChrome } from "../../canvas";
import { Button, Popover, PopoverContent, PopoverTrigger, toast } from "../../components/ui";
import { useAppCapabilities } from "../../lib/app-capabilities";
import { designAppApi, designCanvasApi } from "../../lib/ipc";
import { cn } from "../../lib/ui-utils";
import { parseAppBridgeMessage, postToAppPage } from "../../shared/design-canvas/app-bridge-messages";
import {
  APP_FRAME_ALLOW,
  APP_FRAME_SANDBOX,
  APP_DEFAULT_VIEWPORT,
  appFrameName,
  isAppFrameId,
} from "../../shared/design-canvas/app-frame";
import { APP_FRAME_BLOCKED_HOSTS, type AppFrameDialogKind, type DesignAppFrameMountResult } from "../../shared/design-canvas/app-frame-events";
import { designMinSize, type DesignFrame } from "../../shared/design-canvas/schema";
import {
  consentDisplayText,
  designAppProblemMessage,
  type DesignAppsSnapshot,
  type DesignAppStatus,
} from "../../shared/design-app";
import type { DesignNode } from "../canvas-adapter-core";
import { APP_FRAME_ENTERED_ATTRIBUTE, holdAppFrameFocusGuard } from "../app-frame-focus-guard";
import { useDesignAppsSnapshot } from "../design-app-chip";
import { captureFrameSnapshot, designFrameSnapshots, useFrameSnapshot } from "../frame-snapshots";
import { DESIGN_FRAME_HEADER_PX, useDesignNodeContext } from "./design-node-context";
import { FrameActions } from "./frame-actions";
import { DesignNodeResizer, FrameSkeleton, rectOnCanvas, useRetiringFrame } from "./frame-parts";
import { FrameTitle } from "./frame-title";

/** At most this many bridge messages are read per second per frame; the rest are dropped (D12). */
export const APP_BRIDGE_MESSAGES_PER_SECOND = 60;
/** Pictures of a live app frame are taken at most this often (D16). */
export const APP_FRAME_CAPTURE_GAP_MS = 2000;
/** A picture waits this long after a load or a hot update, so the page has drawn. */
export const APP_FRAME_CAPTURE_SETTLE_MS = 400;
/** Refused navigations show at most one toast per this long per frame; the latest link wins (D16). */
export const APP_FRAME_REFUSED_TOAST_GAP_MS = 1000;
/** An in-app path is shown up to this many characters. */
const PATH_CHARS = 60;

const IPV6_SENTENCE = "This app runs on IPv6 localhost, which the canvas can't show yet. Restart it on 127.0.0.1.";
const LOCALHOST_SENTENCE = "Design mode only lets apps reach localhost for now.";
const ACTION_FAILED = "Aiden couldn't do that.";

/** A fixed sentence over the frame's last picture: the app isn't live here. */
export function AppFrameCard({ title, snapshot, children }: { title: string; snapshot: string | undefined; children: React.ReactNode }) {
  return (
    <div className="relative h-full w-full overflow-hidden rounded-b-button">
      <AppFramePicture title={title} snapshot={snapshot} dim />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-popover/80 p-4 text-center">{children}</div>
    </div>
  );
}

function AppFramePicture({ title, snapshot, dim = false }: { title: string; snapshot: string | undefined; dim?: boolean }) {
  return snapshot ? (
    <img src={snapshot} alt={title} draggable={false} className={cn("block h-full w-full object-cover object-top", dim && "opacity-60")} />
  ) : (
    <FrameSkeleton title={title} />
  );
}

/** A fresh one-use token for one mount of the iframe (D2). */
function newMountToken(): string {
  return crypto.randomUUID().replace(/-/gu, "");
}

/** The app's status for this frame's root, or a stopped stand-in when the root is a candidate or chosen root with no entry yet. */
function appStatusFor(snapshot: DesignAppsSnapshot, appRoot: string): DesignAppStatus | null {
  const app = snapshot.apps.find((entry) => entry.appRoot === appRoot);
  if (app) return app;
  const candidate = snapshot.candidates.find((entry) => entry.appRoot === appRoot);
  if (!candidate && !snapshot.chosen.includes(appRoot)) return null;
  return {
    workspaceId: snapshot.workspaceId,
    appRoot,
    source: "started",
    frameworkLabel: candidate?.frameworkLabel ?? "App",
    phase: "stopped",
    since: 0,
    revision: -1,
  };
}

/** What a frame that isn't showing its app says, and the one button it may offer. */
type Overlay = { text: string; action?: { label: string; run(): void } };

/** The overlay for an app's phase (D16, S77), or null when it runs. */
function phaseOverlay(app: DesignAppStatus, act: (action: "start" | "connect" | "retry") => void): Overlay | null {
  switch (app.phase) {
    case "running":
      return null;
    case "consent":
      return { text: "Waiting for you to allow the app to run" };
    case "installing":
    case "starting":
      return { text: app.source === "attached" ? "Connecting…" : "Starting…" };
    case "crashed":
      return { text: "The app's dev server stopped.", action: { label: "Retry", run: () => act("retry") } };
    case "stopped": {
      const connect = app.source === "attached" && app.url !== undefined && app.problem?.problem !== "attach-url-invalid";
      if (app.problem) {
        return connect
          ? { text: designAppProblemMessage(app.problem), action: { label: "Connect", run: () => act("connect") } }
          : { text: designAppProblemMessage(app.problem) };
      }
      if (app.source === "attached") {
        return connect ? { text: "Not connected", action: { label: "Connect", run: () => act("connect") } } : { text: "Not connected" };
      }
      return { text: "Not running", action: { label: "Start app", run: () => act("start") } };
    }
  }
}

/** The overlay for a mount that didn't give an origin. */
function mountOverlay(result: DesignAppFrameMountResult, app: DesignAppStatus): Overlay | null {
  if ("origin" in result) return result.origin.startsWith("http://[::1]") ? { text: IPV6_SENTENCE } : null;
  switch (result.error) {
    case "too-many-frames":
      return { text: "Too many live frames" };
    case "live-off":
      return { text: "Live apps are off" };
    case "app-not-running":
      // Main no longer ties the app to its address (a holder that is being looked for again).
      return { text: app.source === "attached" ? "Connecting…" : "Starting…" };
    case "unavailable":
      return { text: "This frame can't show the app." };
  }
}

/** The in-app path as the title row shows it: escaped, at most 60 characters. */
function shownPath(path: string): string {
  const escaped = consentDisplayText(path);
  return escaped.length > PATH_CHARS ? `${escaped.slice(0, PATH_CHARS - 1)}…` : escaped;
}

/** A refused link's host as the toast names it, escaped. */
function refusedHost(url: string): { label: string; openable: boolean } {
  try {
    const parsed = new URL(url);
    const openable = parsed.protocol === "http:" || parsed.protocol === "https:";
    return { label: consentDisplayText(parsed.host || parsed.protocol), openable };
  } catch {
    return { label: "That link", openable: false };
  }
}

/** One picture at a time, at most one per 2 s, a moment after the page last changed (D16). */
function useAppFrameCaptures(frameId: string, content: React.RefObject<HTMLElement | null>): () => void {
  const last = React.useRef(Number.NEGATIVE_INFINITY);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
  return React.useCallback(() => {
    if (timer.current !== null) return;
    const wait = Math.max(APP_FRAME_CAPTURE_SETTLE_MS, last.current + APP_FRAME_CAPTURE_GAP_MS - Date.now());
    timer.current = setTimeout(() => {
      timer.current = null;
      last.current = Date.now();
      const rect = rectOnCanvas(content.current);
      // A frame partly off the canvas isn't taken: the picture would hold whatever covers the rest.
      if (rect) void captureFrameSnapshot(designFrameSnapshots, frameId, 0, rect);
    }, wait);
  }, [frameId, content]);
}

/** Main's notices for this mount: blocked requests, suppressed dialogs, refused links. */
function useAppFrameEvents(
  frameId: string,
  mountToken: string | null,
  onOpenInBrowser: (url: string) => void,
): { blocked: number; hosts: string[]; dialogs: AppFrameDialogKind[] } {
  const [state, setState] = React.useState<{ token: string | null; blocked: number; hosts: string[]; dialogs: AppFrameDialogKind[] }>({
    token: null,
    blocked: 0,
    hosts: [],
    dialogs: [],
  });
  const openRef = React.useRef(onOpenInBrowser);
  React.useLayoutEffect(() => {
    openRef.current = onOpenInBrowser;
  });
  React.useEffect(() => {
    if (mountToken === null) return;
    let lastToast = Number.NEGATIVE_INFINITY;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const toastId = `design-app-refused:${frameId}`;
    const show = (url: string) => {
      lastToast = Date.now();
      const { label, openable } = refusedHost(url);
      toast(`${label} is outside the app`, {
        id: toastId,
        ...(openable ? { action: { label: "Open in browser", onClick: () => openRef.current(url) } } : {}),
      });
    };
    const off = designCanvasApi.onDesignAppFrame((event) => {
      if (event.frameId !== frameId || event.mountToken !== mountToken) return;
      if (event.kind === "blocked") {
        // Main sends running totals for this mount.
        setState((current) =>
          current.token === mountToken && current.blocked >= event.count
            ? current
            : { ...current, token: mountToken, blocked: event.count, hosts: event.hosts },
        );
      } else if (event.kind === "dialog-suppressed") {
        setState((current) =>
          current.token === mountToken && current.dialogs.includes(event.dialog)
            ? current
            : {
                ...(current.token === mountToken ? current : { blocked: 0, hosts: [], dialogs: [] }),
                token: mountToken,
                dialogs: [...(current.token === mountToken ? current.dialogs : []), event.dialog],
              },
        );
      } else {
        // Coalesced: at most one toast a second, and the one shown carries the latest link.
        pending = event.url;
        if (timer !== null) return;
        const wait = lastToast + APP_FRAME_REFUSED_TOAST_GAP_MS - Date.now();
        if (wait <= 0) {
          show(pending);
          pending = null;
          return;
        }
        timer = setTimeout(() => {
          timer = null;
          if (pending !== null) show(pending);
          pending = null;
        }, wait);
      }
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [frameId, mountToken]);
  return state.token === mountToken ? state : { blocked: 0, hosts: [], dialogs: [] };
}

function BlockedLabel({ blocked, hosts, dialogs }: { blocked: number; hosts: string[]; dialogs: AppFrameDialogKind[] }) {
  if (blocked === 0 && dialogs.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="bar" size="small" className="nodrag text-tertiary" onPointerDown={(event) => event.stopPropagation()}>
          {blocked > 0 ? `${blocked} blocked` : "Dialogs off"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="flex flex-col gap-2 text-small">
          {hosts.length > 0 ? (
            <ul aria-label="Blocked hosts" className="flex flex-col gap-0.5">
              {hosts.map((host) => (
                <li key={host} className="break-all text-primary">
                  {consentDisplayText(host)}
                </li>
              ))}
            </ul>
          ) : null}
          {hosts.length >= APP_FRAME_BLOCKED_HOSTS ? <span className="text-secondary">Other hosts may not be listed.</span> : null}
          {dialogs.length > 0 ? (
            <span className="text-secondary">Dialogs are turned off on the canvas: {dialogs.join(", ")}</span>
          ) : null}
          <span className="text-secondary">{LOCALHOST_SENTENCE}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ErrorLabel({ error }: { error: { message: string; at?: { path: string; line: number } } }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="bar" size="small" className="nodrag text-status-red" onPointerDown={(event) => event.stopPropagation()}>
          Error
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="flex flex-col gap-1 text-small">
          <span className="whitespace-pre-wrap break-words text-primary">{consentDisplayText(error.message)}</span>
          {error.at ? (
            <span className="text-secondary">
              {consentDisplayText(error.at.path)}:{error.at.line}
            </span>
          ) : null}
          <span className="text-secondary">Reported by the page.</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export type AppFrameProps = {
  frame: DesignFrame;
  chatId: string;
  selected?: boolean;
  /** One of the canvas's live frames (the six-live limit). */
  live: boolean;
  entered: boolean;
  onEnter(): void;
  /** The page's Esc asked to leave (only acted on while entered). */
  onLeave(): void;
  onOpenInBrowser(url: string): void;
  titleSlot?: React.ReactNode;
  actions?: React.ReactNode;
};

/** An app frame's body and title row. */
export function AppFrame({ frame, chatId, selected = false, live, entered, onEnter, onLeave, onOpenInBrowser, titleSlot, actions }: AppFrameProps) {
  const { designLive } = useAppCapabilities();
  const snapshotOfApps = useDesignAppsSnapshot(chatId, designLive);
  const appRoot = frame.appRoot ?? ".";
  const route = frame.route ?? "/";
  const viewport = frame.viewport ?? APP_DEFAULT_VIEWPORT;
  const scale = frame.scale ?? 0.5;
  const contentHeight = Math.max(0, frame.h - DESIGN_FRAME_HEADER_PX);
  const { snapshot } = useFrameSnapshot(frame.id, 0);

  // S75: one document-level guard while any app frame is on the canvas.
  React.useEffect(() => holdAppFrameFocusGuard(), []);

  // ── The app's status, with the instant rule for Start, Connect and Retry ──
  const base = snapshotOfApps ? appStatusFor(snapshotOfApps, appRoot) : null;
  const [override, setOverride] = React.useState<DesignAppStatus | null>(null);
  const app = base && override && override.appRoot === base.appRoot && override.revision >= base.revision ? override : base;
  const act = React.useCallback(
    (action: "start" | "connect" | "retry") => {
      if (!base) return;
      setOverride({ ...base, phase: "starting", problem: undefined });
      const call = action === "retry" ? designAppApi.retry(chatId, base.appRoot) : designAppApi.start(chatId, base.appRoot);
      call.then(
        (result) => {
          if (result.problem && result.phase === base.phase) {
            setOverride(null);
            toast.error(designAppProblemMessage(result.problem));
            return;
          }
          setOverride(result);
        },
        (error: unknown) => {
          setOverride(null);
          toast.error(error instanceof Error && error.message ? error.message : ACTION_FAILED);
        },
      );
    },
    [base, chatId],
  );

  // ── Mounting: main answers the origin for a fresh token (D2) ──
  const running = designLive && app?.phase === "running" && typeof app.origin === "string" && isAppFrameId(frame.id);
  const [nonce, setNonce] = React.useState(0);
  const mountKey = running && live ? `${app.origin}|${nonce}` : null;
  const [mount, setMount] = React.useState<{ key: string; token: string; revision: number; result: DesignAppFrameMountResult | null } | null>(null);
  const revisionRef = React.useRef(app?.revision ?? 0);
  revisionRef.current = app?.revision ?? 0;
  React.useEffect(() => {
    if (mountKey === null) {
      setMount(null);
      return;
    }
    let alive = true;
    const token = newMountToken();
    setMount({ key: mountKey, token, revision: revisionRef.current, result: null });
    designCanvasApi.mountDesignAppFrame(chatId, frame.id, token).then(
      (result) => {
        if (alive) setMount((current) => (current?.token === token ? { ...current, result } : current));
      },
      () => {
        if (alive) setMount((current) => (current?.token === token ? { ...current, result: { error: "unavailable" } } : current));
      },
    );
    return () => {
      alive = false;
    };
  }, [mountKey, chatId, frame.id]);
  // Main didn't tie the app to its address yet: try again once its status moves.
  const currentRevision = app?.revision ?? 0;
  React.useEffect(() => {
    if (mount?.result && "error" in mount.result && mount.result.error === "app-not-running" && currentRevision !== mount.revision) {
      setNonce((value) => value + 1);
    }
  }, [mount, currentRevision]);

  const origin =
    mount && mount.key === mountKey && mount.result && "origin" in mount.result && !mount.result.origin.startsWith("http://[::1]")
      ? mount.result.origin
      : null;
  const token = origin !== null ? mount!.token : null;

  // ── The iframe, the picture under it, and leaving the live set ──
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [loadedKey, setLoadedKey] = React.useState<string | null>(null);
  const iframeKey = origin !== null ? `${origin}|${token}` : null;
  // The last iframe shown, kept while the frame leaves the live set so its picture can be taken first.
  const [retained, setRetained] = React.useState<{ key: string; origin: string; token: string } | null>(null);
  if (iframeKey !== null && retained?.key !== iframeKey) setRetained({ key: iframeKey, origin: origin!, token: token! });
  const retiring = useRetiringFrame({
    frameId: frame.id,
    version: 0,
    live,
    showing: loadedKey !== null && loadedKey === (iframeKey ?? retained?.key),
    content: contentRef,
  });
  const shown = iframeKey !== null ? { key: iframeKey, origin: origin!, token: token! } : retiring ? retained : null;
  const loaded = shown !== null && loadedKey === shown.key;
  const requestCapture = useAppFrameCaptures(frame.id, contentRef);

  // ── The page's bridge: untrusted, bounded, 60 a second ──
  const [page, setPage] = React.useState<{ key: string; path: string | null; error: { message: string; at?: { path: string; line: number } } | null }>({
    key: "",
    path: null,
    error: null,
  });
  const pageState = shown && page.key === shown.key ? page : { key: shown?.key ?? "", path: null, error: null };
  const enteredRef = React.useRef({ entered, onLeave, dark: frame.colorScheme === "dark" });
  React.useLayoutEffect(() => {
    enteredRef.current = { entered, onLeave, dark: frame.colorScheme === "dark" };
  });
  const shownKey = shown?.key ?? null;
  const shownOrigin = shown?.origin ?? null;
  React.useEffect(() => {
    if (shownKey === null || shownOrigin === null) return;
    let windowStart = 0;
    let used = 0;
    const receive = (event: MessageEvent) => {
      const guest = iframeRef.current?.contentWindow;
      // A detached frame has no window; a sourceless message must never match.
      if (!guest || event.source !== guest || event.origin !== shownOrigin) return;
      const message = parseAppBridgeMessage(event.data, event.origin);
      if (!message) return;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        used = 0;
      }
      if (used >= APP_BRIDGE_MESSAGES_PER_SECOND) return;
      used += 1;
      switch (message.type) {
        case "ready":
          if (enteredRef.current.dark) postToAppPage(guest, shownOrigin, { type: "set-scheme", dark: true });
          return;
        case "route":
          setPage((current) => ({ ...(current.key === shownKey ? current : { error: null }), key: shownKey, path: message.path }));
          return;
        case "error":
          setPage((current) => ({
            ...(current.key === shownKey ? current : { path: null }),
            key: shownKey,
            error: { message: message.message, ...(message.at ? { at: message.at } : {}) },
          }));
          return;
        case "hmr":
          requestCapture();
          return;
        case "escape":
          if (enteredRef.current.entered) enteredRef.current.onLeave();
          return;
        default:
          // Source replies, picks and anchors are Phase 4's (S68).
          return;
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [shownKey, shownOrigin, requestCapture]);

  // The Dark switch: posted to this frame's page only, when it changes after load.
  const dark = frame.colorScheme === "dark";
  const postedDark = React.useRef<boolean | null>(null);
  React.useEffect(() => {
    if (!loaded || shownOrigin === null) {
      postedDark.current = null;
      return;
    }
    if (postedDark.current === null) {
      postedDark.current = dark;
      return;
    }
    if (postedDark.current === dark) return;
    postedDark.current = dark;
    postToAppPage(iframeRef.current?.contentWindow, shownOrigin, { type: "set-scheme", dark });
  }, [dark, loaded, shownOrigin]);

  const events = useAppFrameEvents(frame.id, shown?.token ?? null, onOpenInBrowser);

  // ── What the body shows ──
  let card: React.ReactNode = null;
  let overlay: Overlay | null = null;
  if (!designLive) card = "Live apps are off";
  else if (snapshotOfApps === null) card = designAppProblemMessage({ problem: "unavailable" });
  else if (snapshotOfApps !== undefined && !app) card = "This app isn't in this workspace";
  else if (app) {
    overlay = phaseOverlay(app, act);
    if (!overlay && live && mount?.key === mountKey && mount?.result) overlay = mountOverlay(mount.result, app);
  }

  const statusRow = (
    <>
      {pageState.path !== null && pageState.path !== route ? (
        <span className="max-w-48 truncate" title={consentDisplayText(pageState.path)}>
          {shownPath(pageState.path)}
        </span>
      ) : null}
      <span>{`${viewport.width} × ${viewport.height}`}</span>
      {pageState.error ? <ErrorLabel error={pageState.error} /> : null}
      <BlockedLabel {...events} />
    </>
  );

  let body: React.ReactNode;
  if (card !== null) {
    body = (
      <AppFrameCard title={frame.title} snapshot={snapshot}>
        <span className="text-strong text-secondary">{card}</span>
      </AppFrameCard>
    );
  } else if (overlay && !shown) {
    body = (
      <AppFrameCard title={frame.title} snapshot={snapshot}>
        <span className="text-strong text-secondary">{overlay.text}</span>
        {overlay.action ? (
          <Button
            variant="muted"
            size="small"
            className="nodrag"
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={overlay.action.run}
          >
            {overlay.action.label}
          </Button>
        ) : null}
      </AppFrameCard>
    );
  } else {
    body = (
      <div className="relative h-full w-full overflow-hidden rounded-b-button">
        {!shown || !loaded ? (
          <div className="absolute inset-0">
            <AppFramePicture title={frame.title} snapshot={snapshot} />
          </div>
        ) : null}
        {shown ? (
          <div
            className={cn("absolute inset-0 overflow-hidden", entered && "nodrag nowheel")}
            style={{ pointerEvents: entered ? undefined : "none" }}
          >
            <iframe
              key={shown.key}
              ref={iframeRef}
              data-app-frame-id={frame.id}
              {...(entered ? { [APP_FRAME_ENTERED_ATTRIBUTE]: "" } : {})}
              // S75: nothing inside takes focus until the person enters the frame.
              inert={!entered}
              name={appFrameName(frame.id, shown.token)}
              title={frame.title}
              sandbox={APP_FRAME_SANDBOX}
              allow={APP_FRAME_ALLOW}
              referrerPolicy="no-referrer"
              src={`${shown.origin}${route}`}
              tabIndex={entered ? 0 : -1}
              onLoad={() => {
                setLoadedKey(shown.key);
                requestCapture();
              }}
              className="block border-0 bg-background"
              style={{
                width: `${viewport.width}px`,
                height: `${scale > 0 ? contentHeight / scale : viewport.height}px`,
                transform: `scale(${scale})`,
                transformOrigin: "0 0",
                opacity: loaded ? 1 : 0,
                colorScheme: dark ? "dark" : "light",
              }}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="h-full w-full" onDoubleClick={card !== null ? undefined : onEnter}>
      <CanvasNodeChrome title={frame.title} titleSlot={titleSlot} selected={selected} flush status={statusRow} toolbar={actions}>
        <div ref={contentRef} className="relative h-full w-full overflow-hidden rounded-b-button">
          {body}
        </div>
      </CanvasNodeChrome>
    </div>
  );
}

export function AppNode({ id, data, selected }: NodeProps<DesignNode>) {
  const canvas = useDesignNodeContext();
  const { frame } = data;
  return (
    <>
      <DesignNodeResizer selected={selected} minSize={designMinSize("app")} keepAspectRatio />
      <AppFrame
        frame={frame}
        chatId={canvas.chatId}
        selected={selected}
        live={canvas.live.has(id)}
        entered={canvas.entered === id}
        onEnter={() => canvas.enter(id)}
        onLeave={() => canvas.leave(id)}
        onOpenInBrowser={canvas.openInBrowser}
        titleSlot={<FrameTitle frame={frame} />}
        actions={<FrameActions frame={frame} />}
      />
    </>
  );
}
