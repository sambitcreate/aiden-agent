import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { BOT_PLAN_ENDED_SHOWN_MS, BOT_PLAN_MAX_MS, botPlanItemView, type BotPlanDecision, type BotPlanStatus, type BotPlanStepStatus, type BotPlanView } from "../../../renderer/shared/bot-plans.js";
import { writeJsonAtomic } from "../durable-fs.js";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { botPlanCoveredItems, type BotPlanCoverCheck } from "./coverage.js";
import { botPlanProposalFingerprint, type BotPlanProposal } from "./validate.js";
import { isBotPlanProposal, parseBotPlanFile, type BotPlanFile } from "./store.js";

export interface BotPlanRecord {
  planId: string; botId: string; toolCallId: string; proposal: BotPlanProposal;
  requestIds: string[]; status: Exclude<BotPlanStatus, "pending">;
  steps: BotPlanStepStatus[]; from?: string;
  approvedAt: number; expiresAt: number; endedAt?: number; revision: number;
  counted: Record<string, { operationFingerprint: string; itemIds: string[]; admittedAt?: number }>;
}
/** No display/private proposal data. Until a host task-settlement port exists these are never pruned. */
export interface BotPlanReceipt {
  planId: string; identityFingerprint: string; status: "finished" | "stopped" | "expired";
  expiresAt: number; endedAt: number; executionFingerprints: string[];
}
export interface BotPlanRequest {
  botId: string; planId: string; toolCallId: string; proposal: BotPlanProposal;
  requestIds: readonly string[]; from?: string; signal: AbortSignal | undefined;
}
export type BotPlanStepOutcome = "marked" | "finished" | "no_plan" | "no_step";
export interface BotPlanPermit { planId: string; botId: string; executionId: string; operationFingerprint: string }
type RequestResult = { status: "approved"; fresh: boolean; expiresAt: number } | { status: "declined" | "ended" };
export interface BotPlans {
  request(request: BotPlanRequest): Promise<RequestResult>;
  grantFreshAccess(botId: string, planId: string, apply: () => Promise<void>): Promise<boolean>;
  respond(botId: string, planId: string, decision: BotPlanDecision): Promise<"done" | "not_waiting">;
  cover(botId: string, check: BotPlanCoverCheck): Promise<BotPlanPermit | undefined>;
  admit<T>(permit: BotPlanPermit, start: () => Promise<T>): Promise<{ admitted: false } | { admitted: true; started: Promise<T> }>;
  markStep(botId: string, requestIds: readonly (string | undefined)[], step: number, status: "done" | "skipped"): Promise<BotPlanStepOutcome>;
  endRuns(botId: string, reason: "stopped" | "finished"): Promise<void>;
  current(botId: string): Promise<BotPlanView | null>;
  onChange(listener: (botId: string) => void): () => void;
  forgetBot(botId: string): Promise<void>;
}
export interface BotPlansOptions {
  profileDir: string; knownBot(botId: string): Promise<boolean>; now?(): number;
  revalidate(botId: string, proposal: BotPlanProposal): Promise<void>;
  revokeAccess(botId: string, planId: string): void;
}
interface Waiter { original: boolean; resolve(result: RequestResult): void; reject(error: unknown): void; cleanup(): void }
interface Waiting { request: BotPlanRequest; identity: string; waiters: Set<Waiter> }
class OwnerEnded extends Error {}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const boundedIdentity = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);
const keyOf = (botId: string, planId: string) => JSON.stringify([botId, planId]);
const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const identity = (r: Pick<BotPlanRequest, "botId" | "planId" | "toolCallId" | "proposal" | "requestIds" | "from">) => digest(JSON.stringify([
  r.botId, r.planId, r.toolCallId, botPlanProposalFingerprint(r.proposal), [...r.requestIds].sort(), r.from ?? null,
]));
function usage(plan: BotPlanRecord, except?: string): Map<string, number> {
  const used = new Map<string, number>();
  for (const [executionId, entry] of Object.entries(plan.counted)) {
    if (executionId === except) continue;
    for (const id of entry.itemIds) used.set(id, (used.get(id) ?? 0) + 1);
  }
  return used;
}
function view(record: BotPlanRecord): BotPlanView {
  const used = usage(record);
  return { planId: record.planId, botId: record.botId, status: record.status, title: record.proposal.title, why: record.proposal.why,
    steps: record.proposal.steps.map((text, i) => ({ text, status: record.steps[i]! })),
    items: record.proposal.items.map((i) => botPlanItemView(i, used.get(i.id) ?? 0)),
    expiresAt: record.expiresAt, revision: record.revision, ...(record.from === undefined ? {} : { from: record.from }) };
}

