import * as React from "react";
import { type OrbSize, type OrbState } from "thinking-orbs";
import { subagentRunProgressLabel } from "../lib/subagent-panel-state";
import { cn } from "../lib/ui-utils";
import type { SubagentRunViewRole, SubagentRunViewState } from "../lib/subagent-view-state";
import {
  type SubagentMessageReferenceV1,
  type SubagentRunSnapshotV1,
} from "../shared/subagent-runs";
import { AidenOrb } from "./aiden-orb";
import { Button } from "./ui";

function fallbackOrbStateForRole(role: SubagentRunViewRole | undefined): OrbState {
  if (role === "scout") return "searching";
  if (role === "planner") return "solving";
  return "working";
}

export function subagentOrbState(
  state: SubagentRunViewState | "finished",
  role?: SubagentRunViewRole,
  activity?: string,
): OrbState {
  if (state === "queued" || state === "starting") return "shaping";
  if (/^(?:Reading|Listing|Matching|Searching)\b/u.test(activity ?? "")) return "searching";
  if (activity === "Reviewing workspace context") return "solving";
  if (activity === "Writing a bounded report") return "composing";
  return fallbackOrbStateForRole(role);
}

export function subagentStateLabel(state: SubagentRunViewState | "finished"): string {
  if (state === "queued") return "Queued";
  if (state === "starting") return "Starting";
  if (state === "running") return "Working";
  if (state === "completed") return "Finished";
  if (state === "failed") return "Failed";
  if (state === "timed_out") return "Timed out";
  if (state === "interrupted") return "Interrupted";
  return "Finished";
}

export function subagentStatusLabel(
  state: SubagentRunViewState | "finished",
  activity?: string,
): string {
  return subagentRunProgressLabel(state, activity);
}

export interface SubagentOrbProps {
  role?: SubagentRunViewRole;
  state: SubagentRunViewState | "finished";
  activity?: string;
  size?: OrbSize;
  className?: string;
}

export function SubagentOrb({ role, state, activity, size = 20, className }: SubagentOrbProps) {
  const active = state === "queued" || state === "starting" || state === "running";

  return (
    <AidenOrb
      state={subagentOrbState(state, role, activity)}
      size={size}
      active={active}
      className={cn("shrink-0 opacity-70", className)}
      data-subagent-orb-state={active ? "active" : "terminal"}
    />
  );
}

export interface SubagentChipsProps {
  reference?: SubagentMessageReferenceV1;
  runs?: readonly SubagentRunSnapshotV1[];
  onOpen: (runId: string, trigger: HTMLButtonElement) => void;
  className?: string;
}

export function SubagentChips({ reference, runs = [], onOpen, className }: SubagentChipsProps) {
  const snapshotsById = React.useMemo(
    () => new Map(runs.map((run) => [run.runId, run] as const)),
    [runs],
  );
  const runIds = reference?.runIds ?? runs.map((run) => run.runId);
  if (runIds.length === 0) return null;

  return (
    <div
      className={cn("flex min-w-0 flex-wrap gap-1.5", className)}
      aria-label={`${runIds.length} subagent${runIds.length === 1 ? "" : "s"}`}
    >
      {runIds.map((runId, index) => {
        const run = snapshotsById.get(runId);
        const referencedItem =
          reference?.items?.[index]?.runId === runId ? reference.items[index] : undefined;
        const label = run?.label ?? referencedItem?.label ?? `Subagent ${index + 1}`;
        const role = run?.role ?? referencedItem?.role;
        const state = run?.state ?? referencedItem?.state ?? "finished";
        const status = subagentStatusLabel(state, run?.activity);
        return (
          <Button
            key={runId}
            variant="muted"
            size="small"
            radius="rounded"
            data-subagent-chip-run-id={runId}
            className="max-w-full gap-1.5 motion-reduce:transition-none"
            aria-label={`Open ${label}. Status: ${status}.`}
            onClick={(event) => onOpen(runId, event.currentTarget)}
          >
            <SubagentOrb role={role} state={state} activity={run?.activity} />
            <span className="min-w-0 truncate">{label}</span>
            <span
              className={cn(
                "max-w-48 min-w-0 truncate text-mini font-normal text-tertiary",
                state === "failed" && "text-red",
                state === "timed_out" && "text-support-warning",
              )}
            >
              {status}
            </span>
          </Button>
        );
      })}
    </div>
  );
}
