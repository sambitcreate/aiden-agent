import * as React from "react";
import {
  appendReconciliationFailureKind,
  type AppendReconciliationFailureKind,
} from "../shared/chat-message-contract";

let failureKind: AppendReconciliationFailureKind | null = null;
const listeners = new Set<() => void>();

export function rememberAppendReconciliationFailure(error: unknown): boolean {
  const next = appendReconciliationFailureKind(error);
  if (!next) return false;
  failureKind = failureKind === "current" ? failureKind : next;
  for (const listener of listeners) listener();
  return true;
}

export function appendReconciliationRequired(): boolean {
  return failureKind !== null;
}

export function subscribeAppendReconciliation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppendReconciliationRequired(): boolean {
  return React.useSyncExternalStore(
    subscribeAppendReconciliation,
    appendReconciliationRequired,
    appendReconciliationRequired,
  );
}
