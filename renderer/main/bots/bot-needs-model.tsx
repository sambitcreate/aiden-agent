import { Button, EmptyState } from "../../components/ui";
import type { BotDefinition } from "../../shared/bots";
import { BOT_NEEDS_MODEL_LABEL } from "./bot-session-state";

/** What a Bot's chat shows until an AI model is set up. Nothing is sent. */
export function BotNeedsModel({
  bot,
  onSetUp,
}: {
  bot: Pick<BotDefinition, "name">;
  onSetUp(): void;
}) {
  return (
    <div className="aiden-dock-inset chat-content-column flex min-h-full items-center justify-center py-10">
      <EmptyState
        role="status"
        title={BOT_NEEDS_MODEL_LABEL}
        description={`Set up an AI model so ${bot.name} can reply.`}
        action={
          <Button variant="accent" onClick={onSetUp}>
            Set up
          </Button>
        }
      />
    </div>
  );
}
