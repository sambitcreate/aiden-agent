import * as React from "react";
import {
  EnvironmentWorkbench,
  type WorkbenchDesignState,
} from "../components/environment-panel";
import { useCommandHandler } from "../lib/command-system";
import {
  DesignModeControlsContext,
  useDesignMode,
  type DesignModeControls,
} from "../lib/design-mode";
import { DesignExpandContext, type DesignExpandState } from "./design-expand";

export const DESIGN_CHAT_WIDTH_STORAGE_KEY = "aiden-agent.design.chat-width";
export const SIDEBAR_COLLAPSED_BY_DESIGN_STORAGE_KEY =
  "aiden-agent.design.sidebar-collapsed-by-design";

export type DesignPane = "chat" | "canvas";

/** The stacked layout's one visible pane, for the top bar's Chat | Canvas switch and the chat body. */
export interface DesignPaneState {
  /** True while design mode is on and the content is too narrow to split. */
  stacked: boolean;
  pane: DesignPane;
  setPane(pane: DesignPane): void;
}

export const DEFAULT_DESIGN_PANE_STATE: DesignPaneState = {
  stacked: false,
  pane: "chat",
  setPane: () => {},
};

export const DesignPaneContext = React.createContext<DesignPaneState>(DEFAULT_DESIGN_PANE_STATE);

/** The stacked design layout's visible pane; outside design mode the chat is always shown. */
export function useDesignPane(): DesignPaneState {
  return React.useContext(DesignPaneContext);
}

/** True while the stacked design layout shows the canvas, so the chat's body is hidden. */
export function useDesignChatBodyHidden(): boolean {
  const { stacked, pane } = useDesignPane();
  return stacked && pane === "canvas";
}

/** The stacked layout's "needs a wider window" banner, which the chat's top bar shows. */
export interface DesignBannerState {
  visible: boolean;
  widen(): void;
  dismiss(): void;
  /** The banner's height, so the stacked canvas starts below it instead of covering it. */
  reportHeight(height: number): void;
  renderBanner?: (props: { onWiden(): void; onDismiss(): void }) => React.ReactNode;
}

export const DEFAULT_DESIGN_BANNER_STATE: DesignBannerState = {
  visible: false,
  widen: () => {},
  dismiss: () => {},
  reportHeight: () => {},
};

export const DesignBannerContext = React.createContext<DesignBannerState>(
  DEFAULT_DESIGN_BANNER_STATE,
);

const DEFAULT_DESIGN_EXPAND_STATE: DesignExpandState = {
  available: false,
  expanded: false,
  setExpanded: () => {},
};

/**
 * Sits in the chat's top bar, below the title row, while the stacked layout
 * offers to widen the window. It is part of the top bar, so it pushes the
 * conversation down instead of floating over it, and the stacked canvas starts
 * below it.
 */
export function DesignModeBannerSlot() {
  const { visible, widen, dismiss, reportHeight, renderBanner } =
    React.useContext(DesignBannerContext);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!visible || !element) return;
    const measure = () => reportHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      reportHeight(0);
    };
  }, [reportHeight, visible]);
  if (!visible || !renderBanner) return null;
  return (
    // Positioned and filled so the header's fade and the scrolling conversation stay behind it.
    <div ref={ref} data-design-banner className="relative bg-background px-3 pb-2">
      {renderBanner({ onWiden: widen, onDismiss: dismiss })}
    </div>
  );
}

/**
 * Hides chat-column content (the terminal drawer) from sight, focus and
 * assistive tech while the stacked layout shows the canvas, without
 * unmounting it.
 */
export function DesignChatBody({ children }: React.PropsWithChildren) {
  const hidden = useDesignChatBodyHidden();
  return (
    <div
      className={hidden ? "contents invisible" : "contents"}
      inert={hidden}
      aria-hidden={hidden || undefined}
    >
      {children}
    </div>
  );
}

