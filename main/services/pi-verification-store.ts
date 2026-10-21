import { createHash } from "node:crypto";
import { DataStore } from "./data-store.js";
import { ToolOutputStore, toolOutputScope } from "./tool-output-store.js";

export type VerificationResult = "passed" | "failed" | "not_run" | "inconclusive";
export type VerificationKind = "response_ended" | "tool_execution" | "artifact_check" | "task_predicate";
export type VerificationLimitation = "command_only" | "lifecycle_only" | "cancelled" | "observer_failed" | "artifact_changed" | "evidence_unavailable";
export interface VerificationReceipt {
  version: 1;
  checkId: string;
  runId: string;
  turnId: string;
  /** Opaque host identity; never a path or command. */
  artifactId: string;
  snapshot: string;
  kind: VerificationKind;
  result: VerificationResult;
  observedAt: number;
  evidenceHandle?: string;
  limitations: VerificationLimitation[];
}
interface StoredReceipt { chat: string; scope: string; receipt: VerificationReceipt }
export interface HostVerificationCheck {
  checkId: string;
  runId: string;
  turnId: string;
  artifactId: string;
  kind: VerificationKind;
  /** Host must hash the complete artifact examined, not its model description. */
  snapshot: () => Promise<string>;
  observe: (signal?: AbortSignal) => Promise<{ result: VerificationResult; evidence?: string }>;
}
const LIMITATIONS: VerificationLimitation[] = ["command_only", "lifecycle_only", "cancelled", "observer_failed", "artifact_changed", "evidence_unavailable"];
const KINDS: VerificationKind[] = ["response_ended", "tool_execution", "artifact_check", "task_predicate"];
const RESULTS: VerificationResult[] = ["passed", "failed", "not_run", "inconclusive"];
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/u;
const HASH = /^[a-f0-9]{64}$/u;
export const VERIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_MS = VERIFICATION_RETENTION_MS;
const MAX_RECEIPTS = 512;
export function verificationSnapshot(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** Convert existing runtime identities to private, bounded receipt identities. */
export function verificationIdentity(kind: "run" | "turn" | "check" | "artifact", value: string): string {
  return `${kind}:${verificationSnapshot(value)}`;
}
function validReceipt(value: unknown): value is VerificationReceipt {
  const row = value as VerificationReceipt;
  return !!row && row.version === 1 && [row.checkId, row.runId, row.turnId, row.artifactId].every((id) => typeof id === "string" && ID.test(id)) &&
    HASH.test(row.snapshot) && KINDS.includes(row.kind) && RESULTS.includes(row.result) && Number.isSafeInteger(row.observedAt) && row.observedAt >= 0 &&
    (row.evidenceHandle === undefined || /^[a-f0-9-]{36}$/u.test(row.evidenceHandle)) && Array.isArray(row.limitations) &&
    row.limitations.length <= LIMITATIONS.length && row.limitations.every((item) => LIMITATIONS.includes(item)) &&
    Object.keys(row).every((key) => ["version", "checkId", "runId", "turnId", "artifactId", "snapshot", "kind", "result", "observedAt", "evidenceHandle", "limitations"].includes(key));
}
function validDatabase(value: unknown): value is StoredReceipt[] {
  return Array.isArray(value) && value.length <= MAX_RECEIPTS && value.every((row: StoredReceipt) =>
    row && HASH.test(row.chat) && HASH.test(row.scope) && validReceipt(row.receipt) && Object.keys(row).length === 3);
}

/** Private host journal, deliberately absent from model tools and Remote messages.
 * Separate file keeps old effect-journal readers compatible. Unknown versions fail
 * closed; no migration synthesizes a pass. Raw evidence uses existing scoped,
 * expiring output storage; deleting a chat removes both forms of evidence.
 */
export class PiVerificationStore {
  private readonly data: DataStore<StoredReceipt[]>;
  private readonly outputs: ToolOutputStore;
  constructor(root?: () => string, private readonly now = Date.now) {
    this.outputs = new ToolOutputStore(root, now, "pi-verification-evidence.json");
    this.data = new DataStore("pi-verification-receipts.json", [], root, {
      fileMode: 0o600, maxBytes: 1024 * 1024, normalize: (value) => validDatabase(value) ? value : [],
      isSafe: validDatabase, rejectCorruptWrite: true, rejectUnsafeWrite: true,
    });
  }
  private async load(): Promise<StoredReceipt[]> {
    const rows = await this.data.load();
    if (await this.data.loadedFromCorruptFile() || await this.data.loadedFromUnsafeFile()) throw new Error("Verification evidence is unreadable and was preserved.");
    return rows;
  }
  private readonly deletedChats = new Set<string>();
  private readonly pendingChats = new Map<string, number>();
  private canPublish(chat: string): boolean {
    return !this.deletedChats.has(chat);
  }
  private queue: Promise<void> = Promise.resolve();
  check(chatId: string, scope: string, check: HostVerificationCheck, signal?: AbortSignal): Promise<VerificationReceipt> {
    const chat = toolOutputScope(chatId);
    this.pendingChats.set(chat, (this.pendingChats.get(chat) ?? 0) + 1);
    const operation = this.queue.then(async () => {
      try { return await this.checkOnce(chatId, scope, check, signal); }
      finally {
        const remaining = this.pendingChats.get(chat)! - 1;
        if (remaining) this.pendingChats.set(chat, remaining);
        else this.pendingChats.delete(chat);
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private async checkOnce(chatId: string, scope: string, check: HostVerificationCheck, signal?: AbortSignal): Promise<VerificationReceipt> {
    if (!HASH.test(scope) || ![check.checkId, check.runId, check.turnId, check.artifactId].every((id) => ID.test(id)) || !KINDS.includes(check.kind)) throw new Error("Invalid host verification identity.");
    const chat = toolOutputScope(chatId);
    if (!this.canPublish(chat)) throw new Error("Verification chat was deleted.");
    const prior = (await this.load()).find((row) => row.chat === chat && row.scope === scope && row.receipt.checkId === check.checkId);
    if (prior) {
      if (["runId", "turnId", "artifactId", "kind"].some((key) => prior.receipt[key as keyof VerificationReceipt] !== check[key as keyof HostVerificationCheck])) throw new Error("Verification identity reused.");
      return structuredClone(prior.receipt);
    }
    const snapshot = await check.snapshot();
    if (!HASH.test(snapshot)) throw new Error("Invalid artifact snapshot.");
    const limitations: VerificationLimitation[] = check.kind === "response_ended" ? ["lifecycle_only"] : check.kind === "tool_execution" ? ["command_only"] : [];
    let result: VerificationResult = "not_run";
    let evidenceHandle: string | undefined;
    if (signal?.aborted) limitations.push("cancelled");
    else {
      try {
        const observed = await check.observe(signal);
        if (!RESULTS.includes(observed.result)) throw new Error("Invalid host result.");
        result = observed.result;
        if (observed.evidence !== undefined) {
          try {
            evidenceHandle = await this.outputs.put(chatId, scope, "host_verification", observed.evidence, () => !signal?.aborted && this.canPublish(chat));
          } catch { limitations.push("evidence_unavailable"); result = "inconclusive"; }
        }
      } catch { result = "inconclusive"; limitations.push("observer_failed"); }
      if (signal?.aborted) { result = "inconclusive"; limitations.push("cancelled"); }
      try {
        if (await check.snapshot() !== snapshot) { result = "inconclusive"; limitations.push("artifact_changed"); }
      } catch { result = "inconclusive"; limitations.push("observer_failed"); }
    }
    const receipt: VerificationReceipt = { version: 1, checkId: check.checkId, runId: check.runId, turnId: check.turnId, artifactId: check.artifactId, snapshot, kind: check.kind, result, observedAt: this.now(), ...(evidenceHandle ? { evidenceHandle } : {}), limitations: [...new Set(limitations)] };
    if (!validReceipt(receipt)) throw new Error("Invalid host verification receipt.");
    await this.data.update((rows) => {
      if (!this.canPublish(chat)) throw new Error("Verification chat was deleted.");
      // Concurrent duplicate delivery cannot overwrite an already observed check.
      if (rows.some((row) => row.chat === chat && row.scope === scope && row.receipt.checkId === check.checkId)) throw new Error("Verification observation already recorded.");
      const retained = rows.filter((row) => row.receipt.observedAt > this.now() - RETENTION_MS && row.receipt.observedAt <= this.now()).slice(-(MAX_RECEIPTS - 1));
      rows.splice(0, rows.length, ...retained, { chat, scope, receipt });
    });
    return structuredClone(receipt);
  }
  async list(chatId: string, scope: string): Promise<VerificationReceipt[]> {
    return (await this.load()).filter((row) => row.chat === toolOutputScope(chatId) && row.scope === scope && row.receipt.observedAt > this.now() - RETENTION_MS && row.receipt.observedAt <= this.now()).map((row) => structuredClone(row.receipt));
  }
  async inspect(chatId: string, scope: string, receipt: VerificationReceipt, currentSnapshot: string): Promise<{ stale: boolean; evidence: "available" | "missing" | "not_retained" }> {
    const stored = (await this.list(chatId, scope)).find((row) => row.checkId === receipt.checkId);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(receipt)) throw new Error("Verification receipt is unavailable.");
    let evidence: "available" | "missing" | "not_retained" = "not_retained";
    if (stored.evidenceHandle) {
      try { await this.outputs.read(chatId, scope, new Set(["host_verification"]), stored.evidenceHandle, 0, 1); evidence = "available"; }
      catch { evidence = "missing"; }
    }
    return { stale: stored.snapshot !== currentSnapshot, evidence };
  }
  async readEvidence(chatId: string, scope: string, checkId: string, offset = 0, length = 8000): Promise<string> {
    const receipt = (await this.list(chatId, scope)).find((row) => row.checkId === checkId);
    if (!receipt?.evidenceHandle) throw new Error("Verification evidence is unavailable.");
    return this.outputs.read(chatId, scope, new Set(["host_verification"]), receipt.evidenceHandle, offset, length);
  }
  async reconcileChats(validChatIds: ReadonlySet<string>): Promise<void> {
    const valid = new Set([...validChatIds].map((id) => toolOutputScope(id)));
    for (const chat of this.pendingChats.keys()) {
      if (!valid.has(chat)) this.deletedChats.add(chat);
    }
    for (const row of await this.load()) {
      if (!valid.has(row.chat)) this.deletedChats.add(row.chat);
    }
    await this.data.update((rows) => { const retained = rows.filter((row) => valid.has(row.chat)); rows.splice(0, rows.length, ...retained); });
    await this.outputs.reconcileChats(validChatIds);
  }
  async deleteByChat(chatId: string): Promise<void> {
    this.deletedChats.add(toolOutputScope(chatId));
    await this.load();
    await this.data.update((rows) => { const retained = rows.filter((row) => row.chat !== toolOutputScope(chatId)); rows.splice(0, rows.length, ...retained); });
    await this.outputs.deleteByChat(chatId);
  }
}
