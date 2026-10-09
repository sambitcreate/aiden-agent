import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, FieldSet, Text, Textarea, toast } from "../../components/ui";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { BOT_LIMITS, type BotDefinition } from "../../shared/bots";
import { updateBotIdentity } from "./bot-identity";
import { BotPageShell, useDiscardChangesGuard } from "./bot-page-shell";

const countFormatter = new Intl.NumberFormat();

/**
 * The editor for a Bot's instructions. Save in the toolbar keeps the text;
 * Back with unsaved edits asks before discarding them. A Bot always has
 * instructions, so an empty draft can't be saved.
 */
export function BotInstructionsEditor({
  bot,
  onClose,
}: {
  bot: Pick<BotDefinition, "id" | "name" | "instructions">;
  onClose(): void;
}) {
  const qc = useQueryClient();
  const counterId = React.useId();
  const [text, setText] = React.useState(bot.instructions);
  const [saving, setSaving] = React.useState(false);
  const empty = !text.trim();
  const changed = text.trim() !== bot.instructions.trim();
  const guard = useDiscardChangesGuard({
    dirty: changed,
    onLeave: onClose,
    description: `Your edits to ${bot.name}’s instructions won’t be saved.`,
  });
  const save = async () => {
    if (empty || !changed || saving) return;
    setSaving(true);
    try {
      await updateBotIdentity(qc, bot.id, { instructions: text.trim() });
      toast.success("Instructions saved");
      onClose();
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t save these instructions."));
    } finally {
      setSaving(false);
    }
  };
  return (
    <BotPageShell
      scrollId={`bot-instructions:${bot.id}`}
      title={bot.name}
      backLabel="Back"
      onBack={() => {
        if (!saving) guard.requestLeave();
      }}
      heading="Instructions"
      description={`This is ${bot.name}’s personality and how it should help. Memory is separate.`}
      actions={
        <Button variant="accent" disabled={saving || !changed || empty} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      }
    >
      <FieldSet>
        <div className="flex flex-col gap-2 p-4">
          <Textarea
            autoFocus
            aria-label={`Instructions for ${bot.name}`}
            aria-describedby={counterId}
            aria-invalid={empty || undefined}
            className="min-h-[min(60vh,32rem)]"
            value={text}
            maxLength={BOT_LIMITS.instructionsChars}
            disabled={saving}
            placeholder="What should this Bot do, and how should it talk to you?"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void save();
              }
            }}
          />
          <div id={counterId} className="flex items-center justify-between gap-3">
            <Text as="p" variant="small" color={empty ? "status-red" : "secondary"}>
              {empty ? "Instructions can’t be empty." : changed ? "Unsaved changes" : null}
            </Text>
            <Text as="p" variant="small" color="tertiary" className="tabular-nums">
              {`${countFormatter.format(text.length)} / ${countFormatter.format(BOT_LIMITS.instructionsChars)}`}
            </Text>
          </div>
        </div>
      </FieldSet>
      {guard.dialog}
    </BotPageShell>
  );
}
