// Back/forward through the window's in-app navigation history, shown beside the
// sidebar toggle. The router keeps its own memory history, so availability
// comes from the current entry's index rather than the browser's history.

import { useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "./ui";
import { historyNavigationAvailability } from "../lib/history-navigation";

// `aria-disabled` rather than `disabled`: reaching the first or last entry
// must not drop keyboard focus from the button that was just used.
const UNAVAILABLE = "no-drag aria-disabled:opacity-45 aria-disabled:hover:bg-transparent";

export function HistoryNavButtons() {
  const router = useRouter();
  // Re-render on every navigation; the entry index lives in location state.
  const entryIndex = useRouterState({
    select: (state) => (state.location.state as { __TSR_index?: number }).__TSR_index,
  });
  const { canGoBack, canGoForward } = historyNavigationAvailability(
    entryIndex,
    router.history.length,
  );
  return (
    <>
      <Button
        iconOnly
        size="small"
        variant="bar"
        className={UNAVAILABLE}
        aria-label="Go back"
        title="Go back"
        aria-disabled={!canGoBack || undefined}
        onClick={() => {
          if (canGoBack) router.history.back();
        }}
      >
        <ArrowLeft />
      </Button>
      <Button
        iconOnly
        size="small"
        variant="bar"
        className={UNAVAILABLE}
        aria-label="Go forward"
        title="Go forward"
        aria-disabled={!canGoForward || undefined}
        onClick={() => {
          if (canGoForward) router.history.forward();
        }}
      >
        <ArrowRight />
      </Button>
    </>
  );
}
