import * as React from "react";
import { Plus } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Text } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import type { BotRoutine } from "../../../main/services/scheduled-bot-routines";
import type { BotDefinition } from "../../shared/bots";
import { BotRoutineEditor } from "./bot-routine-editor";

export const botRoutinesKey = (botId: string) => ["bot-routines", botId] as const;

/** The Bot's routines: one row per routine, and "+ Add routine". */
export function BotRoutines({ bot }: { bot: Pick<BotDefinition, "id" | "name"> }) {
  const qc = useQueryClient();
  const routines = useQuery({
    queryKey: botRoutinesKey(bot.id),
    queryFn: () => botsApi.routines.list(bot.id),
  });
  const [editing, setEditingState] = React.useState<BotRoutine | "new" | null>(null);
  const [editorSession, setEditorSession] = React.useState(0);
  const setEditing = (next: BotRoutine | "new" | null) => {
    if (next !== null) setEditorSession((value) => value + 1);
    setEditingState(next);
  };
  const list = routines.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: botRoutinesKey(bot.id) });

  return (
    <section aria-labelledby={`routines-${bot.id}`} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Text as="h2" variant="strong" id={`routines-${bot.id}`}>
          Routines
        </Text>
        <Button size="small" variant="transparent" onClick={() => setEditing("new")}>
          <Plus /> Add routine
        </Button>
      </div>
      {routines.isLoading ? (
        <Text as="p" variant="small" color="secondary" role="status">
          Loading routines…
        </Text>
      ) : routines.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <Text as="p" variant="small" color="secondary">
            Aiden couldn’t load {bot.name}’s routines.
          </Text>
          <Button size="small" variant="transparent" onClick={() => void routines.refetch()}>
            Try again
          </Button>
        </div>
      ) : list.length === 0 ? (
        <Text as="p" variant="small" color="secondary">
          No routines yet. A routine has {bot.name} check in on a schedule.
        </Text>
      ) : (
        <ul aria-label="Routines" className="overflow-hidden rounded-card bg-well">
          {list.map((routine) => (
            <li key={routine.id} className="border-b border-separator last:border-b-0">
              <button
                type="button"
                className="flex w-full min-w-0 flex-col gap-0.5 px-4 py-3 text-left outline-none transition-colors duration-150 hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
                onClick={() => setEditing(routine)}
              >
                <span className="truncate text-regular text-primary">{routine.name}</span>
                <span className="truncate text-small text-secondary">{routine.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <BotRoutineEditor
        // Each opening starts a fresh form from the routine it edits (or a blank one).
        key={editorSession}
        bot={bot}
        {...(editing && editing !== "new" ? { routine: editing } : {})}
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
