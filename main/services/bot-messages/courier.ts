import type { JsonValue } from "@earendil-works/chord";
import {
  BOT_MESSAGE_LIMITS as L,
  BOT_MESSAGE_STATUS_ENTRY_KIND,
  botMessageChainOf,
  botMessageRequestId,
  botMessageTurnOf,
  botReplyRequestId,
  botMessageStatusLine,
  isBotMessageRequestId,
  type BotMessageStatusOutcome,
} from "../../../renderer/shared/bot-messages.js";
import type { BotSessionRuntime, BotReplyOutcome } from "../bot-runtime/bot-session-service.js";
import type { BotApprovals } from "../bot-runtime/bot-approvals.js";
import type { BotDeliveryInput } from "../bot-delivery/funnel.js";
import {
  botMessageReplayHash,
  type BotMessageDelivery,
  type BotMessageEffect,
  type BotMessageLedger,
} from "./ledger.js";
import { botMessageInputText, botReplyInputText } from "./framing.js";
export interface BotRosterEntry {
  id: string;
  name: string;
  purpose: string;
  acceptsMessages: boolean;
  sendsMessages: boolean;
  unavailable?: "bot_paused" | "needs_model" | "spending_limit" | "unavailable";
}
export type BotMessageRefusal =
  | "switched_off"
  | "unknown_bot"
  | "ambiguous_bot"
  | "self"
  | "in_chain"
  | "chain_too_deep"
  | "limit_reached"
  | "bot_paused"
  | "needs_model"
  | "spending_limit"
  | "unavailable"
  | "invalid_message";
export interface BotMessagePost {
  fromBotId: string;
  target: string;
  message: string;
  deliveryId: string;
  taskId?: string;
  runRequestIds: readonly (string | undefined)[];
  signal?: AbortSignal;
}
export type BotMessagePostResult =
  | {
      status: "sent";
      deliveryId: string;
      to: {
        id: string;
        name: string;
      };
    }
  | {
      status: "refused";
      code: BotMessageRefusal;
      message: string;
      retryAfter?: number;
      bots?: string[];
    };
