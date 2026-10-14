// The Bot side panel (spec §8) on the C1 workbench shell, beside a Bot's chat:
// fixed Activity, Files, Memory and Routines tabs. A tab's body mounts the first
// time it is shown, then stays mounted like the workspace views. The panel has
// its own state, id, surface name, width key, focus hand-off and Escape, so the
// workspace Environment panel (suppressed on Bots pages) is never touched.

import * as React from "react";
import { CalendarClock, Files, ListChecks } from "lucide-react";
import { MemoryCardIcon } from "../../components/memory-card-icon";
import { WorkbenchPanel, useWorkbenchWidth, type WorkbenchTab, type WorkbenchView } from "../../components/workbench-panel";
import { resolveEnvironmentPanelLayout } from "../../lib/environment-panel-layout";
import { useBot } from "../../lib/queries";
import { cn } from "../../lib/ui-utils";
import { BotLiveProvider, useSharedBotLive } from "../../lib/use-bot-live";
import { BotMemoryContent } from "./bot-memory-page";
import { BotPanelActivity } from "./bot-panel-activity";
import { BOT_PANEL_ID, BOT_PANEL_TABS, BOT_PANEL_WIDTH_KEY, useBotPanel, type BotPanelTab } from "./bot-panel-context";
import { BotPanelFiles } from "./bot-panel-files";
import { BotRoutines } from "./bot-routines";

const TAB_META: Record<BotPanelTab, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  activity: { label: "Activity", icon: ListChecks },
  files: { label: "Files", icon: Files },
  memory: { label: "Memory", icon: MemoryCardIcon },
  routines: { label: "Routines", icon: CalendarClock },
};

/** Wraps a Bot's chat with its side panel; both read the Bot's one live subscription. */
export function BotWorkbench({ botId, children }: React.PropsWithChildren<{ botId: string }>) {
  return (
    <BotLiveProvider botId={botId}>
      <BotWorkbenchLayout botId={botId}>{children}</BotWorkbenchLayout>
    </BotLiveProvider>
  );
}

function BotWorkbenchLayout({ botId, children }: React.PropsWithChildren<{ botId: string }>) {
  const { open, tab, fileRequest, focusRequest, close, consumeFocusRequest, setTab } = useBotPanel();
  const bot = useBot(botId).data ?? null;
  const live = useSharedBotLive(botId);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const activeTabRef = React.useRef<HTMLButtonElement | null>(null);
  const [containerWidth, setContainerWidth] = React.useState(() => window.innerWidth);
  const panelWidth = useWorkbenchWidth(BOT_PANEL_WIDTH_KEY);
  const { width, inline } = resolveEnvironmentPanelLayout(panelWidth.preferredWidth, containerWidth);
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

  const tabs: WorkbenchTab[] = BOT_PANEL_TABS.map((id) => ({
    id,
    viewId: id,
    label: TAB_META[id].label,
    icon: TAB_META[id].icon,
    selected: tab === id,
    closable: false,
  }));
  const running = live.snapshot?.state.kind === "running";
  const body = (id: BotPanelTab, active: boolean): React.ReactNode => {
    if (!bot) return null;
    switch (id) {
      case "activity":
        // Always the full log: the Bot's Chat activity level shapes only the in-chat
        // recap, and opening this tab is the person asking to see every step.
        return (
          <BotPanelActivity
            botName={bot.name}
            entries={live.snapshot?.entries ?? []}
            running={running}
            loading={live.snapshot === null && !live.failed}
          />
        );
      case "files":
        return <BotPanelFiles botId={bot.id} botName={bot.name} active={active} request={fileRequest} />;
      case "memory":
        return <BotMemoryContent bot={bot} compact />;
      case "routines":
        return <BotRoutines bot={bot} />;
    }
  };
  const views: WorkbenchView[] = BOT_PANEL_TABS.map((id) => ({
    id,
    render: ({ presented, selected }) =>
      visited.has(id) ? (
        <div className="h-full min-h-0 overflow-y-auto px-3 py-4">{body(id, presented && selected)}</div>
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
        resizing={panelWidth.resizing}
        onResizingChange={panelWidth.setResizing}
        onWidthChange={panelWidth.setPreferredWidth}
        onWidthCommit={panelWidth.commitPreferredWidth}
        views={views}
        selectedViewId={tab}
        activeTabRef={activeTabRef}
        tabs={tabs}
        idPrefix={BOT_PANEL_ID}
        tabListLabel="Bot panel views"
        onSelectTab={(entry) => setTab(entry.viewId as BotPanelTab)}
        onCloseTab={() => undefined}
        closeLabel="Close Bot panel"
        closeTitle="Close panel"
        onClose={close}
      />
    </div>
  );
}
