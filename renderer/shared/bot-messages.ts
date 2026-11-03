export const BOT_MESSAGE_TOOL_NAME = "message_bot";
export const BOT_MESSAGE_REQUEST_PREFIX = "bot:";
export const BOT_REPLY_REQUEST_PREFIX = "botreply:";
export const BOT_MESSAGE_STATUS_ENTRY_KIND = "aiden.bot-message-status";
export const BOT_MESSAGE_LIMITS = {
  messageChars: 4000,
  replyChars: 8000,
  inFlightPerSender: 3,
  burstCount: 20,
  burstWindowMs: 5 * 60000,
  cooldownMs: 10 * 60000,
  dailyPerPair: 30,
  windowMs: 30 * 60000,
  rosterSize: 12,
} as const;
export function botMessageRequestId(fromBotId: string, hop: 1 | 2, deliveryId: string): string {
  return `bot:${fromBotId}:${hop}:${deliveryId}`;
}
export function botReplyRequestId(deliveryId: string): string {
  return `botreply:${deliveryId}`;
}
export type BotMessageTurnKind =
  | {
      kind: "person";
    }
  | {
      kind: "message";
      fromBotId: string;
      hop: 1 | 2;
      deliveryId: string;
    }
  | {
      kind: "reply";
      deliveryId: string;
    }
  | {
      kind: "unattended";
    };
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
export function isBotMessageRequestId(id: string | undefined): boolean {
  return id?.startsWith(BOT_MESSAGE_REQUEST_PREFIX) === true || id?.startsWith(BOT_REPLY_REQUEST_PREFIX) === true;
}
export function botMessageTurnOf(id: string | undefined): BotMessageTurnKind {
  if (id?.startsWith(BOT_REPLY_REQUEST_PREFIX)) {
    const deliveryId = id.slice(BOT_REPLY_REQUEST_PREFIX.length);
    return UUID.test(deliveryId) ? { kind: "reply", deliveryId } : { kind: "unattended" };
  }
  if (id?.startsWith(BOT_MESSAGE_REQUEST_PREFIX)) {
    const last = id.lastIndexOf(":"),
      previous = id.lastIndexOf(":", last - 1);
    const deliveryId = id.slice(last + 1),
      hop = id.slice(previous + 1, last),
      fromBotId = id.slice(4, previous);
    return fromBotId && (hop === "1" || hop === "2") && UUID.test(deliveryId)
      ? { kind: "message", fromBotId, hop: Number(hop) as 1 | 2, deliveryId }
      : { kind: "unattended" };
  }
  return /^(routine|tg|intro):/u.test(id ?? "") ? { kind: "unattended" } : { kind: "person" };
}
export type BotMessageChain =
  | {
      canSend: true;
      hop: 1 | 2;
      parentDeliveryId?: string;
      chain: readonly string[];
    }
  | {
      canSend: false;
      code: "chain_too_deep";
    };
export function botMessageChainOf(ids: readonly (string | undefined)[]): BotMessageChain {
  let parent:
    | Extract<
        BotMessageTurnKind,
        {
          kind: "message";
        }
      >
    | undefined;
  for (const id of ids) {
    const turn = botMessageTurnOf(id);
    if (turn.kind === "person") continue;
    if (
      turn.kind !== "message" ||
      turn.hop !== 1 ||
      (parent && (parent.deliveryId !== turn.deliveryId || parent.fromBotId !== turn.fromBotId))
    )
      return { canSend: false, code: "chain_too_deep" };
    parent = turn;
  }
  return parent
    ? { canSend: true, hop: 2, parentDeliveryId: parent.deliveryId, chain: [parent.fromBotId] }
    : { canSend: true, hop: 1, chain: [] };
}
export type BotMessageStatusOutcome =
  | "waiting_approval"
  | "silent"
  | "expired"
  | "gave_up"
  | "failed"
  | "replied_while_paused";
export interface BotMessageStatusEntryData {
  deliveryId: string;
  botId: string;
  botName: string;
  outcome: BotMessageStatusOutcome;
  waitId?: string;
  summary?: string;
  text?: string;
}
export function botMessageRowLabel(kind: "request" | "reply", name: string): string {
  return `${name} ${kind === "request" ? "asked" : "replied"}`;
}
export function botMessageStatusLine(data: BotMessageStatusEntryData): string {
  const { botName: bot, summary = "this action" } = data;
  switch (data.outcome) {
    case "waiting_approval":
      return `${bot} is waiting for you to approve: ${summary}`;
    case "silent":
      return `${bot} had nothing to add.`;
    case "expired":
      return `${bot} didn't answer within 30 minutes.`;
    case "gave_up":
      return `${bot} gave up: nobody approved ${summary}.`;
    case "failed":
      return `${bot} couldn't answer.`;
    case "replied_while_paused":
      return `${bot} replied`;
  }
}
export function botMessagingEnabled(
  settings:
    | {
        botMessaging?: unknown;
      }
    | undefined,
): boolean {
  return settings?.botMessaging !== false;
}
