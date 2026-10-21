// The Bot side panel's state (spec §8), kept apart from the workspace
// Environment panel: its own open flag, tab and width keys, so opening it on a
// Bot never opens or reshapes the workspace panel. Focus: opening asks the
// panel to focus its selected tab; closing with focus inside returns it to
// what was focused before, else the header toggle.

import * as React from "react";
import { useRouter } from "@tanstack/react-router";
import { botChatRouteBotId } from "../../lib/bot-routes";

export const BOT_PANEL_ID = "bot-panel";
/** `browser` shows only while the Bot's own browser has a tab (`bot-workbench.tsx`). */
export const BOT_PANEL_TABS = ["activity", "files", "memory", "routines", "browser"] as const;
export type BotPanelTab = (typeof BOT_PANEL_TABS)[number];
export const BOT_PANEL_OPEN_KEY = "aiden-agent.bot-panel.open";
export const BOT_PANEL_TAB_KEY = "aiden-agent.bot-panel.tab";
export const BOT_PANEL_WIDTH_KEY = "aiden-agent.bot-panel.width";

export interface BotPanelFileRequest {
  /** The Bot the file belongs to. Consumers must match both `botId` and `key` before applying a request. */
  botId: string;
  path: string;
  /** New on every request, so the same file chip clicked twice selects its file again. */
  key: number;
}

/** A file to select needs the Bot it belongs to, so a request never lands on another Bot. */
export type BotPanelShowOptions = (
  | { path?: undefined; botId?: string }
  | { path: string; botId: string }
) & {
  /** Where closing the panel returns focus when it was opened from something that unmounts, such as a menu item. */
  returnFocus?: HTMLElement | null;
};

/** Actions never change identity, so a component that only acts does not re-render with panel state. */
export interface BotPanelActions {
  show(tab: BotPanelTab, options?: BotPanelShowOptions): void;
  /** Open on `tab` without moving focus: the Bot, not the person, put something there. */
  reveal(tab: BotPanelTab): void;
  setTab(tab: BotPanelTab): void;
  toggle(): void;
  close(): void;
  /** True once after a person-initiated open: the panel then focuses its selected tab. */
  consumeFocusRequest(): boolean;
}

interface BotPanelState {
  open: boolean;
  tab: BotPanelTab;
  /** Cleared when the chat moves to a different Bot. Apply it only when `botId` is the Bot on screen. */
  fileRequest: BotPanelFileRequest | null;
  /** Bumped whenever the person opens the panel or picks a tab from outside it. */
  focusRequest: number;
}

type BotPanelValue = BotPanelState & BotPanelActions;

function parseBotPanelTab(value: string | null): BotPanelTab {
  return (BOT_PANEL_TABS as readonly string[]).includes(value ?? "") ? (value as BotPanelTab) : "activity";
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Per-device convenience only.
  }
}

/**
 * Keys are unique in the window, not per provider, so a consumer that records
 * the keys it handled never mistakes a new provider's request for an old one.
 */
let lastFileRequestKey = 0;

const BotPanelStateContext = React.createContext<BotPanelState | null>(null);
const BotPanelActionsContext = React.createContext<BotPanelActions | null>(null);

interface PanelState {
  open: boolean;
  tab: BotPanelTab;
  fileRequest: BotPanelFileRequest | null;
}

/**
 * `routedBotId` is the Bot whose chat is on screen, or null on any other page.
 * When it becomes a different Bot, a pending file request is dropped, so it is
 * never re-applied to that Bot.
 */
