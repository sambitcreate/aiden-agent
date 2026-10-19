import type { DataStore, DataStoreOptions } from "./data-store.js";
import {
  AidenIdempotencyLedger,
  MAX_DURABLE_LEDGER_SNAPSHOT_BYTES,
  type AidenIdempotencySnapshot,
} from "./aiden-remote-operation-contract.js";

function normalizeIdempotency(value: unknown): AidenIdempotencySnapshot {
  return new AidenIdempotencyLedger(value as AidenIdempotencySnapshot).snapshot();
}

function safeIdempotency(value: unknown): boolean {
  try {
    normalizeIdempotency(value);
    return true;
  } catch {
    return false;
  }
}

/** Unlike the stream journal, the operations ledger is never discarded: a bad file blocks writes. */
export function aidenRemoteOperationStoreOptions(): DataStoreOptions<AidenIdempotencySnapshot> {
  return {
    maxBytes: MAX_DURABLE_LEDGER_SNAPSHOT_BYTES,
    fileMode: 0o600,
    normalize: normalizeIdempotency,
    isSafe: safeIdempotency,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
  };
}

/**
 * Opens the ledger for one workspace API build. A build that failed on an unreadable file is
 * retried by the next enable, so the file is read again rather than replaying the cached failure.
 */
export async function openAidenRemoteOperationLedger(
  store: DataStore<AidenIdempotencySnapshot>,
): Promise<AidenIdempotencyLedger> {
  await store.reload();
  const ledger = new AidenIdempotencyLedger(await store.load());
  await store.save(ledger.snapshot());
  return ledger;
}
