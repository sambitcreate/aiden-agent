import { Button, EmptyState } from "../../components/ui";
import type { BotDefinition } from "../../shared/bots";
import { BotChatTitle } from "./bot-chat-header";
import { BOT_NEEDS_MODEL_LABEL } from "./bot-session-state";

/** What a Bot's chat shows until an AI model is set up. Nothing is sent. */
export function BotNeedsModel({
  bot,
  onBack,
  onOpenProfile,
  onSetUp,
}: {
  bot: Pick<BotDefinition, "id" | "name" | "avatar">;
  onBack(): void;
  onOpenProfile(): void;
  onSetUp(): void;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <BotChatTitle bot={bot} onBack={onBack} onOpenProfile={onOpenProfile} />
      <div className="flex flex-1 items-center justify-center">
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
    </div>
  );
}
