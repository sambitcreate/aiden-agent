import { BotChatPane } from "./bots/bot-chat-pane";
import { BotWorkbench } from "./bots/bot-workbench";

/** `/bots/$botId/chat`: one Bot's conversation, with its side panel beside it. */
export function BotChatRoute({ botId }: { botId: string }) {
  return (
    <BotWorkbench key={botId} botId={botId}>
      <BotChatPane botId={botId} />
    </BotWorkbench>
  );
}
