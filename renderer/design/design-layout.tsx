import * as React from "react";
import { DesignModeBanner } from "../components/design-mode-banner";
import {
  EnvironmentWorkbench,
  useEnvironmentPanel,
  type WorkbenchDesignState,
} from "../components/environment-panel";
import { useSplitViewSidebar } from "../components/ui";
import { useWorkbenchWidth } from "../components/workbench-panel";
import { useCommandHandler } from "../lib/command-system";
import {
  consumePendingDesignEntry,
  DesignModeControlsContext,
  useDesignMode,
  type DesignModeControls,
} from "../lib/design-mode";
import {
  DESIGN_CHAT_WIDTH_BOUNDS,
  DESIGN_SPLIT_MIN_WIDTH,
  designChatMaxWidth,
  resolveDesignCanvasLayout,
  resolveDesignEntryAction,
} from "../lib/environment-panel-layout";
import { appApi } from "../lib/ipc";
import { DesignCanvasRegion } from "./design-canvas-region";
import { DesignChatDivider } from "./design-chat-divider";

export const DESIGN_CHAT_WIDTH_STORAGE_KEY = "aiden-agent.design.chat-width";
/**
 * Set while the sidebar is collapsed because design mode collapsed it, so exit
 * reopens only that. Holds the sidebar's open width, so a later widen can tell
 * whether the sidebar fits again.
 */
const SIDEBAR_COLLAPSED_BY_DESIGN_STORAGE_KEY = "aiden-agent.design.sidebar-collapsed-by-design";
/** Used when an older build saved the flag without the sidebar's width. */
const FALLBACK_SIDEBAR_WIDTH = 272;
/** Resizes settle (a widen animates) before Aiden asks main again or re-checks the sidebar. */
const RESIZE_SETTLE_MS = 150;

export type DesignPane = "chat" | "canvas";

/** The stacked layout's one visible pane, for the top bar's Chat | Canvas switch and the chat body. */
export interface DesignPaneState {
  /** True while design mode is on and the content is too narrow to split. */
  stacked: boolean;
  pane: DesignPane;
  setPane(pane: DesignPane): void;
}

const DesignPaneContext = React.createContext<DesignPaneState>({
  stacked: false,
  pane: "chat",
  setPane: () => {},
});

/** The stacked design layout's visible pane; outside design mode the chat is always shown. */
export function useDesignPane(): DesignPaneState {
  return React.useContext(DesignPaneContext);
}

/** True while the stacked design layout shows the canvas, so the chat's body is hidden. */
export function useDesignChatBodyHidden(): boolean {
  const { stacked, pane } = useDesignPane();
  return stacked && pane === "canvas";
}

/**
 * Hides chat-column content (the terminal drawer) from sight, focus and
 * assistive tech while the stacked layout shows the canvas, without
 * unmounting it.
 */
export function DesignChatBody({ children }: React.PropsWithChildren) {
  const hidden = useDesignChatBodyHidden();
  return (
    <div className={hidden ? "contents invisible" : "contents"} inert={hidden} aria-hidden={hidden || undefined}>
      {children}
    </div>
  );
}

/**
 * While the stacked layout shows the canvas, the Live pill moves to the
 * canvas's bottom-left corner, this far from the content's left edge, so it
 * stays clear of the zoom controls and overview at the bottom right.
 */
const STACKED_DOCK_LANE = 128;

/** Each chat's stacked pane, for this app session. */
const stackedPaneByChat = new Map<string, DesignPane>();

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

/** The chat area with design mode wired in. */
export function DesignWorkbench({
  chatId,
  design,
  suppressed,
  children,
}: React.PropsWithChildren<{
  chatId: string | undefined;
  /** From `useDesignChatState`. */
  design: DesignChatState;
  suppressed: boolean;
}>) {
  const controls = design.controls;
  // ⌘⇧L has no handler, so the key is left alone, unless this chat can use design mode.
  useCommandHandler("design.toggle", () => controls?.toggle("shortcut"), controls !== null);
  return (
    <DesignModeControlsContext.Provider value={controls}>
      <EnvironmentWorkbench suppressed={suppressed} design={design.state}>
        <DesignLayout chatId={chatId} state={design.state}>
          {children}
        </DesignLayout>
      </EnvironmentWorkbench>
    </DesignModeControlsContext.Provider>
  );
}

