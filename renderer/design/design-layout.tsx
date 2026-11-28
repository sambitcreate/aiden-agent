import * as React from "react";
import { DesignModeBanner } from "../components/design-mode-banner";
import {
  EnvironmentWorkbench,
  useEnvironmentPanelCore,
  type WorkbenchDesignState,
} from "../components/environment-panel";
import { useSplitViewSidebar } from "../components/ui";
import { useWorkbenchWidth } from "../components/workbench-panel";
import { useCommandHandler } from "../lib/command-system";
import {
  consumePendingDesignEntry,
  DesignModeControlsContext,
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
import { DesignExpandContext, type DesignExpandState } from "./design-expand";
import {
  DESIGN_CHAT_WIDTH_STORAGE_KEY,
  SIDEBAR_COLLAPSED_BY_DESIGN_STORAGE_KEY,
  DesignBannerContext,
  DesignChatBody,
  DesignModeBannerSlot,
  DesignPaneContext,
  useDesignChatBodyHidden,
  useDesignChatState,
  useDesignPane,
  type ActiveDesignShellSnapshot,
  type DesignBannerState,
  type DesignChatState,
  type DesignPane,
  type DesignPaneState,
} from "./design-shell";

export {
  DESIGN_CHAT_WIDTH_STORAGE_KEY,
  DesignChatBody,
  DesignModeBannerSlot,
  useDesignChatBodyHidden,
  useDesignChatState,
  useDesignPane,
  type DesignChatState,
  type DesignPane,
  type DesignPaneState,
};

/**
 * "1" while the person wants design mode expanded (the sidebar collapsed), so
 * their next entry into design mode starts expanded too. Device-local.
 */
const DESIGN_EXPANDED_STORAGE_KEY = "aiden-agent.design.expanded";
/** Used when an older build saved the flag without the sidebar's width. */
const FALLBACK_SIDEBAR_WIDTH = 272;
/** Resizes settle (a widen animates) before Aiden asks main again or re-checks the sidebar. */
const RESIZE_SETTLE_MS = 150;

/**
 * While the stacked layout shows the canvas, the Live pill moves to the
 * canvas's bottom-left corner, this far from the content's left edge, so it
 * stays clear of the zoom controls and overview at the bottom right.
 */
const STACKED_DOCK_LANE = 128;

/** Each chat's stacked pane, for this app session. */
const stackedPaneByChat = new Map<string, DesignPane>();

function renderDesignBanner({
  onWiden,
  onDismiss,
}: {
  onWiden(): void;
  onDismiss(): void;
}) {
  return <DesignModeBanner onWiden={onWiden} onDismiss={onDismiss} />;
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

function useDesignLayoutController(
  chatId: string | undefined,
  state: WorkbenchDesignState,
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const on = state === "active" && Boolean(chatId);
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
  const paneState = React.useMemo<DesignPaneState>(
    () => ({ stacked, pane, setPane }),
    [pane, setPane, stacked],
  );
  const expand = windowPolicy.expand;
  const expandAvailable = on && expand.available;
  const toggleExpanded = React.useCallback(() => expand.setExpanded(!expand.expanded), [expand]);
  // ⌘⇧\ is left alone outside design mode.
  useCommandHandler("design.expand", toggleExpanded, expandAvailable);
  const [bannerHeight, setBannerHeight] = React.useState(0);
  const bannerVisible = Boolean(chatId) && windowPolicy.bannerVisible;
  const bannerState = React.useMemo<DesignBannerState>(
    () => ({
      visible: bannerVisible,
      widen: windowPolicy.widen,
      dismiss: windowPolicy.dismiss,
      reportHeight: setBannerHeight,
      renderBanner: renderDesignBanner,
    }),
    [bannerVisible, windowPolicy.dismiss, windowPolicy.widen],
  );
  const canvasHidden = stacked && pane === "chat";
  const dockInset = !on
    ? null
    : !stacked
      ? layout.canvasWidth
      : pane === "canvas"
        ? Math.max(0, containerWidth - STACKED_DOCK_LANE)
        : null;
  const { reportDesignDockInset } = useEnvironmentPanelCore();
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
  }, [containerRef]);

  const canvasSibling =
    on && chatId ? (
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
          stackedTopInset={bannerVisible ? bannerHeight : 0}
        />
      </>
    ) : null;

  return {
    on,
    stacked,
    layout,
    paneState,
    expand,
    bannerState,
    canvasSibling,
  };
}

/**
 * Lazy-loadable active design workbench surface used inside `DesignShell` so
 * `ChatLayout` avoids loading design canvas/divider/banner code until design
 * mode activates, without ever remounting the conversation column.
 */
