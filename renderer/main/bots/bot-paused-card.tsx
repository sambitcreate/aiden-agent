// The card a paused Bot's chat shows (plan §7). The person paused it, so it is
// a calm state, not a warning. Resume lifts the pause; a reply the pause cut
// short then shows the interrupted card with its own Resume and Dismiss.

import * as React from "react";
import { Pause } from "lucide-react";
import { BotNoticeCard } from "../../components/bots/bot-notice-card";
import { Button } from "../../components/ui";
import type { BotDefinition } from "../../shared/bots";
import { setBotPaused } from "./bot-menu";

export function botPausedText(name: string): string {
  return `${name} is paused.`;
}

export function BotPausedCard({ bot }: { bot: Pick<BotDefinition, "id" | "name"> }) {
  // One Resume at a time: the button is disabled while the first is in flight.
  const [busy, setBusy] = React.useState(false);
  const resume = async () => {
    setBusy(true);
    try {
      await setBotPaused(bot, false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <BotNoticeCard
      label={botPausedText(bot.name)}
      icon={<Pause />}
      title={botPausedText(bot.name)}
      actions={
        <Button variant="accent" size="small" disabled={busy} onClick={() => void resume()}>
          Resume
        </Button>
      }
    >
      <p>{`${bot.name} won’t reply or run routines until you resume it.`}</p>
    </BotNoticeCard>
  );
}
