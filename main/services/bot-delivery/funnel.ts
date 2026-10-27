// The one way a Bot message reaches the person. Every class of Bot delivery
// (routine results today; issues, proposals and digests next) is written to
// the per-Bot delivery log once, then sent to the Mac and Telegram. The phone
// feed reads the log, so a row and its phone notification can never disagree.
//
// Quiet hours and the daily cap enter here as the gate (Plan B). Deferred rows
// are sent later by the flush; this module only decides and records.

import type { ScheduledTask } from "../types.js";
import type { BotDeliveryClass, BotDeliveryLog, BotDeliveryRow } from "./log.js";

export interface BotDeliveryInput {
  botId: string;
  class: BotDeliveryClass;
  dedupeKey: string;
  title: string;
  body: string;
  status: BotDeliveryRow["status"];
  routineTask?: ScheduledTask;
  requestId?: string;
  chatId?: string;
}

export interface BotDeliveryGate {
  decide(
    input: BotDeliveryInput,
    now: number,
  ): Promise<{ kind: "now" } | { kind: "defer"; until: number } | { kind: "suppress"; reason: "daily_limit" }>;
}

/** Plan A has no quiet hours or cap; Plan B replaces this with the real gate. */
export const ALWAYS_NOW_GATE: BotDeliveryGate = { decide: async () => ({ kind: "now" }) };

export interface BotDeliveryFunnel {
  deliver(input: BotDeliveryInput): Promise<"sent" | "deferred" | "suppressed" | "duplicate">;
}

/** Telegram needs its own request id for classes that have no routine fire. */
export const BOT_DELIVERY_REQUEST_PREFIX = "bot-delivery:";

export function createBotDeliveryFunnel(deps: {
  log: BotDeliveryLog;
  gate: BotDeliveryGate;
  mac(input: BotDeliveryInput): Promise<void>;
  telegram(input: BotDeliveryInput): Promise<void>;
  now(): number;
}): BotDeliveryFunnel {
  return {
    async deliver(input) {
      const at = deps.now();
      const decision = await deps.gate.decide(input, at);
      const { row, created } = await deps.log.append({
        botId: input.botId,
        class: input.class,
        dedupeKey: input.dedupeKey,
        title: input.title,
        body: input.body,
        status: input.status,
        ...(input.routineTask !== undefined ? { routineId: input.routineTask.id } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        createdAt: at,
        deliverAfter: decision.kind === "defer" ? decision.until : at,
      });
      if (decision.kind === "suppress") return created ? "suppressed" : "duplicate";
      if (decision.kind === "defer") return created ? "deferred" : "duplicate";
      // A logged row whose send failed is retried under the same row; only a
      // row that already went out is a duplicate.
      if (!created && row.sentAt !== undefined) return "duplicate";
      const sending: BotDeliveryInput =
        input.class === "routine_result"
          ? input
          : { ...input, requestId: `${BOT_DELIVERY_REQUEST_PREFIX}${row.id}` };
      await deps.mac(sending);
      await deps.telegram(sending);
      await deps.log.markSent(row.botId, row.id, at);
      return "sent";
    },
  };
}