export function DesignWorkbenchSurface({
  chatId,
  state,
  containerRef,
  onSnapshotChange,
}: {
  chatId: string | undefined;
  state: WorkbenchDesignState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSnapshotChange: (snapshot: ActiveDesignShellSnapshot | null) => void;
}) {
  const { on, stacked, layout, paneState, expand, bannerState, canvasSibling } =
    useDesignLayoutController(chatId, state, containerRef);
  const layoutMode: "off" | "split" | "stacked" = on ? layout.mode : "off";

  React.useLayoutEffect(() => {
    onSnapshotChange({
      layoutMode,
      on,
      stacked,
      chatWidth: layout.chatWidth,
      paneState,
      expand,
      bannerState,
    });
  }, [bannerState, expand, layout.chatWidth, layoutMode, on, onSnapshotChange, paneState, stacked]);

  React.useLayoutEffect(() => () => onSnapshotChange(null), [onSnapshotChange]);

  return canvasSibling;
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
  const containerRef = React.useRef<HTMLDivElement>(null);
  const { on, stacked, layout, paneState, expand, bannerState, canvasSibling } =
    useDesignLayoutController(chatId, state, containerRef);

  return (
    <DesignPaneContext.Provider value={paneState}>
      <DesignExpandContext.Provider value={expand}>
        <DesignBannerContext.Provider value={bannerState}>
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
            {canvasSibling}
          </div>
        </DesignBannerContext.Provider>
      </DesignExpandContext.Provider>
    </DesignPaneContext.Provider>
  );
}

function readDesignExpanded(): boolean {
  try {
    return localStorage.getItem(DESIGN_EXPANDED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDesignExpanded(expanded: boolean): void {
  try {
    if (expanded) localStorage.setItem(DESIGN_EXPANDED_STORAGE_KEY, "1");
    else localStorage.removeItem(DESIGN_EXPANDED_STORAGE_KEY);
  } catch {
    // The preference only decides how the next entry starts.
  }
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
 *
 * Expand collapses the sidebar, which leaves room to split on any window wide
 * enough to keep the sidebar beside the content, and is remembered for the
 * person's next entry. Minimize, opening the sidebar by hand, or leaving design
 * mode brings the sidebar back.
 */
function useDesignWindowPolicy(
  state: WorkbenchDesignState,
  chatId: string | undefined,
  containerRef: React.RefObject<HTMLDivElement | null>,
  stacked: boolean,
): { bannerVisible: boolean; widen(): void; dismiss(): void; expand: DesignExpandState } {
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
    // An expanded layout keeps the sidebar closed even when it would fit again.
    if (!current?.collapsed || !element || sidebarWidth === null || readDesignExpanded()) return;
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
    if (readDesignExpanded() && current && !current.overlaid) {
      // The person left design mode expanded last time, so it starts that way again.
      // A window wide enough to keep its sidebar beside the content always splits without it.
      if (!current.collapsed) {
        current.setCollapsed(true);
        writeSidebarCollapsedByDesign(sidebarWidth || FALLBACK_SIDEBAR_WIDTH);
      }
      return;
    }
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

  const collapsed = sidebar?.collapsed === true;
  // Opening the sidebar by hand while design mode stays on undoes Expand for next time too,
  // and makes the sidebar the person's again: a later collapse is theirs, so exit leaves it.
  // Design mode's own reopenings clear the marker before they open the sidebar.
  const previousRef = React.useRef({ active, collapsed });
  React.useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { active, collapsed };
    if (active && previous.active && previous.collapsed && !collapsed) {
      writeDesignExpanded(false);
      writeSidebarCollapsedByDesign(null);
    }
  }, [active, collapsed]);

  const setExpanded = React.useCallback((next: boolean) => {
    const current = sidebarRef.current;
    if (!activeRef.current || !current || current.overlaid) return;
    writeDesignExpanded(next);
    if (!next) {
      writeSidebarCollapsedByDesign(null);
      current.setCollapsed(false);
      return;
    }
    if (!current.collapsed) {
      // Marked as design mode's own collapse, so Minimize and leaving design mode reopen it.
      if (readSidebarCollapsedByDesign() === null) {
        writeSidebarCollapsedByDesign(current.reservedWidth || FALLBACK_SIDEBAR_WIDTH);
      }
      current.setCollapsed(true);
    }
  }, []);
  const expand = React.useMemo<DesignExpandState>(
    // A narrow window's sidebar slides over the content, so there is nothing to expand into.
    () => ({
      available: active && sidebar !== null && !sidebar.overlaid,
      expanded: active && collapsed,
      setExpanded,
    }),
    [active, collapsed, setExpanded, sidebar],
  );

  const dismiss = React.useCallback(() => setDismissed(true), []);
  return { bannerVisible: stacked && canWiden && !dismissed && !widenFailed, widen, dismiss, expand };
}
