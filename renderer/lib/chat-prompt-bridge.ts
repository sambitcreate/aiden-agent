/**
 * Lets surfaces outside a chat (the Artifacts tab) send a confirmed prompt
 * into the chat that is on screen, through that chat's own send path.
 */

type ChatPromptHandler = (text: string) => void;

const handlers = new Map<string, ChatPromptHandler>();

export function registerChatPromptTarget(chatId: string, handler: ChatPromptHandler): () => void {
  handlers.set(chatId, handler);
  return () => {
    if (handlers.get(chatId) === handler) handlers.delete(chatId);
  };
}

/** False when that chat is not mounted; the caller then stages the text instead. */
export function sendPromptToChat(chatId: string, text: string): boolean {
  const handler = handlers.get(chatId);
  if (!handler) return false;
  handler(text);
  return true;
}
