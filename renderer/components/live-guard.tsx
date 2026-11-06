// Marks a part of Aiden that Aiden Live must leave to the user ("you") or may
// use only after the user's OK ("confirm"). The mark is a `data-live-guard`
// attribute, which main checks on the live page before every action. Menus,
// dialogs, popovers and selects render into a portal outside their region, so
// the region also passes its guard down through context; the shared content
// components in ui.tsx stamp it on their portaled root.

import * as React from "react";
import { LIVE_GUARD_ATTRIBUTE, type LiveGuard as LiveGuardValue } from "../shared/live-app-control";

const LiveGuardContext = React.createContext<LiveGuardValue | null>(null);

/** The guard of the nearest LiveGuard region, for portaled content to carry along. */
export function useLiveGuard(): LiveGuardValue | null {
  return React.useContext(LiveGuardContext);
}

/**
 * Attributes for a portaled root inside a LiveGuard region. Spread them after
 * the caller's props: the stronger of the region's guard and one the caller
 * set directly wins, so neither can weaken the other.
 */
export function useLiveGuardAttributes(props?: object): { [LIVE_GUARD_ATTRIBUTE]?: LiveGuardValue } {
  const inherited = useLiveGuard();
  const explicit = props ? (props as Record<string, unknown>)[LIVE_GUARD_ATTRIBUTE] : undefined;
  const own = explicit === "you" || explicit === "confirm" ? explicit : null;
  const guard = inherited === "you" || own === "you" ? "you" : (inherited ?? own);
  return guard ? { [LIVE_GUARD_ATTRIBUTE]: guard } : {};
}

/**
 * Guards everything inside, including what it opens in a portal. "you" always
 * wins over an outer or inner "confirm". With `wrap={false}` only the context
 * is set, for a child that already stamps the attribute itself.
 */
export function LiveGuard({
  guard,
  wrap = true,
  children,
}: {
  guard: LiveGuardValue;
  wrap?: boolean;
  children: React.ReactNode;
}) {
  const outer = React.useContext(LiveGuardContext);
  const value: LiveGuardValue = outer === "you" ? "you" : guard;
  return (
    <LiveGuardContext.Provider value={value}>
      {wrap ? (
        <div className="contents" {...{ [LIVE_GUARD_ATTRIBUTE]: value }}>
          {children}
        </div>
      ) : (
        children
      )}
    </LiveGuardContext.Provider>
  );
}
