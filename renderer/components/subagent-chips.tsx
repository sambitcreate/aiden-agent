import * as React from "react";
import { subagentRunProgressLabel } from "../lib/subagent-panel-state";
import { cn } from "../lib/ui-utils";
import type {
  SubagentRunViewRole,
  SubagentRunViewState,
} from "../lib/subagent-view-state";
import {
  type SubagentMessageReferenceV1,
  type SubagentRunSnapshot,
} from "../shared/subagent-runs";
import type { ActivityMark } from "../shared/activity-marks";
import { AidenActivityMark } from "./aiden-activity-mark";
import { Button } from "./ui";

function fallbackMarkForRole(role: SubagentRunViewRole | undefined): ActivityMark {
  if (role === "scout") return "scan-grid";
  if (role === "planner") return "tri-step";
  return "quad-shuffle";
}

export function subagentActivityMark(
  state: SubagentRunViewState | "finished",
  role?: SubagentRunViewRole,
  activity?: string,
): ActivityMark {
  if (state === "queued" || state === "starting") return "bounce";
  // A waiting child is blocked on the user, whatever its free-form question says.
  if (state === "needs_attention") return "glance";
  if (/^(?:Reading|Listing|Matching|Searching)\b/u.test(activity ?? ""))
    return "scan-grid";
  if (activity === "Reviewing workspace context") return "tri-step";
  if (activity === "Writing a bounded report") return "compose";
  return fallbackMarkForRole(role);
}

export function subagentStateLabel(
  state: SubagentRunViewState | "finished",
): string {
  if (state === "queued") return "Queued";
  if (state === "starting") return "Starting";
  if (state === "running") return "Working";
  if (state === "completed") return "Finished";
  if (state === "failed") return "Failed";
  if (state === "timed_out") return "Timed out";
  if (state === "interrupted") return "Interrupted";
  if (state === "needs_attention") return "Needs attention";
  if (state === "stopped") return "Stopped";
  if (state === "unknown") return "Outcome unknown";
  return "Finished";
}

export function subagentStatusLabel(
  state: SubagentRunViewState | "finished",
  activity?: string,
): string {
  return subagentRunProgressLabel(state, activity);
}

export interface SubagentMarkProps {
  role?: SubagentRunViewRole;
  state: SubagentRunViewState | "finished";
  activity?: string;
  size?: number;
  className?: string;
}

export function SubagentMark({
  role,
  state,
  activity,
  size = 20,
  className,
}: SubagentMarkProps) {
  const active =
    state === "queued" ||
    state === "starting" ||
    state === "running" ||
    state === "needs_attention";

  return (
    <AidenActivityMark
      mark={subagentActivityMark(state, role, activity)}
      size={size}
      active={active}
      className={cn("shrink-0 opacity-70", className)}
      data-subagent-mark-state={active ? "active" : "terminal"}
    />
  );
}

export interface SubagentChipsProps {
  reference?: SubagentMessageReferenceV1;
  runs?: readonly SubagentRunSnapshot[];
  onOpen: (runId: string, trigger: HTMLButtonElement) => void;
  className?: string;
}

export function SubagentChips({
  reference,
  runs = [],
  onOpen,
  className,
}: SubagentChipsProps) {
  const snapshotsById = React.useMemo(
    () => new Map(runs.map((run) => [run.runId, run] as const)),
    [runs],
  );
  const runIds = reference?.runIds ?? runs.map((run) => run.runId);
  if (runIds.length === 0) return null;

  return (
    <div
      className={cn("flex min-w-0 flex-wrap gap-1.5", className)}
      role="group"
      aria-label={`${runIds.length} subagent${runIds.length === 1 ? "" : "s"}`}
    >
      {runIds.map((runId, index) => {
        const run = snapshotsById.get(runId);
        const referencedItem =
          reference?.items?.[index]?.runId === runId
            ? reference.items[index]
            : undefined;
        const label =
          run?.label ?? referencedItem?.label ?? `Subagent ${index + 1}`;
        const role = run?.role ?? referencedItem?.role;
        const state = run?.state ?? referencedItem?.state ?? "finished";
        const status = subagentStatusLabel(state, run?.activity);
        return (
          <Button
            key={runId}
            variant="muted"
            size="small"
            data-subagent-chip-run-id={runId}
            className="max-w-full gap-1.5 motion-reduce:transition-none"
            aria-label={`Open ${label}. Status: ${status}.`}
            onClick={(event) => onOpen(runId, event.currentTarget)}
          >
            <SubagentMark role={role} state={state} activity={run?.activity} />
            <span className="min-w-0 truncate">{label}</span>
            <span
              className={cn(
                "max-w-48 min-w-0 truncate text-mini font-normal text-tertiary",
                state === "failed" && "text-red",
                state === "timed_out" && "text-support-warning",
                state === "needs_attention" && "text-support-warning",
              )}
              title={status}
            >
              {status}
            </span>
          </Button>
        );
      })}
    </div>
  );
}
