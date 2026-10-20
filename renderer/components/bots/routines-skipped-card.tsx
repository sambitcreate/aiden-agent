// The routines that came due while the person had paused the Bot. Nothing is
// caught up on its own (plan §7, decision 4): each routine gets Run now, which
// runs it once, now. A routine that started settles to a quiet line.

import * as React from "react";
import { CalendarClock, Check } from "lucide-react";
import { Button } from "../ui";
import { BotNoticeCard } from "./bot-notice-card";

export interface SkippedRoutine {
  routineId: string;
  name: string;
  /** How many times it came due while paused. */
  count: number;
}

export function routinesSkippedTitle(routines: readonly SkippedRoutine[]): string {
  const count = routines.length;
  return `${count} ${count === 1 ? "routine" : "routines"} skipped while paused`;
}

function skippedTimes(count: number): string {
  return count === 1 ? "Skipped once" : `Skipped ${count} times`;
}

export function RoutinesSkippedCard({
  routines,
  onRunNow,
}: {
  routines: readonly SkippedRoutine[];
  /** Resolves once the run started; rejects so Run now comes back (the caller reports why). */
  onRunNow(routineId: string): Promise<void>;
}) {
  const [running, setRunning] = React.useState<ReadonlySet<string>>(() => new Set());
  const [started, setStarted] = React.useState<ReadonlySet<string>>(() => new Set());

  const runNow = async (routineId: string) => {
    if (running.has(routineId) || started.has(routineId)) return;
    setRunning((ids) => new Set(ids).add(routineId));
    try {
      await onRunNow(routineId);
      setStarted((ids) => new Set(ids).add(routineId));
    } catch {
      // The caller reports the failure; Run now stays available.
    } finally {
      setRunning((ids) => {
        const rest = new Set(ids);
        rest.delete(routineId);
        return rest;
      });
    }
  };

  const title = routinesSkippedTitle(routines);
  return (
    <BotNoticeCard label={title} icon={<CalendarClock />} title={title}>
      <ul className="mt-1.5 flex flex-col">
        {routines.map((routine) => {
          const isStarted = started.has(routine.routineId);
          const isRunning = running.has(routine.routineId);
          return (
            <li key={routine.routineId} className="flex min-h-8 min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-primary">{routine.name}</span>
                <span className="block text-tertiary">{skippedTimes(routine.count)}</span>
              </span>
              {isStarted ? (
                <span role="status" className="flex shrink-0 items-center gap-1 text-secondary">
                  <Check aria-hidden="true" className="size-3.5 text-status-green" />
                  Started
                </span>
              ) : (
                <Button
                  variant="transparent"
                  size="small"
                  className="shrink-0"
                  disabled={isRunning}
                  aria-label={`Run ${routine.name} now`}
                  onClick={() => void runNow(routine.routineId)}
                >
                  {isRunning ? "Starting…" : "Run now"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </BotNoticeCard>
  );
}
