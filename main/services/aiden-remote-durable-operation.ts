import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AidenOperationNotExecutedError,
  AidenOperationReplayedRejection,
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

/** Operations whose owner has not finished writing, per ledger. */
const unfinishedOperations = new WeakMap<AidenIdempotencyLedger, Map<string, Promise<unknown>>>();

function operationsFor(ledger: AidenIdempotencyLedger): Map<string, Promise<unknown>> {
  let operations = unfinishedOperations.get(ledger);
  if (!operations) {
    operations = new Map();
    unfinishedOperations.set(ledger, operations);
  }
  return operations;
}

function operationKey(scope: AidenDurableOperationScope): string {
  return JSON.stringify([scope.deviceId, scope.route, scope.resourceId, scope.key]);
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
 * of its own to record, so it answers with the owner's durable result: reading
 * the ledger directly could confirm an outcome whose write then fails.
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
  const operations = operationsFor(ledger);
  const operation = operationKey(scope);
  let begun: { admitted: boolean; result: Promise<T> };
  try {
    begun = ledger.begin(scope, input, async () => {
      await admission;
      return action();
    });
  } catch (error) {
    const unfinished = operations.get(operation) as Promise<T> | undefined;
    if (error instanceof AidenOperationReplayedRejection && unfinished) return unfinished;
    throw error;
  }
  const { admitted, result: pending } = begun;
  if (!admitted) return (operations.get(operation) as Promise<T> | undefined) ?? pending;

  const durable = settleDurably(owner, scope, pending, admit, refuse);
  operations.set(operation, durable);
  try {
    return await durable;
  } finally {
    // An operation that ran nothing frees its key, so a later owner may be here.
    if (operations.get(operation) === durable) operations.delete(operation);
  }
}

async function settleDurably<T>(
  owner: AidenDurableOperationOwner,
  scope: AidenDurableOperationScope,
  pending: Promise<T>,
  admit: () => void,
  refuse: (error: unknown) => void,
): Promise<T> {
  const { ledger } = owner;
  const persist = owner.persist!;
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
