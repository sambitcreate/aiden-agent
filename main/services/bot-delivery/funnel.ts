// The one way a Bot message reaches the person. Every class of Bot delivery
// (routine results today; issues, proposals and digests next) is written to
// the per-Bot delivery log once, then sent to the Mac and Telegram. The phone
// feed reads the log, so a row and its phone notification can never disagree.
//
// Quiet hours and the daily cap enter here as the gate (Plan B). The gate is
// checked on admission and again when a deferred group actually goes out.
// A retry of a released row sends only the channels that are still owed.

import { createHash } from "node:crypto";
import { createKeyedSerial } from "../bot-routine-notes.js";
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
  /** Review a previously deferred group against today’s settings and budget. */
  reviewHeld?: BotDeliveryGate["decide"];
  quietUntil?(botId: string, at: number): Promise<number | undefined>;
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

  async function limitNote(botId: string, key: string | undefined, at: number) {
    if (!key || await deps.log.find(botId, key)) return;
    const { row } = await deps.log.append({
      botId, class: "digest", dedupeKey: key, title: (await deps.botName?.(botId)) ?? "Your Bot",
      body: BOT_DELIVERY_LIMIT_NOTE, status: "info", createdAt: at, deliverAfter: at,
    });
    await send(row, inputOf(row), at).catch(() => undefined);
  }

  /** Asks the gate and stores the row it decided for. */
  async function record(input: BotDeliveryInput, at: number): Promise<{ row: BotDeliveryRow; now: boolean }> {
    const decision = await deps.gate.decide(input, at);
    if (decision.kind === "suppress") await limitNote(input.botId, decision.digestKey, at);
    const { row } = await deps.log.append({
      botId: input.botId,
      class: input.class,
      dedupeKey: input.dedupeKey,
      title: input.title,
      body: input.body,
      status: input.status,
      ...(input.routineTask !== undefined ? { routineId: input.routineTask.id } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.routineTask?.notify === false ? { quiet: true } : {}),
      createdAt: at,
      deliverAfter: decision.kind === "defer" ? decision.until : at,
      ...(decision.kind === "suppress" ? { suppressed: true } : {}),
      ...(decision.kind === "now" ? { stampNow: true } : {}),
    });
    return { row, now: decision.kind === "now" };
  }

  const serial = createKeyedSerial();

  async function flushBot(botId: string, at: number): Promise<number | undefined> {
    const rows = await deps.log.list(botId);
    const held = rows.filter((row) => row.suppressed !== true && row.sentAt === undefined && row.deliverAfter > row.createdAt);
    let due = held.filter((row) => row.deliverAfter <= at);
    const later = held.filter((row) => row.deliverAfter > at).map((row) => row.deliverAfter);
    const digests = rows.filter((row) => row.class === "digest" && row.sentAt === undefined && !row.suppressed);
    const quietUntil = due.length || digests.length ? await deps.gate.quietUntil?.(botId, at) : undefined;
    for (const row of digests) {
      if (quietUntil !== undefined && row.dedupeKey.startsWith("digest:away:")) continue;
      await send(row, inputOf(row), at).catch(() => undefined);
    }
    if (quietUntil !== undefined) return Math.min(quietUntil, ...later);
    const unreleased = due.filter((row) => row.releasedAt === undefined && row.macSentAt === undefined && row.telegramSentAt === undefined);
    const counted = unreleased.filter((row) => row.class === "proposal" || row.class === "routine_result");
    const decision = counted.length ? await deps.gate.reviewHeld?.(inputOf(counted[0]!), at) : undefined;
    if (decision?.kind === "defer") return Math.min(decision.until, ...later);
    if (decision?.kind === "suppress") await limitNote(botId, decision.digestKey, at);
    const suppressed = new Set(decision?.kind === "suppress" ? counted.map((row) => row.id) : []);
    if (unreleased.length) await deps.log.releaseHeld(botId, unreleased.map((row) => row.id), at, suppressed);
    due = due.filter((row) => !suppressed.has(row.id));
    const issues = due.filter((row) => row.class === "issue");
    const others = due.filter((row) => row.class !== "issue");
    for (const row of issues) await send(row, inputOf(row), at).catch(() => undefined);
    if (others.length === 1) await send(others[0]!, inputOf(others[0]!), at).catch(() => undefined);
    else if (others.length > 1) {
      // The digest is a row of its own, keyed by the rows it covers: a crash
      // or a failed channel resumes the same digest (same Telegram request
      // id), and the Mac banner is stamped once it went out.
      const ids = others.map((row) => row.id).sort();
      const { row: digest } = await deps.log.append({
        botId,
        class: "digest",
        dedupeKey: `digest:away:${createHash("sha256").update(ids.join("\0")).digest("hex").slice(0, 32)}`,
        title: (await deps.botName?.(botId)) ?? "Your Bot",
        body: awayDigestBody(others.length),
        status: "info",
        createdAt: at,
        deliverAfter: at,
      });
      await deps.log.markCovered(botId, ids, digest.dedupeKey, at);
      await send(digest, inputOf(digest), at).catch(() => undefined);
    }
    return later.length ? Math.min(...later) : undefined;
  }

  return {
    async flush(at) {
      let next: number | undefined;
      for (const botId of await deps.log.botIds()) {
        const botNext = await serial(botId, () => flushBot(botId, at)).catch(() => undefined);
        if (botNext !== undefined) next = next === undefined ? botNext : Math.min(next, botNext);
      }
      return next;
    },

    deliver(input) {
      // The budget decision and the durable row it counts share a lane with flushes.
      return serial(input.botId, () => deliverOnce(input));
    },
  };

  async function deliverOnce(input: BotDeliveryInput): Promise<"sent" | "deferred" | "suppressed" | "duplicate"> {
    {
      const at = deps.now();
      // An existing row keeps its stored decision: asking the gate again would
      // count a retry against the cap and could hold back a row it already
      // released. The gate is asked once, when the row is created.
      const stored = await deps.log.find(input.botId, input.dedupeKey);
      const created = stored ? undefined : await record(input, at);
      const row = stored ?? created!.row;
      if (row.suppressed === true) return "suppressed";
      // Only a row that went out on every channel is a duplicate.
      if (row.sentAt !== undefined) return "duplicate";
      // A row the gate just released goes now; a stored one waits for its time.
      if (created ? !created.now : row.deliverAfter > at) return "deferred";
      if (stored && row.deliverAfter > row.createdAt) {
        // Only the flush releases held rows, including retries after a restart.
        await flushBot(input.botId, at);
        const released = await deps.log.find(input.botId, input.dedupeKey);
        if (released?.suppressed) return "suppressed";
        return released?.sentAt === undefined ? "deferred" : "sent";
      }
      return send(row, input, at);
    }
  }
}
