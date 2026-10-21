// The Bot side panel (spec §8) on the C1 workbench shell, beside a Bot's chat:
// fixed Activity, Files, Memory and Routines tabs, and Browser once the Bot's
// own browser has a tab (a stored Browser tab shows Activity until then; a tab
// the Bot or a hand-off opens to show reveals it). A tab's body mounts the first
// time it is shown, then stays mounted like the workspace views. The panel has
// its own state, id, surface name, width key, focus hand-off and Escape, so the
// workspace Environment panel (suppressed on Bots pages) is never touched.
// Floating over a narrow chat, it repeats a waiting hand-off card's buttons.

import * as React from "react";
import { CalendarClock, Files, Globe, ListChecks } from "lucide-react";
import { MemoryCardIcon } from "../../components/memory-card-icon";
import { WorkbenchPanel, useWorkbenchWidth, type WorkbenchTab, type WorkbenchView } from "../../components/workbench-panel";
import { BOT_PANEL_WIDTH_BOUNDS, resolveEnvironmentPanelLayout } from "../../lib/environment-panel-layout";
import { useBot } from "../../lib/queries";
import { cn } from "../../lib/ui-utils";
import { useBotLive } from "../../lib/use-bot-live";
import type { BotTranscriptEntry } from "../../shared/bot-live";
import { BotBrowserTab, useBotBrowserPresence } from "./bot-browser-tab";
import { BotMemoryContent } from "./bot-memory-page";
import { BotPanelActivity } from "./bot-panel-activity";
import { BOT_PANEL_ID, BOT_PANEL_TABS, BOT_PANEL_WIDTH_KEY, useBotPanel, type BotPanelTab } from "./bot-panel-context";
import { BotPanelFiles } from "./bot-panel-files";
import { BotPanelHandoff } from "./bot-panel-handoff";
import { BotRoutines } from "./bot-routines";

const TAB_META: Record<BotPanelTab, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  activity: { label: "Activity", icon: ListChecks },
  files: { label: "Files", icon: Files },
  memory: { label: "Memory", icon: MemoryCardIcon },
  routines: { label: "Routines", icon: CalendarClock },
  browser: { label: "Browser", icon: Globe },
};

/**
 * The log redraws only when its entries or running state change, never for a
 * streamed token (`partial`) or other live fields it doesn't show.
 */
const MemoBotPanelActivity = React.memo(BotPanelActivity);
const NO_ENTRIES: readonly BotTranscriptEntry[] = [];

/**
 * The Activity tab owns its read of the live conversation, so a live event
 * re-renders this subtree and not the rest of the panel. It shares the Bot's
 * one live subscription with the chat beside it.
 */
function ActivityTab({ botId, botName }: { botId: string; botName: string }) {
  const live = useBotLive(botId);
  // Always the full log: the Bot's Chat activity level shapes only the in-chat
  // recap, and opening this tab is the person asking to see every step.
  return (
    <MemoBotPanelActivity
      botName={botName}
      entries={live.snapshot?.entries ?? NO_ENTRIES}
      running={live.snapshot?.state.kind === "running"}
      loading={live.snapshot === null && !live.failed}
      failed={live.snapshot === null && live.failed}
      onRetry={live.reload}
    />
  );
}

/**
 * Wraps a Bot's chat with its side panel. The chat holds the Bot's live
 * subscription for as long as it is shown; the Activity tab shares it.
 */
