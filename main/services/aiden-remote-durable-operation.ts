import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AidenOperationNotExecutedError,
  AidenOperationReplayedRejection,
  type AidenIdempotencyLedger,
  type AidenIdempotencySnapshot,
  type AidenOperationOwnership,
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
 * An action that proves it never ran frees its key, and that removal is an
 * outcome like any other. If its write fails, a restart reads the admission and
 * treats the key as unknown until a later write clears it. That can strand the
 * key but cannot repeat an effect, which is the safe side of a disk that just failed.
 *
 * The ledger is saved whole, so another scope's save can carry this operation's
 * phase after this operation's own write failed. Both results stay honest: an
 * unknown caller may later learn the true outcome, and an admission that never
 * ran can strand its key as above. Leaving unconfirmed entries out of a save
 * would be unsafe, because that save could erase an admission already on disk
 * while its action runs.
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
  let begun: ReturnType<AidenIdempotencyLedger["begin"]> & { result: Promise<T> };
  try {
    begun = ledger.begin(
      scope,
      input,
      async () => {
        await admission;
        return action();
      },
      undefined,
      true,
    );
  } catch (error) {
    const unfinished = operations.get(operation) as Promise<T> | undefined;
    if (error instanceof AidenOperationReplayedRejection && unfinished) return unfinished;
    throw error;
  }
  const { result: pending, ownership } = begun;
  if (!ownership) return (operations.get(operation) as Promise<T> | undefined) ?? pending;

  const durable = settleDurably(owner, ownership, pending, admit, refuse);
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
  ownership: AidenOperationOwnership,
  pending: Promise<T>,
  admit: () => void,
  refuse: (error: unknown) => void,
): Promise<T> {
  const { ledger } = owner;
  const persist = owner.persist!;
  const unrecorded = () =>
    new AidenRemoteServiceError("idempotency_in_flight", owner.outcomeUnrecordedMessage, 409);
  try {
    await persist(ledger.snapshot());
    admit();
  } catch {
    const notPrepared = new AidenRemoteServiceError("internal_error", owner.notPreparedMessage, 500);
    refuse(new AidenOperationNotExecutedError(notPrepared));
    await pending.catch(() => undefined);
    ownership.recorded();
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
    ownership.unrecorded();
    throw unrecorded();
  }
  ownership.recorded();
  if (!failed) return result as T;
  throw ownership.outcomeUnknown() ? unrecorded() : failure;
}
