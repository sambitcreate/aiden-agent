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
  APP_DEFAULT_SCALE,
  APP_DEFAULT_VIEWPORT,
  appFrameName,
  isAppFrameId,
  isAppRoute,
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
import { AppViewportRulerToolbar } from "../app-viewport-ruler";
import { useDesignAppsSnapshot } from "../design-app-chip";
import { captureFrameSnapshot, designFrameSnapshots, useFrameSnapshot } from "../frame-snapshots";
import { DESIGN_FRAME_HEADER_PX, useDesignNodeContext } from "./design-node-context";
import { FrameActions } from "./frame-actions";
import { AppFrameResizers, DesignNodeResizer, FrameSkeleton, rectOnCanvas, useRetiringFrame } from "./frame-parts";
import { FrameTitle } from "./frame-title";
import { LayoutGuide } from "./layout-guide";

/** At most this many bridge messages are read per second per frame; the rest are dropped (D12). */
export const APP_BRIDGE_MESSAGES_PER_SECOND = 60;
/** Pictures of a live app frame are taken at most this often (D16). */
export const APP_FRAME_CAPTURE_GAP_MS = 2000;
/** A picture waits this long after a load or a hot update, so the page has drawn. */
export const APP_FRAME_CAPTURE_SETTLE_MS = 400;
/** Refused navigations show at most one toast per this long per frame; the latest link wins (D16). */
export const APP_FRAME_REFUSED_TOAST_GAP_MS = 1000;
/**
 * Putting a frame back after a blocked way out (S1) is bounded per mount. A
 * frame nobody has entered can't be clicked, so its ways out are its page's
 * own: it is put back once. An entered frame is put back up to three times,
 * and gets them back after the person stays in it a while with no way out,
 * enters it afresh, or presses Reload.
 */
const APP_FRAME_RESTORES_NOT_ENTERED = 1;
const APP_FRAME_RESTORES_ENTERED = 3;
const APP_FRAME_RESTORE_STAY_MS = 10_000;
const monotonicNow = () => performance.now();
/** An in-app path is shown up to this many characters. */
const PATH_CHARS = 60;

const IPV6_SENTENCE = "This app runs on IPv6 localhost, which the canvas can't show yet. Restart it on 127.0.0.1.";
const LOCALHOST_SENTENCE = "Design mode only lets apps reach localhost for now.";
const ACTION_FAILED = "Aiden couldn't do that.";
const NO_BREAKPOINTS: readonly number[] = Object.freeze([]);

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

/**
 * One picture at a time, at most one per 2 s, a moment after the page last
 * changed (D16). Only while the loaded page is showing: a picture due when
 * the page goes (the app stopped, the frame left) is dropped, never taken of
 * the card in its place.
 */
function useAppFrameCaptures(frameId: string, content: React.RefObject<HTMLElement | null>, showing: boolean): () => void {
  const last = React.useRef(Number.NEGATIVE_INFINITY);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const showingRef = React.useRef(showing);
  showingRef.current = showing;
  React.useEffect(() => {
    if (showing) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, [showing, frameId]);
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
      if (!showingRef.current) return;
      last.current = Date.now();
      const rect = rectOnCanvas(content.current);
      // A frame partly off the canvas isn't taken: the picture would hold whatever covers the rest.
      if (rect) void captureFrameSnapshot(designFrameSnapshots, frameId, 0, rect);
    }, wait);
  }, [frameId, content]);
}

