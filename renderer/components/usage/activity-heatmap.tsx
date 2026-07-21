import * as React from "react";
import { Text } from "../ui";
import { buildActivityCalendar } from "../../lib/usage-profile-data";
import type { UsageSummary } from "../../lib/types";

const LEVEL_CLASSES = [
  "bg-control/55",
  "bg-accent/20",
  "bg-accent/40",
  "bg-accent/65",
  "bg-accent",
] as const;

const CELL_SIZE = 9;
const CELL_GAP = 3;

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function activityDescription(
  date: string,
  requests: number,
  reportedTokens: number,
  unmeteredRequests: number,
): string {
  const label = DATE_FORMATTER.format(new Date(`${date}T00:00:00Z`));
  if (requests === 0) return `${label}: no model activity`;
  const tokenLabel =
    reportedTokens > 0
      ? `${reportedTokens.toLocaleString()} reported tokens`
      : "no reported tokens";
  const unmeteredLabel =
    unmeteredRequests > 0 ? `, ${unmeteredRequests.toLocaleString()} unmetered` : "";
  return `${label}: ${requests.toLocaleString()} requests, ${tokenLabel}${unmeteredLabel}`;
}

export function ActivityHeatmap({ summary }: { summary: UsageSummary }) {
  const calendar = React.useMemo(() => buildActivityCalendar(summary), [summary]);
  const activeCells = calendar.cells.filter((cell) => cell.inRange && cell.requests > 0);
  const visibleMonths = calendar.months.filter(
    (month, index, months) => index === 0 || month.weekIndex - months[index - 1].weekIndex >= 3,
  );
  const gridWidth = calendar.weekCount * CELL_SIZE + Math.max(0, calendar.weekCount - 1) * CELL_GAP;
  const chartWidth = Math.max(280, gridWidth + 34);
  const startLabel = DATE_FORMATTER.format(new Date(`${summary.startDate}T00:00:00Z`));
  const endLabel = DATE_FORMATTER.format(new Date(`${summary.endDate}T00:00:00Z`));

  return (
    <section aria-labelledby="usage-activity-heading" className="min-w-0 py-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <Text id="usage-activity-heading" as="h2" className="text-large-strong font-medium">
            Model activity
          </Text>
          <Text as="p" variant="small" color="secondary" className="mt-0.5">
            Every model call counts, including local and unmetered requests.
          </Text>
        </div>
        <Text variant="small" color="secondary" className="tabular-nums">
          {summary.totals.activeDays.toLocaleString()} active days
        </Text>
      </div>

      <div
        role="img"
        aria-label={`${summary.totals.activeDays.toLocaleString()} active days and ${summary.totals.requests.toLocaleString()} model requests from ${startLabel} through ${endLabel}`}
        className="min-w-0 overflow-x-auto pb-1"
      >
        <div className="grid grid-cols-[26px_minmax(0,1fr)] gap-x-2" style={{ width: chartWidth }}>
          <div />
          <div
            aria-hidden="true"
            className="mb-1 grid h-4 gap-x-[3px] text-mini text-tertiary"
            style={{ gridTemplateColumns: `repeat(${calendar.weekCount}, ${CELL_SIZE}px)` }}
          >
            {visibleMonths.map((month) => (
              <span
                key={`${month.weekIndex}-${month.label}`}
                className="whitespace-nowrap"
                style={{ gridColumnStart: month.weekIndex + 1 }}
              >
                {month.label}
              </span>
            ))}
          </div>

          <div aria-hidden="true" className="grid grid-rows-7 gap-[3px] text-mini text-tertiary">
            <span className="row-start-2 self-center">Mon</span>
            <span className="row-start-4 self-center">Wed</span>
            <span className="row-start-6 self-center">Fri</span>
          </div>
          <div
            aria-hidden="true"
            className="grid grid-flow-col grid-rows-7 gap-[3px]"
            style={{ gridTemplateColumns: `repeat(${calendar.weekCount}, ${CELL_SIZE}px)` }}
          >
            {calendar.cells.map((cell) => (
              <span
                key={cell.date}
                title={activityDescription(
                  cell.date,
                  cell.requests,
                  cell.reportedTokens,
                  cell.unmeteredRequests,
                )}
                className={`size-[9px] rounded-[2px] ${cell.inRange ? LEVEL_CLASSES[cell.level] : "invisible"}`}
              />
            ))}
          </div>
        </div>
      </div>

      <table className="sr-only">
        <caption>Daily model activity</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Requests</th>
            <th scope="col">Reported tokens</th>
            <th scope="col">Unmetered requests</th>
          </tr>
        </thead>
        <tbody>
          {activeCells.length > 0 ? (
            activeCells.map((cell) => (
              <tr key={cell.date}>
                <th scope="row">{DATE_FORMATTER.format(new Date(`${cell.date}T00:00:00Z`))}</th>
                <td>{cell.requests}</td>
                <td>{cell.reportedTokens}</td>
                <td>{cell.unmeteredRequests}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={4}>No model activity in this date range.</td>
            </tr>
          )}
        </tbody>
      </table>

      <div aria-hidden="true" className="mt-3 flex items-center justify-end gap-1.5">
        <Text variant="small" color="tertiary">
          Less
        </Text>
        {LEVEL_CLASSES.map((className, level) => (
          <span
            key={className}
            className={`size-2.5 rounded-[2px] ${className}`}
            data-level={level}
          />
        ))}
        <Text variant="small" color="tertiary">
          More
        </Text>
      </div>
    </section>
  );
}