export function createBotPlans(options: BotPlansOptions): BotPlans {
  const now = options.now ?? Date.now, serial = createKeyedSerial();
  const deleted = new Set<string>(), unreadable = new Set<string>();
  const hadStore = new Set<string>();
  const waiting = new Map<string, Waiting>(); // one visible card per Bot
  const fresh = new Map<string, AbortSignal | undefined>();
  const listeners = new Set<(botId: string) => void>();
  const issued = new WeakSet<BotPlanPermit>();
  const started = new Map<string, Promise<unknown>>();
  const terminal = new Map<string, Map<string, BotPlanRecord>>(); // fail closed even when persisting termination fails
  const observed = new Map<string, Map<string, BotPlanRecord>>();
  const timers = new Map<string, { planId: string; deadline: number; handle: ReturnType<typeof setTimeout> }>();
  const terminating = new Map<string, number>();
  function transition<T>(botId: string, endsAuthority: boolean, action: () => Promise<T>): Promise<T> {
    if (!endsAuthority) return serial(botId, action);
    // Person/run termination requested while admission awaits I/O wins before
    // actual invocation. The mutation/revoke itself still owns the plan serial.
    terminating.set(botId, (terminating.get(botId) ?? 0) + 1);
    return serial(botId, action).finally(() => {
      const remaining = (terminating.get(botId) ?? 1) - 1;
      if (remaining) terminating.set(botId, remaining); else terminating.delete(botId);
    });
  }
  const fileOf = (botId: string) => path.join(botSessionDirectory(options.profileDir, botId), "plans.json");
  const emit = (botId: string) => { for (const listener of listeners) { try { listener(botId); } catch { /* Observers never own transitions. */ } } };
  const available = async (botId: string) => !deleted.has(botId) && await options.knownBot(botId) && !deleted.has(botId);
  function clearTimer(botId: string) { const timer = timers.get(botId); if (timer) clearTimeout(timer.handle); timers.delete(botId); }
  function settle(wait: Waiting, result: RequestResult | unknown, error = false) {
    if (waiting.get(wait.request.botId) === wait) waiting.delete(wait.request.botId);
    for (const waiter of wait.waiters) {
      waiter.cleanup();
      if (error) waiter.reject(result);
      else {
        const value = result as RequestResult;
        waiter.resolve(value.status === "approved" ? { ...value, fresh: waiter.original && value.fresh } : value);
      }
    }
    wait.waiters.clear();
  }
  function rememberEnd(record: BotPlanRecord, reason: "finished" | "stopped" | "expired") {
    const botTerminal = terminal.get(record.botId) ?? new Map<string, BotPlanRecord>();
    if (!botTerminal.has(record.planId)) {
      // Revoke synchronously before permission can be acknowledged as ended.
      options.revokeAccess(record.botId, record.planId);
      record.status = reason;
      record.endedAt = reason === "expired" ? record.expiresAt : now();
      record.revision++;
      botTerminal.set(record.planId, structuredClone(record));
      terminal.set(record.botId, botTerminal);
    } else Object.assign(record, structuredClone(botTerminal.get(record.planId)!));
    fresh.delete(keyOf(record.botId, record.planId));
    for (const executionId of Object.keys(record.counted)) started.delete(keyOf(record.botId, JSON.stringify([record.planId, executionId])));
    if (timers.get(record.botId)?.planId === record.planId) clearTimer(record.botId);
  }
  function receiptOf(record: BotPlanRecord): BotPlanReceipt {
    if (record.status === "active" || record.endedAt === undefined) throw new Error("An active plan has no ended receipt.");
    return { planId: record.planId, identityFingerprint: identity(record), status: record.status, expiresAt: record.expiresAt, endedAt: record.endedAt,
      executionFingerprints: Object.keys(record.counted).map(digest).sort() };
  }
  function compact(file: BotPlanFile) {
    for (const record of file.plans) {
      if (record.status === "active") continue;
      const receipt = receiptOf(record), old = file.receipts.find((r) => r.planId === record.planId);
      if (old && JSON.stringify(old) !== JSON.stringify(receipt)) throw new Error("A plan's ended receipt changed.");
      if (!old) file.receipts.push(receipt);
    }
    file.plans = file.plans.filter((p) => p.status === "active" || now() - p.endedAt! < 24 * 60 * 60_000)
      .sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || b.approvedAt - a.approvedAt).slice(0, 20);
  }
  async function save(botId: string, file: BotPlanFile, beforePublish?: () => Promise<void>, finalFence?: () => void) {
    compact(file);
    await writeJsonAtomic(fileOf(botId), file, { mode: 0o600, mkdirMode: 0o700, beforePublish: async () => {
      if (!await available(botId)) throw new OwnerEnded("This Bot no longer exists.");
      await beforePublish?.();
      if (!await available(botId)) throw new OwnerEnded("This Bot no longer exists.");
      finalFence?.();
    } });
    hadStore.add(botId);
    observed.set(botId, new Map(file.plans.map((p) => [p.planId, structuredClone(p)])));
    // A durable compact receipt now owns replay protection. Full private
    // fail-closed overlays are needed only while termination cannot be saved.
    const overlay = terminal.get(botId);
    for (const receipt of file.receipts) overlay?.delete(receipt.planId);
    if (!overlay?.size) terminal.delete(botId);
  }
  function schedule(botId: string, record: BotPlanRecord | undefined) {
    if (!record || record.status !== "active") { clearTimer(botId); return; }
    const current = timers.get(botId);
    if (current?.planId === record.planId && current.deadline === record.expiresAt) return;
    clearTimer(botId);
    const handle = setTimeout(() => {
      timers.delete(botId);
      // One timer per active plan, no polling. All effect admission shares this serial.
      void serial(botId, async () => { await load(botId); }).catch(() => undefined);
    }, Math.max(0, record.expiresAt - now()));
    handle.unref();
    timers.set(botId, { planId: record.planId, deadline: record.expiresAt, handle });
  }
  function invalidate(botId: string) {
    clearTimer(botId);
    for (const record of observed.get(botId)?.values() ?? []) if (record.status === "active") rememberEnd(record, "stopped");
    const wait = waiting.get(botId); if (wait) settle(wait, { status: "ended" });
  }
  async function load(botId: string): Promise<BotPlanFile | undefined> {
    if (!await available(botId)) { invalidate(botId); return undefined; }
    if (unreadable.has(botId)) return undefined;
    let file: BotPlanFile;
    try {
      const parsed = parseBotPlanFile(JSON.parse(await fs.readFile(fileOf(botId), "utf8")), botId);
      if (!parsed) throw new Error("Invalid plan store.");
      file = parsed;
      hadStore.add(botId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !hadStore.has(botId)) file = { version: 1, plans: [], receipts: [] };
      else { unreadable.add(botId); invalidate(botId); return undefined; }
    }
    let dirty = false, changed = false;
    for (const record of file.plans) {
      const ended = terminal.get(botId)?.get(record.planId);
      if (ended && record.status === "active") { Object.assign(record, structuredClone(ended)); dirty = true; }
      if (record.status === "active" && (now() >= record.expiresAt || now() < record.approvedAt)) {
        rememberEnd(record, "expired"); dirty = true; changed = true;
      }
    }
    const before = JSON.stringify(file); compact(file);
    dirty ||= before !== JSON.stringify(file);
    observed.set(botId, new Map(file.plans.map((p) => [p.planId, structuredClone(p)])));
    schedule(botId, file.plans.find((p) => p.status === "active"));
    // Revocation above never depends on the history write succeeding.
    if (dirty) await save(botId, file).catch(() => undefined);
    if (changed) emit(botId);
    return file;
  }
  function addWaiter(wait: Waiting, original: boolean, signal?: AbortSignal): Promise<RequestResult> {
    const result = new Promise<RequestResult>((resolve, reject) => {
      const abort = () => {
        void serial(wait.request.botId, async () => {
          if (!wait.waiters.has(waiter)) return;
          if (original) { settle(wait, { status: "ended" }); emit(wait.request.botId); }
          else { wait.waiters.delete(waiter); waiter.cleanup(); resolve({ status: "ended" }); }
        }).catch(reject);
      };
      const waiter: Waiter = { original, resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) };
      wait.waiters.add(waiter); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    void result.catch(() => undefined);
    return result;
  }
  const active = (file: BotPlanFile, requestIds?: readonly (string | undefined)[]) => file.plans.find((p) => p.status === "active" && (!requestIds || p.requestIds.some((id) => requestIds.includes(id))));
  const permitFor = (plan: BotPlanRecord, check: BotPlanCoverCheck): BotPlanPermit => {
    const permit = Object.freeze({ botId: plan.botId, planId: plan.planId, executionId: check.executionId, operationFingerprint: check.operationFingerprint });
    issued.add(permit); return permit;
  };

  return {
    async request(input) {
      const copy: BotPlanRequest = { ...input, proposal: structuredClone(input.proposal), requestIds: [...input.requestIds] };
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(copy.botId) || !/^[A-Za-z0-9-]{1,64}$/u.test(copy.planId) ||
          !copy.toolCallId || copy.toolCallId.length > 256 || !copy.requestIds.length || copy.requestIds.length > 256 || copy.requestIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 256) || new Set(copy.requestIds).size !== copy.requestIds.length || !isBotPlanProposal(copy.proposal) || (copy.from !== undefined && (!copy.from.trim() || [...copy.from].length > 120))) throw new Error("Invalid plan request or proposal identity.");
      const result = await serial(copy.botId, async (): Promise<{ result: RequestResult } | { pending: Promise<RequestResult> }> => {
        const file = await load(copy.botId);
        if (unreadable.has(copy.botId)) throw new Error("The plan store is unreadable or invalid.");
        if (!file || copy.signal?.aborted) return { result: { status: "ended" } };
        const saved = file.plans.find((p) => p.planId === copy.planId), receipt = file.receipts.find((r) => r.planId === copy.planId);
        const fingerprint = identity(copy);
        if (saved || receipt) {
          if ((saved ? identity(saved) : receipt!.identityFingerprint) !== fingerprint) throw new Error("The plan replay identity changed.");
          return { result: saved?.status === "active" ? { status: "approved", fresh: false, expiresAt: saved.expiresAt } : { status: "ended" } };
        }
        const previous = waiting.get(copy.botId);
        if (previous?.request.planId === copy.planId) {
          if (previous.identity !== fingerprint) throw new Error("The waiting plan replay identity changed.");
          return { pending: addWaiter(previous, false, copy.signal) };
        }
        if (previous) settle(previous, { status: "ended" });
        const wait: Waiting = { request: copy, identity: fingerprint, waiters: new Set() };
        waiting.set(copy.botId, wait);
        const pending = addWaiter(wait, true, copy.signal); emit(copy.botId);
        return { pending };
      });
      return "result" in result ? result.result : result.pending;
    },
    grantFreshAccess(botId, planId, apply) {
      return serial(botId, async () => {
        const file = await load(botId), plan = file?.plans.find((p) => p.planId === planId && p.status === "active");
        const key = keyOf(botId, planId);
        if (!plan || !fresh.has(key)) return false;
        const signal = fresh.get(key); fresh.delete(key);
        if (signal?.aborted) return false;
        try {
          await apply();
          if (!await available(botId) || signal?.aborted || now() >= plan.expiresAt || now() < plan.approvedAt) {
            rememberEnd(plan, now() >= plan.expiresAt ? "expired" : "stopped");
            if (file && !deleted.has(botId)) await save(botId, file);
            emit(botId); return false;
          }
          return true;
        } catch (error) {
          rememberEnd(plan, "stopped");
          if (file && !deleted.has(botId)) await save(botId, file).catch(() => undefined);
          emit(botId); throw error;
        }
      });
    },
    respond(botId, planId, decision) {
      return transition(botId, decision === "stop" || decision === "approve", async () => {
        const file = await load(botId); if (!file) return "not_waiting";
        if (decision === "stop") {
          const plan = file.plans.find((p) => p.planId === planId && p.status === "active");
          if (!plan) return "not_waiting";
          rememberEnd(plan, "stopped"); await save(botId, file); emit(botId); return "done";
        }
        const wait = waiting.get(botId);
        if (!wait || wait.request.planId !== planId) return "not_waiting";
        if (decision === "not_now") { settle(wait, { status: "declined" }); emit(botId); return "done"; }
        if (decision !== "approve") return "not_waiting";
        if (wait.request.signal?.aborted) { settle(wait, { status: "ended" }); emit(botId); return "not_waiting"; }
        const approvedAt = now();
        const record: BotPlanRecord = { planId, botId, toolCallId: wait.request.toolCallId, proposal: structuredClone(wait.request.proposal), requestIds: [...wait.request.requestIds], status: "active", steps: wait.request.proposal.steps.map(() => "pending"), approvedAt, expiresAt: approvedAt + BOT_PLAN_MAX_MS, revision: 2, counted: {}, ...(wait.request.from === undefined ? {} : { from: wait.request.from }) };
        const previous = file.plans.filter((p) => p.status === "active");
        try {
          // Stage first, then validate the exact captured snapshot at publication.
          // No Bot-session operation or external effect is called under this serial.
          const next: BotPlanFile = { version: 1, plans: [record, ...file.plans.map((p) => p.status === "active" ? { ...p, status: "finished" as const, endedAt: approvedAt, revision: p.revision + 1 } : p)], receipts: [...file.receipts] };
          const fence = () => {
            if (wait.request.signal?.aborted || deleted.has(botId) || now() >= record.expiresAt || now() < record.approvedAt) throw new OwnerEnded("The plan owner ended.");
          };
          await save(botId, next, async () => {
            await options.revalidate(botId, structuredClone(wait.request.proposal));
            fence();
            for (const old of previous) rememberEnd(old, "finished");
          }, fence);
          observed.set(botId, new Map(next.plans.map((p) => [p.planId, structuredClone(p)])));
          if (!await available(botId) || wait.request.signal?.aborted || now() >= record.expiresAt || now() < record.approvedAt) {
            rememberEnd(record, now() >= record.expiresAt ? "expired" : "stopped");
            if (!deleted.has(botId)) await save(botId, next).catch(() => undefined);
            settle(wait, { status: "ended" }); emit(botId); return "not_waiting";
          }
          fresh.set(keyOf(botId, planId), wait.request.signal);
          schedule(botId, record);
          settle(wait, { status: "approved", fresh: true, expiresAt: record.expiresAt }); emit(botId);
          return "done";
        } catch (error) {
          settle(wait, error instanceof OwnerEnded ? { status: "ended" } : error, !(error instanceof OwnerEnded)); emit(botId);
          if (error instanceof OwnerEnded) return "not_waiting";
          throw error;
        }
      });
    },
    cover(botId, input) {
      const check = structuredClone(input);
      return serial(botId, async () => {
        const file = await load(botId); if (!file) return undefined;
        if (!boundedIdentity(check.executionId, 256) || !boundedIdentity(check.operationFingerprint, 512)) return undefined;
        const plan = active(file); if (!plan) return undefined;
        try { await options.revalidate(botId, structuredClone(plan.proposal)); } catch { return undefined; }
        if (terminating.has(botId)) return undefined;
        if (deleted.has(botId) || now() >= plan.expiresAt || now() < plan.approvedAt) {
          rememberEnd(plan, now() >= plan.expiresAt ? "expired" : "stopped");
          if (!deleted.has(botId)) await save(botId, file);
          emit(botId); return undefined;
        }
        if (file.receipts.some((r) => r.executionFingerprints.includes(digest(check.executionId))) || file.plans.some((p) => p.planId !== plan.planId && has(p.counted, check.executionId))) return undefined;
        const existing = has(plan.counted, check.executionId) ? plan.counted[check.executionId] : undefined;
        if (existing && existing.operationFingerprint !== check.operationFingerprint) return undefined;
        const ids = botPlanCoveredItems(plan, usage(plan, existing ? check.executionId : undefined), check, now());
        if (!ids || (existing && JSON.stringify([...existing.itemIds].sort()) !== JSON.stringify([...ids].sort()))) return undefined;
        if (existing) return permitFor(plan, check);
        plan.counted = { ...plan.counted, [check.executionId]: { operationFingerprint: check.operationFingerprint, itemIds: ids } };
        plan.revision++;
        await save(botId, file);
        emit(botId); return permitFor(plan, check);
      });
    },
    admit<T>(permit: BotPlanPermit, start: () => Promise<T>) {
      return serial(permit.botId, async (): Promise<{ admitted: false } | { admitted: true; started: Promise<T> }> => {
        if (!issued.has(permit)) return { admitted: false };
        const file = await load(permit.botId), plan = file?.plans.find((p) => p.planId === permit.planId && p.status === "active");
        if (!plan || !has(plan.counted, permit.executionId)) return { admitted: false };
        const reservation = plan.counted[permit.executionId]!;
        if (reservation.operationFingerprint !== permit.operationFingerprint) return { admitted: false };
        const key = keyOf(permit.botId, JSON.stringify([permit.planId, permit.executionId]));
        if (reservation.admittedAt !== undefined) {
          try { await options.revalidate(permit.botId, structuredClone(plan.proposal)); } catch { return { admitted: false }; }
          if (terminating.has(permit.botId) || deleted.has(permit.botId) || now() >= plan.expiresAt || now() < plan.approvedAt) return { admitted: false };
          const live = started.get(key);
          // A restart cannot infer whether the previous callback caused an external effect.
          return live ? { admitted: true, started: live as Promise<T> } : { admitted: false };
        }
        const live = () => !deleted.has(permit.botId) && now() >= plan.approvedAt && now() < plan.expiresAt;
        try { await options.revalidate(permit.botId, structuredClone(plan.proposal)); } catch { return { admitted: false }; }
        if (terminating.has(permit.botId)) return { admitted: false };
        if (!live()) {
          rememberEnd(plan, now() >= plan.expiresAt ? "expired" : "stopped");
          if (!deleted.has(permit.botId)) await save(permit.botId, file!);
          emit(permit.botId); return { admitted: false };
        }
        reservation.admittedAt = now();
        try {
          await save(permit.botId, file!, undefined, () => {
            if (terminating.has(permit.botId) || !live()) throw new OwnerEnded("The plan ended before admission publication.");
          });
        } catch (error) {
          if (!(error instanceof OwnerEnded)) throw error;
          if (terminating.has(permit.botId)) return { admitted: false };
          rememberEnd(plan, now() >= plan.expiresAt ? "expired" : "stopped");
          if (!deleted.has(permit.botId)) await save(permit.botId, file!).catch(() => undefined);
          emit(permit.botId); return { admitted: false };
        }
        // Disk publication/fsync can cross a deadline or authorization change.
        // This is the final await before the synchronous invocation boundary.
        try { await options.revalidate(permit.botId, structuredClone(plan.proposal)); } catch { return { admitted: false }; }
        if (terminating.has(permit.botId)) return { admitted: false };
        if (!live()) {
          rememberEnd(plan, now() >= plan.expiresAt ? "expired" : "stopped");
          if (!deleted.has(permit.botId)) await save(permit.botId, file!);
          emit(permit.botId); return { admitted: false };
        }
        // Invocation, not completion, is the boundary serialized against Stop.
        let effect: Promise<T>;
        try { effect = Promise.resolve(start()); } catch (error) { effect = Promise.reject(error); }
        void effect.catch(() => undefined);
        started.set(key, effect);
        return { admitted: true, started: effect };
      });
    },
    markStep(botId, requestIds, step, status) {
      // A queued final mark may finish the plan. Conservatively fence all
      // queued marks rather than infer completion from a stale snapshot.
      return transition(botId, true, async () => {
        const file = await load(botId), plan = file && active(file, requestIds);
        if (!plan) return "no_plan";
        if (!Number.isInteger(step) || step < 1 || step > plan.steps.length || (status !== "done" && status !== "skipped")) return "no_step";
        if (plan.steps[step - 1] !== "pending") return "marked";
        plan.steps[step - 1] = status; plan.revision++;
        const finished = plan.steps.every((s) => s !== "pending");
        if (finished) rememberEnd(plan, "finished");
        await save(botId, file!); emit(botId); return finished ? "finished" : "marked";
      });
    },
    endRuns(botId, reason) {
      return transition(botId, true, async () => {
        const file = await load(botId), plans = file?.plans.filter((p) => p.status === "active") ?? [];
        const wait = waiting.get(botId); if (wait) settle(wait, { status: "ended" });
        for (const plan of plans) rememberEnd(plan, reason);
        if (plans.length) await save(botId, file!);
        if (plans.length || wait) emit(botId);
      });
    },
    current(botId) {
      return serial(botId, async () => {
        const file = await load(botId); if (!file) return null;
        const wait = waiting.get(botId);
        if (wait) {
          const r = wait.request;
          return { planId: r.planId, botId, status: "pending", title: r.proposal.title, why: r.proposal.why,
            steps: r.proposal.steps.map((text) => ({ text, status: "pending" as const })), items: r.proposal.items.map((item) => botPlanItemView(item, 0)), revision: 1, ...(r.from === undefined ? {} : { from: r.from }) };
        }
        const record = active(file) ?? file.plans.filter((p) => p.endedAt !== undefined && now() >= p.endedAt && now() - p.endedAt < BOT_PLAN_ENDED_SHOWN_MS).sort((a, b) => b.endedAt! - a.endedAt!)[0];
        return record ? view(record) : null;
      });
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    forgetBot(botId) {
      // Synchronous fence also invalidates a write currently staging under the serial.
      deleted.add(botId);
      return serial(botId, async () => {
        invalidate(botId);
        for (const key of fresh.keys()) if (JSON.parse(key)[0] === botId) fresh.delete(key);
        await fs.rm(fileOf(botId), { force: true });
        observed.delete(botId); terminal.delete(botId); unreadable.delete(botId); emit(botId);
      });
    },
  };
}
