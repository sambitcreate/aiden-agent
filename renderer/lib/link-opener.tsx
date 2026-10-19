import * as React from "react";
import { browserApi } from "./ipc";
import { resolveLinkOpen, type LinkRoute } from "./browser-link-routing";
import type { BrowserLinkOpening } from "../shared/browser";
import { LinkOpenDialog, type LinkOpenChoice } from "../components/link-open-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, toast } from "../components/ui";

export interface OpenLinkOptions {
  modifiers?: { metaKey: boolean; ctrlKey: boolean };
  workspaceId?: string | null;
  forcePrompt?: boolean;
  forceExternal?: boolean;
}

interface LinkOpener {
  openLink: (href: string, options?: OpenLinkOptions) => boolean;
  canOpen: (href: string) => boolean;
  preference: BrowserLinkOpening;
  registerSurface: () => () => void;
  registerBlocker: () => () => void;
}

const NO_MODIFIERS = { metaKey: false, ctrlKey: false };
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

function openExternal(url: string): void {
  void browserApi.openExternal(url).catch((error: unknown) => toast.error(message(error, "Couldn't open this link.")));
}

const FALLBACK: LinkOpener = {
  // Only for components rendered outside the app-wide provider (isolated tests, detached windows).
  // forcePrompt callers are always inside the provider, so it is ignored here.
  openLink: (href, options) => {
    const route = resolveLinkOpen({ href, modifiers: options?.modifiers ?? NO_MODIFIERS, preference: "external", browserAvailable: false });
    if (route?.kind !== "external") return false;
    openExternal(route.url);
    return true;
  },
  canOpen: (href) => resolveLinkOpen({ href, modifiers: NO_MODIFIERS, preference: "external", browserAvailable: false }) !== null,
  preference: "external",
  registerSurface: () => () => undefined,
  registerBlocker: () => () => undefined,
};

const LinkOpenerContext = React.createContext<LinkOpener>(FALLBACK);

export function useLinkOpener(): Omit<LinkOpener, "registerSurface" | "registerBlocker"> {
  return React.useContext(LinkOpenerContext);
}

/**
 * Hands every link to `openExternal` instead of the app's routing. For pages
 * with no preload, such as the phone visual viewer, where the host app (not
 * Electron) decides how a link opens.
 */
export function ExternalLinkOpenerProvider({
  openExternal,
  children,
}: React.PropsWithChildren<{ openExternal: (url: string) => boolean }>) {
  const value = React.useMemo<LinkOpener>(
    () => ({
      openLink: (href) => openExternal(href),
      canOpen: (href) => /^https:\/\//iu.test(href),
      preference: "external",
      registerSurface: () => () => undefined,
      registerBlocker: () => () => undefined,
    }),
    [openExternal],
  );
  return <LinkOpenerContext.Provider value={value}>{children}</LinkOpenerContext.Provider>;
}

/** Mount while the browser panel can actually be shown on this route. */
export function useBrowserSurface(active: boolean): void {
  const { registerSurface } = React.useContext(LinkOpenerContext);
  React.useEffect(() => (active ? registerSurface() : undefined), [active, registerSurface]);
}

/**
 * Mount while something is drawn over the whole app (the onboarding overlay),
 * so links behind it route as if no browser surface were registered: no
 * prompt, and straight to the system browser.
 */
export function useBrowserSurfaceBlocker(active: boolean): void {
  const { registerBlocker } = React.useContext(LinkOpenerContext);
  React.useEffect(() => (active ? registerBlocker() : undefined), [active, registerBlocker]);
}

type Pending = { url: string; workspaceId: string | null; remember: boolean; inApp: boolean };
type Menu = { url: string; x: number; y: number; web: boolean; workspaceId: string | null };