/** Design mode for the open chat, as the chat area and the sidebar both use it. */
export interface DesignChatState {
  state: WorkbenchDesignState;
  /** The open chat's workspace while design mode is active, for the scoped sidebar. */
  workspaceId: string | undefined;
  /** Null when the open chat cannot use design mode. */
  controls: DesignModeControls | null;
}

/**
 * Reads the open chat's design mode in the same render that the route
 * changes, so switching between a design chat and a normal chat never shows
 * one chat in the other's layout or sidebar scope.
 */
export function useDesignChatState(chatId: string | undefined, allowed: boolean): DesignChatState {
  const design = useDesignMode(allowed ? chatId : undefined);
  const state: WorkbenchDesignState = !allowed
    ? "inactive"
    : !design.settled
      ? "pending"
      : design.on
        ? "active"
        : "inactive";
  const { available, on, set, toggle } = design;
  const controls = React.useMemo<DesignModeControls | null>(
    () => (allowed && chatId && available ? { chatId, on, set, toggle } : null),
    [allowed, available, chatId, on, set, toggle],
  );
  return { state, workspaceId: state === "active" ? design.workspaceId : undefined, controls };
}

export interface ActiveDesignShellSnapshot {
  layoutMode: "off" | "split" | "stacked";
  on: boolean;
  stacked: boolean;
  chatWidth: number;
  paneState: DesignPaneState;
  expand: DesignExpandState;
  bannerState: DesignBannerState;
}

export function hasSavedDesignSidebarCollapse(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_BY_DESIGN_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Lightweight chat-column shell that keeps `{children}` at one stable React
 * tree position whether design mode is inactive, pending, or active, while
 * allowing the active design workbench surface to load lazily as a sibling.
 */
export function DesignShell({
  design,
  suppressed,
  renderActiveWorkbench,
  children,
}: React.PropsWithChildren<{
  design: DesignChatState;
  suppressed: boolean;
  renderActiveWorkbench?: (props: {
    containerRef: React.RefObject<HTMLDivElement | null>;
    onSnapshotChange: (snapshot: ActiveDesignShellSnapshot | null) => void;
  }) => React.ReactNode;
}>) {
  const controls = design.controls;
  // ⌘⇧L has no handler, so the key is left alone, unless this chat can use design mode.
  useCommandHandler("design.toggle", () => controls?.toggle("shortcut"), controls !== null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = React.useState<ActiveDesignShellSnapshot | null>(null);
  const shouldActivate = design.state === "active" || hasSavedDesignSidebarCollapse();
  const [activated, setActivated] = React.useState(shouldActivate);
  React.useLayoutEffect(() => {
    if (shouldActivate) setActivated(true);
  }, [shouldActivate]);

  return (
    <DesignModeControlsContext.Provider value={controls}>
      <EnvironmentWorkbench suppressed={suppressed} design={design.state}>
        <DesignPaneContext.Provider value={snapshot?.paneState ?? DEFAULT_DESIGN_PANE_STATE}>
          <DesignExpandContext.Provider value={snapshot?.expand ?? DEFAULT_DESIGN_EXPAND_STATE}>
            <DesignBannerContext.Provider
              value={snapshot?.bannerState ?? DEFAULT_DESIGN_BANNER_STATE}
            >
              <div
                ref={containerRef}
                data-design-layout={snapshot?.layoutMode ?? "off"}
                className="relative flex h-full min-h-0 w-full"
              >
                <div
                  data-design-mode={snapshot?.on ? "true" : undefined}
                  className="h-full min-h-0 min-w-0 flex-1"
                  style={
                    snapshot?.on && !snapshot.stacked
                      ? { width: snapshot.chatWidth, flex: "none" }
                      : undefined
                  }
                >
                  {children}
                </div>
                {activated && renderActiveWorkbench
                  ? renderActiveWorkbench({ containerRef, onSnapshotChange: setSnapshot })
                  : null}
              </div>
            </DesignBannerContext.Provider>
          </DesignExpandContext.Provider>
        </DesignPaneContext.Provider>
      </EnvironmentWorkbench>
    </DesignModeControlsContext.Provider>
  );
}
