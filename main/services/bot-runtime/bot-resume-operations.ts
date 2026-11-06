import { createHash, randomUUID } from "node:crypto";
import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const RECEIPTS = 512;
const RETENTION_MS = 24 * 60 * 60 * 1_000;
type Receipt = { id: string; signature: string; source?: string; acceptedAt: number; expiresAt: number };
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
const validSource = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,31}$/u.test(value);
export const BotResumeOperationsDoc = defineDoc({ kind: "aiden.resume-operations", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: (): { receipts: Receipt[] } => ({ receipts: [] }), checkpointWhen: () => true });
export const BotCostReceiptScopeDoc = defineDoc({ kind: "aiden.cost-receipt-scope", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: (): { nonce: string } => ({ nonce: "" }), checkpointWhen: () => true });
/** Host-private session incarnation; resets/forks cannot alias a prior cost dialog. */
export async function botCostReceiptScope(conversation: Conversation): Promise<string> {
  return conversation.commit(async (tx) => { const scope = await tx.doc(BotCostReceiptScopeDoc, conversation.id); if (scope.nonce === "") scope.nonce = randomUUID(); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(scope.nonce)) throw new Error("The saved cost decision scope is unavailable."); return scope.nonce; }, BACKGROUND_CONTEXT);
}

/** Consumed before effects: a replay can observe current state, never perform Resume again. */
export async function consumeBotResumeOperation(conversation: Conversation, id: string, options: { acknowledgeUnknownCost?: true; expectedSubmissionId?: string; expectedCostReceiptId?: string } | undefined, source: string | undefined, now: number, assertEligible?: () => Promise<void>): Promise<"new" | "replayed"> {
  if (!validId(id) || !Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - RETENTION_MS || source !== undefined && !validSource(source) || options && (Object.keys(options).some((key) => !["acknowledgeUnknownCost", "expectedSubmissionId", "expectedCostReceiptId"].includes(key)) || options.acknowledgeUnknownCost !== undefined && options.acknowledgeUnknownCost !== true || options.expectedSubmissionId !== undefined && !validSource(options.expectedSubmissionId) || options.expectedCostReceiptId !== undefined && !/^cost_[a-f0-9]{64}$/u.test(options.expectedCostReceiptId))) throw new Error("This Resume action is invalid. Review the current work and try a new action.");
  const signature = createHash("sha256").update(JSON.stringify({ acknowledgeUnknownCost: options?.acknowledgeUnknownCost === true, expectedSubmissionId: options?.expectedSubmissionId ?? null, expectedCostReceiptId: options?.expectedCostReceiptId ?? null })).digest("hex");
  return conversation.commit(async (tx) => {
    const stored = await tx.doc(BotResumeOperationsDoc, conversation.id);
    if (!Array.isArray(stored.receipts) || stored.receipts.length > RECEIPTS || new Set(stored.receipts.map((row) => row.id)).size !== stored.receipts.length || stored.receipts.some((row) => !row || Object.keys(row).some((key) => !["id", "signature", "source", "acceptedAt", "expiresAt"].includes(key)) || !validId(row.id) || !/^[a-f0-9]{64}$/u.test(row.signature) || row.source !== undefined && !validSource(row.source) || !Number.isSafeInteger(row.acceptedAt) || row.acceptedAt < 0 || row.expiresAt !== row.acceptedAt + RETENTION_MS)) throw new Error("Saved Resume decisions are unavailable. Preserve this Bot's session before retrying.");
    const previous = stored.receipts.find((row) => row.id === id && row.expiresAt > now);
    if (previous) { if (previous.signature !== signature) throw new Error("This Resume identity was already used with a different decision. Review the current work and use a new action."); return "replayed"; }
    const retained = stored.receipts.filter((row) => row.expiresAt > now);
    if (retained.length >= RECEIPTS) throw new Error("Recent Resume decisions are still protected. Try again after their retention period.");
    // A read-only first-admission refusal spends no identity. An already
    // accepted replay above remains observational, even while paused.
    await assertEligible?.();
    stored.receipts = [...retained, { id, signature, ...(source ? { source } : {}), acceptedAt: now, expiresAt: now + RETENTION_MS }];
    return "new";
  }, BACKGROUND_CONTEXT);
}