export interface BotMessageCourierDeps {
  ledger: BotMessageLedger;
  sessions: Pick<
    BotSessionRuntime,
    "send" | "awaitReply" | "markSilent" | "appendEntry" | "state" | "submissionForRequest"
  > &
    Partial<Pick<BotSessionRuntime, "awaitMessageTaskSettlement">>;
  roster(): Promise<readonly BotRosterEntry[]>;
  enabled(): Promise<boolean>;
  approvals: Pick<BotApprovals, "pending" | "decide" | "onChange">;
  onStateChange(listener: (botId: string) => void): () => void;
  deliver?(input: BotDeliveryInput): Promise<unknown>;
  now(): number;
  setTimer(
    fn: () => void,
    ms: number,
  ): {
    cancel(): void;
  };
  report?(error: unknown): void;
}
export interface BotMessageCourier {
  post(input: BotMessagePost): Promise<BotMessagePostResult>;
  start(): Promise<void>;
  forgetBot(botId: string): Promise<void>;
  dispose(): Promise<void>;
  announceWaiting(
    botId: string,
    requestIds: readonly (string | undefined)[],
    summary: string,
    waitId: string,
  ): Promise<
    | {
        deadline: number;
        expired: boolean;
      }
    | undefined
  >;
}
const silent = (text: string) => text.trim() === "[SILENT]" || !text.trim();
const unfinished = (row: BotMessageDelivery) => row.status === "delivered";
export function createBotMessageCourier(deps: BotMessageCourierDeps): BotMessageCourier {
  let disposed = false,
    started = false;
  const workers = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<void>;
    }
  >();
  const dirty = new Set<string>();
  const approvalUpdates = new Map<string, Promise<void>>();
  const timers = new Map<
    string,
    {
      cancel(): void;
    }
  >();
  const scheduled = new Map<
    string,
    {
      cancel(): void;
    }
  >();
  const deleted = new Set<string>();
  const waits = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<BotReplyOutcome>;
      users: Set<symbol>;
    }
  >();
  const receiptWatches = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const publications = new Map<string, Promise<void>>();
  const background = new Set<Promise<unknown>>();
  const posts = new Set<Promise<BotMessagePostResult>>();
  function track(task: Promise<unknown>): void {
    background.add(task);
    void task.catch(report).finally(() => background.delete(task));
  }
  let removeState: (() => void) | undefined, removeApprovals: (() => void) | undefined;
  const report = (e: unknown) => deps.report?.(e);
  function queue(id: string) {
    if (disposed) return;
    if (workers.has(id)) {
      dirty.add(id);
      return;
    }
    if (scheduled.has(id)) return;
    // Dispatch is a separate event-loop task, after the posting tool returned.
    scheduled.set(
      id,
      deps.setTimer(() => {
        scheduled.delete(id);
        launch(id);
      }, 0),
    );
  }
  function launch(id: string) {
    if (disposed || workers.has(id)) return;
    const controller = new AbortController();
    const promise = work(id, controller.signal)
      .catch(report)
      .finally(() => {
        workers.delete(id);
        if (!disposed)
          track(
            (async () => {
              const row = await deps.ledger.get(id);
              if (row) arm(row);
            })(),
          );
        if (dirty.delete(id)) queue(id);
      });
    workers.set(id, { controller, promise });
  }
  async function exists(botId: string, id: string): Promise<boolean> {
    const row = await deps.ledger.get(id),
      roster = await deps.roster();
    return !disposed && !deleted.has(botId) && !!row && roster.some((b) => b.id === botId);
  }
  function liveDeadline(row: BotMessageDelivery): boolean {
    return (
      unfinished(row) ||
      row.effects.some((e) => e.kind === "reply" && e.acknowledgedAt === undefined) ||
      deps.approvals.pending().some((p) => p.owner?.inputs.some((i) => i.botMessage?.deliveryId === row.id))
    );
  }
  function arm(row: BotMessageDelivery) {
    if (disposed) return;
    if (!liveDeadline(row) || row.deadline <= deps.now()) {
      timers.get(row.id)?.cancel();
      timers.delete(row.id);
      return;
    }
    if (timers.has(row.id)) return;
    timers.set(
      row.id,
      deps.setTimer(() => {
        timers.delete(row.id);
        if (disposed) return;
        workers.get(row.id)?.controller.abort();
        track(expire(row.id).then(() => queue(row.id)));
      }, row.deadline - deps.now()),
    );
  }
  function notice(
    row: BotMessageDelivery,
    outcome: BotMessageStatusOutcome,
    text?: string,
    waitId?: string,
    summary?: string,
    ownerBotId = row.toBotId,
  ): BotMessageEffect[] {
    const data = {
      deliveryId: row.id,
      botId: ownerBotId,
      botName: ownerBotId === row.fromBotId ? row.fromName : row.toName,
      outcome,
      ...(text === undefined ? {} : { text }),
      ...(waitId ? { waitId } : {}),
      ...(summary ? { summary } : {}),
    };
    const key = `${row.id}:${outcome}:${waitId ?? "final"}`;
    return [
      { id: `${key}:notice`, kind: "notice", botId: row.fromBotId, data },
      {
        id: `${key}:notification`,
        kind: "notification",
        botId: row.fromBotId,
        data,
      },
    ];
  }
  async function quiet(id: string, outcome: BotMessageStatusOutcome): Promise<void> {
    const row = await deps.ledger.update(id, (r) => {
      if (!unfinished(r)) return r;
      return {
        ...r,
        status:
          outcome === "expired" || outcome === "gave_up" ? "expired" : outcome === "silent" ? "answered" : "failed",
        outcome,
        settledAt: deps.now(),
        effects: [
          ...r.effects.map((e) =>
            e.kind === "target" || e.kind === "reply" ? { ...e, acknowledgedAt: deps.now() } : e,
          ),
          ...notice(r, outcome, undefined, undefined, r.waiting[r.waiting.length - 1]?.summary),
        ],
      };
    });
    if (row?.parentDeliveryId && row.outcome === outcome) {
      await deps.ledger.update(row.parentDeliveryId, (r) => (unfinished(r) ? { ...r, childOutcome: outcome } : r));
      queue(row.parentDeliveryId);
    }
    if (row?.childDeliveryId) queue(row.childDeliveryId);
    queue(id);
  }
  async function expire(id: string): Promise<void> {
    const row = await deps.ledger.get(id);
    if (!row) return;
    const prompts = deps.approvals
      .pending()
      .filter((prompt) => prompt.owner?.inputs.some((i) => i.botMessage?.deliveryId === id));
    for (const prompt of prompts) {
      if (prompt.owner?.inputs.some((i) => i.botMessage?.deliveryId === id))
        deps.approvals.decide(prompt.waitId, "deny", undefined, "expiry");
    }
    if (unfinished(row) && row.parentDeliveryId) {
      const parent = await deps.ledger.get(row.parentDeliveryId);
      if (parent?.status === "answered" && (parent.outcome === "replied" || parent.outcome === "silent")) {
        queue(id);
        return;
      }
      if (row.initialAnswer !== undefined) return settleSavedChild(row);
      if (!parent || !unfinished(parent)) {
        if (prompts.length) return quiet(id, "gave_up");
        queue(id); // The normal worker settles against the parent's saved outcome.
        return;
      }
    }
    if (unfinished(row)) await quiet(id, prompts.length ? "gave_up" : "expired");
    else queue(id); // An answer already saved falls back to a display row.
  }
  async function ack(id: string, effectId: string, extra: Partial<BotMessageEffect> = {}) {
    await deps.ledger.update(id, (r) => ({
      ...r,
      effects: r.effects.map((e) => (e.id === effectId ? { ...e, ...extra, acknowledgedAt: deps.now() } : e)),
    }));
  }
  async function answer(id: string, text: string): Promise<void> {
    const row = await deps.ledger.get(id);
    if (!row || !unfinished(row)) return;
    if (deps.now() >= row.deadline) return expire(id);
    const bounded = text.trim().slice(0, L.replyChars);
    if (silent(bounded) && !row.childDeliveryId && !row.childOutcome) return quiet(id, "silent");
    if (row.parentDeliveryId) {
      await deps.ledger.update(id, (r) => (unfinished(r) ? { ...r, initialAnswer: bounded } : r));
      queue(id);
      return;
    }
    if (row.childDeliveryId) {
      await deps.ledger.update(id, (r) => (unfinished(r) ? { ...r, initialAnswer: bounded } : r));
      queue(row.childDeliveryId);
      queue(id);
      return;
    }
    if (row.childOutcome) {
      await deps.ledger.update(id, (r) => (unfinished(r) ? { ...r, initialAnswer: bounded } : r));
      queue(id);
      return;
    }
    await finalAnswer(id, bounded);
  }
  async function finalAnswer(id: string, text: string, fromChild = false): Promise<void> {
    const saved = await deps.ledger.update(id, (r) => {
      if (!unfinished(r) || deps.now() >= r.deadline) return r;
      if (r.childDeliveryId && !fromChild) return { ...r, initialAnswer: text };
      return {
        ...r,
        status: "answered",
        outcome: "replied",
        settledAt: deps.now(),
        initialAnswer: text,
        effects: [
          ...r.effects,
          {
            id: `${r.id}:reply`,
            kind: "reply",
            botId: r.fromBotId,
            requestId: botReplyRequestId(r.id),
            text,
          },
        ],
      };
    });
    if (saved && unfinished(saved) && deps.now() >= saved.deadline) return expire(id);
    if (saved?.childDeliveryId && !fromChild) queue(saved.childDeliveryId);
    queue(id);
  }
  async function wait(botId: string, submissionId: string, signal: AbortSignal): Promise<BotReplyOutcome | undefined> {
    if (signal.aborted || disposed) return;
    const key = JSON.stringify([botId, submissionId]);
    let shared = waits.get(key);
    if (shared?.controller.signal.aborted) {
      await shared.promise.catch(() => undefined);
      shared = undefined;
    }
    if (signal.aborted || disposed) return;
    if (!shared) {
      const controller = new AbortController();
      const users = new Set<symbol>();
      const promise = deps.sessions.awaitReply(botId, submissionId, controller.signal);
      shared = { controller, promise, users };
      waits.set(key, shared);
      const saved = shared;
      void promise
        .finally(() => {
          if (waits.get(key) === saved) waits.delete(key);
        })
        .catch(() => undefined);
    }
    const user = Symbol();
    shared.users.add(user);
    let onAbort: () => void = () => undefined;
    const canceled = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      const result = await Promise.race([shared.promise, canceled]);
      return signal.aborted || disposed ? undefined : result;
    } finally {
      signal.removeEventListener("abort", onAbort);
      shared.users.delete(user);
      if (!shared.users.size) shared.controller.abort();
    }
  }
  async function observeBusy(
    id: string,
    botId: string,
    signal: AbortSignal,
    unavailable = () => quiet(id, "failed"),
  ): Promise<void> {
    const state = await deps.sessions.state(botId);
    if (state.kind === "running") {
      await wait(botId, state.submissionId, signal);
      if (!disposed && !signal.aborted) queue(id);
    } else if (state.kind === "idle") {
      if (!disposed && !signal.aborted) queue(id);
    } else if (!disposed && !signal.aborted) await unavailable();
  }
  async function collectReceipts(): Promise<void> {
    if (disposed || !deps.sessions.awaitMessageTaskSettlement) return;
    for (const receipt of await deps.ledger.receipts()) {
      if (!receipt.taskId || receiptWatches.has(receipt.id) || deleted.has(receipt.fromBotId)) continue;
      const controller = new AbortController();
      const taskId = receipt.taskId;
      const promise = deps.sessions
        .awaitMessageTaskSettlement(receipt.fromBotId, taskId, controller.signal)
        .then(async (settled) => {
          if (settled && !disposed && !controller.signal.aborted) await deps.ledger.collectReceipt(receipt.id, taskId);
        })
        .catch((error) => {
          if (!controller.signal.aborted) report(error);
        })
        .finally(() => receiptWatches.delete(receipt.id));
      receiptWatches.set(receipt.id, { controller, promise });
    }
  }
  async function displayReply(
    row: BotMessageDelivery,
    effect: BotMessageEffect,
    parentOutcome: "failed" | "expired",
  ): Promise<void> {
    if (!(await exists(effect.botId, row.id))) return;
    if (row.parentDeliveryId) {
      await settleSavedChild(row, parentOutcome);
      await quiet(row.parentDeliveryId, parentOutcome);
      return;
    }
    await deps.ledger.update(row.id, (r) => {
      if (r.effects.find((e) => e.id === effect.id)?.acknowledgedAt !== undefined) return r;
      const effects = notice(r, "replied_while_paused", effect.text);
      return {
        ...r,
        effects: [
          ...r.effects.map((e) => (e.id === effect.id ? { ...e, acknowledgedAt: deps.now() } : e)),
          ...effects.filter((e) => !r.effects.some((saved) => saved.id === e.id)),
        ],
      };
    });
    queue(row.id);
  }
  async function settleSavedChild(
    row: BotMessageDelivery,
    parentFallbackOutcome?: "failed" | "expired",
  ): Promise<void> {
    if (deps.now() >= row.deadline) {
      for (const prompt of deps.approvals.pending())
        if (prompt.owner?.inputs.some((i) => i.botMessage?.deliveryId === row.id))
          deps.approvals.decide(prompt.waitId, "deny", undefined, "expiry");
    }
    await deps.ledger.update(row.id, (r) => {
      if (!unfinished(r) || r.initialAnswer === undefined) return r;
      const effects = notice(r, "replied_while_paused", r.initialAnswer).filter((e) => e.kind === "notice");
      return {
        ...r,
        status: "answered",
        outcome: "replied_while_paused",
        settledAt: deps.now(),
        ...(parentFallbackOutcome ? { parentFallbackOutcome } : {}),
        effects: [
          ...r.effects.map((e) =>
            e.kind === "target" || e.kind === "reply" ? { ...e, acknowledgedAt: deps.now() } : e,
          ),
          ...effects.filter((e) => !r.effects.some((saved) => saved.id === e.id)),
        ],
      };
    });
    queue(row.id);
  }
  async function reply(row: BotMessageDelivery, effect: BotMessageEffect, signal: AbortSignal): Promise<void> {
    if (!(await exists(effect.botId, row.id))) {
      if (!disposed) await ack(row.id, effect.id);
      return;
    }
    if (deps.now() >= row.deadline) {
      return displayReply(row, effect, "expired");
    }
    let submission = effect.submissionId ?? (await deps.sessions.submissionForRequest(effect.botId, effect.requestId!));
    if (!submission) {
      const state = await deps.sessions.state(effect.botId);
      if ((state.kind !== "idle" && state.kind !== "running") || deps.now() >= row.deadline) {
        return displayReply(row, effect, "failed");
      }
      if (state.kind === "running")
        return observeBusy(row.id, effect.botId, signal, () => displayReply(row, effect, "failed"));
      try {
        if (!(await exists(effect.botId, row.id))) return;
        submission = (
          await deps.sessions.send(effect.botId, {
            text: botReplyInputText({
              fromName: row.toName,
              reply: effect.text!,
            }),
            requestId: effect.requestId!,
            ifIdle: true,
            ifNotInterrupted: true,
            botMessage: {
              kind: "reply",
              deliveryId: row.id,
              botId: row.toBotId,
              botName: row.toName,
              text: effect.text!,
              deadline: row.deadline,
            },
          })
        ).submissionId;
      } catch (e) {
        if (reason(e) === "bot_busy")
          return observeBusy(row.id, effect.botId, signal, () => displayReply(row, effect, "failed"));
        if (
          ["bot_paused", "paused_by_person", "spending_limit", "needs_model", "model_error", "unavailable"].includes(
            reason(e),
          )
        ) {
          return displayReply(row, effect, "failed");
        }
        throw e;
      }
      await deps.ledger.update(row.id, (r) => ({
        ...r,
        effects: r.effects.map((e) => (e.id === effect.id ? { ...e, submissionId: submission } : e)),
      }));
    }
    const result = await wait(effect.botId, submission, signal);
    if (!result) return;
    if (result.kind === "interrupted" && !result.settled) return;
    if (result.kind === "completed" && silent(result.text)) await deps.sessions.markSilent(effect.botId, submission);
    // Child continuation satisfies the parent's obligation, never an independent origin delivery.
    if (row.parentDeliveryId) {
      if (result.kind === "completed" && !silent(result.text) && deps.now() < row.deadline) {
        const parent = await deps.ledger.get(row.parentDeliveryId);
        if (parent && unfinished(parent)) await finalAnswer(parent.id, result.text.trim().slice(0, L.replyChars), true);
      } else await quiet(row.parentDeliveryId, result.kind === "completed" ? "silent" : "failed");
      await deps.ledger.update(row.id, (r) => ({
        ...r,
        status: "answered",
        outcome: "replied",
        settledAt: deps.now(),
        effects: r.effects.map((e) => (e.id === effect.id ? { ...e, acknowledgedAt: deps.now() } : e)),
      }));
    } else {
      if (result.kind !== "completed") return displayReply(row, effect, "failed");
      await deps.ledger.update(row.id, (r) => ({
        ...r,
        effects: [
          ...r.effects.map((e) => (e.id === effect.id ? { ...e, acknowledgedAt: deps.now() } : e)),
          ...(result.kind === "completed" && !silent(result.text)
            ? [
                {
                  id: `row:${r.id}:final`,
                  kind: "notification" as const,
                  botId: r.fromBotId,
                  text: result.text.trim().slice(0, L.replyChars),
                },
              ]
            : []),
        ],
      }));
    }
    queue(row.id);
  }
  async function publish(row: BotMessageDelivery, effect: BotMessageEffect): Promise<void> {
    const active = publications.get(effect.id);
    if (active) return active;
    const task = (async () => {
      if (!(await exists(effect.botId, row.id))) return;
      // A child's answer belongs in its parent's chat, never a separate funnel delivery.
      if (row.parentDeliveryId && effect.kind === "notification" && effect.data?.outcome === "replied_while_paused") {
        await ack(row.id, effect.id);
        return;
      }
      if (effect.kind === "notice")
        await deps.sessions.appendEntry(effect.botId, BOT_MESSAGE_STATUS_ENTRY_KIND, {
          ...effect.data,
          effectId: effect.id,
        } as JsonValue);
      else
        await deps.deliver?.({
          botId: effect.botId,
          class: "bot_message",
          dedupeKey: effect.id,
          title: effect.data ? botMessageStatusLine(effect.data) : `${row.toName} replied`,
          body: effect.text ?? effect.data?.text ?? (effect.data ? botMessageStatusLine(effect.data) : ""),
          status: effect.data?.outcome === "failed" ? "failed" : "info",
        });
      await ack(row.id, effect.id);
    })();
    publications.set(effect.id, task);
    try {
      await task;
    } finally {
      publications.delete(effect.id);
    }
  }
  function publishWaiting(id: string) {
    const key = `notice:${id}`;
    if (disposed || scheduled.has(key)) return;
    scheduled.set(
      key,
      deps.setTimer(() => {
        scheduled.delete(key);
        if (disposed) return;
        track(
          (async () => {
            const row = await deps.ledger.get(id);
            if (!row) return;
            for (const effect of row.effects)
              if (effect.acknowledgedAt === undefined && (effect.kind === "notice" || effect.kind === "notification"))
                await publish(row, effect);
          })(),
        );
      }, 0),
    );
  }
  async function work(id: string, signal: AbortSignal): Promise<void> {
    let row = await deps.ledger.get(id);
    if (!row || disposed) return;
    arm(row);
    await collectReceipts();
    if (row.parentDeliveryId && unfinished(row)) {
      const parent = await deps.ledger.get(row.parentDeliveryId);
      if (!parent || !unfinished(parent)) {
        if (parent?.status === "answered" && (parent.outcome === "replied" || parent.outcome === "silent")) {
          await deps.ledger.update(id, (r) => ({
            ...r,
            status: "answered",
            outcome: "replied",
            settledAt: deps.now(),
            effects: r.effects.map((e) =>
              e.kind === "target" || e.kind === "reply" ? { ...e, acknowledgedAt: deps.now() } : e,
            ),
          }));
          queue(id);
          return;
        }
        if (row.initialAnswer !== undefined) return settleSavedChild(row);
        let outcome = parent?.outcome && parent.outcome !== "replied" ? parent.outcome : "failed";
        const pending = deps.approvals
          .pending()
          .filter((p) => p.owner?.inputs.some((i) => i.botMessage?.deliveryId === id));
        if (deps.now() >= row.deadline) {
          for (const prompt of pending) deps.approvals.decide(prompt.waitId, "deny", undefined, "expiry");
          if (pending.length) outcome = "gave_up";
          else if (outcome === "gave_up") outcome = "expired";
        } else if (outcome === "gave_up") outcome = "failed";
        await quiet(id, outcome);
        return;
      }
    }
    if (row.childDeliveryId && unfinished(row) && !row.childOutcome) {
      const child = await deps.ledger.get(row.childDeliveryId);
      const outcome =
        child?.parentFallbackOutcome ??
        (child?.outcome !== "replied" && child?.outcome !== "replied_while_paused" ? child?.outcome : undefined);
      if (child && !unfinished(child) && outcome) {
        row = await deps.ledger.update(id, (r) => (unfinished(r) ? { ...r, childOutcome: outcome } : r));
        if (!row || disposed || signal.aborted) return;
      }
    }
    if (unfinished(row) && deps.now() >= row.deadline) {
      await expire(id);
      row = await deps.ledger.get(id);
      if (!row) return;
    }
    for (const effect of row.effects) {
      if (signal.aborted || disposed) return;
      if (effect.acknowledgedAt !== undefined) continue;
      if (effect.kind === "target") {
        if (!unfinished(row)) {
          await ack(id, effect.id);
          continue;
        }
        if (!(await exists(effect.botId, id))) {
          if (!disposed && !signal.aborted) await quiet(id, "failed");
          return;
        }
        let submission =
          row.submissionId ?? (await deps.sessions.submissionForRequest(effect.botId, effect.requestId!));
        if (!submission) {
          const state = await deps.sessions.state(effect.botId);
          if (disposed || signal.aborted) return;
          if (state.kind !== "idle" && state.kind !== "running") {
            await quiet(id, "failed");
            return;
          }
          if (deps.now() >= row.deadline) return expire(id);
          if (state.kind === "running") return observeBusy(id, effect.botId, signal);
          try {
            if (!(await exists(effect.botId, id))) return;
            submission = (
              await deps.sessions.send(effect.botId, {
                requestId: effect.requestId!,
                text: botMessageInputText({
                  fromName: row.fromName,
                  hop: row.hop,
                  message: row.message,
                }),
                ifIdle: true,
                ifNotInterrupted: true,
                botMessage: {
                  kind: "request",
                  deliveryId: id,
                  botId: row.fromBotId,
                  botName: row.fromName,
                  text: row.message,
                  deadline: row.deadline,
                },
              })
            ).submissionId;
          } catch (e) {
            if (disposed || signal.aborted) return;
            if (reason(e) === "bot_busy") return observeBusy(id, effect.botId, signal);
            await quiet(id, "failed");
            return;
          }
        }
        if (disposed || signal.aborted) return;
        await deps.ledger.update(id, (r) => ({
          ...r,
          submissionId: submission,
          effects: r.effects.map((e) =>
            e.id === effect.id ? { ...e, submissionId: submission, acknowledgedAt: deps.now() } : e,
          ),
        }));
      } else if (effect.kind === "reply") {
        await reply(row, effect, signal);
        return;
      } else {
        if (!(await exists(effect.botId, id))) {
          if (!disposed) await ack(id, effect.id);
          continue;
        }
        await publish(row, effect);
      }
    }
    row = await deps.ledger.get(id);
    if (!row || !unfinished(row) || signal.aborted) return;
    if (row.initialAnswer !== undefined) {
      if (row.childOutcome) return quiet(id, row.childOutcome);
      if (row.parentDeliveryId) {
        const parent = await deps.ledger.get(row.parentDeliveryId);
        if (!parent || !unfinished(parent)) {
          queue(id);
          return;
        }
        if (parent.initialAnswer === undefined) return;
        const replyEffect = row.effects.find((e) => e.kind === "reply");
        if (replyEffect?.acknowledgedAt !== undefined) return quiet(row.parentDeliveryId, "failed");
        if (!replyEffect)
          await deps.ledger.update(id, (r) => ({
            ...r,
            effects: [
              ...r.effects,
              {
                id: `${id}:reply`,
                kind: "reply",
                botId: r.fromBotId,
                requestId: botReplyRequestId(id),
                text: r.initialAnswer,
              },
            ],
          }));
        queue(id);
      }
      return;
    }
    if (!row.submissionId) return;
    const result = await wait(row.toBotId, row.submissionId, signal);
    if (!result) return;
    if (result.kind === "completed") {
      if (silent(result.text)) await deps.sessions.markSilent(row.toBotId, row.submissionId);
      await answer(id, result.text);
    } else if (result.kind === "failed" || result.settled) await quiet(id, "failed");
  }
  function reason(e: unknown): string {
    return (
      (
        e as {
          reason?: string;
        }
      )?.reason ?? ((e as { name?: string })?.name === "ConversationBusy" ? "bot_busy" : "")
    );
  }
  async function wake(botId?: string) {
    for (const row of await deps.ledger.open())
      if (!botId || row.fromBotId === botId || row.toBotId === botId) queue(row.id);
  }
  const courier: BotMessageCourier = {
    async post(input) {
      const refuse = (
        code: BotMessageRefusal,
        message: string,
        extra: Partial<
          Extract<
            BotMessagePostResult,
            {
              status: "refused";
            }
          >
        > = {},
      ): BotMessagePostResult => ({
        status: "refused",
        code,
        message,
        ...extra,
      });
      try {
        if (disposed || deleted.has(input.fromBotId)) return refuse("unavailable", "Bot messaging is unavailable.");
        const chain = botMessageChainOf(input.runRequestIds);
        if (!chain.canSend) return refuse("chain_too_deep", "Messaging other Bots is off for this turn.");
        const message = typeof input.message === "string" ? input.message.trim() : "";
        if (
          !message ||
          message.length > L.messageChars ||
          botMessageTurnOf(botReplyRequestId(input.deliveryId)).kind !== "reply"
        )
          return refuse("invalid_message", "Write a message of up to 4,000 characters.");
        const receipt = await deps.ledger.receipt(input.deliveryId);
        if (receipt) {
          if (
            receipt.fromBotId !== input.fromBotId ||
            receipt.inputHash !==
              botMessageReplayHash({
                ...input,
                message,
                hop: chain.hop,
                parentDeliveryId: chain.parentDeliveryId,
              }) ||
            receipt.taskId !== input.taskId ||
            deleted.has(receipt.toBotId)
          )
            return refuse("unavailable", "This replay does not match the accepted message.");
          queue(receipt.id);
          return {
            status: "sent",
            deliveryId: receipt.id,
            to: { id: receipt.toBotId, name: receipt.toName },
          };
        }
        const roster = await deps.roster(),
          sender = roster.find((b) => b.id === input.fromBotId);
        const target = input.target.trim();
        const exact = roster.find((b) => b.id === target);
        const matches = exact ? [exact] : roster.filter((b) => b.name.toLowerCase() === target.toLowerCase());
        if (matches.length !== 1)
          return refuse(
            matches.length ? "ambiguous_bot" : "unknown_bot",
            matches.length ? "More than one Bot has that name. Use its id." : "That Bot is not available.",
            { bots: roster.map((b) => b.name) },
          );
        const to = matches[0]!;
        if (!sender) return refuse("unavailable", "The sending Bot no longer exists.");
        if (to.id === sender.id) return refuse("self", "Choose another Bot.");
        if (chain.chain.includes(to.id)) return refuse("in_chain", "That Bot is already in this exchange.");
        if (!(await deps.enabled()) || !sender.sendsMessages || !to.acceptsMessages)
          return refuse("switched_off", "Messaging is turned off for these Bots.");
        if (sender.unavailable || to.unavailable)
          return refuse(sender.unavailable ?? to.unavailable!, "This Bot is not available for messaging.");
        const parent = chain.parentDeliveryId ? await deps.ledger.get(chain.parentDeliveryId) : undefined;
        if (
          chain.parentDeliveryId &&
          (!parent ||
            parent.toBotId !== sender.id ||
            parent.fromBotId !== chain.chain[0] ||
            parent.deadline <= deps.now())
        )
          return refuse("unavailable", "The parent message is no longer available.");
        if (input.signal?.aborted || disposed)
          return refuse("unavailable", "The message was canceled before acceptance.");
        const id = input.deliveryId,
          now = deps.now(),
          requestId = botMessageRequestId(sender.id, chain.hop, id);
        const result = await deps.ledger.reserve({
          id,
          fromBotId: sender.id,
          toBotId: to.id,
          replayTarget: input.target.trim(),
          ...(input.taskId ? { taskId: input.taskId } : {}),
          fromName: sender.name,
          toName: to.name,
          hop: chain.hop,
          ...(chain.parentDeliveryId ? { parentDeliveryId: chain.parentDeliveryId } : {}),
          targetRequestId: requestId,
          createdAt: now,
          deadline: Math.min(now + L.windowMs, parent?.deadline ?? Infinity),
          status: "delivered",
          message,
          waiting: [],
          effects: [
            {
              id: `${id}:target`,
              kind: "target",
              botId: to.id,
              requestId,
              text: message,
            },
          ],
        });
        if ("refused" in result)
          return refuse("limit_reached", "This Bot has reached its messaging limit.", {
            retryAfter: result.refused.retryAfter,
          });
        queue(id);
        return {
          status: "sent",
          deliveryId: id,
          to: { id: to.id, name: to.name },
        };
      } catch (e) {
        report(e);
        return refuse("unavailable", e instanceof Error ? e.message : "Bot messaging is unavailable.");
      }
    },
    async start() {
      if (disposed) return;
      if (!started) {
        started = true;
        removeState = deps.onStateChange((id) => {
          track(wake(id));
        });
        removeApprovals = deps.approvals.onChange((botId) => {
          const task = (approvalUpdates.get(botId) ?? Promise.resolve())
            .catch(() => undefined)
            .then(async () => {
              if (disposed) return;
              for (const row of await deps.ledger.open()) {
                if (row.fromBotId !== botId && row.toBotId !== botId) continue;
                const saved = await deps.ledger.update(row.id, (r) => {
                  const active = new Set(
                    deps.approvals
                      .pending()
                      .filter((p) => p.owner?.inputs.some((i) => i.botMessage?.deliveryId === row.id))
                      .map((p) => p.waitId),
                  );
                  return {
                    ...r,
                    waiting: r.waiting.filter((w) => active.has(w.waitId)),
                  };
                });
                if (saved) arm(saved);
              }
              for (const prompt of deps.approvals.pending(botId)) {
                if (!deps.approvals.pending(botId).some((p) => p.waitId === prompt.waitId)) continue;
                const ids = prompt.owner?.inputs.map((i) => i.requestId) ?? [];
                if (!ids.length) continue;
                try {
                  await courier.announceWaiting(botId, ids, prompt.summary, prompt.waitId);
                } catch (error) {
                  deps.approvals.decide(prompt.waitId, "deny", undefined, "expiry");
                  report(error);
                }
              }
            });
          approvalUpdates.set(botId, task);
          track(
            task.finally(() => {
              if (approvalUpdates.get(botId) === task) approvalUpdates.delete(botId);
            }),
          );
        });
      }
      await collectReceipts();
      await wake();
    },
    async announceWaiting(botId, ids, summary, waitId) {
      const claimed = ids.map(botMessageTurnOf).filter(
        (
          t,
        ): t is Extract<
          ReturnType<typeof botMessageTurnOf>,
          {
            kind: "message" | "reply";
          }
        > => t.kind === "message" || t.kind === "reply",
      );
      if (!claimed.length) {
        if (ids.some(isBotMessageRequestId)) throw new Error("Authoritative Bot message delivery is unavailable.");
        return undefined;
      }
      let deadline = Infinity,
        expired = false;
      for (const turn of claimed) {
        const row = await deps.ledger.get(turn.deliveryId);
        if (!row || (turn.kind === "message" ? row.toBotId : row.fromBotId) !== botId)
          throw new Error("Authoritative Bot message delivery is unavailable.");
        deadline = Math.min(deadline, row.deadline);
        if (deps.now() >= row.deadline || (row.status !== "delivered" && turn.kind === "message")) {
          expired = true;
          deps.approvals.decide(waitId, "deny", undefined, "expiry");
          continue;
        }
        await deps.ledger.update(row.id, (r) =>
          r.waiting.some((w) => w.waitId === waitId)
            ? r
            : {
                ...r,
                waiting: [...r.waiting, { waitId, summary: summary.slice(0, 160), at: deps.now() }],
                effects: [
                  ...r.effects,
                  ...notice(r, "waiting_approval", undefined, waitId, summary.slice(0, 160), botId).filter(
                    (e) => !r.effects.some((saved) => saved.id === e.id),
                  ),
                ],
              },
        );
        publishWaiting(row.id);
        const saved = await deps.ledger.get(row.id);
        if (saved) arm(saved);
        queue(row.id);
      }
      return { deadline, expired: expired || deadline <= deps.now() };
    },
    async forgetBot(botId) {
      deleted.add(botId);
      // Deny before cancellation removes the pending prompt and its ownership.
      for (const prompt of deps.approvals.pending()) {
        if (
          prompt.botId === botId ||
          prompt.owner?.inputs.some((i) => i.botMessage?.botId === botId || deleted.has(i.botMessage?.botId ?? ""))
        )
          deps.approvals.decide(prompt.waitId, "deny", undefined, "expiry");
      }
      const removed = await deps.ledger.forgetBot(botId);
      const removedIds = new Set(removed.map((r) => r.id));
      for (const prompt of deps.approvals.pending()) {
        if (prompt.owner?.inputs.some((i) => removedIds.has(i.botMessage?.deliveryId ?? "")))
          deps.approvals.decide(prompt.waitId, "deny", undefined, "expiry");
      }
      // Abort all observation only if bookkeeping is unavailable; never stop a session.
      let live: BotMessageDelivery[];
      try {
        live = await deps.ledger.open();
      } catch (error) {
        report(error);
        for (const worker of workers.values()) worker.controller.abort();
        for (const timer of timers.values()) timer.cancel();
        timers.clear();
        return;
      }
      for (const row of removed) {
        workers.get(row.id)?.controller.abort();
        timers.get(row.id)?.cancel();
        timers.delete(row.id);
        scheduled.get(row.id)?.cancel();
        scheduled.delete(row.id);
        receiptWatches.get(row.id)?.controller.abort();
      }
      for (const row of live) queue(row.id);
    },
    async dispose() {
      disposed = true;
      removeState?.();
      removeApprovals?.();
      for (const timer of [...timers.values(), ...scheduled.values()]) timer.cancel();
      for (const worker of workers.values()) worker.controller.abort();
      for (const watch of receiptWatches.values()) watch.controller.abort();
      for (const shared of waits.values()) shared.controller.abort();
      await Promise.allSettled([...receiptWatches.values()].map((w) => w.promise));
      await Promise.allSettled([...waits.values()].map((w) => w.promise));
      await Promise.allSettled([...workers.values()].map((w) => w.promise));
      await Promise.allSettled([...publications.values(), ...background, ...posts]);
      for (const timer of [...timers.values(), ...scheduled.values()]) timer.cancel();
      timers.clear();
      scheduled.clear();
    },
  };
  const post = courier.post;
  courier.post = (input) => {
    const task = post(input);
    posts.add(task);
    void task.finally(() => posts.delete(task)).catch(() => undefined);
    return task;
  };
  return courier;
}
