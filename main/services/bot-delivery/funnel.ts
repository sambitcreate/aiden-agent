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
  ): Promise<
    | { kind: "now" }
    | { kind: "defer"; until: number }
    /** `digestKey` dedupes the one "More updates are in the chat" note of that day. */
    | { kind: "suppress"; reason: "daily_limit"; digestKey?: string }
  >;
}

/** Plan A has no quiet hours or cap; Plan B replaces this with the real gate. */
export const ALWAYS_NOW_GATE: BotDeliveryGate = { decide: async () => ({ kind: "now" }) };

export interface BotDeliveryFunnel {
  deliver(input: BotDeliveryInput): Promise<"sent" | "deferred" | "suppressed" | "duplicate">;
  /**
   * Send what quiet hours held back and is now due: each issue on its own,
   * everything else as one digest per Bot. Rows are durable, so this also
   * catches up after a restart. Returns when the next held row comes due.
   */
  flush(at: number): Promise<number | undefined>;
}

export const BOT_DELIVERY_LIMIT_NOTE = "More updates are in the chat.";

/** The one Mac banner and Telegram line for rows quiet hours held back. */
export function awayDigestBody(count: number): string {
  return `While you were away: ${count} update${count === 1 ? "" : "s"}.`;
}

/** Telegram needs its own request id for classes that have no routine fire. */
export const BOT_DELIVERY_REQUEST_PREFIX = "bot-delivery:";

export function createBotDeliveryFunnel(deps: {
  log: BotDeliveryLog;
  gate: BotDeliveryGate;
  mac(input: BotDeliveryInput): Promise<void>;
  telegram(input: BotDeliveryInput): Promise<void>;
  now(): number;
  /** The Bot's name for a digest's title; falls back to "Your Bot". */
  botName?(botId: string): Promise<string | undefined>;
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

  /** A stored row as the input the ports send; held rows are sent from the log, not the caller. */
  function inputOf(row: BotDeliveryRow): BotDeliveryInput {
    return {
      botId: row.botId,
      class: row.class,
      dedupeKey: row.dedupeKey,
      title: row.title,
      body: row.body,
      status: row.status,
      ...(row.requestId !== undefined ? { requestId: row.requestId } : {}),
    };
  }

  /** Asks the gate and stores the row it decided for. */
  async function record(input: BotDeliveryInput, at: number): Promise<BotDeliveryRow> {
    const decision = await deps.gate.decide(input, at);
    if (decision.kind === "suppress" && decision.digestKey !== undefined) {
      // The first row held back today leaves one note that more is in the chat.
      const note = await deps.log.find(input.botId, decision.digestKey);
      if (!note) {
        const { row: digest } = await deps.log.append({
          botId: input.botId,
          class: "digest",
          dedupeKey: decision.digestKey,
          title: (await deps.botName?.(input.botId)) ?? "Your Bot",
          body: BOT_DELIVERY_LIMIT_NOTE,
          status: "info",
          createdAt: at,
          deliverAfter: at,
        });
        await send(digest, inputOf(digest), at).catch(() => undefined);
      }
    }
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

  async function flushBot(botId: string, at: number): Promise<number | undefined> {
    const rows = await deps.log.list(botId);
    const held = rows.filter((row) => row.suppressed !== true && row.sentAt === undefined && row.deliverAfter > row.createdAt);
    const due = held.filter((row) => row.deliverAfter <= at);
    const later = held.filter((row) => row.deliverAfter > at).map((row) => row.deliverAfter);
    const issues = due.filter((row) => row.class === "issue");
    const others = due.filter((row) => row.class !== "issue");
    for (const row of issues) await send(row, inputOf(row), at).catch(() => undefined);
    if (others.length === 1) await send(others[0]!, inputOf(others[0]!), at).catch(() => undefined);
    else if (others.length > 1) {
      const digest: BotDeliveryInput = {
        botId,
        class: "digest",
        dedupeKey: `digest:away:${at}`,
        title: (await deps.botName?.(botId)) ?? "Your Bot",
        body: awayDigestBody(others.length),
        status: "info",
        requestId: `${BOT_DELIVERY_REQUEST_PREFIX}away-${botId}-${at}`,
      };
      try {
        await deps.mac(digest);
        await deps.telegram(digest);
        for (const row of others) {
          await deps.log.markChannel(botId, row.id, "mac", at);
          await deps.log.markChannel(botId, row.id, "telegram", at);
          await deps.log.markSent(botId, row.id, at);
        }
      } catch {
        // Left owed; the next flush tries again.
      }
    }
    return later.length ? Math.min(...later) : undefined;
  }

  return {
    async flush(at) {
      let next: number | undefined;
      for (const botId of await deps.log.botIds()) {
        const botNext = await flushBot(botId, at).catch(() => undefined);
        if (botNext !== undefined) next = next === undefined ? botNext : Math.min(next, botNext);
      }
      return next;
    },

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
