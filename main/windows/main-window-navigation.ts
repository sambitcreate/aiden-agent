// The main window's navigation rules (moved out of `main/index.ts` in design
// mode v2 Phase 3a, D9, D11, S1). They run for every main window Aiden
// creates, including one recreated after close.
//
// With live apps off, the handlers are today's, plus the loopback refusal that
// stands in for the CSP's old `frame-src`: a subframe may not go to a loopback
// `http:` origin other than the renderer's own, and a `frame: null` subframe
// navigation toward the web or an unknown scheme is refused.
//
// With live apps on, admission and the app guard decide for subframes, and a
// subframe redirect never reaches `openExternal` (S1).

import type { AppFrameRegistry } from "../services/design-canvas/app-frames/app-frame-registry.js";
import { appFrameRef, mainFrameIdOf, type FrameLike } from "../services/design-canvas/app-frames/app-frame-ref.js";
import { decideBlockedLoad, decideFrameNavigation, decideRedirect, type GuardContext } from "../services/design-canvas/app-frames/app-frame-guard.js";
import { createDesignFrameNavigationGuard } from "../services/design-canvas/frame-navigation.js";

type Listener = (...args: never[]) => void;

/** The parts of a main window's `webContents` these rules use. */
export type NavigationContents = {
  getURL(): string;
  readonly mainFrame: { readonly frameTreeNodeId: number };
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" } | { action: "allow" }): void;
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
};

export type MainWindowNavigationDeps = {
  openExternal(url: string): void;
  warn(message: string): void;
  designLive: boolean;
  /** The app frame registry, or null when it isn't installed. */
  registry(): AppFrameRegistry | null;
  rendererOrigin: string;
  ownPorts(): ReadonlySet<number>;
  /** The frame a load event names by process and routing id (`webFrameMain.fromId`), or null. */
  frameFromId?(processId: number, routingId: number): FrameLike | null;
};

type WillFrameNavigateEvent = {
  url: string;
  isMainFrame: boolean;
  frame: FrameLike | null;
  initiator?: { frameTreeNodeId: number } | null;
  preventDefault(): void;
};

type WillRedirectEvent = {
  url?: string;
  isMainFrame?: boolean;
  frame?: FrameLike | null;
  preventDefault(): void;
};

export function installMainWindowNavigation(contents: NavigationContents, deps: MainWindowNavigationDeps): () => void {
  const designFrames = createDesignFrameNavigationGuard();
  const cleanups: Array<() => void> = [];
  const on = (event: string, listener: Listener) => {
    contents.on(event, listener);
    cleanups.push(() => contents.removeListener(event, listener));
  };

  const guardContext = (): GuardContext => {
    const registry = deps.designLive ? deps.registry() : null;
    // The registry decides only for the window it is bound to (D6).
    const bound = registry && registry.mainContents() === contents ? registry : null;
    return {
      designLive: deps.designLive,
      registry: bound,
      v1: designFrames,
      rendererOrigin: deps.rendererOrigin,
      ownPorts: deps.ownPorts(),
    };
  };

  contents.setWindowOpenHandler(({ url }) => {
    deps.openExternal(url);
    return { action: "deny" };
  });

  on("will-navigate", ((event: { preventDefault(): void }, url: string) => {
    const current = contents.getURL();
    if (url === current) return;
    event.preventDefault();
    deps.openExternal(url);
  }) as Listener);

  on("will-redirect", ((event: WillRedirectEvent, legacyUrl?: string) => {
    const url = typeof event.url === "string" ? event.url : (legacyUrl ?? "");
    const context = guardContext();
    if (!deps.designLive) {
      event.preventDefault();
      deps.openExternal(url);
      return;
    }
    const mainId = mainFrameIdOf(contents);
    const frame = event.frame ? appFrameRef(event.frame, mainId) : null;
    const verdict = decideRedirect({ url, isMainFrame: event.isMainFrame === true, frame }, context);
    if (verdict.action === "proceed") return;
    event.preventDefault();
    if (verdict.action === "prevent-and-open") {
      deps.openExternal(url);
      return;
    }
    report(context, frame, verdict);
  }) as Listener);

  const report = (
    context: GuardContext,
    frame: ReturnType<typeof appFrameRef> | null,
    verdict: { blocked?: string; refusedUrl?: string },
  ) => {
    const registry = context.registry;
    if (!registry || !frame) return;
    if (verdict.blocked !== undefined) registry.reportBlocked(frame, verdict.blocked);
    if (verdict.refusedUrl !== undefined) {
      try {
        registry.emitFor(frame.frameTreeNodeId, { kind: "navigation-refused", url: verdict.refusedUrl });
      } catch {
        // A destroyed frame has nothing to show the toast in.
      }
    }
  };

  // S1, D1: the window's frame-src refuses an app frame's way out before the
  // handlers above see it, and Chromium shows its blocked page in the frame.
  // Answer it as the guard would have, and have the renderer put the frame back.
  on("did-fail-provisional-load", ((
    _event: unknown,
    errorCode: number,
    _description: string,
    validatedUrl: string,
    isMainFrame: boolean,
    processId: number,
    routingId: number,
  ) => {
    if (!deps.designLive || isMainFrame || !deps.frameFromId) return;
    const context = guardContext();
    let found: FrameLike | null = null;
    try {
      found = deps.frameFromId(processId, routingId);
    } catch {
      found = null;
    }
    const frame = found ? appFrameRef(found, mainFrameIdOf(contents)) : null;
    const verdict = decideBlockedLoad({ url: validatedUrl, errorCode, isMainFrame, frame }, context);
    if (!verdict || !frame) return;
    report(context, frame, verdict);
    try {
      context.registry?.emitFor(frame.frameTreeNodeId, { kind: "navigation-restore" });
    } catch {
      // A destroyed frame has nothing to put back.
    }
  }) as Listener);

  // A design canvas frame runs a workspace page's own scripts; it must never leave its
  // aiden-design: host for the web or a blank page that keeps the frame's window.
  on("did-navigate", (() => designFrames.reset()) as Listener);
  on("will-frame-navigate", ((event: WillFrameNavigateEvent) => {
    const context = guardContext();
    const mainId = mainFrameIdOf(contents);
    const frame = event.frame ? appFrameRef(event.frame, mainId) : null;
    let initiator: "main-frame" | "none" | "other" = "none";
    try {
      if (event.initiator) initiator = mainId !== null && event.initiator.frameTreeNodeId === mainId ? "main-frame" : "other";
    } catch {
      initiator = "other";
    }
    const verdict = decideFrameNavigation({ url: event.url, isMainFrame: event.isMainFrame, frame, initiator }, context);
    if (verdict.allow) return;
    event.preventDefault();
    report(context, frame, verdict);
    deps.warn("Blocked a design canvas frame from leaving its workspace page");
  }) as Listener);

  if (deps.designLive) {
    // Electron otherwise picks the first device for a Web Bluetooth request.
    on("select-bluetooth-device", ((event: { preventDefault(): void }, _devices: unknown, callback: (id: string) => void) => {
      event.preventDefault();
      callback("");
    }) as Listener);
  }

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}
