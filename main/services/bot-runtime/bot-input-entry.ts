/** Pi places this kind on the input itself only when the host admits a routine. */
export const BOT_ROUTINE_INPUT_KIND = "aiden.routine-input";

export const BOT_MESSAGE_INPUT_KIND = "aiden.bot-message-input";

export interface BotMessageInputMetadata {
  kind: "request" | "reply"; deliveryId: string; botId: string; botName: string; text: string; deadline: number;
}

export function isBotInputEntryKind(kind: string): boolean {
  return kind === "pi.user" || kind === BOT_ROUTINE_INPUT_KIND || kind === BOT_MESSAGE_INPUT_KIND;
}
