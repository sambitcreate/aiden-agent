import * as React from "react";
import {
  SubagentLiveAnnouncementCoordinator,
  subagentSnapshotLiveSummary,
  subagentSnapshotLiveSummaryIsTerminal,
} from "../lib/subagent-panel-state";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";

export interface SubagentDetailAnnouncementRequest {
  id: number;
  ownerKey: string;
  message: string;
}

export function SubagentLiveAnnouncer({
  ownerKey,
  runs,
  detailRequest,
}: {
  ownerKey: string;
  runs: readonly SubagentRunSnapshot[];
  detailRequest: SubagentDetailAnnouncementRequest | null;
}) {
  const summary = runs.length > 0 ? subagentSnapshotLiveSummary(runs) : "";
  const terminal = subagentSnapshotLiveSummaryIsTerminal(runs);
  const [announcement, setAnnouncement] = React.useState("");
  const coordinatorRef =
    React.useRef<SubagentLiveAnnouncementCoordinator | null>(null);
  const handledDetailRequestRef = React.useRef(0);

  React.useLayoutEffect(() => {
    const coordinator = new SubagentLiveAnnouncementCoordinator(
      setAnnouncement,
      (callback, delayMs) => window.setTimeout(callback, delayMs),
      (timer) => window.clearTimeout(timer as number),
    );
    coordinatorRef.current = coordinator;
    return () => {
      coordinator.dispose();
      coordinatorRef.current = null;
    };
  }, []);

  React.useLayoutEffect(() => {
    coordinatorRef.current?.update(ownerKey, summary, terminal);
  }, [ownerKey, summary, terminal]);

  React.useLayoutEffect(() => {
    if (
      !detailRequest ||
      detailRequest.id <= handledDetailRequestRef.current
    )
      return;
    handledDetailRequestRef.current = detailRequest.id;
    coordinatorRef.current?.announceDetail(
      detailRequest.ownerKey,
      detailRequest.message,
    );
  }, [detailRequest]);

  // Keep the live region mounted outside panels that can become inert or hidden.
  return (
    <div
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-subagent-live-announcer="true"
    >
      {announcement}
    </div>
  );
}
