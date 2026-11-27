import { randomUUID } from "node:crypto";

export function fakeDocumentOwner() {
  let destroyed = false;
  const listeners = new Set<() => void>();
  return {
    documentId: randomUUID(),
    isDestroyed: () => destroyed,
    onInvalidated: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invalidate: () => {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
}
