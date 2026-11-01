import * as React from "react";
import { DesignModeBanner } from "../components/design-mode-banner";
import { EnvironmentWorkbench, type WorkbenchDesignState } from "../components/environment-panel";
import { useSplitViewSidebar } from "../components/ui";
import { useWorkbenchWidth } from "../components/workbench-panel";
import { useDesignMode } from "../lib/design-mode";
import {
  DESIGN_CANVAS_MIN_WIDTH,
  DESIGN_CHAT_WIDTH_BOUNDS,
  DESIGN_SIDEBAR_COLLAPSE_BELOW,
  DESIGN_WIDE_WINDOW_MIN,
  resolveDesignCanvasLayout,
  resolveDesignWindowPolicy,
} from "../lib/environment-panel-layout";
import { appApi } from "../lib/ipc";
import { DesignCanvasRegion } from "./design-canvas-region";
import { DesignChatDivider } from "./design-chat-divider";

export const DESIGN_CHAT_WIDTH_STORAGE_KEY = "aiden-agent.design.chat-width";
/** Set while the sidebar is collapsed because design mode collapsed it, so exit reopens only that. */
const SIDEBAR_COLLAPSED_BY_DESIGN_STORAGE_KEY = "aiden-agent.design.sidebar-collapsed-by-design";

/** Design mode for the open chat, as the chat area and the sidebar both use it. */
export interface DesignChatState {
  state: WorkbenchDesignState;
  /** The open chat's workspace while design mode is active, for the scoped sidebar. */
  workspaceId: string | undefined;
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
  return { state, workspaceId: state === "active" ? design.workspaceId : undefined };
}

/** The chat area with design mode wired in. */
export function DesignWorkbench({
  chatId,
  design,
  suppressed,
  children,
}: React.PropsWithChildren<{
  chatId: string | undefined;
  /** From `useDesignChatState`; "inactive" on surfaces design mode never applies to. */
  design: WorkbenchDesignState;
  suppressed: boolean;
}>) {
  return (
    <EnvironmentWorkbench suppressed={suppressed} design={design}>
      <DesignLayout chatId={chatId} state={design}>
        {children}
      </DesignLayout>
    </EnvironmentWorkbench>
  );
}

/**
 * Splits the chat area into the design chat column and the canvas while
 * design mode is active. The chat content keeps one place in the tree, so
 * entering or leaving never remounts the conversation.
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
  const windowPolicy = useDesignWindowPolicy(state);

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
    <div ref={containerRef} data-design-layout={on ? "on" : "off"} className="relative flex h-full min-h-0 w-full">
      <div
        data-design-mode={on ? "true" : undefined}
        className="h-full min-h-0 min-w-0 flex-1"
        style={on && layout.inline ? { width: layout.chatWidth, flex: "none" } : undefined}
      >
        {children}
      </div>
      {on && chatId ? (
        <>
          {layout.inline ? (
            <DesignChatDivider
              width={layout.chatWidth}
              min={DESIGN_CHAT_WIDTH_BOUNDS.min}
              max={Math.max(
                DESIGN_CHAT_WIDTH_BOUNDS.min,
                Math.min(DESIGN_CHAT_WIDTH_BOUNDS.max, containerWidth - DESIGN_CANVAS_MIN_WIDTH),
              )}
              onWidthChange={chatWidth.setPreferredWidth}
              onWidthCommit={chatWidth.commitPreferredWidth}
              onResizingChange={chatWidth.setResizing}
            />
          ) : null}
          <DesignCanvasRegion chatId={chatId} width={layout.canvasWidth} overlay={!layout.inline} />
          {windowPolicy.bannerVisible ? (
            <div className="pointer-events-none absolute inset-x-0 top-14 z-40 flex justify-center px-3">
              <div className="pointer-events-auto">
                <DesignModeBanner onWiden={windowPolicy.widen} />
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // The flag only decides whether exit reopens the sidebar.
  }
}

/**
 * The window rules for design mode: below 1100 px the sidebar collapses (and
 * reopens on exit only if design mode collapsed it); below 840 px Aiden asks
 * main to widen the window and shows a banner when it cannot.
 */
function useDesignWindowPolicy(state: WorkbenchDesignState): { bannerVisible: boolean; widen(): void } {
  const sidebar = useSplitViewSidebar();
  const sidebarRef = React.useRef(sidebar);
  sidebarRef.current = sidebar;
  const [bannerVisible, setBannerVisible] = React.useState(false);
  const activeRef = React.useRef(false);
  activeRef.current = state === "active";

  const widen = React.useCallback(() => {
    void appApi.widenForDesign().then(
      (result) => {
        if (!activeRef.current) return;
        setBannerVisible(!result?.widened || window.innerWidth < DESIGN_WIDE_WINDOW_MIN);
      },
      () => {
        if (activeRef.current) setBannerVisible(true);
      },
    );
  }, []);

  const collapseSidebar = React.useCallback(() => {
    const current = sidebarRef.current;
    if (!current || current.collapsed) return;
    current.setCollapsed(true);
    writeFlag(SIDEBAR_COLLAPSED_BY_DESIGN_STORAGE_KEY, true);
  }, []);

  React.useLayoutEffect(() => {
    if (state === "pending") return;
    if (state === "inactive") {
      setBannerVisible(false);
      if (readFlag(SIDEBAR_COLLAPSED_BY_DESIGN_STORAGE_KEY)) {
        writeFlag(SIDEBAR_COLLAPSED_BY_DESIGN_STORAGE_KEY, false);
        if (sidebarRef.current?.collapsed) sidebarRef.current.setCollapsed(false);
      }
      return;
    }
    const policy = resolveDesignWindowPolicy(window.innerWidth);
    if (policy.collapseSidebar) collapseSidebar();
    if (policy.needsWiderWindow) widen();

    let previousWidth = window.innerWidth;
    const onResize = () => {
      const width = window.innerWidth;
      if (previousWidth >= DESIGN_SIDEBAR_COLLAPSE_BELOW && width < DESIGN_SIDEBAR_COLLAPSE_BELOW) collapseSidebar();
      if (width >= DESIGN_WIDE_WINDOW_MIN) setBannerVisible(false);
      else if (previousWidth >= DESIGN_WIDE_WINDOW_MIN) setBannerVisible(true);
      previousWidth = width;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [collapseSidebar, state, widen]);

  return { bannerVisible, widen };
}
