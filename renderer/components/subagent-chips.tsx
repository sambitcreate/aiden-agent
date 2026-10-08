import * as React from "react";
import { type OrbSize, type OrbState } from "thinking-orbs";
import { subagentModelDisplay, subagentRunProgressLabel } from "../lib/subagent-panel-state";
import { cn } from "../lib/ui-utils";
import type {
  SubagentRunViewRole,
  SubagentRunViewState,
} from "../lib/subagent-view-state";
import {
  type SubagentMessageReferenceV1,
  type SubagentRunSnapshot,
} from "../shared/subagent-runs";
import { AidenOrb } from "./aiden-orb";
import { Button, HoverCard, HoverCardContent, HoverCardTrigger } from "./ui";

function fallbackOrbStateForRole(
  role: SubagentRunViewRole | undefined,
): OrbState {
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
  // A waiting child's activity is its free-form pending question, not a tool milestone.
  if (state === "needs_attention") return fallbackOrbStateForRole(role);
  if (/^(?:Reading|Listing|Matching|Searching)\b/u.test(activity ?? ""))
    return "searching";
  if (activity === "Reviewing workspace context") return "solving";
  if (activity === "Writing a bounded report") return "composing";
  return fallbackOrbStateForRole(role);
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

export interface SubagentOrbProps {
  role?: SubagentRunViewRole;
  state: SubagentRunViewState | "finished";
  activity?: string;
  size?: OrbSize;
  className?: string;
}

export function SubagentOrb({
  role,
  state,
  activity,
  size = 20,
  className,
}: SubagentOrbProps) {
  const active =
    state === "queued" ||
    state === "starting" ||
    state === "running" ||
    state === "needs_attention";

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
        const model = run ? subagentModelDisplay(run) : undefined;
        // Older snapshots never recorded a model choice; their label stays unchanged.
        const recordedModel = run?.modelSelection !== undefined ? model : undefined;
        const chip = (
          <Button
            key={runId}
            variant="muted"
            size="small"
            data-subagent-chip-run-id={runId}
            className="max-w-full gap-1.5 motion-reduce:transition-none"
            aria-label={`Open ${label}. Status: ${status}.${recordedModel ? ` ${recordedModel.spoken}.` : ""}`}
            onClick={(event) => onOpen(runId, event.currentTarget)}
          >
            <SubagentOrb role={role} state={state} activity={run?.activity} />
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
        if (!model) return chip;
        return (
          <HoverCard key={runId} openDelay={200} closeDelay={100}>
            <HoverCardTrigger asChild>{chip}</HoverCardTrigger>
            <HoverCardContent
              side="top"
              align="start"
              className="w-[min(18rem,calc(100vw-2rem))]"
              data-subagent-model-card={runId}
            >
              <p className="truncate text-small font-medium text-primary">{label}</p>
              <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-mini">
                <dt className="text-tertiary">Model</dt>
                <dd className="break-words text-secondary [overflow-wrap:anywhere]">{model.model}</dd>
                {model.effort ? (
                  <>
                    <dt className="text-tertiary">Effort</dt>
                    <dd className="text-secondary">{model.effort}</dd>
                  </>
                ) : null}
                {model.selection ? (
                  <>
                    <dt className="text-tertiary">Choice</dt>
                    <dd className="text-secondary">{model.selection}</dd>
                  </>
                ) : null}
                <dt className="text-tertiary">Status</dt>
                <dd className="break-words text-secondary">{status}</dd>
              </dl>
            </HoverCardContent>
          </HoverCard>
        );
      })}
    </div>
  );
}
