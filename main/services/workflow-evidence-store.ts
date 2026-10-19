import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DataStore } from "./data-store.js";
import { PiVerificationStore, verificationSnapshot, type VerificationReceipt } from "./pi-verification-store.js";
import { toolOutputScope } from "./tool-output-store.js";

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/u;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const MAX_BUNDLES = 64;
const MAX_LESSONS = 128;
const MAX_CHECKS = 16;
const OBSERVATIONS = ["current", "stale", "missing", "evidence_missing", "observation_failed"] as const;
type Observation = typeof OBSERVATIONS[number];
export type WorkflowLessonOutcome = "candidate" | "no_lesson" | "conflicting_evidence" | "withdrawn";
export interface WorkflowComponent { id: string; version: string }
export interface WorkflowProposal {
  applicability: string;
  operation: string;
  limitations: string[];
}
export interface WorkflowEvidenceCheck {
  checkId: string;
  receiptDigest?: string;
  /** A host receipt reference, never a caller-provided verdict. */
  runId?: string;
  artifactId?: string;
  snapshot?: string;
  observation: Observation;
}
export interface WorkflowEvidenceBundle {
  version: 1;
  bundleId: string;
  workflowId: string;
  component: WorkflowComponent;
  createdAt: number;
  expiresAt: number;
  checks: WorkflowEvidenceCheck[];
}
export interface WorkflowLessonRecord {
  version: 1;
  recordId: string;
  requestId: string;
  lessonId: string;
  revision: number;
  previousRecordId?: string;
  rollbackOfRecordId?: string;
  bundleId: string;
  workflowId: string;
  component: WorkflowComponent;
  outcome: WorkflowLessonOutcome;
  proposal?: WorkflowProposal;
  confidence: "unassessed" | "tentative";
  review: "pending" | "withdrawn";
  /** This draft is never an authority to apply a change or inject context. */
  limitations: ["selection_is_not_causation", "not_adopted"];
  createdAt: number;
  expiresAt: number;
}
interface Scoped<T> { chat: string; scope: string; value: T }
interface Database { version: 1; bundles: Scoped<WorkflowEvidenceBundle>[]; lessons: Scoped<WorkflowLessonRecord>[] }
export type WorkflowSnapshotReader = (artifactId: string, signal?: AbortSignal) => Promise<string>;
export interface WorkflowLessonInput {
  requestId: string;
  lessonId: string;
  bundleId: string;
  outcome: Exclude<WorkflowLessonOutcome, "withdrawn">;
  proposal?: WorkflowProposal;
  previousRecordId?: string;
  rollbackOfRecordId?: string;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function hash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function time(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= max && [...value].every((character) => {
    const code = character.charCodeAt(0); return (code >= 32 && code !== 127) || code === 9 || code === 10;
  });
}
function component(value: unknown): value is WorkflowComponent {
  return object(value) && id(value.id) && typeof value.version === "string" && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/u.test(value.version) && keys(value, ["id", "version"]);
}
function proposal(value: unknown): value is WorkflowProposal {
  return object(value) && text(value.applicability, 1024) && text(value.operation, 2048) && Array.isArray(value.limitations) && value.limitations.length <= 8 && value.limitations.every((item) => text(item, 512)) && keys(value, ["applicability", "operation", "limitations"]);
}
function check(value: unknown): value is WorkflowEvidenceCheck {
  return object(value) && id(value.checkId) && OBSERVATIONS.includes(value.observation as Observation) &&
    (value.receiptDigest === undefined ? value.observation === "missing" && value.runId === undefined && value.artifactId === undefined && value.snapshot === undefined : hash(value.receiptDigest) && id(value.runId) && id(value.artifactId) && hash(value.snapshot)) &&
    keys(value, ["checkId", "receiptDigest", "runId", "artifactId", "snapshot", "observation"]);
}
function bundle(value: unknown): value is WorkflowEvidenceBundle {
  return object(value) && value.version === 1 && id(value.bundleId) && id(value.workflowId) && component(value.component) && time(value.createdAt) && time(value.expiresAt) && value.expiresAt > value.createdAt && value.expiresAt <= value.createdAt + WEEK &&
    Array.isArray(value.checks) && value.checks.length > 0 && value.checks.length <= MAX_CHECKS && value.checks.every(check) && new Set(value.checks.map((item) => item.checkId)).size === value.checks.length &&
    keys(value, ["version", "bundleId", "workflowId", "component", "createdAt", "expiresAt", "checks"]);
}
function lesson(value: unknown): value is WorkflowLessonRecord {
  return object(value) && value.version === 1 && [value.recordId, value.requestId, value.lessonId, value.bundleId, value.workflowId].every(id) && component(value.component) &&
    typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision > 0 && value.revision <= MAX_LESSONS && (value.previousRecordId === undefined ? value.revision === 1 : id(value.previousRecordId) && value.revision > 1) &&
    (value.rollbackOfRecordId === undefined || id(value.rollbackOfRecordId)) && ["candidate", "no_lesson", "conflicting_evidence", "withdrawn"].includes(String(value.outcome)) &&
    (value.outcome === "candidate" ? proposal(value.proposal) : value.proposal === undefined) && value.confidence === (value.outcome === "candidate" ? "tentative" : "unassessed") && value.review === (value.outcome === "withdrawn" ? "withdrawn" : "pending") &&
    Array.isArray(value.limitations) && JSON.stringify(value.limitations) === JSON.stringify(["selection_is_not_causation", "not_adopted"]) && time(value.createdAt) && time(value.expiresAt) && value.expiresAt > value.createdAt && value.expiresAt <= value.createdAt + WEEK &&
    keys(value, ["version", "recordId", "requestId", "lessonId", "revision", "previousRecordId", "rollbackOfRecordId", "bundleId", "workflowId", "component", "outcome", "proposal", "confidence", "review", "limitations", "createdAt", "expiresAt"]);
}
function database(value: unknown): value is Database {
  if (!object(value) || value.version !== 1 || !keys(value, ["version", "bundles", "lessons"]) || !Array.isArray(value.bundles) || !Array.isArray(value.lessons) || value.bundles.length > MAX_BUNDLES || value.lessons.length > MAX_LESSONS) return false;
  const scoped = <T>(row: unknown, validate: (value: unknown) => value is T): row is Scoped<T> => object(row) && hash(row.chat) && hash(row.scope) && validate(row.value) && keys(row, ["chat", "scope", "value"]);
  if (!value.bundles.every((row) => scoped(row, bundle)) || !value.lessons.every((row) => scoped(row, lesson))) return false;
  const bundles = value.bundles as Scoped<WorkflowEvidenceBundle>[];
  const lessons = value.lessons as Scoped<WorkflowLessonRecord>[];
  if (new Set(bundles.map((row) => `${row.chat}:${row.scope}:${row.value.bundleId}`)).size !== bundles.length || new Set(lessons.map((row) => `${row.chat}:${row.scope}:${row.value.requestId}`)).size !== lessons.length || new Set(lessons.map((row) => row.value.recordId)).size !== lessons.length) return false;
  return lessons.every((row) => {
    const evidence = bundles.find((item) => item.chat === row.chat && item.scope === row.scope && item.value.bundleId === row.value.bundleId)?.value;
    if (!evidence || evidence.workflowId !== row.value.workflowId || !isDeepStrictEqual(evidence.component, row.value.component)) return false;
    const prior = row.value.previousRecordId ? lessons.find((item) => item.value.recordId === row.value.previousRecordId) : undefined;
    if (prior && (prior.chat !== row.chat || prior.scope !== row.scope || prior.value.lessonId !== row.value.lessonId || prior.value.revision + 1 !== row.value.revision || prior.value.workflowId !== row.value.workflowId || prior.value.createdAt > row.value.createdAt)) return false;
    if (row.value.previousRecordId && !prior) return false;
    const rollback = row.value.rollbackOfRecordId ? lessons.find((item) => item.value.recordId === row.value.rollbackOfRecordId) : undefined;
    if (row.value.rollbackOfRecordId && (!rollback || rollback.chat !== row.chat || rollback.scope !== row.scope || rollback.value.lessonId !== row.value.lessonId || rollback.value.revision >= row.value.revision)) return false;
    return lessons.filter((item) => item.chat === row.chat && item.scope === row.scope && item.value.lessonId === row.value.lessonId && item.value.revision === row.value.revision).length === 1;
  });
}

/** Private host-owned proposals, separate from personal memory, Bot persona and
 * executable skills. No model tool, IPC, retrieval injection or adoption path is
 * registered here. The caller supplies trusted artifact readers, never verdicts.
 * Process-owned storage rejects corrupt/unsupported data rather than replacing it.
 */
export class WorkflowEvidenceStore {
  private readonly data: DataStore<Database>;
  private queue: Promise<void> = Promise.resolve();
  private readonly deletedChats = new Set<string>();
  private readonly pendingChats = new Map<string, number>();
  constructor(private readonly verification: PiVerificationStore, root?: () => string, private readonly now = Date.now) {
    this.data = new DataStore("workflow-evidence.json", { version: 1, bundles: [], lessons: [] }, root, {
      fileMode: 0o600, compact: true, maxBytes: 2 * 1024 * 1024, normalize: (value) => database(value) ? value : { version: 1, bundles: [], lessons: [] },
      isSafe: database, rejectCorruptWrite: true, rejectUnsafeWrite: true,
    });
  }
  private currentTime(): number { const value = this.now(); if (!time(value)) throw new Error("Invalid workflow evidence clock."); return value; }
  private async load(): Promise<Database> {
    const value = await this.data.load();
    if (await this.data.loadedFromCorruptFile() || await this.data.loadedFromUnsafeFile()) throw new Error("Workflow evidence is unreadable and was preserved.");
    return value;
  }
  private authorize(chatId: string, scope: string, signal?: AbortSignal): void {
    if (!chatId || !hash(scope) || this.deletedChats.has(toolOutputScope(chatId)) || signal?.aborted) throw new Error("Workflow evidence scope is unavailable or cancelled.");
  }
  private serialized<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const chat = toolOutputScope(chatId); this.pendingChats.set(chat, (this.pendingChats.get(chat) ?? 0) + 1);
    const result = this.queue.then(operation).finally(() => {
      const count = this.pendingChats.get(chat)! - 1; if (count) this.pendingChats.set(chat, count); else this.pendingChats.delete(chat);
    });
    this.queue = result.then(() => undefined, () => undefined); return result;
  }
  private prune(value: Database, now: number): void {
    // Keep complete lineage while any revision is retained. Never leave a live
    // rollback reference pointing into a pruned prefix of its own history.
    const live = new Set(value.lessons.filter((row) => row.value.expiresAt > now).map((row) => `${row.chat}:${row.scope}:${row.value.lessonId}`));
    value.lessons = value.lessons.filter((row) => live.has(`${row.chat}:${row.scope}:${row.value.lessonId}`));
    const referenced = new Set(value.lessons.map((row) => `${row.chat}:${row.scope}:${row.value.bundleId}`));
    value.bundles = value.bundles.filter((row) => row.value.expiresAt > now || referenced.has(`${row.chat}:${row.scope}:${row.value.bundleId}`));
  }
  private async observe(chatId: string, scope: string, checkId: string, readSnapshot: WorkflowSnapshotReader, signal?: AbortSignal): Promise<WorkflowEvidenceCheck> {
    const receipt = (await this.verification.list(chatId, scope)).find((row) => row.checkId === checkId);
    if (!receipt) return { checkId, observation: "missing" };
    const reference = { checkId, receiptDigest: verificationSnapshot(JSON.stringify(receipt)), runId: receipt.runId, artifactId: receipt.artifactId, snapshot: receipt.snapshot };
    try {
      const snapshot = await readSnapshot(receipt.artifactId, signal);
      if (!hash(snapshot)) throw new Error("Invalid workflow artifact snapshot.");
      const inspected = await this.verification.inspect(chatId, scope, receipt, snapshot);
      return { ...reference, observation: inspected.stale ? "stale" : inspected.evidence !== "available" ? "evidence_missing" : "current" };
    } catch { return { ...reference, observation: "observation_failed" }; }
  }
  capture(chatId: string, scope: string, input: { bundleId: string; workflowId: string; component: WorkflowComponent; checkIds: string[] }, readSnapshot: WorkflowSnapshotReader, signal?: AbortSignal): Promise<WorkflowEvidenceBundle> {
    const requested = structuredClone(input);
    return this.serialized(chatId, async () => {
      this.authorize(chatId, scope, signal);
      if (!object(requested) || !keys(requested, ["bundleId", "workflowId", "component", "checkIds"]) || !id(requested.bundleId) || !id(requested.workflowId) || !component(requested.component) || !Array.isArray(requested.checkIds) || requested.checkIds.length < 1 || requested.checkIds.length > MAX_CHECKS || !requested.checkIds.every(id) || new Set(requested.checkIds).size !== requested.checkIds.length) throw new Error("Invalid workflow evidence request.");
      const prior = (await this.load()).bundles.find((row) => row.chat === toolOutputScope(chatId) && row.scope === scope && row.value.bundleId === requested.bundleId)?.value;
      if (prior) {
        if (prior.workflowId !== requested.workflowId || !isDeepStrictEqual(prior.component, requested.component) || !isDeepStrictEqual(prior.checks.map((row) => row.checkId), requested.checkIds)) throw new Error("Workflow bundle identity reused.");
        return structuredClone(prior);
      }
      const checks: WorkflowEvidenceCheck[] = [];
      for (const checkId of requested.checkIds) { this.authorize(chatId, scope, signal); checks.push(await this.observe(chatId, scope, checkId, readSnapshot, signal)); }
      const createdAt = this.currentTime();
      const value: WorkflowEvidenceBundle = { version: 1, bundleId: requested.bundleId, workflowId: requested.workflowId, component: requested.component, checks, createdAt, expiresAt: createdAt + WEEK };
      await this.data.update((draft) => { this.prune(draft, createdAt); if (draft.bundles.length >= MAX_BUNDLES) throw new Error("Workflow evidence is at capacity."); draft.bundles.push({ chat: toolOutputScope(chatId), scope, value }); }, () => !signal?.aborted && !this.deletedChats.has(toolOutputScope(chatId)));
      return structuredClone(value);
    });
  }
  async inspect(chatId: string, scope: string, bundleId: string, readSnapshot: WorkflowSnapshotReader, signal?: AbortSignal): Promise<{ expired: boolean; checks: WorkflowEvidenceCheck[]; supportingChecks: string[] }> {
    this.authorize(chatId, scope, signal);
    const value = (await this.load()).bundles.find((row) => row.chat === toolOutputScope(chatId) && row.scope === scope && row.value.bundleId === bundleId)?.value;
    if (!value) throw new Error("Workflow evidence bundle is unavailable.");
    const expired = value.expiresAt <= this.currentTime() || value.createdAt > this.currentTime();
    const checks: WorkflowEvidenceCheck[] = []; const supportingChecks: string[] = [];
    const receipts = await this.verification.list(chatId, scope);
    for (const reference of value.checks) {
      const observed = await this.observe(chatId, scope, reference.checkId, readSnapshot, signal);
      // A previously missing receipt cannot be inserted later to upgrade a frozen
      // bundle. New checks require a new evidence bundle.
      if (observed.receiptDigest !== reference.receiptDigest) observed.observation = "missing";
      checks.push(observed);
      const receipt = receipts.find((row) => row.checkId === reference.checkId);
      if (!expired && observed.observation === "current" && receipt && supportsLesson(receipt)) supportingChecks.push(reference.checkId);
    }
    this.authorize(chatId, scope, signal);
    return { expired, checks, supportingChecks };
  }
  propose(chatId: string, scope: string, input: WorkflowLessonInput, readSnapshot: WorkflowSnapshotReader, signal?: AbortSignal): Promise<WorkflowLessonRecord> {
    const requested = structuredClone(input);
    return this.serialized(chatId, async () => {
      this.authorize(chatId, scope, signal);
      if (!object(requested) || !keys(requested, ["requestId", "lessonId", "bundleId", "outcome", "proposal", "previousRecordId", "rollbackOfRecordId"]) || ![requested.requestId, requested.lessonId, requested.bundleId].every(id) || !["candidate", "no_lesson", "conflicting_evidence"].includes(requested.outcome) || (requested.outcome === "candidate" ? !proposal(requested.proposal) : requested.proposal !== undefined) || (requested.previousRecordId !== undefined && !id(requested.previousRecordId)) || (requested.rollbackOfRecordId !== undefined && !id(requested.rollbackOfRecordId))) throw new Error("Invalid workflow lesson proposal.");
      const stored = await this.load();
      const existing = stored.lessons.find((row) => row.chat === toolOutputScope(chatId) && row.scope === scope && row.value.requestId === requested.requestId)?.value;
      if (existing) {
        if (Object.entries(requested).some(([key, value]) => !isDeepStrictEqual(existing[key as keyof WorkflowLessonRecord], value))) throw new Error("Workflow lesson request identity reused.");
        return structuredClone(existing);
      }
      const evidence = stored.bundles.find((row) => row.chat === toolOutputScope(chatId) && row.scope === scope && row.value.bundleId === requested.bundleId)?.value;
      if (!evidence) throw new Error("Workflow evidence bundle is unavailable.");
      const inspected = await this.inspect(chatId, scope, requested.bundleId, readSnapshot, signal);
      if (inspected.expired) throw new Error("Workflow evidence bundle expired.");
      if (requested.outcome === "candidate" && (inspected.supportingChecks.length !== evidence.checks.length || inspected.checks.some((row) => row.observation !== "current"))) throw new Error("A candidate needs current host-observed artifact or task evidence for every supporting check.");
      const createdAt = this.currentTime();
      return this.data.update((draft) => {
        this.prune(draft, createdAt);
        const previous = this.latest(draft, chatId, scope, requested.lessonId);
        if (previous?.recordId !== requested.previousRecordId || (previous && previous.workflowId !== evidence.workflowId)) throw new Error("Workflow lesson lineage changed.");
        if (requested.rollbackOfRecordId && !draft.lessons.some((row) => row.chat === toolOutputScope(chatId) && row.scope === scope && row.value.lessonId === requested.lessonId && row.value.recordId === requested.rollbackOfRecordId)) throw new Error("Workflow rollback lineage is unavailable.");
        const value: WorkflowLessonRecord = { version: 1, ...requested, recordId: randomUUID(), revision: (previous?.revision ?? 0) + 1, workflowId: evidence.workflowId, component: evidence.component, confidence: requested.outcome === "candidate" ? "tentative" : "unassessed", review: "pending", limitations: ["selection_is_not_causation", "not_adopted"], createdAt, expiresAt: evidence.expiresAt };
        if (draft.lessons.length >= MAX_LESSONS) throw new Error("Workflow lesson evidence is at capacity.");
        draft.lessons.push({ chat: toolOutputScope(chatId), scope, value }); return structuredClone(value);
      }, () => !signal?.aborted && !this.deletedChats.has(toolOutputScope(chatId)));
    });
  }
  private latest(data: Database, chatId: string, scope: string, lessonId: string): WorkflowLessonRecord | undefined {
    return data.lessons.filter((row) => row.chat === toolOutputScope(chatId) && row.scope === scope && row.value.lessonId === lessonId).map((row) => row.value).sort((a, b) => b.revision - a.revision)[0];
  }
  withdraw(chatId: string, scope: string, lessonId: string, expectedRecordId: string, requestId: string): Promise<WorkflowLessonRecord> {
    return this.serialized(chatId, async () => {
      this.authorize(chatId, scope); if (![lessonId, expectedRecordId, requestId].every(id)) throw new Error("Invalid workflow withdrawal."); await this.load();
      return this.data.update((draft) => {
        const duplicate = draft.lessons.find((row) => row.chat === toolOutputScope(chatId) && row.scope === scope && row.value.requestId === requestId)?.value;
        if (duplicate) {
          if (duplicate.outcome !== "withdrawn" || duplicate.lessonId !== lessonId || duplicate.previousRecordId !== expectedRecordId) throw new Error("Workflow lesson request identity reused.");
          return structuredClone(duplicate);
        }
        const previous = this.latest(draft, chatId, scope, lessonId);
        if (!previous || previous.recordId !== expectedRecordId || previous.review === "withdrawn") throw new Error("Workflow lesson lineage changed.");
        const createdAt = this.currentTime();
        const value: WorkflowLessonRecord = { version: 1, recordId: randomUUID(), requestId, lessonId, revision: previous.revision + 1, previousRecordId: previous.recordId, bundleId: previous.bundleId, workflowId: previous.workflowId, component: previous.component, outcome: "withdrawn", confidence: "unassessed", review: "withdrawn", limitations: ["selection_is_not_causation", "not_adopted"], createdAt, expiresAt: createdAt + WEEK };
        // The new withdrawal retains its complete preceding chain, even if the
        // user withdraws a draft after the original evidence expired.
        draft.lessons.push({ chat: toolOutputScope(chatId), scope, value });
        this.prune(draft, createdAt);
        if (draft.lessons.length > MAX_LESSONS) throw new Error("Workflow lesson evidence is at capacity.");
        return structuredClone(value);
      }, () => !this.deletedChats.has(toolOutputScope(chatId)));
    });
  }
  async list(chatId: string, scope: string): Promise<Array<{ record: WorkflowLessonRecord; expired: boolean }>> {
    this.authorize(chatId, scope); const data = await this.load(); const now = this.currentTime();
    const ids = new Set(data.lessons.filter((row) => row.chat === toolOutputScope(chatId) && row.scope === scope).map((row) => row.value.lessonId));
    return [...ids].map((lessonId) => { const record = structuredClone(this.latest(data, chatId, scope, lessonId)!); return { record, expired: record.expiresAt <= now || record.createdAt > now }; });
  }
  async deleteByChat(chatId: string): Promise<void> {
    const chat = toolOutputScope(chatId); this.deletedChats.add(chat);
    await this.serialized(chatId, async () => { await this.load(); await this.data.update((draft) => { draft.bundles = draft.bundles.filter((row) => row.chat !== chat); draft.lessons = draft.lessons.filter((row) => row.chat !== chat); }); });
  }
  async reconcileChats(validChatIds: ReadonlySet<string>): Promise<void> {
    const valid = new Set([...validChatIds].map((chatId) => toolOutputScope(chatId)));
    for (const chat of this.pendingChats.keys()) if (!valid.has(chat)) this.deletedChats.add(chat);
    for (const row of [...(await this.load()).bundles, ...(await this.load()).lessons]) if (!valid.has(row.chat)) this.deletedChats.add(row.chat);
    const operation = this.queue.then(() => this.data.update((draft) => { draft.bundles = draft.bundles.filter((row) => valid.has(row.chat)); draft.lessons = draft.lessons.filter((row) => valid.has(row.chat)); }));
    this.queue = operation.then(() => undefined, () => undefined); await operation;
  }
}
function supportsLesson(receipt: VerificationReceipt): boolean {
  return receipt.result === "passed" && (receipt.kind === "artifact_check" || receipt.kind === "task_predicate") && receipt.limitations.length === 0;
}
