// The design subscribers on the default session's two dispatchers (design
// mode v2 Phase 3a, D3–D8). `main/index.ts` installs them right after the
// claims and before the first window. With live apps off nothing is
// subscribed, so the session has no listener and the permission handlers are
// exactly Gemini Live's; only the S76 startup clear of app service workers
// runs, flag on or off.

import { appendFileSync } from "node:fs";

import type { DesignAppFrameEvent } from "../../../../renderer/shared/design-canvas/app-frame-events.js";
import type { DefaultSessionPermissions } from "../../default-session-permissions.js";
import type { DefaultSessionWebRequest } from "../../default-session-web-request.js";
import { AppFrameRegistry } from "./app-frame-registry.js";
import { appFrameRef, mainFrameIdOf, type FrameLike } from "./app-frame-ref.js";
import {
  AppCancelCache,
  appResponseHeaders,
  decideAppRequest,
  isLoopbackHttpOrigin,
  type AppPolicyContext,
} from "./app-network-policy.js";
import type { AppServiceWorkerOrigins } from "./app-sw-origins.js";

/** Initiator-less frameless requests Aiden itself makes on the default session (D4); audited in the Space. */
export const APP_FRAMELESS_ALLOWLIST: readonly string[] = [];

const SUBSCRIBER = "design-live";
const FLOOR_PORTS = [9222, 9229];
const LOG_EVERY_MS = 60_000;

export type MainContentsLike = {
  readonly id: number;
  readonly mainFrame: { readonly frameTreeNodeId: number };
  send(channel: string, ...args: unknown[]): void;
  isDestroyed?(): boolean;
};

export type AppNetworkDeps = {
  enabled: boolean;
  webRequest: DefaultSessionWebRequest;
  permissions: DefaultSessionPermissions;
  isAppOrigin(origin: string): boolean;
  /** The current main window's web contents, through a getter (never a captured reference). */
  mainContents(): MainContentsLike | null;
  rendererOrigin: string;
  /** Aiden's registered loopback ports, read live. */
  loopbackPorts: { snapshot(): ReadonlySet<number>; version?(): number };
  commandLine: { getSwitchValue(name: string): string };
  inspectorUrl(): string | undefined;
  serviceWorkers?: AppServiceWorkerOrigins;
  log(event: string, fields: Record<string, unknown>): void;
  /** `AIDEN_E2E_DESIGN_LIVE_RECORD` in non-packaged builds only. */
  recordFile?: string;
  now?: () => number;
  /** The registry's blocked-event timer, for tests. */
  schedule?: (callback: () => void, ms: number) => unknown;
  /** 2b/2c's owner lookup, so forgetting a workspace clears only its app origins (S76). */
  appForOrigin?(origin: string): { workspaceId: string; appRoot: string } | undefined;
  frameless?: readonly string[];
};

export type AppNetwork = {
  registry: AppFrameRegistry;
  ownPorts(): ReadonlySet<number>;
  /** Clears the service workers of the app origins admitted for this workspace (S76). */
  forgetWorkspace(workspaceId: string): Promise<void>;
  dispose(): void;
};

let installed: AppNetwork | null = null;

/** The design subscribers `main/index.ts` installed, or null with live apps off or before ready. */
export function installedAppNetwork(): AppNetwork | null {
  return installed;
}

