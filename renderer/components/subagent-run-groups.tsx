// Quick View's expanded Subagents detail: every run in the chat, grouped by
// outcome. Completed runs stay folded behind one disclosure row.

import * as React from "react";
import { ChevronRight, Square } from "lucide-react";
import { groupSubagentRuns, type SubagentRunStatusGroup } from "../lib/subagent-panel-state";
import {
  isSubagentRunViewStateActive,
  subagentElapsedLabel,
  type SubagentRunView,
} from "../lib/subagent-view-state";
import { cn } from "../lib/ui-utils";
import { formatContextTokenCount } from "../shared/context-pressure";
import type { SubagentRunSnapshot } from "../shared/subagent-runs";
import { SubagentMark, subagentStateLabel } from "./subagent-chips";
import { Button } from "./ui";

export interface SubagentRunGroupsProps {
  runs: readonly SubagentRunView[];
  /** Runs whose Stop request is in flight (the environment panel's stop-pending state). */
  stopPendingRunIds: readonly string[];
  onOpen: (runId: string, trigger: HTMLElement) => void;
  onStop: (run: SubagentRunSnapshot) => Promise<void> | void;
}

const ROW =
  "grid min-h-11 w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-control px-2.5 py-1 text-left text-regular text-primary outline-none transition-colors duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection motion-reduce:transition-none";

/** Wall-clock time, refreshed once a second through one interval only while `live` is true. */
function useNow(live: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [live]);
  return now;
}

/** Stop applies to foreground runs that are still working, the same rule as the subagent detail. */
function stoppableSnapshot(run: SubagentRunView): SubagentRunSnapshot | undefined {
  const snapshot = run.snapshot;
  if (!snapshot || !isSubagentRunViewStateActive(run.state)) return undefined;
  return snapshot.version === 2 && snapshot.execution === "foreground" ? snapshot : undefined;
}

function roleLabel(run: SubagentRunView): string | null {
  if (run.role === "unknown") return null;
  return run.role.charAt(0).toUpperCase() + run.role.slice(1);
}

function secondaryLine(run: SubagentRunView): { text: string; error: boolean } {
  const snapshot = run.snapshot;
  const error = snapshot?.error?.trim();
  if (error) return { text: error, error: true };
  const activity = snapshot?.activity?.trim();
  if (activity) return { text: activity, error: false };
  if (run.state === "completed" && snapshot) {
    return { text: `Finished · ${formatContextTokenCount(snapshot.tokens)} tokens`, error: false };
  }
  return { text: subagentStateLabel(run.state), error: false };
}

function RunRow({
  run,
  now,
  stopPending,
  onOpen,
  onStop,
}: {
  run: SubagentRunView;
  now: number;
  stopPending: boolean;
  onOpen: SubagentRunGroupsProps["onOpen"];
  onStop: SubagentRunGroupsProps["onStop"];
}) {
  const stoppable = stoppableSnapshot(run);
  const role = roleLabel(run);
  const line = secondaryLine(run);
  const elapsed = subagentElapsedLabel(run, now);
  const stop = () => {
    if (!stoppable || stopPending) return;
    // The environment panel's stop-pending state owns and presents failures.
    void Promise.resolve(onStop(stoppable)).catch(() => undefined);
  };

  return (
    <div className="group/run relative">
      <button
        type="button"
        data-subagent-run-id={run.runId}
        onClick={(event) => onOpen(run.runId, event.currentTarget)}
        className={ROW}
      >
        <SubagentMark role={run.role} state={run.state} activity={run.snapshot?.activity} size={18} />
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">{run.label}</span>
            {role ? (
              <span className="shrink-0 rounded-full bg-control px-1.5 text-mini text-secondary">{role}</span>
            ) : null}
          </span>
          <span className={cn("truncate text-small", line.error ? "text-red" : "text-tertiary")}>{line.text}</span>
          <span className="sr-only">{`, ${subagentStateLabel(run.state)}`}</span>
        </span>
        {elapsed ? (
          <span
            className={cn(
              "text-small whitespace-nowrap text-tertiary tabular-nums",
              stoppable && "group-hover/run:invisible group-focus-within/run:invisible",
            )}
          >
            {elapsed}
          </span>
        ) : (
          <span />
        )}
      </button>
      {stoppable ? (
        <Button
          variant="muted"
          size="small"
          disabled={stopPending}
          aria-label={stopPending ? `Stopping ${run.label}` : `Stop ${run.label}`}
          aria-busy={stopPending ? true : undefined}
          onClick={stop}
          className={cn(
            "absolute top-1/2 right-2.5 -translate-y-1/2 opacity-0 group-hover/run:opacity-100 group-focus-within/run:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none",
            stopPending && "opacity-100",
          )}
        >
          <Square aria-hidden="true" className="size-3" />
          {stopPending ? "Stopping…" : "Stop"}
        </Button>
      ) : null}
    </div>
  );
}

