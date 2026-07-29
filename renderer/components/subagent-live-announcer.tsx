import * as React from "react";
import { createPortal } from "react-dom";
import {
  SubagentLiveAnnouncementCoordinator,
  subagentSnapshotLiveSummary,
  subagentSnapshotLiveSummaryIsTerminal,
} from "../lib/subagent-panel-state";
import type { SubagentRunSnapshotV1 } from "../shared/subagent-runs";

export interface SubagentDetailAnnouncementRequest {
  id: number;
  ownerKey: string;
  message: string;
}

export function SubagentLiveAnnouncer({
  ownerKey,
  runs,
  detailRequest,
  portalHost,
}: {
  ownerKey: string;
  runs: readonly SubagentRunSnapshotV1[];
  detailRequest: SubagentDetailAnnouncementRequest | null;
  portalHost: HTMLElement | null;
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

  const region = (
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
  return portalHost ? createPortal(region, portalHost) : region;
}
