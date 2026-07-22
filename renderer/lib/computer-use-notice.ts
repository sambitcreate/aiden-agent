import * as React from "react";

export const COMPUTER_USE_NOTICE_VERSION = 1;
export const COMPUTER_USE_NOTICE_PERMANENT_KEY = "aiden-agent.computerUseNotice.dismissedVersion";
export const COMPUTER_USE_NOTICE_SESSION_KEY =
  "aiden-agent.computerUseNotice.sessionDismissedVersion";

const COMPUTER_USE_NOTICE_CHANGED_EVENT = "aiden-agent:computer-use-notice-changed";

export interface ComputerUseNoticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ComputerUseNoticeDismissalScope = "session" | "permanent";

function storesCurrentVersion(storage: ComputerUseNoticeStorage, key: string): boolean {
  try {
    return storage.getItem(key) === String(COMPUTER_USE_NOTICE_VERSION);
  } catch {
    return false;
  }
}

export function isComputerUseNoticeDismissed(
  permanentStorage: ComputerUseNoticeStorage,
  sessionStorage: ComputerUseNoticeStorage,
): boolean {
  return (
    storesCurrentVersion(permanentStorage, COMPUTER_USE_NOTICE_PERMANENT_KEY) ||
    storesCurrentVersion(sessionStorage, COMPUTER_USE_NOTICE_SESSION_KEY)
  );
}

export function persistComputerUseNoticeDismissal(
  scope: ComputerUseNoticeDismissalScope,
  permanentStorage: ComputerUseNoticeStorage,
  sessionStorage: ComputerUseNoticeStorage,
): void {
  const storage = scope === "permanent" ? permanentStorage : sessionStorage;
  const key =
    scope === "permanent" ? COMPUTER_USE_NOTICE_PERMANENT_KEY : COMPUTER_USE_NOTICE_SESSION_KEY;
  try {
    storage.setItem(key, String(COMPUTER_USE_NOTICE_VERSION));
  } catch {
    // The notice stays visible if browser storage is temporarily unavailable.
  }
}

export function clearComputerUseNoticeDismissal(
  permanentStorage: ComputerUseNoticeStorage,
  sessionStorage: ComputerUseNoticeStorage,
): void {
  try {
    permanentStorage.removeItem(COMPUTER_USE_NOTICE_PERMANENT_KEY);
  } catch {
    // Keep clearing the session preference even if permanent storage is unavailable.
  }
  try {
    sessionStorage.removeItem(COMPUTER_USE_NOTICE_SESSION_KEY);
  } catch {
    // The next successful reset can clear an unavailable session preference.
  }
}

export function shouldShowComputerUseNotice(
  chatComputerUseEnabled: boolean,
  dismissed: boolean,
): boolean {
  return chatComputerUseEnabled && !dismissed;
}

function browserNoticeDismissed(): boolean {
  if (typeof window === "undefined") return false;
  return isComputerUseNoticeDismissed(window.localStorage, window.sessionStorage);
}

function emitNoticeChange(): void {
  window.dispatchEvent(new Event(COMPUTER_USE_NOTICE_CHANGED_EVENT));
}

function subscribeToNoticeChanges(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === COMPUTER_USE_NOTICE_PERMANENT_KEY ||
      event.key === COMPUTER_USE_NOTICE_SESSION_KEY
    ) {
      onStoreChange();
    }
  };
  window.addEventListener(COMPUTER_USE_NOTICE_CHANGED_EVENT, onStoreChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(COMPUTER_USE_NOTICE_CHANGED_EVENT, onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useComputerUseNoticeDismissed(): boolean {
  return React.useSyncExternalStore(subscribeToNoticeChanges, browserNoticeDismissed, () => false);
}

export function dismissComputerUseNotice(scope: ComputerUseNoticeDismissalScope): void {
  persistComputerUseNoticeDismissal(scope, window.localStorage, window.sessionStorage);
  emitNoticeChange();
}

export function restoreComputerUseNotice(): void {
  clearComputerUseNoticeDismissal(window.localStorage, window.sessionStorage);
  emitNoticeChange();
}
