import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertDialog, toast } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { queryKeys } from "../../lib/queries";
import type { BotDefinition } from "../../shared/bots";
import { botSidebarPreferenceActions } from "./use-bot-sidebar-preferences";

export function botDeleteTitle(name: string): string {
  return `Delete ${name}?`;
}

export function botDeleteDescription(name: string): string {
  return `This permanently erases ${name}'s chat, memory, instructions, routines, files, and photo. This can't be undone.`;
}

/** Confirms, permanently deletes the Bot, then returns to the Bots list. */
export function BotDeleteDialog({
  bot,
  open,
  onOpenChange,
  returnFocus,
}: {
  bot: Pick<BotDefinition, "id" | "name">;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Where focus goes when the dialog closes, such as the next row once this Bot's row is gone. */
  returnFocus?: () => HTMLElement | null;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = React.useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await botsApi.delete(bot.id);
      // Here, not in a list prune: deleting the last Bot leaves an empty list, which never prunes.
      botSidebarPreferenceActions.forget(bot.id);
      qc.removeQueries({ queryKey: queryKeys.bot(bot.id) });
      qc.removeQueries({ queryKey: queryKeys.botChats(bot.id) });
      await qc.invalidateQueries({ queryKey: queryKeys.bots });
      onOpenChange(false);
      await navigate({ to: "/bots" });
    } catch (error) {
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t delete ${bot.name}.`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={onOpenChange}
      title={botDeleteTitle(bot.name)}
      description={botDeleteDescription(bot.name)}
      confirmLabel="Delete Bot"
      confirmVariant="destructive"
      keepOpenOnConfirm
      busy={busy}
      returnFocus={returnFocus}
      onConfirm={confirm}
    />
  );
}