export function BotPanelProvider({
  children,
  routedBotId = null,
}: React.PropsWithChildren<{ routedBotId?: string | null }>) {
  const [state, setState] = React.useState<PanelState>(() => ({
    open: readStored(BOT_PANEL_OPEN_KEY) === "true",
    tab: parseBotPanelTab(readStored(BOT_PANEL_TAB_KEY)),
    fileRequest: null,
  }));
  const [focusRequest, setFocusRequest] = React.useState(0);
  const openRef = React.useRef(state.open);
  openRef.current = state.open;
  const pendingFocus = React.useRef(false);
  const returnFocus = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => writeStored(BOT_PANEL_OPEN_KEY, String(state.open)), [state.open]);
  React.useEffect(() => writeStored(BOT_PANEL_TAB_KEY, state.tab), [state.tab]);
  // Only reaching a different Bot's chat drops a request: a page in between
  // (the Bots home, a Profile) may be where a request for the next chat was made.
  React.useEffect(() => {
    if (routedBotId === null) return;
    setState((current) =>
      current.fileRequest && current.fileRequest.botId !== routedBotId ? { ...current, fileRequest: null } : current,
    );
  }, [routedBotId]);

  const requestFocus = React.useCallback((returnTo?: HTMLElement | null) => {
    if (!openRef.current) {
      const active = document.activeElement;
      returnFocus.current =
        returnTo ?? (active instanceof HTMLElement && !active.closest(`#${BOT_PANEL_ID}`) ? active : null);
    }
    pendingFocus.current = true;
    setFocusRequest((value) => value + 1);
  }, []);

  const close = React.useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(`#${BOT_PANEL_ID}`)) {
      const stored = returnFocus.current;
      const target =
        stored?.isConnected && !stored.closest("[inert]")
          ? stored
          : (document.querySelector<HTMLElement>("[data-bot-panel-toggle]") ??
            document.querySelector<HTMLElement>("[data-app-focus-root]"));
      requestAnimationFrame(() => target?.focus());
    }
    pendingFocus.current = false;
    setState((current) => (current.open ? { ...current, open: false } : current));
  }, []);

  const show = React.useCallback(
    (tab: BotPanelTab, options?: BotPanelShowOptions) => {
      requestFocus(options?.returnFocus);
      // A path without its Bot can't be scoped, so it selects nothing.
      const request =
        options?.path && options.botId
          ? { botId: options.botId, path: options.path, key: (lastFileRequestKey += 1) }
          : null;
      setState((current) => ({ open: true, tab, fileRequest: request ?? current.fileRequest }));
    },
    [requestFocus],
  );

  const toggle = React.useCallback(() => {
    if (openRef.current) {
      close();
      return;
    }
    requestFocus();
    setState((current) => ({ ...current, open: true }));
  }, [close, requestFocus]);

  const setTab = React.useCallback(
    (tab: BotPanelTab) => setState((current) => (current.tab === tab ? current : { ...current, tab })),
    [],
  );

  const reveal = React.useCallback(
    (tab: BotPanelTab) =>
      setState((current) => (current.open && current.tab === tab ? current : { ...current, open: true, tab })),
    [],
  );

  const consumeFocusRequest = React.useCallback(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = false;
    return pending;
  }, []);

  const actions = React.useMemo<BotPanelActions>(
    () => ({ show, reveal, setTab, toggle, close, consumeFocusRequest }),
    [show, reveal, setTab, toggle, close, consumeFocusRequest],
  );
  const panelState = React.useMemo<BotPanelState>(() => ({ ...state, focusRequest }), [state, focusRequest]);
  return (
    <BotPanelActionsContext.Provider value={actions}>
      <BotPanelStateContext.Provider value={panelState}>{children}</BotPanelStateContext.Provider>
    </BotPanelActionsContext.Provider>
  );
}

/** The provider for the app and for tests under a router: it follows the Bot whose chat is routed. */
export function RoutedBotPanelProvider({ children }: React.PropsWithChildren) {
  const router = useRouter();
  const [routedBotId, setRoutedBotId] = React.useState(() => botChatRouteBotId(router.state.location.pathname));
  React.useEffect(() => {
    const follow = (pathname: string) => setRoutedBotId(botChatRouteBotId(pathname));
    follow(router.state.location.pathname);
    return router.subscribe("onResolved", ({ toLocation }) => follow(toLocation.pathname));
  }, [router]);
  return <BotPanelProvider routedBotId={routedBotId}>{children}</BotPanelProvider>;
}

export function useBotPanelActions(): BotPanelActions {
  const value = React.useContext(BotPanelActionsContext);
  if (!value) throw new Error("useBotPanelActions must be used inside BotPanelProvider.");
  return value;
}

export function useBotPanel(): BotPanelValue {
  const actions = useBotPanelActions();
  const panelState = React.useContext(BotPanelStateContext);
  if (!panelState) throw new Error("useBotPanel must be used inside BotPanelProvider.");
  return React.useMemo(() => ({ ...panelState, ...actions }), [panelState, actions]);
}
