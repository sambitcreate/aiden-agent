// Profile → What I've learned (spec 2026-10-27 §7 L5): the lessons a Bot
// keeps, the follow-ups it noted, and recent changes, each with Remove or
// Undo. A change made since can't be undone here.

import * as React from "react";
import { Button, Field, FieldSet, Text, toast } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { BotLearningOverview } from "../../shared/bot-learning-overview";
import type { BotDefinition } from "../../shared/bots";
import { BotPageShell } from "./bot-page-shell";

export interface BotLearningApi {
  get(botId: string): Promise<BotLearningOverview>;
  undo(input: { botId: string; changeId: string }): Promise<{ ok: true } | { ok: false; code: string }>;
  removeLesson(input: { botId: string; lessonId: string }): Promise<void>;
}

export const BOT_LEARNING_CONFLICT_MESSAGE = "This changed since. Edit it on the Memory page.";

export function BotLearningSections({
  bot,
  api,
}: {
  bot: Pick<BotDefinition, "id" | "name">;
  api: BotLearningApi;
}) {
  const [overview, setOverview] = React.useState<BotLearningOverview | null>(null);
  const reload = React.useCallback(async () => setOverview(await api.get(bot.id).catch(() => null)), [api, bot.id]);
  React.useEffect(() => {
    void reload();
  }, [reload]);
  if (!overview) return null;
  const empty = !overview.lessons.length && !overview.followUps.length && !overview.changes.length;
  if (empty) {
    return (
      <FieldSet title="What I've learned">
        <Field label="Nothing yet" description={`${bot.name} will show what it learns here.`} />
      </FieldSet>
    );
  }
  const undo = async (changeId: string) => {
    const result = await api.undo({ botId: bot.id, changeId });
    if (!result.ok) toast.error(result.code === "conflict" ? BOT_LEARNING_CONFLICT_MESSAGE : "Aiden couldn’t undo that.");
    await reload();
  };
  return (
    <>
      {overview.lessons.length ? (
        <FieldSet title="Lessons">
          {overview.lessons.map((lesson) => (
            <Field key={lesson.id} label={lesson.lesson} description={lesson.source === "correction" ? "From your correction" : "From its routine runs"}>
              <Button
                size="small"
                variant="transparent"
                className="justify-self-end"
                aria-label={`Remove lesson: ${lesson.lesson}`}
                onClick={() => void api.removeLesson({ botId: bot.id, lessonId: lesson.id }).then(reload, (error: unknown) =>
                  toast.error(userFacingErrorMessage(error, "Aiden couldn’t remove that lesson.")))}
              >
                Remove
              </Button>
            </Field>
          ))}
        </FieldSet>
      ) : null}
      {overview.followUps.length ? (
        <FieldSet title="Follow-ups">
          {overview.followUps.map((followUp) => (
            <Field key={followUp.id} label={followUp.text} description={`Due ${followUp.dueDate}`} />
          ))}
        </FieldSet>
      ) : null}
      {overview.changes.length ? (
        <FieldSet title="Recent changes">
          {overview.changes.map((change) => (
            <Field key={change.id} label={change.summary} description={new Date(change.at).toLocaleString()}>
              {change.undoneAt || change.undoOf ? (
                <Text as="span" variant="small" color="tertiary" className="justify-self-end">{change.undoOf ? "Undo" : "Undone"}</Text>
              ) : (
                <Button size="small" variant="transparent" className="justify-self-end" aria-label={`Undo: ${change.summary}`} onClick={() => void undo(change.id)}>
                  Undo
                </Button>
              )}
            </Field>
          ))}
        </FieldSet>
      ) : null}
    </>
  );
}

export function BotLearningPage({ bot, onClose }: { bot: BotDefinition; onClose(): void }) {
  return (
    <BotPageShell scrollId={`bot-learning:${bot.id}`} title="What I've learned" backLabel={bot.name} onBack={onClose}>
      <BotLearningSections bot={bot} api={botsApi.learning} />
    </BotPageShell>
  );
}
