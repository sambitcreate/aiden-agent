// The one way a Bot message reaches the person. Every class of Bot delivery
// (routine results today; issues, proposals and digests next) is written to
// the per-Bot delivery log once, then sent to the Mac and Telegram. The phone
// feed reads the log, so a row and its phone notification can never disagree.
//
// Quiet hours and the daily cap enter here as the gate (Plan B). The gate is
// asked once, when the row is created: an existing row keeps the decision it
// was stored with, and a retry only sends the channels that are still owed.
// Deferred rows are sent later by the flush; this module only decides and
// records.

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
  /**
   * Sends only the channels the row still owes, stamping each as it succeeds.
   * `sentAt` is the row's "all channels done"; a row that has both stamps from
   * an earlier attempt is finalized without contacting either port again.
   */
  async function send(row: BotDeliveryRow, input: BotDeliveryInput, at: number) {
    const sending: BotDeliveryInput =
      row.class === "routine_result"
        ? input
        : { ...input, requestId: `${BOT_DELIVERY_REQUEST_PREFIX}${row.id}` };
    let delivered = false;
    if (row.macSentAt === undefined) {
      await deps.mac(sending);
      await deps.log.markChannel(row.botId, row.id, "mac", at);
      delivered = true;
    }
    if (row.telegramSentAt === undefined) {
      await deps.telegram(sending);
      await deps.log.markChannel(row.botId, row.id, "telegram", at);
      delivered = true;
    }
    await deps.log.markSent(row.botId, row.id, at);
    return delivered ? "sent" : "duplicate";
  }

  /** Asks the gate and stores the row it decided for. */
  async function record(input: BotDeliveryInput, at: number): Promise<BotDeliveryRow> {
    const decision = await deps.gate.decide(input, at);
    const { row } = await deps.log.append({
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
      ...(decision.kind === "suppress" ? { suppressed: true } : {}),
    });
    return row;
  }

  return {
    async deliver(input) {
      const at = deps.now();
      // An existing row keeps its stored decision: asking the gate again would
      // count a retry against the cap and could hold back a row it already
      // released. The gate is asked once, when the row is created.
      const row = (await deps.log.find(input.botId, input.dedupeKey)) ?? (await record(input, at));
      if (row.suppressed === true) return "suppressed";
      // Only a row that went out on every channel is a duplicate.
      if (row.sentAt !== undefined) return "duplicate";
      if (row.deliverAfter > at) return "deferred";
      return send(row, input, at);
    },
  };
}
