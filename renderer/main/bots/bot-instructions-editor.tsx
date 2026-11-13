import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, Text, Textarea, toast } from "../../components/ui";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { BOT_LIMITS, type BotDefinition } from "../../shared/bots";
import { updateBotIdentity } from "./bot-identity";

const countFormatter = new Intl.NumberFormat();

/**
 * Unsaved instruction edits, per Bot, for this window's life. Closing the
 * editor never throws typed text away: it waits here and comes back the next
 * time the editor opens, until it is saved or the person clears it.
 */
const drafts = new Map<string, string>();

/** The draft kept for a Bot, if any (for tests and the editor). */
export function botInstructionsDraft(botId: string): string | undefined {
  return drafts.get(botId);
}

/**
 * The editor for a Bot's instructions, in a dialog over the chat. Save keeps
 * the text; Cancel or Escape with edits keeps them as a draft for next time
 * (no "Discard changes?" question). `seed` starts from proposed text, such as
 * a held "Update instructions?" card's Edit. A Bot always has instructions,
 * so an empty draft can't be saved.
 */
export function BotInstructionsDialog({
  bot,
  open,
  onOpenChange,
  seed,
  onSaved,
}: {
  bot: Pick<BotDefinition, "id" | "name" | "instructions">;
  open: boolean;
  onOpenChange(open: boolean): void;
  seed?: string;
  onSaved?(instructions: string): void | Promise<void>;
}) {
  const qc = useQueryClient();
  const counterId = React.useId();
  const start = () => seed ?? drafts.get(bot.id) ?? bot.instructions;
  const [text, setText] = React.useState(start);
  const [restored, setRestored] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // Each opening starts from the seed, a kept draft, or the saved text.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setText(start());
      setRestored(seed === undefined && drafts.has(bot.id));
    }
  }
  const empty = !text.trim();
  const changed = text.trim() !== bot.instructions.trim();
  const close = (next: boolean) => {
    if (!next) {
      if (changed && !empty) drafts.set(bot.id, text);
      else drafts.delete(bot.id);
    }
    onOpenChange(next);
  };
  const save = async () => {
    if (empty || saving) return;
    if (!changed) {
      drafts.delete(bot.id);
      await onSaved?.(bot.instructions);
      onOpenChange(false);
      return;
    }
    setSaving(true);
    const next = text.trim();
    try {
      await updateBotIdentity(qc, bot.id, { instructions: next });
      drafts.delete(bot.id);
      toast.success("Instructions saved");
      await onSaved?.(next);
      onOpenChange(false);
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t save these instructions."));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size="large"
      title="Instructions"
      description={`${bot.name}’s personality and how it should help. Memory is separate.`}
      confirmLabel={saving ? "Saving…" : "Save"}
      confirmDisabled={empty || saving}
      busy={saving}
      onConfirm={save}
      submitOnEnter
    >
      <div className="flex flex-col gap-2">
        <Textarea
          autoFocus
          aria-label={`Instructions for ${bot.name}`}
          aria-describedby={counterId}
          aria-invalid={empty || undefined}
          className="min-h-[min(50vh,24rem)]"
          value={text}
          maxLength={BOT_LIMITS.instructionsChars}
          disabled={saving}
          placeholder="What should this Bot do, and how should it talk to you?"
          onChange={(event) => setText(event.target.value)}
        />
        <div id={counterId} className="flex items-center justify-between gap-3">
          <Text as="p" variant="small" color={empty ? "status-red" : "secondary"}>
            {empty ? "Instructions can’t be empty." : restored ? "Your unsaved edit is back." : changed ? "Unsaved changes" : null}
          </Text>
          <Text as="p" variant="small" color="tertiary" className="tabular-nums">
            {`${countFormatter.format(text.length)} / ${countFormatter.format(BOT_LIMITS.instructionsChars)}`}
          </Text>
        </div>
      </div>
    </Dialog>
  );
}