function GroupRows({
  group,
  now,
  stopPending,
  onOpen,
  onStop,
}: {
  group: SubagentRunStatusGroup;
  now: number;
  stopPending: ReadonlySet<string>;
  onOpen: SubagentRunGroupsProps["onOpen"];
  onStop: SubagentRunGroupsProps["onStop"];
}) {
  return group.runs.map((run) => (
    <RunRow
      key={run.runId}
      run={run}
      now={now}
      stopPending={stopPending.has(run.runId)}
      onOpen={onOpen}
      onStop={onStop}
    />
  ));
}

export function SubagentRunGroups({
  runs,
  stopPendingRunIds,
  onOpen,
  onStop,
}: SubagentRunGroupsProps): React.JSX.Element {
  const [completedOpen, setCompletedOpen] = React.useState(false);
  const completedListId = React.useId();
  const groups = React.useMemo(() => groupSubagentRuns(runs), [runs]);
  const stopPending = React.useMemo(() => new Set(stopPendingRunIds), [stopPendingRunIds]);
  const live = groups.some((group) => group.id === "running" || group.id === "needs_attention");
  const now = useNow(live);

  return (
    <div className="flex flex-col">
      {groups.map((group) => {
        const label = `${group.title}, ${group.runs.length}`;
        if (group.id === "completed") {
          return (
            <div key={group.id} role="group" aria-label={label} className="pb-1">
              <button
                type="button"
                aria-expanded={completedOpen}
                aria-controls={completedOpen ? completedListId : undefined}
                onClick={() => setCompletedOpen((value) => !value)}
                className="flex min-h-8 w-full items-center gap-2 rounded-control px-2.5 text-left text-small font-medium text-tertiary outline-none transition-colors duration-150 ease-out hover:bg-list-hover hover:text-primary focus-visible:bg-list-selection focus-visible:text-primary motion-reduce:transition-none"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0 transition-transform duration-(--motion-duration) ease-standard motion-reduce:transition-none",
                    completedOpen && "rotate-90",
                  )}
                />
                <span>{group.title}</span>
                <span className="ml-auto tabular-nums">{group.runs.length}</span>
              </button>
              {completedOpen ? (
                <div id={completedListId}>
                  <GroupRows group={group} now={now} stopPending={stopPending} onOpen={onOpen} onStop={onStop} />
                </div>
              ) : null}
            </div>
          );
        }
        return (
          <div key={group.id} role="group" aria-label={label} className="pb-1">
            <div aria-hidden="true" className="flex items-center gap-1.5 px-2.5 pt-2 pb-0.5 text-small font-medium text-tertiary">
              <span>{group.title}</span>
              <span className="tabular-nums">{group.runs.length}</span>
            </div>
            <GroupRows group={group} now={now} stopPending={stopPending} onOpen={onOpen} onStop={onStop} />
          </div>
        );
      })}
    </div>
  );
}
