import * as React from "react";
import {
  AlarmClock,
  CalendarClock,
  ChevronRight,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Text, toast } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { botWakeUpWhen } from "../../shared/bot-wake-ups";
import type { BotRoutine } from "../../../main/services/scheduled-bot-routines";
import type { BotDefinition } from "../../shared/bots";
import { formatBotRoutineLabel } from "../../shared/bot-routine-label";
import { BOT_DAILY_CHECKIN_SUGGESTION } from "../../shared/bot-routine-proposals";
import { BotRoutineEditor } from "./bot-routine-editor";

export const botRoutinesKey = (botId: string) =>
  ["bot-routines", botId] as const;

type Editing = BotRoutine | "new" | "suggestion" | null;

/**
 * The Bot's routines: one row per routine, and "+ Add routine". With no
 * routines yet, "Try a daily check-in" opens the editor prefilled; nothing is
 * created until the person saves it.
 */
export function BotRoutines({
  bot,
  compact = false,
}: {
  bot: Pick<BotDefinition, "id" | "name">;
  /** The side panel's narrower column: the same smaller heading as Memory there. */
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const routines = useQuery({
    queryKey: botRoutinesKey(bot.id),
    queryFn: () => botsApi.routines.list(bot.id),
  });
  const [editing, setEditingState] = React.useState<Editing>(null);
  const [editorSession, setEditorSession] = React.useState(0);
  const setEditing = (next: Editing) => {
    if (next !== null) setEditorSession((value) => value + 1);
    setEditingState(next);
  };
  const list = routines.data ?? [];
  const key = botRoutinesKey(bot.id);
  // The editor's answer is placed in the list at once; the reread follows in the background.
  const placeSaved = (saved: BotRoutine) => {
    qc.setQueryData<BotRoutine[]>(key, (current) => {
      const rows = current ?? [];
      return rows.some((row) => row.id === saved.id)
        ? rows.map((row) => (row.id === saved.id ? saved : row))
        : [...rows, saved];
    });
    void qc.invalidateQueries({ queryKey: key });
  };
  const dropDeleted = (id: string) => {
    qc.setQueryData<BotRoutine[]>(key, (current) =>
      current?.filter((row) => row.id !== id),
    );
    void qc.invalidateQueries({ queryKey: key });
  };

  // A wake-up the Bot set for itself has no editor: Cancel is the one action.
  // It leaves the list at once and comes back if main refuses.
  const cancelWakeUp = async (routine: BotRoutine) => {
    const before = qc.getQueryData<BotRoutine[]>(key);
    qc.setQueryData<BotRoutine[]>(key, (current) =>
      current?.filter((row) => row.id !== routine.id),
    );
    try {
      await botsApi.routines.delete({ botId: bot.id, id: routine.id });
    } catch (error) {
      qc.setQueryData(key, before);
      toast.error(
        userFacingErrorMessage(error, "Aiden couldn’t cancel that wake-up."),
      );
    } finally {
      void qc.invalidateQueries({ queryKey: key });
    }
  };

  const titleId = `routines-${bot.id}`;
  const rowClass =
    "relative flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-150 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none";

  return (
    <section
      aria-labelledby={titleId}
      className={compact ? "settings-group mb-5" : "settings-group mb-7"}
    >
      <h2
        id={titleId}
        className={
          compact
            ? "settings-group-title mb-2 px-4 text-strong text-primary"
            : "settings-group-title mb-3 px-4 text-large-strong text-primary"
        }
      >
        Routines
      </h2>
      <div className="settings-group-card overflow-hidden rounded-card bg-well">
        {routines.isLoading ? (
          <div
            role="status"
            aria-label="Loading routines"
            className="relative px-4 py-3 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator"
          >
            <span className="grid gap-2">
              <span className="h-3 w-36 rounded-full bg-control motion-safe:animate-pulse" />
              <span className="h-2.5 w-48 max-w-full rounded-full bg-control motion-safe:animate-pulse" />
            </span>
          </div>
        ) : routines.isError ? (
          <div
            role="alert"
            className="relative flex flex-wrap items-center justify-between gap-3 px-4 py-3 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator"
          >
            <Text as="p" variant="small" color="secondary">
              Aiden couldn’t load {bot.name}’s routines.
            </Text>
            <Button
              size="small"
              variant="filled"
              onClick={() => void routines.refetch()}
            >
              <RotateCcw /> Try again
            </Button>
          </div>
        ) : list.length === 0 ? (
          <>
            <Text
              as="p"
              variant="small"
              color="secondary"
              className="relative px-4 py-3 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator"
            >
              No routines yet. A routine has {bot.name} check in on a schedule.
            </Text>
            <button
              type="button"
              className={rowClass}
              onClick={() => setEditing("suggestion")}
            >
              <CalendarClock
                aria-hidden="true"
                className="size-4 shrink-0 text-secondary"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-regular text-primary">
                  Try a daily check-in
                </span>
                <span className="mt-0.5 block truncate text-small text-secondary">
                  {formatBotRoutineLabel(BOT_DAILY_CHECKIN_SUGGESTION.schedule)}
                </span>
              </span>
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 text-tertiary"
              />
            </button>
          </>
        ) : (
          <ul aria-label="Routines">
            {list.map((routine) => (
              <li key={routine.id}>
                {routine.wakeUp ? (
                  <div className="relative flex w-full min-w-0 items-center gap-3 px-4 py-3 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator">
                    <AlarmClock
                      aria-hidden="true"
                      className="size-4 shrink-0 text-secondary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-strong text-primary">
                        {routine.name}
                        {routine.nextRunAt !== undefined ? (
                          <span className="font-normal text-secondary">
                            {" "}
                            {botWakeUpWhen(routine.nextRunAt, Date.now())}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-small text-secondary">
                        {routine.prompt}
                      </span>
                    </span>
                    {routine.enabled ? (
                      <Button
                        size="small"
                        variant="filled"
                        onClick={() => void cancelWakeUp(routine)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <button
                    type="button"
                    className={rowClass}
                    onClick={() => setEditing(routine)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-strong text-primary">
                        {routine.name}
                      </span>
                      <span className="mt-0.5 block truncate text-small text-secondary">
                        {routine.label}
                      </span>
                      {routine.pendingFireCount > 0 ? (
                        <span className="mt-0.5 block text-small text-status-warning">
                          Finishing an earlier run
                        </span>
                      ) : routine.overdueSince !== undefined ? (
                        <span className="mt-0.5 block text-small text-status-warning">
                          Overdue since{" "}
                          {new Date(routine.overdueSince).toLocaleString()}
                        </span>
                      ) : null}
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-tertiary"
                    />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className={`${rowClass} after:hidden`}
          onClick={() => setEditing("new")}
        >
          <Plus aria-hidden="true" className="size-4 shrink-0 text-secondary" />
          <span className="text-regular text-primary">Add routine</span>
        </button>
      </div>
      <BotRoutineEditor
        // Each opening starts a fresh form from the routine it edits (or a blank one).
        key={editorSession}
        bot={bot}
        {...(editing && typeof editing === "object"
          ? { routine: editing }
          : {})}
        {...(editing === "suggestion"
          ? {
              draft: {
                name: BOT_DAILY_CHECKIN_SUGGESTION.name,
                prompt: BOT_DAILY_CHECKIN_SUGGESTION.prompt,
                schedule: BOT_DAILY_CHECKIN_SUGGESTION.schedule,
              },
            }
          : {})}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={placeSaved}
        onDeleted={dropDeleted}
      />
    </section>
  );
}
