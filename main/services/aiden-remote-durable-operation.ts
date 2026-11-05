import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AidenOperationNotExecutedError,
  type AidenIdempotencyLedger,
  type AidenIdempotencySnapshot,
} from "./aiden-remote-operation-contract.js";

export interface AidenDurableOperationScope {
  deviceId: string;
  route: string;
  resourceId: string;
  key: string;
}

export interface AidenDurableOperationOwner {
  ledger: AidenIdempotencyLedger;
  persist?: (snapshot: AidenIdempotencySnapshot) => Promise<void>;
  /** Shown when the request could not be admitted, so nothing ran. */
  notPreparedMessage: string;
  /** Shown when the outcome could not be recorded, so it must stay unknown. */
  outcomeUnrecordedMessage: string;
}

/**
 * Runs one idempotent request through the two durable edges every Remote
 * mutation shares:
 *
 *   1. The `in_flight` entry is written before the action may start. A failed
 *      write proves the action never ran, so the entry is dropped and the same
 *      key stays usable.
 *   2. The outcome is written after the action settles. A failed write leaves
 *      the effect standing with no durable record, so the operation becomes
 *      unknown, in memory as on disk, and the caller is told so.
 *
 * Only the call that owns the operation writes. A replay or a join has nothing
 * of its own to record, and its write failing would say nothing about the
 * operation it is reporting on.
 */
export async function executeAidenDurableOperation<T>(
  owner: AidenDurableOperationOwner,
  scope: AidenDurableOperationScope,
  input: unknown,
  action: () => Promise<T>,
): Promise<T> {
  const { ledger, persist } = owner;
  if (!persist) return ledger.execute(scope, input, action);

  let admit!: () => void;
  let refuse!: (error: unknown) => void;
  const admission = new Promise<void>((resolve, reject) => {
    admit = resolve;
    refuse = reject;
  });
  const { admitted, result: pending } = ledger.begin(scope, input, async () => {
    await admission;
    return action();
  });
  if (!admitted) return pending;

  try {
    await persist(ledger.snapshot());
    admit();
  } catch {
    const notPrepared = new AidenRemoteServiceError("internal_error", owner.notPreparedMessage, 500);
    refuse(new AidenOperationNotExecutedError(notPrepared));
    await pending.catch(() => undefined);
    throw notPrepared;
  }

  let result: T | undefined;
  let failure: unknown;
  let failed = false;
  try {
    result = await pending;
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await persist(ledger.snapshot());
  } catch {
    ledger.markOutcomeUnrecorded(scope);
    throw new AidenRemoteServiceError("idempotency_in_flight", owner.outcomeUnrecordedMessage, 409);
  }
  if (failed) throw failure;
  return result as T;
}
