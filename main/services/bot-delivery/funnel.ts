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
import { BotDeliveryHistoryFullError, type BotDeliveryClass, type BotDeliveryLog, type BotDeliveryRow } from "./log.js";

export interface BotDeliveryInput {
  botId: string;
  class: BotDeliveryClass;
  requiredCapability?: BotDeliveryRow["requiredCapability"];
  dedupeKey: string;
  title: string;
  body: string;
  status: BotDeliveryRow["status"];
  routineTask?: ScheduledTask;
  requestId?: string;
  chatId?: string;
  /** Host-derived notification preference from the accepted originating task. */
  quiet?: boolean;
  /** Host-only original identity fence; never persisted in a delivery row. */
  publication?: {incarnation?:string;assertCurrent():Promise<void>};
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
  ownsPeerFinal?(botId: string, requestId: string): Promise<boolean>;
  peerPublication?(botId:string,rootId:string):Promise<{incarnation?:string;assertCurrent():Promise<void>}|undefined>;
  peerSettled?(botId:string,rootId:string):Promise<void>;
  peerPending?(botId:string,rootId:string):Promise<void>;
  /** The Bot's name for a digest's title; falls back to "Your Bot". */
  botName?(botId: string): Promise<string | undefined>;
}): BotDeliveryFunnel {
  /**
   * Sends only the channels the row still owes, stamping each as it succeeds.
   * `sentAt` is the row's "all channels done"; a row that has both stamps from
   * an earlier attempt is finalized without contacting either port again.
   */
  function rowRoots(row:Pick<BotDeliveryRow,"class"|"requestId"|"peerRootIds">):string[]{return row.peerRootIds??(row.class==="peer_result"&&row.requestId?[row.requestId]:[]);}
  function rootsPublication(botId:string,roots:readonly string[]):BotDeliveryInput["publication"]{if(!roots.length||!deps.peerPublication)return undefined;return {assertCurrent:async()=>{for(const id of roots){const current=await deps.peerPublication!(botId,id);if(!current)throw new Error("This delayed peer result belongs to a retired Bot.");await current.assertCurrent();}}};}
  async function settled(row:BotDeliveryRow):Promise<void>{if(row.peerSettledAt!==undefined||!rowRoots(row).length)return;await deps.log.settlePeerReferences(row.botId,row.id,async facts=>{for(const root of facts.pending)await deps.peerPending?.(row.botId,root);for(const root of facts.settled)await deps.peerSettled?.(row.botId,root);},deps.now());}
  async function send(row: BotDeliveryRow, input: BotDeliveryInput, at: number) {
    const storedPublication=rootsPublication(row.botId,rowRoots(row));
    if(storedPublication){const original=input.publication,first=await deps.peerPublication!(row.botId,rowRoots(row)[0]!);if(!first)throw new Error("This peer result belongs to a retired Bot.");const incarnation=original?.incarnation??first.incarnation;input={...input,publication:{...(incarnation?{incarnation}:{}),assertCurrent:async()=>{await original?.assertCurrent();await storedPublication.assertCurrent();}}};}
    await input.publication?.assertCurrent();
    const sending: BotDeliveryInput =
      row.class === "routine_result"
        ? input
        : { ...input, requestId: `${BOT_DELIVERY_REQUEST_PREFIX}${row.id}` };
    if (row.quiet === true) { await deps.log.markSent(row.botId, row.id, at,input.publication); await settled(row);return "suppressed"; }
    let delivered = false;
    if (row.macSentAt === undefined) {
      await input.publication?.assertCurrent();
      await deps.mac(sending);
      await deps.log.markChannel(row.botId, row.id, "mac", at,input.publication);
      delivered = true;
    }
    if (row.telegramSentAt === undefined) {
      await input.publication?.assertCurrent();
      await deps.telegram(sending);
      await deps.log.markChannel(row.botId, row.id, "telegram", at,input.publication);
      delivered = true;
    }
    await deps.log.markSent(row.botId, row.id, at,input.publication);
    await settled(row);
    return delivered ? "sent" : "duplicate";
  }

  /** A stored row as the input the ports send; held rows are sent from the log, not the caller. */
  function inputOf(row: BotDeliveryRow): BotDeliveryInput {
    return {
      botId: row.botId,
      class: row.class,
      ...(row.requiredCapability === undefined ? {} : { requiredCapability: row.requiredCapability }),
      dedupeKey: row.dedupeKey,
      title: row.title,
      body: row.body,
      status: row.status,
      ...(row.requestId !== undefined ? { requestId: row.requestId } : {}),
    };
  }

  async function limitNote(botId: string, key: string | undefined, at: number, source?: BotDeliveryInput) {
    if (!key || await deps.log.find(botId, key)) return;
    const { row } = await deps.log.append({
      botId, class: "digest", dedupeKey: key, title: (await deps.botName?.(botId)) ?? "Your Bot",
      body: BOT_DELIVERY_LIMIT_NOTE, status: "info", createdAt: at, deliverAfter: at,
      ...(source?.class === "peer_result" && source.requestId ? { peerRootIds: [source.requestId] } : {}),
    }, source?.publication);
    await send(row, { ...inputOf(row), publication: source?.publication }, at).catch(() => undefined);
  }

  /** Asks the gate and stores the row it decided for. */
  async function record(input: BotDeliveryInput, at: number): Promise<{ row: BotDeliveryRow; now: boolean }> {
    const decision = input.quiet === true || input.routineTask?.notify === false ? {kind:"now" as const} : await deps.gate.decide(input, at);
    if (decision.kind === "suppress") await limitNote(input.botId, decision.digestKey, at, input);
    await input.publication?.assertCurrent();
    const { row } = await deps.log.append({
      botId: input.botId,
      class: input.class,
      ...(input.requiredCapability === undefined ? {} : { requiredCapability: input.requiredCapability }),
      dedupeKey: input.dedupeKey,
      title: input.title,
      body: input.body,
      status: input.status,
      ...(input.routineTask !== undefined ? { routineId: input.routineTask.id } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.class==="peer_result"&&input.requestId?{peerRootIds:[input.requestId]}:{}),
      ...(input.quiet === true || input.routineTask?.notify === false ? { quiet: true } : {}),
      createdAt: at,
      deliverAfter: decision.kind === "defer" ? decision.until : at,
      ...(decision.kind === "suppress" ? { suppressed: true } : {}),
      ...(decision.kind === "now" ? { stampNow: true } : {}),
    },input.publication);
    return { row, now: decision.kind === "now" };
  }

  const serial = createKeyedSerial();

  async function flushBot(botId: string, at: number): Promise<number | undefined> {
    const retained=await deps.log.list(botId),rows:BotDeliveryRow[]=[];
    // Reconcile durable stamps before filtering delivery authority: one digest
    // may have settled/pruned its first root before a crash left another owed.
    // This bookkeeping grants no send or execution authority.
    for(const row of retained)if(row.suppressed===true||row.quiet===true||row.sentAt!==undefined&&(!row.coveredBy||retained.some(digest=>digest.dedupeKey===row.coveredBy&&digest.sentAt!==undefined)))await settled(row);
    for(const row of retained){try{await rootsPublication(botId,rowRoots(row))?.assertCurrent();rows.push(row);}catch{/* Retired peer rows never become a new owner notification or digest. */}}
    const held = rows.filter((row) => row.quiet !== true && row.suppressed !== true && row.sentAt === undefined && row.deliverAfter > row.createdAt);
    let due = held.filter((row) => row.deliverAfter <= at);
    const later = held.filter((row) => row.deliverAfter > at).map((row) => row.deliverAfter);
    // A digest whose channels didn't all go out last time: only the owed ones.
    const digests = rows.filter((row) => row.class === "digest" && row.sentAt === undefined && row.suppressed !== true);
    const quietUntil = due.length || digests.length ? await deps.gate.quietUntil?.(botId, at) : undefined;
    for (const row of digests) {
      if (quietUntil !== undefined && row.dedupeKey.startsWith("digest:away:")) continue;
      await send(row, inputOf(row), at).catch(() => undefined);
    }
    for(const row of rows.filter(row=>row.quiet===true&&row.sentAt===undefined)) await deps.log.markSent(row.botId,row.id,at,rootsPublication(botId,rowRoots(row)));
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
      async function digest(group:BotDeliveryRow[]):Promise<void>{
        const ids=group.map(row=>row.id).sort(),peerRootIds=[...new Set(group.flatMap(rowRoots))],publication=rootsPublication(botId,peerRootIds);
        const {row:summary}=await deps.log.append({botId,class:"digest",dedupeKey:`digest:away:${createHash("sha256").update(ids.join("\0")).digest("hex").slice(0,32)}`,title:(await deps.botName?.(botId))??"Your Bot",body:awayDigestBody(group.length),...(peerRootIds.length?{peerRootIds}:{}),status:"info",createdAt:at,deliverAfter:at},publication);
        await deps.log.markCovered(botId,ids,summary.dedupeKey,at,publication);
        await send(summary,{...inputOf(summary),publication},at);
      }
      try{await digest(others);}catch(error){if(!(error instanceof BotDeliveryHistoryFullError))throw error;
        // A full retained queue has no room for its digest control row. Drain
        // one existing delivery completely, then reuse only that settled slot.
        const first=others[others.length-1]!;await send(first,inputOf(first),at);
        const remainder=others.slice(0,-1);if(remainder.length===1)await send(remainder[0]!,inputOf(remainder[0]!),at);else if(remainder.length>1)await digest(remainder);
      }
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
      if (input.class === "routine_result" && input.requestId && await deps.ownsPeerFinal?.(input.botId,input.requestId)) return "suppressed";
      await input.publication?.assertCurrent();
      const at = deps.now();
      // An existing row keeps its stored decision: asking the gate again would
      // count a retry against the cap and could hold back a row it already
      // released. The gate is asked once, when the row is created.
      const stored = await deps.log.find(input.botId, input.dedupeKey);
      const created = stored ? undefined : await record(input, at);
      const row = stored ?? created!.row;
      if (row.suppressed === true) {await settled(row);return "suppressed";}
      // Only a row that went out on every channel is a duplicate.
      if (row.sentAt !== undefined) {await settled(row);return "duplicate";}
      // A row the gate just released goes now; a stored one waits for its time.
      if (created ? !created.now : row.deliverAfter > at) return "deferred";
      if (stored && row.deliverAfter > row.createdAt) {
        // Only the flush releases held rows, including retries after a restart.
        await flushBot(input.botId, at);
        const released = await deps.log.find(input.botId, input.dedupeKey);
        if (released?.suppressed) {await settled(released);return "suppressed";}
        return released?.sentAt === undefined ? "deferred" : "sent";
      }
      return send(row, input, at);
    }
  }
}
