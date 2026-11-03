import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { BOT_MESSAGE_LIMITS as L, BOT_MESSAGE_TOOL_NAME } from "../../../renderer/shared/bot-messages.js";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import type { BotMessageCourier, BotRosterEntry } from "./courier.js";
export const BOT_MESSAGE_MEMO = "aiden.bot-message";
export interface MessageBotToolDeps {
  post: BotMessageCourier["post"];
  roster(): Promise<readonly BotRosterEntry[]>;
  /** Captured by the refresh that builds the declaration, never model supplied. */
  descriptionRoster?: readonly BotRosterEntry[];
}
const parameters = Type.Object(
  { bot: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1, maxLength: L.messageChars }) },
  { additionalProperties: false },
);
export function createMessageBotTool(
  botId: string,
  deps: MessageBotToolDeps,
  call?: Pick<BotToolCall, "memo" | "runRequestIds" | "signal">,
): AgentTool {
  const roster = (deps.descriptionRoster ?? [])
    .filter((b) => b.id !== botId && b.acceptsMessages)
    .slice(0, L.rosterSize);
  return {
    name: BOT_MESSAGE_TOOL_NAME,
    label: "Message a Bot",
    parameters,
    description: [
      "Send one of the person's other Bots a message. It answers later, as a new message in this chat.",
      "Write your own message; don't paste the person's words. Message only the one Bot that can help, unless the person asks for more. Finish your turn after sending.",
      ...roster.map((b) => `${b.name} — ${b.purpose.slice(0, 80)} (id: ${b.id})`),
    ].join("\n"),
    async execute(_id, args) {
      if (!call?.runRequestIds) throw new Error("The owning Bot run is unavailable.");
      const { deliveryId } = await call.memo(BOT_MESSAGE_MEMO, { deliveryId: randomUUID() });
      const { bot, message } = args as {
        bot: string;
        message: string;
      };
      const result = await deps.post({
        fromBotId: botId,
        target: bot,
        message,
        deliveryId,
        runRequestIds: await call.runRequestIds(),
        signal: call.signal,
      });
      const details =
        result.status === "sent" ? { status: "sent", deliveryId: result.deliveryId, to: result.to.name } : result;
      return {
        content: [
          {
            type: "text",
            text:
              result.status === "sent"
                ? `${JSON.stringify(details)}\nSent. ${result.to.name} will reply later in this chat. Finish your turn now; don't wait or check.`
                : JSON.stringify(details),
          },
        ],
        details,
        ...(result.status === "refused" ? { isError: true } : {}),
      };
    },
  };
}
