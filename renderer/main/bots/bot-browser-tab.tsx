// A Bot's own browser in its side panel (plan §5.1): the shared browser panel
// in its Bot variant, without profile choice, annotations, DevTools, capture,
// recording or floating, plus the presence the panel needs to show the tab.
//
// The window that shows a Bot owns its browser: asking for the browser's state
// moves it here, and so does focusing this window again after another window
// showed the same Bot.

import * as React from "react";
import { BrowserPanel } from "../../components/browser-panel";
import { botsApi, browserApi } from "../../lib/ipc";
import type { BrowserState } from "../../shared/browser";

export interface BotBrowserPresence {
  /** The Bot's browser workspace; `null` while unknown or for a Bot that is gone. */
  workspaceId: string | null;
  /** The Bot's browser has at least one tab. */
  hasTabs: boolean;
  /** The first read has answered or failed. */
  resolved: boolean;
}

const UNKNOWN: BotBrowserPresence = { workspaceId: null, hasTabs: false, resolved: false };

function same(left: BotBrowserPresence, right: BotBrowserPresence): boolean {
  return left.workspaceId === right.workspaceId && left.hasTabs === right.hasTabs && left.resolved === right.resolved;
}

/**
 * Whether `botId`'s browser has tabs, kept current from browser events.
 * `onShow` runs when the Bot, or a hand-off card's Open, opens a tab to show,
 * and when a tab is newly held for the person: a sign-in opened from a phone
 * may hold its tab before this chat is on screen to hear it open.
 */
export function useBotBrowserPresence(botId: string, onShow: () => void): BotBrowserPresence {
  const [presence, setPresence] = React.useState<BotBrowserPresence>(UNKNOWN);
  const onShowRef = React.useRef(onShow);
  onShowRef.current = onShow;

  React.useEffect(() => {
    let cancelled = false;
    let workspaceId: string | null = null;
    // Each hold is revealed once while this chat is open, so a later focus or
    // state change never pulls the panel back to Browser.
    const revealedHolds = new Set<string>();
    const update = (next: BotBrowserPresence) => setPresence((current) => (same(current, next) ? current : next));
    const revealNewHolds = (state: BrowserState) => {
      let fresh = false;
      for (const tab of state.tabs) {
        if (!tab.heldForPerson || revealedHolds.has(tab.id)) continue;
        revealedHolds.add(tab.id);
        fresh = true;
      }
      for (const id of [...revealedHolds]) {
        if (!state.tabs.some((tab) => tab.id === id && tab.heldForPerson)) revealedHolds.delete(id);
      }
      if (fresh) onShowRef.current();
    };
    const read = async () => {
      try {
        const answer = await botsApi.browser.workspace(botId);
        if (cancelled) return;
        workspaceId = answer?.workspaceId ?? null;
        if (workspaceId === null) {
          update({ workspaceId: null, hasTabs: false, resolved: true });
          return;
        }
        const state = await browserApi.getState(workspaceId);
        if (cancelled) return;
        update({ workspaceId, hasTabs: state.tabs.length > 0, resolved: true });
        revealNewHolds(state);
      } catch {
        if (!cancelled) setPresence((current) => (current.resolved ? current : { ...current, resolved: true }));
      }
    };
    void read();
    const unsubscribe = browserApi.onEvent((event) => {
      if (workspaceId === null) return;
      if (event.type === "state" && event.state.workspaceId === workspaceId) {
        update({ workspaceId, hasTabs: event.state.tabs.length > 0, resolved: true });
        revealNewHolds(event.state);
      } else if (event.type === "show" && event.workspaceId === workspaceId) {
        update({ workspaceId, hasTabs: true, resolved: true });
        onShowRef.current();
      }
    });
    // Another window may have shown this Bot meanwhile and taken its browser.
    const onFocus = () => void read();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [botId]);

  return presence;
}

/** The Browser tab's body: the Bot's own browser, live while the tab is shown. */
export function BotBrowserTab({ workspaceId, botName, active }: { workspaceId: string; botName: string; active: boolean }) {
  return <BrowserPanel workspaceId={workspaceId} active={active} variant="bot" agentName={botName} />;
}