export function BotWorkbench({ botId, children }: React.PropsWithChildren<{ botId: string }>) {
  const { open, tab: storedTab, fileRequest, focusRequest, close, consumeFocusRequest, setTab, reveal } = useBotPanel();
  const bot = useBot(botId).data ?? null;
  const revealBrowser = React.useCallback(() => reveal("browser"), [reveal]);
  const browser = useBotBrowserPresence(botId, revealBrowser);
  // Once shown, Browser stays while this chat is open, so closing the last tab doesn't move the panel.
  const [browserSeen, setBrowserSeen] = React.useState(false);
  if (browser.hasTabs && !browserSeen) setBrowserSeen(true);
  const browserShown =
    (browser.workspaceId !== null && (browser.hasTabs || browserSeen)) || (!browser.resolved && storedTab === "browser");
  const tab: BotPanelTab = storedTab === "browser" && !browserShown ? "activity" : storedTab;
  const shownTabs = BOT_PANEL_TABS.filter((id) => id !== "browser" || browserShown);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const activeTabRef = React.useRef<HTMLButtonElement | null>(null);
  const [containerWidth, setContainerWidth] = React.useState(() => window.innerWidth);
  const panelWidth = useWorkbenchWidth(BOT_PANEL_WIDTH_KEY, BOT_PANEL_WIDTH_BOUNDS);
  // Beside the chat, reflowing it, wherever the chat keeps a usable column.
  const { width, inline } = resolveEnvironmentPanelLayout(panelWidth.preferredWidth, containerWidth, BOT_PANEL_WIDTH_BOUNDS);
  const [visited, setVisited] = React.useState<ReadonlySet<BotPanelTab>>(() => new Set());
  // Mark the shown tab visited in the same render, so its body never paints a blank frame.
  if (open && !visited.has(tab)) setVisited(new Set([...visited, tab]));

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setContainerWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A person-initiated open focuses the selected tab; a panel restored open at launch does not.
  React.useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (consumeFocusRequest()) activeTabRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, tab, focusRequest, consumeFocusRequest]);

  // Arrow keys in the strip select a tab; focus follows to the strip's one tab stop.
  React.useEffect(() => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active.getAttribute("role") === "tab" &&
      active.closest(`#${BOT_PANEL_ID}`) &&
      active !== activeTabRef.current
    ) {
      activeTabRef.current?.focus();
    }
  }, [tab]);

  // The workspace's Escape handler is not installed on Bots pages; this one closes the Bot panel.
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !active.closest(`#${BOT_PANEL_ID}`)) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  const tabs: WorkbenchTab[] = shownTabs.map((id) => ({
    id,
    viewId: id,
    label: TAB_META[id].label,
    icon: TAB_META[id].icon,
    selected: tab === id,
    closable: false,
  }));
  const body = (id: BotPanelTab, active: boolean): React.ReactNode => {
    if (!bot) return null;
    switch (id) {
      case "activity":
        return <ActivityTab botId={bot.id} botName={bot.name} />;
      case "files":
        return <BotPanelFiles botId={bot.id} botName={bot.name} active={active} request={fileRequest} />;
      case "memory":
        return <BotMemoryContent bot={bot} compact />;
      case "routines":
        return <BotRoutines bot={bot} compact />;
      case "browser":
        return browser.workspaceId === null ? null : (
          <BotBrowserTab workspaceId={browser.workspaceId} botName={bot.name} active={active} />
        );
    }
  };
  const views: WorkbenchView[] = shownTabs.map((id) => ({
    id,
    render: ({ presented, selected }) =>
      id === "browser" ? (
        // The page owns the whole area: no padding or scroller of its own.
        visited.has(id) ? <div className="flex h-full min-h-0 flex-col">{body(id, presented && selected)}</div> : null
      ) : visited.has(id) ? (
        <div
          // The log has no controls of its own, so its scroller takes a tab stop to scroll by
          // keyboard. The tab panel around it already carries the "Activity" name.
          {...(id === "activity" ? { tabIndex: 0 } : {})}
          className="h-full min-h-0 overflow-y-auto px-3 py-4 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
        >
          {body(id, presented && selected)}
        </div>
      ) : null,
  }));

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 w-full flex-1 overflow-clip">
      <div className="h-full min-h-0 min-w-0 flex-1">{children}</div>
      <div
        aria-hidden="true"
        className={cn(
          "h-full shrink-0 transition-[width] duration-300 ease-out motion-reduce:transition-none",
          panelWidth.resizing && "transition-none",
        )}
        style={{ width: open && inline ? width : 0 }}
      />
      <WorkbenchPanel
        id={BOT_PANEL_ID}
        surface="bot-panel"
        label="Bot panel"
        resizeLabel="Resize Bot panel"
        open={open}
        presented={open}
        inline={inline}
        width={width}
        containerWidth={containerWidth}
        widthBounds={BOT_PANEL_WIDTH_BOUNDS}
        resizing={panelWidth.resizing}
        onResizingChange={panelWidth.setResizing}
        onWidthChange={panelWidth.setPreferredWidth}
        onWidthCommit={panelWidth.commitPreferredWidth}
        views={views}
        selectedViewId={tab}
        // Floating, the panel covers the hand-off card above the composer; it carries the card's buttons instead.
        notice={open && !inline && bot ? <BotPanelHandoff botId={bot.id} name={bot.name} avatar={bot.avatar} /> : null}
        activeTabRef={activeTabRef}
        tabs={tabs}
        idPrefix={BOT_PANEL_ID}
        tabListLabel="Bot panel views"
        // At most five fixed tabs, which always fit; there is nothing for an "Open tabs" list to reveal.
        tabMenu={false}
        onSelectTab={(entry) => setTab(entry.viewId as BotPanelTab)}
        onCloseTab={() => undefined}
        closeLabel="Close Bot panel"
        closeTitle="Close panel"
        onClose={close}
      />
    </div>
  );
}
