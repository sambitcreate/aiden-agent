// Navigation and redirect decisions for every main-window subframe (design
// mode v2 Phase 3a, D9, D11, S1, S58, S67, S69). Pure: `main-window-
// navigation.ts` applies the verdicts.
//
// The main window's CSP lists the loopback sources in `frame-src` statically,
// so this guard is what keeps every frame that existed before 3a (generative
// UI, v1 file frames, anything else) off loopback, in both flag states. Only
// an admitted app frame, with the flag on, may show a loopback app.

import type { AppFrameRegistry } from "./app-frame-registry.js";
import type { NamedFrameRef } from "./app-frame-ref.js";
import { isAppLoopback, isLoopbackHttpOrigin } from "./app-network-policy.js";

export type GuardNavigation = {
  url: string;
  isMainFrame: boolean;
  frame: NamedFrameRef | null;
  initiator: "main-frame" | "none" | "other";
};

export type V1DesignGuard = {
  allows(navigation: { url: string; isMainFrame: boolean; frame: { frameTreeNodeId: number; url: string } | null }): boolean;
  has(frameTreeNodeId: number): boolean;
};

export type GuardContext = {
  designLive: boolean;
  /** The registry, when it is bound to this window; null before install or with the flag off. */
  registry: AppFrameRegistry | null;
  v1: V1DesignGuard;
  rendererOrigin: string;
  ownPorts: ReadonlySet<number>;
};

export type GuardVerdict = {
  allow: boolean;
  /** Count a blocked navigation for this frame's registered app frame. */
  blocked?: string;
  /** Send `navigation-refused` with this URL for the app frame itself. */
  refusedUrl?: string;
  /** The frame was admitted as an app frame by this navigation. */
  admitted?: boolean;
};

/** Schemes `frame: null` and v1's handling already know, apart from the web. */
const KNOWN_FRAME_NULL_SCHEMES = new Set(["aiden-design:", "aiden-genui:", "about:", "data:", "blob:"]);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function hostOrScheme(parsed: URL | null): string {
  if (!parsed) return "unknown";
  return /^(?:https?|wss?):$/u.test(parsed.protocol) ? parsed.hostname : parsed.protocol.slice(0, -1);
}

function isWeb(parsed: URL | null): boolean {
  return parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:");
}

function isLoopbackHttp(parsed: URL | null): boolean {
  return parsed !== null && parsed.protocol === "http:" && isLoopbackHttpOrigin(parsed.origin);
}

/** What a frame in app context may navigate to (D9 step 4). */
function appTargetAllowed(parsed: URL | null, ownPorts: ReadonlySet<number>): boolean {
  if (!parsed) return false;
  if (parsed.href === "about:blank" || parsed.href === "about:srcdoc") return true;
  if (parsed.protocol === "data:") return true;
  if (parsed.protocol === "blob:") {
    const inner = parse(parsed.pathname);
    return inner !== null && inner.protocol === "http:" && isAppLoopback(inner.href, ownPorts);
  }
  return parsed.protocol === "http:" && isAppLoopback(parsed.href, ownPorts);
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function onDesignHost(frame: NamedFrameRef): boolean {
  return safe(() => frame.url.toLowerCase().startsWith("aiden-design:"), false);
}

/** `will-frame-navigate` for the main window (D9). */
export function decideFrameNavigation(navigation: GuardNavigation, context: GuardContext): GuardVerdict {
  const { frame } = navigation;
  const parsed = parse(navigation.url);
  if (navigation.isMainFrame) return { allow: context.v1.allows({ ...navigation, frame }) };

  // 1. A subframe Electron can't name any more.
  if (frame === null) {
    if (!parsed || !KNOWN_FRAME_NULL_SCHEMES.has(parsed.protocol)) return { allow: false };
    return { allow: context.v1.allows({ ...navigation, frame: null }) };
  }

  const id = safe(() => frame.frameTreeNodeId, null as number | null);
  if (id === null) return { allow: false };

  // 2. The v1 pin decides for a frame that has shown a design page.
  if (context.v1.has(id) || onDesignHost(frame)) return { allow: context.v1.allows({ ...navigation, frame }) };

  if (context.designLive && context.registry) {
    const registry = context.registry;
    const kind = registry.appContext(frame, true);
    // 4. A frame in app context stays on loopback.
    if (kind) {
      if (appTargetAllowed(parsed, context.ownPorts)) return { allow: true };
      const isApp = registry.isAppFrame(id);
      return {
        allow: false,
        blocked: kind === "registered" ? hostOrScheme(parsed) : undefined,
        refusedUrl: isApp && isWeb(parsed) ? navigation.url : undefined,
      };
    }
    // 3. Admission.
    const admitted = registry.admit({
      frame: { frameTreeNodeId: id, name: safe(() => frame.name, ""), url: safe(() => frame.url, "unreadable") },
      targetUrl: navigation.url,
      isDirectChild: safe(() => frame.parent?.isMainFrame === true, false),
      initiator: navigation.initiator,
      designFrame: false,
    });
    if (admitted === "app") return { allow: true, admitted: true };
    if (admitted === "refused") return { allow: false };
  }

  // 5. Loopback for anything that isn't an admitted app frame.
  if (isLoopbackHttp(parsed)) {
    const registryMissing = context.designLive && !context.registry;
    if (registryMissing || parsed!.origin !== context.rendererOrigin) return { allow: false };
  }

  // 6. Today's v1 guard.
  return { allow: context.v1.allows({ ...navigation, frame }) };
}

export type RedirectVerdict = { action: "proceed" | "prevent" | "prevent-and-open"; blocked?: string; refusedUrl?: string };

/** `will-redirect` for the main window (S1). With the flag off, today's: prevent and open externally. */
export function decideRedirect(
  redirect: { url: string; isMainFrame: boolean; frame: NamedFrameRef | null },
  context: GuardContext,
): RedirectVerdict {
  if (redirect.isMainFrame || !context.designLive) return { action: "prevent-and-open" };
  const { frame } = redirect;
  if (frame === null || !context.registry) return { action: "prevent" };
  const kind = context.registry.appContext(frame, true);
  if (!kind) return { action: "prevent" };
  const parsed = parse(redirect.url);
  if (parsed && parsed.protocol === "http:" && isAppLoopback(parsed.href, context.ownPorts)) return { action: "proceed" };
  const id = safe(() => frame.frameTreeNodeId, null as number | null);
  const isApp = id !== null && context.registry.isAppFrame(id);
  return {
    action: "prevent",
    blocked: kind === "registered" ? hostOrScheme(parsed) : undefined,
    refusedUrl: isApp && isWeb(parsed) ? redirect.url : undefined,
  };
}