/** Main's notices for this mount: blocked requests, suppressed dialogs, refused links, and putting the frame back. */
function useAppFrameEvents(
  frameId: string,
  mountToken: string | null,
  onOpenInBrowser: (url: string) => void,
  onRestore: () => void,
): { blocked: number; hosts: string[]; dialogs: AppFrameDialogKind[] } {
  const [state, setState] = React.useState<{ token: string | null; blocked: number; hosts: string[]; dialogs: AppFrameDialogKind[] }>({
    token: null,
    blocked: 0,
    hosts: [],
    dialogs: [],
  });
  const openRef = React.useRef(onOpenInBrowser);
  const restoreRef = React.useRef(onRestore);
  React.useLayoutEffect(() => {
    openRef.current = onOpenInBrowser;
    restoreRef.current = onRestore;
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
      if (event.kind === "navigation-restore") {
        restoreRef.current();
      } else if (event.kind === "blocked") {
        // Main sends running totals for this mount.
        setState((current) =>
          current.token === mountToken && current.blocked >= event.count
            ? current
            : {
                ...(current.token === mountToken ? current : { dialogs: [] }),
                token: mountToken,
                blocked: event.count,
                hosts: event.hosts,
              },
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
        <Button
          variant="bar"
          size="small"
          className="nodrag text-tertiary"
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
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
        <Button
          variant="bar"
          size="small"
          className="nodrag text-status-red"
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
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
  /** A monotonic clock for the restore bound (tests pass their own). */
  now?: () => number;
  /** 3c (S91): what the frame draws with its page's breakpoints (the resize ruler); display only. */
  ruler?: (breakpoints: readonly number[]) => React.ReactNode;
};

/** An app frame's body and title row. */
export function AppFrame({
  frame,
  chatId,
  selected = false,
  live,
  entered,
  onEnter,
  onLeave,
  onOpenInBrowser,
  titleSlot,
  actions,
  now = monotonicNow,
  ruler,
}: AppFrameProps) {
  const { designLive } = useAppCapabilities();
  const snapshotOfApps = useDesignAppsSnapshot(chatId, designLive);
  const appRoot = frame.appRoot ?? ".";
  const route = frame.route ?? "/";
  const viewport = frame.viewport ?? APP_DEFAULT_VIEWPORT;
  const scale = frame.scale ?? 0.5;
  const contentHeight = Math.max(0, frame.h - DESIGN_FRAME_HEADER_PX);
  const { snapshot } = useFrameSnapshot(frame.id, 0);

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
  // The iframe went while the frame stayed live (the app stopped or moved): there's nothing left to retire.
  else if (iframeKey === null && live && retained !== null) setRetained(null);
  const retiring = useRetiringFrame({
    frameId: frame.id,
    version: 0,
    live,
    showing: loadedKey !== null && loadedKey === (iframeKey ?? retained?.key),
    content: contentRef,
  });
  const shown = iframeKey !== null ? { key: iframeKey, origin: origin!, token: token! } : retiring ? retained : null;
  const loaded = shown !== null && loadedKey === shown.key;

  // Set when the page keeps leading out of the app and the frame stops putting it back (S1).
  const [stuckKey, setStuckKey] = React.useState<string | null>(null);
  const stuck = shown !== null && stuckKey === shown.key;

  // Entering holds for the page that was on screen when the person entered:
  // once it goes (the app stopped, restarted or moved), or the frame is stuck
  // behind its card, the frame is left and goes inert. A frame entered with
  // no page is left at once.
  const [enteredKey, setEnteredKey] = React.useState<string | null>(null);
  if (entered && enteredKey === null && iframeKey !== null) setEnteredKey(iframeKey);
  else if (!entered && enteredKey !== null) setEnteredKey(null);
  const inside = entered && iframeKey !== null && enteredKey === iframeKey && !stuck;
  const stale = entered && (stuck || iframeKey === null || (enteredKey !== null && enteredKey !== iframeKey));
  const leaveRef = React.useRef(onLeave);
  React.useLayoutEffect(() => {
    leaveRef.current = onLeave;
  });
  React.useEffect(() => {
    if (stale) leaveRef.current();
  }, [stale]);

  const requestCapture = useAppFrameCaptures(frame.id, contentRef, loaded && !stuck);

  // S75: one document-level guard while any app frame shows a page. A layout
  // effect, so it is up in the same commit that puts the iframe in the DOM:
  // a passive effect runs a task later, and a focus move in between went
  // unanswered.
  const framing = shown !== null;
  React.useLayoutEffect(() => (framing ? holdAppFrameFocusGuard() : undefined), [framing]);

  // ── The page's bridge: untrusted, bounded, 60 a second ──
  const [page, setPage] = React.useState<{ key: string; path: string | null; error: { message: string; at?: { path: string; line: number } } | null }>({
    key: "",
    path: null,
    error: null,
  });
  // A new route (3b: canvas_update_frame or the picker retargets the frame)
  // starts clean: the old route's path, error, load and stuck state don't carry over.
  // 3c (S91): the page's breakpoints, for this mount's page only.
  const [breakpoints, setBreakpoints] = React.useState<{ key: string | null; widths: readonly number[] }>({ key: null, widths: [] });
  const [routeShown, setRouteShown] = React.useState(route);
  if (routeShown !== route) {
    setRouteShown(route);
    setBreakpoints({ key: null, widths: [] });
    setPage({ key: "", path: null, error: null });
    setLoadedKey(null);
    setStuckKey(null);
  }
  const pageState = shown && page.key === shown.key ? page : { key: shown?.key ?? "", path: null, error: null };
  const enteredRef = React.useRef({ entered: inside, onLeave, dark: frame.colorScheme === "dark" });
  React.useLayoutEffect(() => {
    enteredRef.current = { entered: inside, onLeave, dark: frame.colorScheme === "dark" };
  });
  const shownKey = shown?.key ?? null;
  const shownOrigin = shown?.origin ?? null;
  const pageBreakpoints = shownKey !== null && breakpoints.key === shownKey ? breakpoints.widths : NO_BREAKPOINTS;
  /** The scheme this mount's page was last told (a page starts light until told). */
  const postedScheme = React.useRef<{ key: string | null; dark: boolean }>({ key: null, dark: false });
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
          // A fresh page starts in its own scheme.
          postedScheme.current = { key: shownKey, dark: enteredRef.current.dark };
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
        case "breakpoints":
          setBreakpoints({ key: shownKey, widths: message.widths });
          return;
        default:
          // Source replies, picks and anchors are Phase 4's (S68).
          return;
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [shownKey, shownOrigin, requestCapture]);

  // The Dark switch: posted to this frame's page only, once it has loaded,
  // whenever the page wasn't last told the switch's state (so a press before
  // load is sent at load).
  const dark = frame.colorScheme === "dark";
  React.useEffect(() => {
    if (!loaded || shownKey === null || shownOrigin === null) return;
    const told = postedScheme.current.key === shownKey ? postedScheme.current.dark : false;
    if (told === dark) return;
    postedScheme.current = { key: shownKey, dark };
    postToAppPage(iframeRef.current?.contentWindow, shownOrigin, { type: "set-scheme", dark });
  }, [dark, loaded, shownKey, shownOrigin]);

  // S1, D1: main says the window's frame-src left the frame on Chromium's blocked
  // page; it goes back to the last path its own page reported, or its route.
  // Bounded per mount (see APP_FRAME_RESTORES_*), never by what the page says:
  // the restore after one to a path always goes to the route, and a way out
  // past the budget stops the reloads; the frame then says so and offers Reload.
  const lastPathRef = React.useRef<string | null>(null);
  lastPathRef.current = pageState.path !== null && isAppRoute(pageState.path) ? pageState.path : null;
  type Restores = { key: string | null; count: number; lastAt: number | null; toPath: boolean };
  const restores = React.useRef<Restores>({ key: null, count: 0, lastAt: null, toPath: false });
  const clockRef = React.useRef(now);
  clockRef.current = now;
  const insideRef = React.useRef(inside);
  insideRef.current = inside;
  const insideSince = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!inside) {
      insideSince.current = null;
      return;
    }
    // A fresh enter gives the frame its restores back.
    insideSince.current = clockRef.current();
    restores.current = { ...restores.current, count: 0 };
  }, [inside]);
  // The new route gets its own restores.
  React.useLayoutEffect(() => {
    restores.current = { key: null, count: 0, lastAt: null, toPath: false };
  }, [route]);
  const stuckRef = React.useRef(stuck);
  stuckRef.current = stuck;
  const forgetPath = React.useCallback(() => {
    lastPathRef.current = null;
    setPage((current) => (current.key === shownKey ? { ...current, path: null } : current));
  }, [shownKey]);
  const restore = React.useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe || shownOrigin === null || shownKey === null || stuckRef.current) return;
    const at = clockRef.current();
    const previous: Restores = restores.current.key === shownKey ? restores.current : { key: shownKey, count: 0, lastAt: null, toPath: false };
    const enteredNow = insideRef.current;
    let count = previous.count;
    // The person stayed in the frame a while since entering and since its last way out.
    const stayedFrom = Math.max(previous.lastAt ?? Number.NEGATIVE_INFINITY, insideSince.current ?? Number.POSITIVE_INFINITY);
    if (enteredNow && at - stayedFrom >= APP_FRAME_RESTORE_STAY_MS) count = 0;
    count += 1;
    if (count > (enteredNow ? APP_FRAME_RESTORES_ENTERED : APP_FRAME_RESTORES_NOT_ENTERED)) {
      restores.current = { key: shownKey, count, lastAt: at, toPath: false };
      stuckRef.current = true;
      setStuckKey(shownKey);
      return;
    }
    let path = lastPathRef.current;
    if (previous.toPath) {
      path = null;
      forgetPath();
    }
    restores.current = { key: shownKey, count, lastAt: at, toPath: path !== null && path !== route };
    iframe.src = `${shownOrigin}${path ?? route}`;
  }, [shownOrigin, shownKey, route, forgetPath]);
  const reload = () => {
    const iframe = iframeRef.current;
    restores.current = { key: shownKey, count: 0, lastAt: null, toPath: false };
    stuckRef.current = false;
    forgetPath();
    setStuckKey(null);
    if (iframe && shownOrigin !== null) iframe.src = `${shownOrigin}${route}`;
  };
  const events = useAppFrameEvents(frame.id, shown?.token ?? null, onOpenInBrowser, restore);

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

  // Only a page on screen in the live set can be entered (not a card, a picture or a retiring frame).
  const enterable = card === null && live && iframeKey !== null && !stuck;

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
            className={cn("absolute inset-0 overflow-hidden", inside && "nodrag nowheel")}
            style={{ pointerEvents: inside ? undefined : "none" }}
          >
            <iframe
              key={shown.key}
              ref={iframeRef}
              data-app-frame-id={frame.id}
              {...(inside ? { [APP_FRAME_ENTERED_ATTRIBUTE]: "" } : {})}
              // S75: nothing inside takes focus until the person enters the frame.
              inert={!inside}
              name={appFrameName(frame.id, shown.token)}
              title={frame.title}
              sandbox={APP_FRAME_SANDBOX}
              allow={APP_FRAME_ALLOW}
              referrerPolicy="no-referrer"
              src={`${shown.origin}${route}`}
              tabIndex={inside ? 0 : -1}
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
        {stuck ? (
          <div className="absolute inset-0">
            <AppFrameCard title={frame.title} snapshot={snapshot}>
              <span className="text-strong text-secondary">This page leads outside the app.</span>
              <Button
                variant="muted"
                size="small"
                className="nodrag"
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={reload}
              >
                Reload
              </Button>
            </AppFrameCard>
          </div>
        ) : null}
      </div>
    );
  }

  // 3b (S85): a variant's label follows the title, in muted text.
  const titledRow = frame.label ? (
    <>
      {titleSlot ?? <span className="min-w-0 flex-1 truncate text-strong text-primary">{frame.title}</span>}
      <span className="max-w-[40%] shrink-0 truncate text-secondary">{frame.label}</span>
    </>
  ) : (
    titleSlot
  );

  return (
    <div className="h-full w-full" onDoubleClick={enterable ? onEnter : undefined}>
      <CanvasNodeChrome title={frame.title} titleSlot={titledRow} selected={selected} flush status={statusRow} toolbar={actions}>
        <div ref={contentRef} className="relative h-full w-full overflow-hidden rounded-b-button">
          {body}
          {frame.guide ? <LayoutGuide guide={frame.guide} scale={scale} /> : null}
        </div>
      </CanvasNodeChrome>
      {ruler ? ruler(pageBreakpoints) : null}
    </div>
  );
}

