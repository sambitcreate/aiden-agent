interface WindowEvents {
  addEventListener(type: "focus", listener: () => void): void;
  removeEventListener(type: "focus", listener: () => void): void;
}

interface DocumentEvents {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export function installAccessibilityRefresh(
  refresh: () => void,
  windowEvents: WindowEvents = window,
  documentEvents: DocumentEvents = document,
): () => void {
  const onFocus = () => refresh();
  const onVisibility = () => {
    if (documentEvents.visibilityState === "visible") refresh();
  };
  windowEvents.addEventListener("focus", onFocus);
  documentEvents.addEventListener("visibilitychange", onVisibility);
  return () => {
    windowEvents.removeEventListener("focus", onFocus);
    documentEvents.removeEventListener("visibilitychange", onVisibility);
  };
}