/**
 * Splits the chat area into the design chat column and the canvas while
 * design mode is active. Content narrower than 680 px stacks the two instead,
 * showing one at a time behind the top bar's Chat | Canvas switch. The chat
 * content keeps one place in the tree, so entering, leaving or switching
 * panes never remounts the conversation.
 */
export function DesignLayout({
  chatId,
  state,
  children,
}: React.PropsWithChildren<{ chatId: string | undefined; state: WorkbenchDesignState }>) {
  const on = state === "active" && Boolean(chatId);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = React.useState(() => window.innerWidth);
  const chatWidth = useWorkbenchWidth(DESIGN_CHAT_WIDTH_STORAGE_KEY, DESIGN_CHAT_WIDTH_BOUNDS);
  const layout = resolveDesignCanvasLayout(chatWidth.preferredWidth, containerWidth);
  const stacked = on && layout.mode === "stacked";
  const windowPolicy = useDesignWindowPolicy(state, chatId, containerRef, stacked);
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);
  const pane: DesignPane = (chatId && stackedPaneByChat.get(chatId)) || "chat";
  const setPane = React.useCallback(
    (next: DesignPane) => {
      if (!chatId) return;
      stackedPaneByChat.set(chatId, next);
      rerender();
    },
    [chatId],
  );
  const paneState = React.useMemo<DesignPaneState>(() => ({ stacked, pane, setPane }), [pane, setPane, stacked]);
  const canvasHidden = stacked && pane === "chat";
  const dockInset = !on
    ? null
    : !stacked
      ? layout.canvasWidth
      : pane === "canvas"
        ? Math.max(0, containerWidth - STACKED_DOCK_LANE)
        : null;
  const { reportDesignDockInset } = useEnvironmentPanel();
  React.useLayoutEffect(() => reportDesignDockInset(dockInset), [dockInset, reportDesignDockInset]);
  React.useLayoutEffect(() => () => reportDesignDockInset(null), [reportDesignDockInset]);

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setContainerWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <DesignPaneContext.Provider value={paneState}>
      <div
        ref={containerRef}
        data-design-layout={on ? layout.mode : "off"}
        className="relative flex h-full min-h-0 w-full"
      >
        <div
          data-design-mode={on ? "true" : undefined}
          className="h-full min-h-0 min-w-0 flex-1"
          style={on && !stacked ? { width: layout.chatWidth, flex: "none" } : undefined}
        >
          {children}
        </div>
        {on && chatId ? (
          <>
            {stacked ? null : (
              <DesignChatDivider
                width={layout.chatWidth}
                min={DESIGN_CHAT_WIDTH_BOUNDS.min}
                max={designChatMaxWidth(containerWidth)}
                onWidthChange={chatWidth.setPreferredWidth}
                onWidthCommit={chatWidth.commitPreferredWidth}
                onResizingChange={chatWidth.setResizing}
              />
            )}
            <DesignCanvasRegion
              chatId={chatId}
              width={layout.canvasWidth}
              placement={stacked ? "stacked" : "split"}
              hidden={canvasHidden}
            />
            {stacked && windowPolicy.bannerVisible ? (
              <div className="pointer-events-none absolute inset-x-0 top-14 z-40 flex justify-center px-3">
                <div className="pointer-events-auto">
                  <DesignModeBanner onWiden={windowPolicy.widen} onDismiss={windowPolicy.dismiss} />
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </DesignPaneContext.Provider>
  );
}

function readSidebarCollapsedByDesign(): number | null {
  try {
    const value = localStorage.getItem(SIDEBAR_COLLAPSED_BY_DESIGN_STORAGE_KEY);
    if (value === null) return null;
    const width = Number(value);
    return Number.isFinite(width) && width > 1 ? width : FALLBACK_SIDEBAR_WIDTH;
  } catch {
    return null;
  }
}

function writeSidebarCollapsedByDesign(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(SIDEBAR_COLLAPSED_BY_DESIGN_STORAGE_KEY);
    else localStorage.setItem(SIDEBAR_COLLAPSED_BY_DESIGN_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // The flag only decides whether exit reopens the sidebar.
  }
}

/**
 * The window rules for design mode. Only a person's own entry (the toggle,
 * ⌘⇧L or /design) may make room: it collapses the sidebar when that is enough
 * for the split, and otherwise asks main to widen the window. Launch, reload,
 * chat switches and other windows' changes never resize anything. While the
 * layout is stacked, a banner offers to widen, but only when main says that
 * can work (not full screen, not maximized, a display at least 1280 px wide).
 */
function useDesignWindowPolicy(
  state: WorkbenchDesignState,
  chatId: string | undefined,
  containerRef: React.RefObject<HTMLDivElement | null>,
  stacked: boolean,
): { bannerVisible: boolean; widen(): void; dismiss(): void } {
  const sidebar = useSplitViewSidebar();
  const sidebarRef = React.useRef(sidebar);
  sidebarRef.current = sidebar;
  const [canWiden, setCanWiden] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const [widenFailed, setWidenFailed] = React.useState(false);
  const active = state === "active";
  const activeRef = React.useRef(active);
  activeRef.current = active;
  /** Set after a successful widen, so the next settled resize re-checks the sidebar. */
  const recheckSidebarRef = React.useRef(false);

  const refreshCanWiden = React.useCallback(() => {
    void appApi.designWindowCanWiden().then(
      (result) => {
        if (activeRef.current) setCanWiden(result?.canWiden === true);
      },
      () => {
        if (activeRef.current) setCanWiden(false);
      },
    );
  }, []);

  const widen = React.useCallback(() => {
    void appApi.widenForDesign().then(
      (result) => {
        if (!activeRef.current) return;
        if (result?.widened) {
          // The resize that follows decides the layout; the banner goes with the stacked mode.
          recheckSidebarRef.current = true;
          setCanWiden(false);
        } else {
          setWidenFailed(true);
        }
      },
      () => {
        if (activeRef.current) setWidenFailed(true);
      },
    );
  }, []);

  const recheckSidebar = React.useCallback(() => {
    const current = sidebarRef.current;
    const element = containerRef.current;
    const sidebarWidth = readSidebarCollapsedByDesign();
    if (!current?.collapsed || !element || sidebarWidth === null) return;
    if (element.getBoundingClientRect().width - sidebarWidth >= DESIGN_SPLIT_MIN_WIDTH) {
      writeSidebarCollapsedByDesign(null);
      current.setCollapsed(false);
    }
  }, [containerRef]);

  // A person's entry makes room once; every other way into design mode leaves the window alone.
  React.useLayoutEffect(() => {
    if (!active || !chatId) return;
    const source = consumePendingDesignEntry(chatId);
    const element = containerRef.current;
    if (!source || !element) return;
    const current = sidebarRef.current;
    // Measure the room design mode will have, not the container now: on entry the
    // Environment panel is still closing and would make the content look too narrow.
    const sidebarWidth = current?.reservedWidth ?? 0;
    const containerWidth = Math.max(0, window.innerWidth - sidebarWidth);
    const action = resolveDesignEntryAction({ containerWidth, sidebarWidth, canWiden: true });
    if (action === "collapseSidebar" && current) {
      current.setCollapsed(true);
      writeSidebarCollapsedByDesign(sidebarWidth);
    } else if (action === "widenWindow") {
      // Main refuses (and says so) when widening cannot work, which leaves no banner.
      widen();
    }
  }, [active, chatId, containerRef, widen]);

  React.useLayoutEffect(() => {
    if (state === "pending") return;
    if (state === "inactive") {
      setCanWiden(false);
      setDismissed(false);
      setWidenFailed(false);
      recheckSidebarRef.current = false;
      if (readSidebarCollapsedByDesign() !== null) {
        writeSidebarCollapsedByDesign(null);
        if (sidebarRef.current?.collapsed) sidebarRef.current.setCollapsed(false);
      }
      return;
    }
    refreshCanWiden();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (recheckSidebarRef.current) {
          recheckSidebarRef.current = false;
          recheckSidebar();
        }
        refreshCanWiden();
      }, RESIZE_SETTLE_MS);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [recheckSidebar, refreshCanWiden, state]);

  const dismiss = React.useCallback(() => setDismissed(true), []);
  return { bannerVisible: stacked && canWiden && !dismissed && !widenFailed, widen, dismiss };
}
