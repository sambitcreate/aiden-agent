import { BotChatPane } from "./bots/bot-chat-pane";

/** `/bots/$botId/chat`: one Bot's conversation. */
export function BotChatRoute({ botId }: { botId: string }) {
  return (
    <div className="h-full min-h-0 px-6 pb-4 pt-14 max-[640px]:px-3">
      <BotChatPane key={botId} botId={botId} />
    </div>
  );
}