/**
 * The final size of a resize, said once politely when it ends (S91): nothing
 * during the drag, and the region stays mounted so the words are read.
 */
function useResizeAnnouncement(resizing: boolean, viewport: { width: number; height: number }): string {
  const [said, setSaid] = React.useState("");
  const [was, setWas] = React.useState(resizing);
  if (was !== resizing) {
    setWas(resizing);
    setSaid(resizing ? "" : `Viewport ${viewport.width} by ${viewport.height}`);
  }
  return said;
}

export function AppNode({ id, data, selected }: NodeProps<DesignNode>) {
  const canvas = useDesignNodeContext();
  const { designLive } = useAppCapabilities();
  const { frame } = data;
  const resize = designLive && canvas.activeResize?.frameId === id ? canvas.activeResize.side : null;
  const viewport = frame.viewport ?? APP_DEFAULT_VIEWPORT;
  const scale = frame.scale ?? APP_DEFAULT_SCALE;
  const announcement = useResizeAnnouncement(resize !== null, viewport);
  const ruler = React.useCallback(
    (breakpoints: readonly number[]) =>
      resize === null ? null : <AppViewportRulerToolbar nodeId={id} side={resize} viewport={viewport} scale={scale} breakpoints={breakpoints} />,
    [id, resize, viewport, scale],
  );
  return (
    <>
      {designLive ? (
        // 3c (S89): edges change the viewport, corners scale.
        <AppFrameResizers
          nodeId={id}
          selected={selected}
          minSize={designMinSize("app")}
          scale={scale}
          onStart={(mode) => canvas.resizeStart(id, mode)}
        />
      ) : (
        <DesignNodeResizer selected={selected} minSize={designMinSize("app")} keepAspectRatio />
      )}
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
        ruler={designLive ? ruler : undefined}
      />
      {designLive ? (
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>
      ) : null}
    </>
  );
}
