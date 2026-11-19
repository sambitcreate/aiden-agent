import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { BOT_MESSAGE_LIMITS as L, BOT_MESSAGE_TOOL_NAME } from "../../../renderer/shared/bot-messages.js";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import type { BotMessageCourier, BotRosterEntry } from "./courier.js";
export const BOT_MESSAGE_MEMO = "aiden.bot-message";
export interface MessageBotToolDeps {
  post: BotMessageCourier["post"];
  roster(): Promise<readonly BotRosterEntry[]>;
}
const parameters = Type.Object(
  {
    action: Type.Optional(
      Type.Union([Type.Literal("send"), Type.Literal("list")], {
        description: '"list" returns the Bots you can message; "send" (the default) sends one a message.',
      }),
    ),
    bot: Type.Optional(Type.String({ minLength: 1, description: "The Bot's id or name, from the list." })),
    message: Type.Optional(Type.String({ minLength: 1, maxLength: L.messageChars })),
  },
  { additionalProperties: false },
);
/**
 * One fixed declaration for every Bot and every roster: the peers are listed
 * by the `list` action, never in the description, so a Bot being added,
 * renamed or paused leaves every other Bot's cached tool list unchanged.
 */
export const MESSAGE_BOT_DESCRIPTION = [
  "Send one of the person's other Bots a message. It answers later, as a new message in this chat.",
  'Call with action "list" first to see which Bots accept messages and what each is for, then send to one by id.',
  "Write your own message; don't paste the person's words. Message only the one Bot that can help, unless the person asks for more. Finish your turn after sending.",
].join("\n");
/** The Bots `botId` may message now, as the `list` action returns them. */
export async function messageBotPeers(botId: string, deps: Pick<MessageBotToolDeps, "roster">) {
  return (await deps.roster())
    .filter((b) => b.id !== botId && b.acceptsMessages)
    .slice(0, L.rosterSize)
    .map((b) => ({ id: b.id, name: b.name, purpose: b.purpose.slice(0, 80) }));
}
export function createMessageBotTool(
  botId: string,
  deps: MessageBotToolDeps,
  call?: Pick<BotToolCall, "memo" | "runRequestIds" | "signal" | "taskId">,
): AgentTool {
  return {
    name: BOT_MESSAGE_TOOL_NAME,
    label: "Message a Bot",
    parameters,
    description: MESSAGE_BOT_DESCRIPTION,
    async execute(_id, args) {
      const { action, bot, message } = args as { action?: "send" | "list"; bot?: string; message?: string };
      if (action === "list") {
        // Reads the roster only; nothing is sent, so there is nothing to journal.
        const bots = await messageBotPeers(botId, deps);
        const details = { status: "listed", bots };
        return {
          content: [
            {
              type: "text",
              text:
                bots.length === 0
                  ? `${JSON.stringify(details)}\nNo other Bot accepts messages right now.`
                  : JSON.stringify(details),
            },
          ],
          details,
        };
      }
      if (!bot || !message) throw new Error('Sending needs both "bot" and "message". Call with action "list" to see the Bots.');
      if (!call?.runRequestIds) throw new Error("The owning Bot run is unavailable.");
      const memo = await call.memo(BOT_MESSAGE_MEMO, {
        deliveryId: randomUUID(),
        ...(call.taskId ? { taskId: call.taskId } : {}),
      });
      const { deliveryId } = memo;
      const result = await deps.post({
        fromBotId: botId,
        target: bot,
        message,
        deliveryId,
        ...(memo.taskId ? { taskId: memo.taskId } : {}),
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
