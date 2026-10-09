// Back/forward through the window's in-app navigation history, shown beside the
// sidebar toggle. The router keeps its own memory history, so availability
// comes from the current entry's index rather than the browser's history.

import { useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "./ui";
import { historyNavigationAvailability } from "../lib/history-navigation";

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
        className="no-drag"
        aria-label="Go back"
        title="Go back"
        disabled={!canGoBack}
        onClick={() => router.history.back()}
      >
        <ArrowLeft />
      </Button>
      <Button
        iconOnly
        size="small"
        variant="bar"
        className="no-drag"
        aria-label="Go forward"
        title="Go forward"
        disabled={!canGoForward}
        onClick={() => router.history.forward()}
      >
        <ArrowRight />
      </Button>
    </>
  );
}
