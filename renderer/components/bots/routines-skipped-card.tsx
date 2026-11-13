// The routines that came due while the person had paused the Bot. Nothing is
// caught up on its own (plan §7, decision 4): each routine is a receipt line
// with Run now, which runs it once, now, and then reads Started.

import * as React from "react";
import { CalendarClock, Check } from "lucide-react";
import { ReceiptLine } from "./receipt-line";

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
  return count === 1 ? "once" : `${count} times`;
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
    <div role="group" aria-label={title} className="flex flex-col">
      {routines.map((routine) => {
        const isStarted = started.has(routine.routineId);
        const isRunning = running.has(routine.routineId);
        return (
          <ReceiptLine
            key={routine.routineId}
            icon={isStarted ? <Check className="text-status-green" /> : <CalendarClock />}
            text={isStarted ? `Started: ${routine.name}` : `Skipped while paused (${skippedTimes(routine.count)}): ${routine.name}`}
            {...(isStarted ? { role: "status" as const } : {})}
            actions={
              isStarted
                ? []
                : [
                    {
                      label: isRunning ? "Starting…" : "Run now",
                      ariaLabel: `Run now: ${routine.name}`,
                      disabled: isRunning,
                      onClick: () => void runNow(routine.routineId),
                    },
                  ]
            }
          />
        );
      })}
    </div>
  );
}