export function LinkOpenerProvider({ workspaceId, children }: React.PropsWithChildren<{ workspaceId: string | null }>) {
  const [preference, setPreference] = React.useState<BrowserLinkOpening>("ask");
  const [surfaces, setSurfaces] = React.useState(0);
  const [blockers, setBlockers] = React.useState(0);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [menu, setMenu] = React.useState<Menu | null>(null);
  const state = React.useRef({ preference, surfaces, blockers, workspaceId });
  // Keep the latest render's values available to stable callbacks without
  // writing a ref during render (a discarded concurrent render would corrupt
  // it); the layout effect runs only for a render that actually committed.
  React.useLayoutEffect(() => {
    state.current = { preference, surfaces, blockers, workspaceId };
  }, [preference, surfaces, blockers, workspaceId]);

  // True once the saved preference has loaded (or failed to). A click that
  // arrives first must not show the ask dialog based on the "ask" default
  // when the saved choice is actually "browser" or "external"; it is queued
  // and replayed once the real preference is known.
  const preferenceReady = React.useRef(false);
  const queuedLinks = React.useRef<Array<() => void>>([]);

  React.useEffect(() => {
    let live = true;
    const settle = (value: BrowserLinkOpening) => {
      if (!live) return;
      setPreference(value);
      preferenceReady.current = true;
      const queued = queuedLinks.current;
      queuedLinks.current = [];
      queued.forEach((run) => run());
    };
    void browserApi
      .linkPreference()
      .then(settle)
      .catch((error: unknown) => {
        console.warn("Couldn't load the link-opening preference; treating it as \"ask\".", error);
        settle("ask");
      });
    const off = browserApi.onEvent((event) => {
      if (event.type === "state" && event.state.defaults) setPreference(event.state.defaults.linkOpening);
      else if (event.type === "link-preference") setPreference(event.linkOpening);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  const openInBrowser = React.useCallback((target: string, url: string) => {
    void browserApi.command(target, { action: "open_link", url }).catch((error: unknown) => {
      const reason = message(error, "The Aiden browser couldn't open this link.");
      void browserApi.openExternal(url).then(
        () => toast.message(`${reason} Opened it in your system browser.`),
        (fallbackError: unknown) => toast.error(message(fallbackError, reason)),
      );
    });
  }, []);

  const perform = React.useCallback(
    (route: LinkRoute, target: string | null) => {
      if (route.kind === "external") openExternal(route.url);
      else if (route.kind === "ask")
        setPending({ url: route.url, workspaceId: target, remember: route.remember, inApp: route.inApp && Boolean(target) });
      else if (route.kind === "browser" && target) openInBrowser(target, route.url);
      else if (route.kind === "file" && target)
        void browserApi.command(target, { action: "open_file", path: route.path }).catch((error: unknown) =>
          toast.error(message(error, "Couldn't open this file.")),
        );
    },
    [openInBrowser],
  );

  const route = React.useCallback((href: string, options: OpenLinkOptions = {}) => {
    const { preference: current, surfaces: count, blockers: blocked, workspaceId: active } = state.current;
    const target = options.workspaceId === undefined ? active : options.workspaceId;
    const resolved = resolveLinkOpen({
      href,
      modifiers: options.modifiers ?? NO_MODIFIERS,
      preference: current,
      browserAvailable: Boolean(target) && count > 0 && blocked === 0,
      forcePrompt: options.forcePrompt,
      forceExternal: options.forceExternal,
    });
    return { resolved, target: target ?? null };
  }, []);

  const openLink = React.useCallback(
    (href: string, options?: OpenLinkOptions) => {
      const { resolved, target } = route(href, options);
      if (!resolved) return false;
      // The "ask" branch is only reachable while the preference is still the
      // unresolved "ask" default; defer it until the real value is in, then
      // let it resolve against that value instead.
      if (resolved.kind === "ask" && !preferenceReady.current) {
        queuedLinks.current.push(() => openLink(href, options));
        return true;
      }
      perform(resolved, target);
      return true;
    },
    [perform, route],
  );

  React.useEffect(() => {
    const anchorOf = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      return anchor instanceof HTMLAnchorElement && !anchor.hasAttribute("download") ? anchor : null;
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.altKey || event.shiftKey) return;
      const anchor = anchorOf(event);
      if (!anchor) return;
      const handled = openLink(anchor.getAttribute("href") ?? "", {
        modifiers: event,
        forceExternal: anchor.dataset.linkTarget === "external",
      });
      if (handled) event.preventDefault();
    };
    const insideEditableOrSelected = (anchor: HTMLAnchorElement) => {
      if (anchor.closest('[contenteditable]:not([contenteditable="false"])')) return true;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return false;
      const { anchorNode, focusNode } = selection;
      return Boolean((anchorNode && anchor.contains(anchorNode)) || (focusNode && anchor.contains(focusNode)));
    };
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const anchor = anchorOf(event);
      if (!anchor || insideEditableOrSelected(anchor)) return;
      const href = anchor.getAttribute("href") ?? "";
      const forceExternal = anchor.dataset.linkTarget === "external";
      const { resolved, target } = route(href, { forceExternal });
      if (!resolved || resolved.kind === "file") return;
      event.preventDefault();
      lastAnchor.current = anchor;
      setMenu({
        url: resolved.url,
        x: event.clientX,
        y: event.clientY,
        web: !forceExternal && !resolved.url.startsWith("mailto:"),
        workspaceId: target && state.current.surfaces > 0 && state.current.blockers === 0 ? target : null,
      });
    };
    document.addEventListener("click", onClick);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("contextmenu", onContextMenu);
    };
  }, [openLink, route]);

  const lastAnchor = React.useRef<HTMLAnchorElement | null>(null);

  const registerSurface = React.useCallback(() => {
    setSurfaces((count) => count + 1);
    return () => setSurfaces((count) => count - 1);
  }, []);

  const registerBlocker = React.useCallback(() => {
    setBlockers((count) => count + 1);
    return () => setBlockers((count) => count - 1);
  }, []);

  const choose = React.useCallback(
    (choice: LinkOpenChoice) => {
      const current = pending;
      setPending(null);
      if (!current) return;
      if (choice.remember) {
        const previous = preference;
        setPreference(choice.target);
        void browserApi.setLinkPreference(choice.target).catch((error: unknown) => {
          setPreference(previous);
          toast.error(message(error, "Couldn't save your link preference."));
        });
      }
      if (choice.target === "browser" && current.workspaceId) openInBrowser(current.workspaceId, current.url);
      else openExternal(current.url);
    },
    [openInBrowser, pending, preference],
  );

  const value = React.useMemo<LinkOpener>(
    () => ({
      openLink,
      canOpen: (href) => route(href).resolved !== null,
      preference,
      registerSurface,
      registerBlocker,
    }),
    [openLink, preference, registerBlocker, registerSurface, route],
  );

  const closeMenu = (open: boolean) => {
    if (open) return;
    setMenu(null);
    lastAnchor.current?.focus({ preventScroll: true });
    lastAnchor.current = null;
  };

  return (
    <LinkOpenerContext.Provider value={value}>
      {children}
      <LinkOpenDialog
        url={pending?.url ?? null}
        rememberable={pending?.remember ?? true}
        inApp={pending?.inApp ?? true}
        onChoose={choose}
        onCancel={() => setPending(null)}
      />
      <DropdownMenu open={menu !== null} onOpenChange={closeMenu}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden="true" style={{ position: "fixed", left: menu?.x ?? 0, top: menu?.y ?? 0, width: 0, height: 0 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {menu?.web ? (
            <DropdownMenuItem
              disabled={!menu.workspaceId}
              onSelect={() => menu.workspaceId && openInBrowser(menu.workspaceId, menu.url)}
            >
              Open in Aiden browser
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => menu && openExternal(menu.url)}>Open in system browser</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              menu &&
              void navigator.clipboard.writeText(menu.url).then(
                () => toast.success("Link copied."),
                () => toast.error("Couldn't copy the link."),
              )
            }
          >
            Copy link
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </LinkOpenerContext.Provider>
  );
}
