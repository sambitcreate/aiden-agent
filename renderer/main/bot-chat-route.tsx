import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { EmptyState, Text } from "../components/ui";
import { useChat } from "../lib/queries";
import { ChatPane } from "./chat-pane";

export function BotChatRoute({ botId, chatId }: { botId: string; chatId: string }) {
  const navigate = useNavigate();
  const chat = useChat(chatId);
  const actualBotId = chat.data?.botId;

  React.useEffect(() => {
    if (chat.isLoading || !chat.data || actualBotId === botId) return;
    void navigate(
      actualBotId
        ? {
            to: "/bots/$botId/chat/$chatId",
            params: { botId: actualBotId, chatId },
            replace: true,
          }
        : { to: "/chat/$chatId", params: { chatId }, replace: true },
    );
  }, [actualBotId, botId, chat.data, chat.isLoading, chatId, navigate]);

  if (chat.isLoading) return <Text color="secondary">Loading conversation…</Text>;
  if (chat.isError || !chat.data) {
    return (
      <EmptyState
        title="Conversation not found"
        description="This conversation is no longer available."
      />
    );
  }
  if (actualBotId !== botId) {
    return <Text color="secondary">Opening the correct conversation…</Text>;
  }
  return <ChatPane chatId={chatId} />;
}