function portOf(value: string | undefined): number | null {
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function inspectorPort(url: string | undefined): number | null {
  if (!url) return null;
  try {
    return portOf(new URL(url).port);
  } catch {
    return null;
  }
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export function installAppNetwork(deps: AppNetworkDeps): AppNetwork | null {
  // S76: whatever an app registered in an earlier run stops now, flag on or
  // off. It never blocks window creation, and it is queued before any
  // admission's `remember`.
  void deps.serviceWorkers?.clear().catch(() => undefined);
  if (!deps.enabled) return null;
  const now = deps.now ?? Date.now;
  const removals: Array<() => void> = [];

  // ---- Aiden's own ports (D5) ----
  const fixedPorts = new Set<number>(FLOOR_PORTS);
  const debugging = portOf(deps.commandLine.getSwitchValue("remote-debugging-port"));
  if (debugging) fixedPorts.add(debugging);
  const inspector = inspectorPort(deps.inspectorUrl());
  if (inspector) fixedPorts.add(inspector);
  try {
    const renderer = new URL(deps.rendererOrigin);
    const port = portOf(renderer.port);
    if (renderer.protocol === "http:" && port) fixedPorts.add(port);
  } catch {
    // file:// has no port.
  }
  let cachedPorts: { key: string; ports: ReadonlySet<number> } | null = null;
  const ownPorts = (): ReadonlySet<number> => {
    const live = deps.loopbackPorts.snapshot();
    const key = deps.loopbackPorts.version ? String(deps.loopbackPorts.version()) : [...live].join(",");
    if (cachedPorts?.key === key) return cachedPorts.ports;
    const ports = new Set<number>([...fixedPorts, ...live]);
    cachedPorts = { key, ports };
    record({ event: "own-ports", ports: [...ports] });
    return ports;
  };

  // ---- The test-only recorder (D6) ----
  function record(line: Record<string, unknown>): void {
    if (!deps.recordFile) return;
    try {
      appendFileSync(deps.recordFile, `${JSON.stringify(line)}\n`);
    } catch {
      // The recorder never affects a decision.
    }
  }

  const registry = new AppFrameRegistry({
    mainContents: () => deps.mainContents(),
    liveIds: () => {
      const contents = deps.mainContents();
      if (!contents) return null;
      try {
        const frames = (contents.mainFrame as unknown as { framesInSubtree: Array<{ frameTreeNodeId: number }> }).framesInSubtree;
        return new Set(frames.map((frame) => frame.frameTreeNodeId));
      } catch {
        return null;
      }
    },
    rendererOrigin: deps.rendererOrigin,
    now,
    schedule: deps.schedule,
  });
  // Admitted origins per workspace, in memory only; the device-local list holds origins alone.
  const workspaceOrigins = new Map<string, Set<string>>();
  removals.push(
    registry.onEvent((event: DesignAppFrameEvent) => {
      const contents = deps.mainContents();
      if (!contents || contents.isDestroyed?.()) return;
      try {
        contents.send("designCanvas:appFrame", event);
      } catch {
        // A closing window misses the event.
      }
    }),
  );
  /**
   * S76: an origin whose page ran in app context may have registered a
   * service worker. It is remembered for the start-up clear and tied to the
   * workspace of the app it was reached from (`via`, an admitted app origin).
   */
  const rememberPage = (origin: string, via: string | null) => {
    const workspaceId = via !== null ? deps.appForOrigin?.(via)?.workspaceId : undefined;
    if (workspaceId !== undefined) {
      const origins = workspaceOrigins.get(workspaceId) ?? new Set<string>();
      origins.add(origin);
      workspaceOrigins.set(workspaceId, origins);
    }
    void deps.serviceWorkers?.remember(origin).catch(() => undefined);
  };
  removals.push(registry.onAdmit((origin) => rememberPage(origin, origin)));

  const cache = new AppCancelCache({ now });
  const policy: AppPolicyContext = {
    appContext: (frame, inMainWindow) => registry.appContext(frame, inMainWindow),
    isAppOrigin: (origin) => deps.isAppOrigin(origin),
    isExportContents: (id) => registry.isExportContents(id),
    rendererOrigin: deps.rendererOrigin,
    get ownPorts() {
      return ownPorts();
    },
    frameless: deps.frameless ?? APP_FRAMELESS_ALLOWLIST,
    cache,
  };

  const framelessLogged = new Map<string, number>();
  const logFrameless = (host: string) => {
    const at = now();
    const last = framelessLogged.get(host);
    if (last !== undefined && at - last < LOG_EVERY_MS) return;
    framelessLogged.set(host, at);
    deps.log("design-live frameless-cancel", { host });
  };

  /** The request's frame and whether it belongs to the current main window. */
  const locate = (details: { webContentsId?: number; frame?: FrameLike | null }) => {
    const contents = deps.mainContents();
    const inMainWindow = contents !== null && details.webContentsId !== undefined && details.webContentsId === contents.id;
    const mainId = inMainWindow ? mainFrameIdOf(contents) : null;
    const frame = details.frame ? appFrameRef(details.frame, mainId) : null;
    return { inMainWindow, frame };
  };

  const frameIdOf = (frame: ReturnType<typeof appFrameRef> | null): number | null => {
    try {
      return frame ? frame.frameTreeNodeId : null;
    } catch {
      return null;
    }
  };

  removals.push(
    deps.webRequest.onBeforeRequest(SUBSCRIBER, (details) => {
      // An export window settles once it has started nothing for a while (D18).
      if (details.webContentsId !== undefined) registry.noteExportRequest(details.webContentsId);
      const { inMainWindow, frame } = locate(details as { webContentsId?: number; frame?: FrameLike | null });
      const decision = decideAppRequest(
        { url: details.url, frame, initiatorOrigin: details.initiatorOrigin, webContentsId: details.webContentsId, inMainWindow },
        policy,
      );
      if (decision.context !== null) {
        let scheme = "unknown";
        try {
          scheme = new URL(details.url).protocol.slice(0, -1);
        } catch {
          // Unparsable.
        }
        record({
          event: "request",
          resourceType: details.resourceType,
          frameTreeNodeId: frameIdOf(frame),
          initiatorOrigin: details.initiatorOrigin ?? null,
          context: decision.context,
          scheme,
          target: decision.target,
          verdict: decision.verdict,
        });
      }
      if (decision.verdict !== "cancel") {
        // A page an app frame (or export window) reached on another local server (G5) can
        // register a service worker for that origin too: remember every such page's origin.
        const page = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
        const origin = page && decision.context !== null && decision.context !== "frameless-app" && decision.context !== "frameless-unknown" ? originOf(details.url) : null;
        if (origin !== null && origin !== deps.rendererOrigin && isLoopbackHttpOrigin(origin)) {
          rememberPage(origin, registry.admittedOrigin(frame) ?? (deps.isAppOrigin(origin) ? origin : null));
        }
        return undefined;
      }
      if (decision.context === "registered") registry.reportBlocked(frame, decision.target);
      if (decision.context === "frameless-unknown") logFrameless(decision.target);
      return "cancel";
    }),
  );

  removals.push(
    deps.webRequest.onHeadersReceived(SUBSCRIBER, (details, headers) => {
      const { inMainWindow, frame } = locate(details as { webContentsId?: number; frame?: FrameLike | null });
      const isExport = details.webContentsId !== undefined && registry.isExportContents(details.webContentsId);
      let appContext = isExport || registry.appContext(frame, inMainWindow) !== null;
      if (!appContext && !frame) {
        // A worker or service-worker script an app origin asked for.
        const initiator = details.initiatorOrigin;
        appContext =
          initiator !== undefined &&
          initiator !== deps.rendererOrigin &&
          (initiator === "null" || deps.isAppOrigin(initiator) || isLoopbackHttpOrigin(initiator));
      }
      if (!appContext) return undefined;
      const origin = originOf(details.url);
      return appResponseHeaders(headers, {
        appOrigin: origin !== null && deps.isAppOrigin(origin),
        resourceType: details.resourceType,
        exportMainFrame: isExport && details.resourceType === "mainFrame",
      });
    }),
  );

  // ---- Permissions, downloads and choosers (D8) ----
  const ownUrl = (url: string | undefined): boolean => {
    if (!url) return false;
    const lower = url.toLowerCase();
    const own = (value: string) =>
      value.startsWith("aiden-design:") ||
      value.startsWith("aiden-genui:") ||
      (deps.rendererOrigin === "file://" ? value.startsWith("file://") : value === deps.rendererOrigin || value.startsWith(`${deps.rendererOrigin}/`));
    if (lower.startsWith("blob:")) return own(lower.slice(5));
    return own(lower);
  };
  const loopbackNotRenderer = (origin: string | null): boolean =>
    origin !== null && origin !== deps.rendererOrigin && isLoopbackHttpOrigin(origin);
  const isMainContents = (contents: { id: number } | null | undefined): boolean => {
    const main = deps.mainContents();
    return !!contents && !!main && contents.id === main.id;
  };
  const appOriginOf = (url: string | undefined) => {
    const origin = originOf(url);
    return origin !== null && deps.isAppOrigin(origin);
  };
  const frameInAppContext = (contents: { id: number } | null | undefined, frame: FrameLike | null | undefined): boolean => {
    if (!frame) return false;
    const inMain = isMainContents(contents ?? null);
    const main = deps.mainContents();
    return registry.appContext(appFrameRef(frame, inMain ? mainFrameIdOf(main) : null), inMain) !== null;
  };

  /**
   * For handlers Electron gives only a frame, from any default-session window
   * (the main window, Quick Chat, the pill, bot bubbles, export windows): the
   * frame is app context when it or an ancestor is on an app origin or another
   * loopback origin (which covers export windows), or when it sits in the main
   * window under an admitted app frame. A detached or unreadable frame is.
   */
  const frameIsApp = (frame: FrameLike): boolean => {
    try {
      if ((frame as { detached?: boolean }).detached === true) return true;
      let top: FrameLike = frame;
      let current: FrameLike | null = frame;
      for (let depth = 0; current && depth < 64; current = current.parent, depth++) {
        if (appOriginOf(current.url) || loopbackNotRenderer(originOf(current.url))) return true;
        top = current;
      }
      // Too deep to see the top: fail closed, as the registry's walk does.
      if (current) return true;
      const mainId = mainFrameIdOf(deps.mainContents());
      if (mainId === null || top.frameTreeNodeId !== mainId) return false;
      return registry.appContext(appFrameRef(frame, mainId), true) !== null;
    } catch {
      return true;
    }
  };

  removals.push(
    deps.permissions.addDenyLayer(SUBSCRIBER, {
      denyCheck: (contents, _permission, requestingOrigin, details) => {
        if (contents && registry.isExportContents(contents.id)) return true;
        if (contents && isMainContents(contents) && details.isMainFrame === false && !ownUrl(details.requestingUrl)) return true;
        if (appOriginOf(details.requestingUrl) || appOriginOf(requestingOrigin)) return true;
        if (!contents) {
          const security = originOf((details as { securityOrigin?: string }).securityOrigin);
          if (loopbackNotRenderer(security) || loopbackNotRenderer(originOf(details.requestingUrl)) || loopbackNotRenderer(originOf(requestingOrigin))) {
            return true;
          }
          if ((security !== null && deps.isAppOrigin(security))) return true;
        }
        return false;
      },
      denyRequest: (contents, _permission, details) => {
        if (registry.isExportContents(contents.id)) return true;
        if (isMainContents(contents) && details.isMainFrame === false && !ownUrl(details.requestingUrl)) return true;
        return appOriginOf(details.requestingUrl);
      },
      denyDisplay: (request) => {
        const security = (request as { securityOrigin?: string }).securityOrigin;
        const securityOrigin = originOf(security);
        if ((securityOrigin !== null && deps.isAppOrigin(securityOrigin)) || loopbackNotRenderer(securityOrigin)) return true;
        const frame = (request as { frame?: FrameLike | null }).frame ?? null;
        // Without a frame (it navigated or closed), only Aiden's own documents pass.
        if (!frame) return !ownUrl(security);
        return frameIsApp(frame);
      },
      denyDevice: (details) => {
        const origin = originOf(details.origin);
        return (origin !== null && deps.isAppOrigin(origin)) || loopbackNotRenderer(origin);
      },
    }),
  );
  removals.push(
    deps.permissions.onWillDownload(SUBSCRIBER, (item, contents, frame) => {
      if (registry.isExportContents(contents.id)) return "cancel";
      if (!frame) {
        // The frame is gone (it navigated or closed); the item still names who started it.
        let initiator: string | null = null;
        try {
          initiator = originOf(item.getInitiatorOrigin?.());
        } catch {
          return "cancel";
        }
        return (initiator !== null && deps.isAppOrigin(initiator)) || loopbackNotRenderer(initiator) ? "cancel" : undefined;
      }
      return frameInAppContext(contents, frame) ? "cancel" : undefined;
    }),
  );
  removals.push(
    deps.permissions.onSelectDevice(SUBSCRIBER, (kind, details) => {
      if (kind === "serial") {
        // Serial names no frame. The main window hosts app frames and Aiden
        // itself uses no chooser, so it cancels there and in export windows.
        const contents = details.webContents;
        if (!contents) return "cancel";
        return isMainContents(contents) || registry.isExportContents(contents.id) ? "cancel" : undefined;
      }
      if (!details.frame) return "cancel";
      return frameIsApp(details.frame) ? "cancel" : undefined;
    }),
  );

  record({ event: "install", ports: [...ownPorts()] });
  removals.push(
    registry.onAdmit((origin) => record({ event: "admitted", origin })),
  );

  const network: AppNetwork = {
    registry,
    ownPorts,
    async forgetWorkspace(workspaceId) {
      const origins = workspaceOrigins.get(workspaceId);
      workspaceOrigins.delete(workspaceId);
      // An origin another workspace's frames also reached keeps its worker and
      // its record: a session's worker is per origin, so clearing it now would
      // pull it from under a page that is still live. It is cleared when the
      // last workspace that reached it ends, or at the next start.
      const stillOwned = new Set([...workspaceOrigins.values()].flatMap((set) => [...set]));
      const ending = [...(origins ?? [])].filter((origin) => !stillOwned.has(origin));
      if (ending.length === 0 || !deps.serviceWorkers) return;
      await deps.serviceWorkers.clear(ending).catch(() => undefined);
    },
    dispose() {
      for (const remove of removals.splice(0)) remove();
      if (installed === network) installed = null;
    },
  };
  installed = network;
  return network;
}
