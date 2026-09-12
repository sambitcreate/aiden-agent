import * as React from "react";
import { AlertTriangle, ArrowRight, Loader2, RotateCcw, X } from "lucide-react";
import type { DesignHandoffRecoveryViewV1 } from "../shared/design-projects";
import { Button, Text } from "./ui";

function stageLabel(stage: DesignHandoffRecoveryViewV1["stage"]): string {
  switch (stage) {
    case "prepared":
      return "Ready to resume";
    case "workspace-ready":
      return "Workspace created";
    case "chat-ready":
      return "Task created";
    case "context-ready":
      return "Context installed";
    case "rolling-back":
      return "Cancelling";
    case "recoverable":
      return "Review required";
  }
}

export function DesignHandoffRecoveryPanel({
  records,
  loading,
  error,
  busyOperationId,
  onRetry,
  onResume,
  onOpen,
  onCancel,
}: {
  records: readonly DesignHandoffRecoveryViewV1[];
  loading: boolean;
  error?: string;
  busyOperationId?: string;
  onRetry: () => void;
  onResume: (record: DesignHandoffRecoveryViewV1) => void;
  onOpen: (record: DesignHandoffRecoveryViewV1) => void;
  onCancel: (record: DesignHandoffRecoveryViewV1) => void;
}) {
  const titleId = React.useId();
  if (!loading && !error && records.length === 0) return null;
  return (
    <section
      className="design-handoff-recovery overflow-hidden rounded-popover bg-popover shadow-popover"
      aria-labelledby={titleId}
      aria-live="polite"
    >
      <header className="flex items-start gap-2 px-3 py-2.5">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-accent"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <Text id={titleId} as="h2" variant="small-strong">
            Handoff recovery
          </Text>
          <Text as="p" variant="small" color="secondary">
            Preserved work stays local until you resume, open, or cancel a valid
            operation.
          </Text>
        </div>
      </header>
      {error ? (
        <div
          className="flex items-center gap-2 border-t border-separator px-3 py-2"
          role="alert"
        >
          <Text as="p" variant="small" color="red" className="min-w-0 flex-1">
            {error}
          </Text>
          <Button size="small" variant="toolbar" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : loading ? (
        <div
          className="flex items-center gap-2 border-t border-separator px-3 py-2"
          role="status"
        >
          <Loader2
            className="size-4 animate-spin text-secondary"
            aria-hidden="true"
          />
          <Text variant="small" color="secondary">
            Checking preserved handoffs…
          </Text>
        </div>
      ) : (
        <ol
          className="max-h-64 overflow-auto border-t border-separator"
          aria-label="Recoverable handoffs"
        >
          {records.map((record) => {
            const busy = busyOperationId === record.operationId;
            return (
              <li
                key={record.operationId}
                className="border-b border-separator px-3 py-2.5 last:border-b-0"
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Text as="p" variant="small-strong" truncate>
                      {record.workspaceLabel}
                    </Text>
                    <Text as="p" variant="small" color="secondary" truncate>
                      {record.branchLabel} · {stageLabel(record.stage)}
                    </Text>
                  </div>
                  <span className="shrink-0 rounded-control bg-control px-2 py-1 text-mini text-secondary">
                    {record.targetKind === "managed-worktree"
                      ? "Managed"
                      : "Existing"}
                  </span>
                </div>
                {record.recoveryReason ? (
                  <Text
                    as="p"
                    variant="small"
                    color="tertiary"
                    className="mt-1.5 line-clamp-2"
                  >
                    {record.recoveryReason}
                  </Text>
                ) : null}
                <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                  {record.canCancel ? (
                    <Button
                      size="small"
                      variant="transparent"
                      disabled={Boolean(busyOperationId)}
                      onClick={() => onCancel(record)}
                    >
                      <X aria-hidden="true" /> Cancel
                    </Button>
                  ) : null}
                  {record.linkage ? (
                    <Button
                      size="small"
                      variant="toolbar"
                      disabled={Boolean(busyOperationId)}
                      onClick={() => onOpen(record)}
                    >
                      Open <ArrowRight aria-hidden="true" />
                    </Button>
                  ) : null}
                  {record.canResume ? (
                    <Button
                      size="small"
                      variant="accent"
                      disabled={Boolean(busyOperationId)}
                      onClick={() => onResume(record)}
                    >
                      {busy ? (
                        <Loader2 className="animate-spin" aria-hidden="true" />
                      ) : (
                        <RotateCcw aria-hidden="true" />
                      )}
                      Resume
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
