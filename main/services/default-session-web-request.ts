// The one owner of the default session's `webRequest` (design mode v2 Phase
// 3a, §11 item 4, D6). Electron keeps a single listener per event per
// session, so two modules that each set one would silently replace each
// other. Every default-session subscriber registers here by name instead:
//
// - before-request subscribers run in order and the first `"cancel"` wins;
//   one that throws counts as a cancel (fail closed) and is logged once a
//   minute with its name;
// - headers subscribers run in order, each seeing the previous one's
//   headers; one that throws changes nothing;
// - the Electron listener exists only while a subscriber of that event does,
//   so with none the session has no listener at all (the flag-off path is
//   exactly what it was before 3a).
//
// `check:aiden-rules`' `default-session-owner` rule keeps other modules off
// the default session's setters; `guardSetters` (non-packaged builds) also
// replaces them with throwing stubs, for a session reached dynamically.

export type BeforeRequestHandler = (details: Electron.OnBeforeRequestListenerDetails) => "cancel" | undefined;
export type HeadersHandler = (
  details: Electron.OnHeadersReceivedListenerDetails,
  headers: Record<string, string[]>,
) => Record<string, string[]> | undefined;

export interface DefaultSessionWebRequest {
  onBeforeRequest(name: string, handler: BeforeRequestHandler): () => void;
  onHeadersReceived(name: string, handler: HeadersHandler): () => void;
}

type BeforeListener = (
  details: Electron.OnBeforeRequestListenerDetails,
  callback: (response: Electron.CallbackResponse) => void,
) => void;
type HeadersListener = (
  details: Electron.OnHeadersReceivedListenerDetails,
  callback: (response: Electron.HeadersReceivedResponse) => void,
) => void;

export type WebRequestTarget = {
  onBeforeRequest(listener: BeforeListener | null): void;
  onHeadersReceived(listener: HeadersListener | null): void;
};

const GUARDED_SETTERS = [
  "onBeforeRequest",
  "onBeforeSendHeaders",
  "onSendHeaders",
  "onHeadersReceived",
  "onResponseStarted",
  "onBeforeRedirect",
  "onCompleted",
  "onErrorOccurred",
] as const;
const LOG_EVERY_MS = 60_000;
const claimed = new WeakSet<object>();
let current: DefaultSessionWebRequest | null = null;

/** The dispatcher `main/index.ts` claimed for the default session, once it has. */
export function defaultSessionWebRequest(): DefaultSessionWebRequest | null {
  return current;
}

export function claimDefaultSessionWebRequest(
  webRequest: WebRequestTarget,
  options: {
    log?: (event: string, fields: Record<string, unknown>) => void;
    guardSetters?: boolean;
    now?: () => number;
  } = {},
): DefaultSessionWebRequest {
  if (claimed.has(webRequest)) {
    throw new Error("The default session's webRequest is already owned by default-session-web-request.ts.");
  }
  claimed.add(webRequest);
  const setBefore = webRequest.onBeforeRequest.bind(webRequest);
  const setHeaders = webRequest.onHeadersReceived.bind(webRequest);
  if (options.guardSetters) {
    for (const name of GUARDED_SETTERS) {
      if (typeof (webRequest as Record<string, unknown>)[name] !== "function") continue;
      Object.defineProperty(webRequest, name, {
        configurable: true,
        writable: true,
        value: () => {
          throw new Error("Use default-session-web-request.ts to subscribe to the default session's webRequest.");
        },
      });
    }
  }
  const now = options.now ?? Date.now;
  const lastLogged = new Map<string, number>();
  const logFailure = (name: string, error: unknown) => {
    const at = now();
    const last = lastLogged.get(name);
    if (last !== undefined && at - last < LOG_EVERY_MS) return;
    lastLogged.set(name, at);
    options.log?.("default-session-subscriber-failed", { subscriber: name, error: error instanceof Error ? error.name : "unknown" });
  };

  const before: Array<{ name: string; handler: BeforeRequestHandler }> = [];
  const headers: Array<{ name: string; handler: HeadersHandler }> = [];

  const beforeListener: BeforeListener = (details, callback) => {
    for (const { name, handler } of before.slice()) {
      let verdict: "cancel" | undefined;
      try {
        verdict = handler(details);
      } catch (error) {
        logFailure(name, error);
        verdict = "cancel";
      }
      if (verdict === "cancel") {
        callback({ cancel: true });
        return;
      }
    }
    callback({});
  };
  const headersListener: HeadersListener = (details, callback) => {
    let result = details.responseHeaders ?? {};
    let changed = false;
    for (const { name, handler } of headers.slice()) {
      try {
        const next = handler(details, result);
        if (next) {
          result = next;
          changed = true;
        }
      } catch (error) {
        logFailure(name, error);
      }
    }
    callback(changed ? { responseHeaders: result } : {});
  };

  function subscribe<T>(list: Array<{ name: string; handler: T }>, name: string, handler: T, apply: (on: boolean) => void) {
    if (list.some((entry) => entry.name === name)) {
      throw new Error(`A default-session webRequest subscriber named "${name}" already exists.`);
    }
    const entry = { name, handler };
    list.push(entry);
    if (list.length === 1) apply(true);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) apply(false);
    };
  }

  const dispatcher: DefaultSessionWebRequest = {
    onBeforeRequest: (name, handler) =>
      subscribe(before, name, handler, (on) => setBefore(on ? beforeListener : null)),
    onHeadersReceived: (name, handler) =>
      subscribe(headers, name, handler, (on) => setHeaders(on ? headersListener : null)),
  };
  current = dispatcher;
  return dispatcher;
}
