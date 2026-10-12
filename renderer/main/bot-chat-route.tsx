import { BotChatPane } from "./bots/bot-chat-pane";

/** `/bots/$botId/chat`: one Bot's conversation. */
export function BotChatRoute({ botId }: { botId: string }) {
  return <BotChatPane key={botId} botId={botId} />;
}
