import * as React from "react";
import { cn } from "../lib/ui-utils";
import {
  splitSubagentRunViews,
  type SubagentRunView,
  type SubagentRunViewState,
} from "../lib/subagent-view-state";
import { SubagentOrb, subagentStateLabel } from "./subagent-chips";
import { Text } from "./ui";

export interface SubagentRunGroups {
  active: SubagentRunView[];
  done: SubagentRunView[];
}

export function groupSubagentRuns(runs: readonly SubagentRunView[]): SubagentRunGroups {
  return splitSubagentRunViews(runs);
}

function stateTone(state: SubagentRunViewState): string {
  if (state === "failed") return "text-red";
  if (state === "timed_out") return "text-support-warning";
  return "text-tertiary";
}

function RosterGroup({
  label,
  runs,
  selectedRunId,
  onSelect,
}: {
  label: string;
  runs: readonly SubagentRunView[];
  selectedRunId: string | null;
  onSelect: (runId: string, trigger: HTMLButtonElement) => void;
}) {
  const headingId = React.useId();
  if (runs.length === 0) return null;

  return (
    <section aria-labelledby={headingId}>
      <Text
        as="h3"
        id={headingId}
        variant="small-strong"
        color="tertiary"
        className="px-3 pb-1 pt-3"
      >
        {label} · {runs.length}
      </Text>
      <div role="list" className="flex flex-col gap-0.5 px-1.5">
        {runs.map((run) => {
          const selected = run.runId === selectedRunId;
          const state = subagentStateLabel(run.state);
          return (
            <div key={run.runId} role="listitem">
              <button
                type="button"
                data-subagent-run-id={run.runId}
                aria-current={selected ? "true" : undefined}
                aria-label={`${run.label}, ${run.role}, ${state}`}
                onClick={(event) => onSelect(run.runId, event.currentTarget)}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-2 text-left outline-none transition-colors duration-150 ease-out hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline-none active:bg-list-selection motion-reduce:transition-none",
                  selected && "bg-list-selection",
                )}
              >
                <SubagentOrb role={run.role} state={run.state} activity={run.snapshot?.activity} />
                <span className="min-w-0 flex-1">
                  <Text as="span" variant="small-strong" truncate className="block">
                    {run.label}
                  </Text>
                  <Text
                    as="span"
                    variant="small"
                    color="secondary"
                    truncate
                    className="mt-0.5 block"
                  >
                    {run.snapshot?.taskPreview ??
                      (run.role === "unknown" ? "Saved subagent result" : run.role)}
                  </Text>
                </span>
                <Text
                  as="span"
                  variant="small"
                  color="tertiary"
                  className={cn("shrink-0", stateTone(run.state))}
                >
                  {state}
                </Text>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export interface SubagentRosterProps {
  runs: readonly SubagentRunView[];
  selectedRunId: string | null;
  onSelect: (runId: string, trigger: HTMLButtonElement) => void;
  className?: string;
}

export function SubagentRoster({ runs, selectedRunId, onSelect, className }: SubagentRosterProps) {
  const groups = groupSubagentRuns(runs);
  return (
    <nav aria-label="Subagents" className={cn("min-h-0 overflow-y-auto pb-3", className)}>
      <RosterGroup
        label="Active"
        runs={groups.active}
        selectedRunId={selectedRunId}
        onSelect={onSelect}
      />
      <RosterGroup
        label="Done"
        runs={groups.done}
        selectedRunId={selectedRunId}
        onSelect={onSelect}
      />
    </nav>
  );
}
