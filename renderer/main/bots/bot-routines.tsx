import * as React from "react";
import { CalendarClock, ChevronRight, Plus, RotateCcw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Text } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import type { BotRoutine } from "../../../main/services/scheduled-bot-routines";
import type { BotDefinition } from "../../shared/bots";
import { formatBotRoutineLabel } from "../../shared/bot-routine-label";
import { BOT_DAILY_CHECKIN_SUGGESTION } from "../../shared/bot-routine-proposals";
import { BotRoutineEditor } from "./bot-routine-editor";

export const botRoutinesKey = (botId: string) => ["bot-routines", botId] as const;

type Editing = BotRoutine | "new" | "suggestion" | null;

/**
 * The Bot's routines: one row per routine, and "+ Add routine". With no
 * routines yet, "Try a daily check-in" opens the editor prefilled; nothing is
 * created until the person saves it.
 */
export function BotRoutines({ bot }: { bot: Pick<BotDefinition, "id" | "name"> }) {
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
  const refresh = () => qc.invalidateQueries({ queryKey: botRoutinesKey(bot.id) });

  const titleId = `routines-${bot.id}`;
  const rowClass =
    "relative flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-150 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none";

  return (
    <section aria-labelledby={titleId} className="settings-group mb-7">
      <h2 id={titleId} className="settings-group-title mb-3 px-4 text-large-strong text-primary">
        Routines
      </h2>
      <div className="settings-group-card overflow-hidden rounded-card bg-well">
        {routines.isLoading ? (
          <div role="status" aria-label="Loading routines" className="relative px-4 py-3 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator">
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
            <Button size="small" variant="filled" onClick={() => void routines.refetch()}>
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
            <button type="button" className={rowClass} onClick={() => setEditing("suggestion")}>
              <CalendarClock aria-hidden="true" className="size-4 shrink-0 text-secondary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-regular text-primary">Try a daily check-in</span>
                <span className="mt-0.5 block truncate text-small text-secondary">
                  {formatBotRoutineLabel(BOT_DAILY_CHECKIN_SUGGESTION.schedule)}
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
            </button>
          </>
        ) : (
          <ul aria-label="Routines">
            {list.map((routine) => (
              <li key={routine.id}>
                <button type="button" className={rowClass} onClick={() => setEditing(routine)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-strong text-primary">{routine.name}</span>
                    <span className="mt-0.5 block truncate text-small text-secondary">{routine.label}</span>
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
                </button>
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
        {...(editing && typeof editing === "object" ? { routine: editing } : {})}
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
        onSaved={() => void refresh()}
        onDeleted={() => void refresh()}
      />
    </section>
  );
}
