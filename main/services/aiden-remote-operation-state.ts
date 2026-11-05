import type { AidenOperationContractErrorCode } from "./aiden-remote-operation-contract.js";

/**
 * The lifecycle of one idempotent Remote operation, in the ledger that owns it.
 *
 *   executing --action_fulfilled--> fulfilled
 *   executing --action_rejected---> rejected
 *   executing --outcome_lost------> unknown
 *   unknown   --reconciled_*------> fulfilled | rejected
 *
 * `executing` is the only phase with a live owner in this process. `unknown`
 * has none: the effect may or may not have committed, so nothing short of an
 * authoritative reconciliation may leave it, and neither time nor a repeated
 * request reopens execution. Both serialize as the wire-stable `in_flight`, so
 * a restart turns `executing` into `unknown` without changing the stored shape.
 *
 * Linearization points: admission is the durable `in_flight` write, and the
 * terminal phases hold only after the outcome fits the snapshot budget. An
 * outcome that cannot be recorded is `outcome_lost`, never a clean failure.
 */
export type AidenOperationPhase<Value> =
  | { kind: "executing"; result: Promise<unknown> }
  | { kind: "unknown" }
  | { kind: "fulfilled"; value: Value; expiresAt: number }
  | { kind: "rejected"; errorCode: AidenOperationContractErrorCode; expiresAt: number };

export type AidenOperationEvent<Value> =
  | { type: "action_fulfilled"; value: Value; expiresAt: number }
  | { type: "action_rejected"; errorCode: AidenOperationContractErrorCode; expiresAt: number }
  | { type: "outcome_lost" }
  | { type: "reconciled_fulfilled"; value: Value; expiresAt: number }
  | { type: "reconciled_rejected"; errorCode: AidenOperationContractErrorCode; expiresAt: number };

/**
 * Applies one event. An event the phase does not accept changes nothing, so a
 * late or duplicate completion can never reopen or rewrite a settled outcome.
 */
export function advanceAidenOperation<Value>(
  phase: AidenOperationPhase<Value>,
  event: AidenOperationEvent<Value>,
): AidenOperationPhase<Value> {
  switch (event.type) {
    case "action_fulfilled":
      return phase.kind === "executing"
        ? { kind: "fulfilled", value: event.value, expiresAt: event.expiresAt }
        : phase;
    case "action_rejected":
      return phase.kind === "executing"
        ? { kind: "rejected", errorCode: event.errorCode, expiresAt: event.expiresAt }
        : phase;
    case "outcome_lost":
      return phase.kind === "executing" ? { kind: "unknown" } : phase;
    case "reconciled_fulfilled":
      return phase.kind === "unknown"
        ? { kind: "fulfilled", value: event.value, expiresAt: event.expiresAt }
        : phase;
    case "reconciled_rejected":
      return phase.kind === "unknown"
        ? { kind: "rejected", errorCode: event.errorCode, expiresAt: event.expiresAt }
        : phase;
  }
}

/** Only a terminal outcome expires; unresolved work is kept indefinitely. */
export function aidenOperationExpiry<Value>(phase: AidenOperationPhase<Value>): number | null {
  return phase.kind === "fulfilled" || phase.kind === "rejected" ? phase.expiresAt : null;
}
