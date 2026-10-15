// Maps Design Studio store and service refusals to typed IPC results, so the
// renderer never receives a raw throw or an internal message.
import { DesignStoreError, type DesignStoreErrorCode } from "../../services/design/store-core.js";

export interface DesignIpcFailure {
  ok: false;
  reason: DesignStoreErrorCode;
  message: string;
}

function failureOf(error: unknown): DesignIpcFailure | undefined {
  if (!(error instanceof DesignStoreError)) return undefined;
  return { ok: false, reason: error.code, message: error.message };
}

export function settleDesignCall<T>(run: () => T): T | DesignIpcFailure {
  try {
    return run();
  } catch (error) {
    const failure = failureOf(error);
    if (failure) return failure;
    throw error;
  }
}

export async function settleDesignCallAsync<T>(run: () => Promise<T>): Promise<T | DesignIpcFailure> {
  try {
    return await run();
  } catch (error) {
    const failure = failureOf(error);
    if (failure) return failure;
    throw error;
  }
}
