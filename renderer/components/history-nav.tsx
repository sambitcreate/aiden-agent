// Back/forward through the window's in-app navigation history, shown beside the
// sidebar toggle. The router keeps its own memory history, so availability
// comes from the current entry's index rather than the browser's history.

import { useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEnvironmentPanel } from "./environment-panel";
import { Button, toast } from "./ui";
import { historyNavigationAvailability } from "../lib/history-navigation";

// `aria-disabled` rather than `disabled`: reaching the first or last entry
// must not drop keyboard focus from the button that was just used.
const UNAVAILABLE = "no-drag aria-disabled:opacity-45 aria-disabled:hover:bg-transparent";

export function HistoryNavButtons() {
  const router = useRouter();
  const environmentPanel = useEnvironmentPanel();
  // The same protections as opening another chat or Settings from the sidebar:
  // the Files editor keeps unsaved text only while it is mounted, and leaving
  // mid-Git-operation would hide its outcome. These are action checks, not
  // registered route blockers, so traversal must consult them itself.
  const blockedReason = environmentPanel.gitOperationBusy
    ? "Wait for the current Git operation to finish"
    : environmentPanel.editorState.saving
      ? "Wait for the open file to finish saving"
      : environmentPanel.editorState.dirty
        ? "Save or discard the open file's edits first"
        : null;
  const traverse = (go: () => void) => {
    if (blockedReason) {
      toast.info(blockedReason);
      return;
    }
    go();
  };
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
          if (canGoBack) traverse(() => router.history.back());
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
          if (canGoForward) traverse(() => router.history.forward());
        }}
      >
        <ArrowRight />
      </Button>
    </>
  );
}
