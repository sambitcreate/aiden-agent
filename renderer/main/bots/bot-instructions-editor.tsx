import * as React from "react";
import { ChevronLeft } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Text, Textarea, toast } from "../../components/ui";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { BOT_LIMITS, type BotDefinition } from "../../shared/bots";
import { updateBotIdentity } from "./bot-identity";

/**
 * A full-page editor for a Bot's instructions. Save keeps the text; Back
 * leaves without saving.
 */
export function BotInstructionsEditor({
  bot,
  onClose,
}: {
  bot: Pick<BotDefinition, "id" | "name" | "instructions">;
  onClose(): void;
}) {
  const qc = useQueryClient();
  const [text, setText] = React.useState(bot.instructions);
  const [saving, setSaving] = React.useState(false);
  const changed = text.trim() !== bot.instructions.trim();
  const save = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      await updateBotIdentity(qc, bot.id, { instructions: text.trim() });
      onClose();
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t save these instructions."));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex min-h-full flex-col gap-4">
      <header className="flex items-center gap-3">
        <Button iconOnly variant="filled" size="large" aria-label="Back" disabled={saving} onClick={onClose}>
          <ChevronLeft />
        </Button>
        <Text as="h1" variant="heading1" className="min-w-0 flex-1 truncate">
          Instructions
        </Text>
        <Button variant="accent" disabled={saving || !changed || !text.trim()} onClick={() => void save()}>
          Save
        </Button>
      </header>
      <Textarea
        autoFocus
        aria-label={`Instructions for ${bot.name}`}
        className="min-h-80 flex-1 resize-none"
        value={text}
        maxLength={BOT_LIMITS.instructionsChars}
        disabled={saving}
        placeholder="What should this Bot do, and how should it talk to you?"
        onChange={(event) => setText(event.target.value)}
      />
    </div>
  );
}
