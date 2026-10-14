// The Bot side panel's state (spec §8), kept apart from the workspace
// Environment panel: its own open flag, tab and width keys, so opening it on a
// Bot never opens or reshapes the workspace panel. Focus: opening asks the
// panel to focus its selected tab; closing with focus inside returns it to
// what was focused before, else the header toggle.

import * as React from "react";

export const BOT_PANEL_ID = "bot-panel";
export const BOT_PANEL_TABS = ["activity", "files", "memory", "routines"] as const;
export type BotPanelTab = (typeof BOT_PANEL_TABS)[number];
export const BOT_PANEL_OPEN_KEY = "aiden-agent.bot-panel.open";
export const BOT_PANEL_TAB_KEY = "aiden-agent.bot-panel.tab";
export const BOT_PANEL_WIDTH_KEY = "aiden-agent.bot-panel.width";

export interface BotPanelFileRequest {
  path: string;
  /** New on every request, so the same file chip clicked twice selects its file again. */
  key: number;
}

export interface BotPanelValue {
  open: boolean;
  tab: BotPanelTab;
  fileRequest: BotPanelFileRequest | null;
  /** Bumped whenever the person opens the panel or picks a tab from outside it. */
  focusRequest: number;
  show(tab: BotPanelTab, options?: { path?: string }): void;
  setTab(tab: BotPanelTab): void;
  toggle(): void;
  close(): void;
  /** True once after a person-initiated open: the panel then focuses its selected tab. */
  consumeFocusRequest(): boolean;
}

export function parseBotPanelTab(value: string | null): BotPanelTab {
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

const BotPanelContext = React.createContext<BotPanelValue | null>(null);

interface PanelState {
  open: boolean;
  tab: BotPanelTab;
  fileRequest: BotPanelFileRequest | null;
}

export function BotPanelProvider({ children }: React.PropsWithChildren) {
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
  const fileKey = React.useRef(0);

  React.useEffect(() => writeStored(BOT_PANEL_OPEN_KEY, String(state.open)), [state.open]);
  React.useEffect(() => writeStored(BOT_PANEL_TAB_KEY, state.tab), [state.tab]);

  const requestFocus = React.useCallback(() => {
    if (!openRef.current) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement && !active.closest(`#${BOT_PANEL_ID}`) ? active : null;
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
    (tab: BotPanelTab, options?: { path?: string }) => {
      requestFocus();
      const request = options?.path ? { path: options.path, key: (fileKey.current += 1) } : null;
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

  const consumeFocusRequest = React.useCallback(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = false;
    return pending;
  }, []);

  const value = React.useMemo<BotPanelValue>(
    () => ({ ...state, focusRequest, show, setTab, toggle, close, consumeFocusRequest }),
    [state, focusRequest, show, setTab, toggle, close, consumeFocusRequest],
  );
  return <BotPanelContext.Provider value={value}>{children}</BotPanelContext.Provider>;
}

export function useBotPanel(): BotPanelValue {
  const value = React.useContext(BotPanelContext);
  if (!value) throw new Error("useBotPanel must be used inside BotPanelProvider.");
  return value;
}
