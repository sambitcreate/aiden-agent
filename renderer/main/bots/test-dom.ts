import { Window } from "happy-dom";

const GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLImageElement",
  "HTMLDivElement",
  "HTMLSpanElement",
  "HTMLFormElement",
  "SVGElement",
  "Text",
  "DocumentFragment",
  "ShadowRoot",
  "NodeFilter",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "InputEvent",
  "CustomEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "localStorage",
  "sessionStorage",
] as const;

/**
 * Installs one happy-dom window as the global DOM so Testing Library can mount
 * Bot components under `tsx --test`. Import this module before
 * `@testing-library/react`; the install is idempotent per process.
 */
export function installBotTestDom(): Window {
  const holder = globalThis as { __aidenBotTestWindow?: Window };
  if (holder.__aidenBotTestWindow) return holder.__aidenBotTestWindow;
  // Tests never load network resources; a pending fetch would keep the
  // test process alive after its last test.
  const window = new Window({
    url: "http://localhost/",
    settings: {
      disableJavaScriptFileLoading: true,
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  const source = window as unknown as Record<string, unknown>;
  for (const key of GLOBAL_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        typeof value === "function" && /^[a-z]/u.test(key)
          ? (value as (...args: unknown[]) => unknown).bind(window)
          : value,
    });
  }
  Object.defineProperty(globalThis, "self", { configurable: true, writable: true, value: window });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  holder.__aidenBotTestWindow = window;
  return window;
}

/** Answers for reads every Bot surface makes, unless a test overrides them. */
const BOT_TEST_IPC_DEFAULTS: Record<string, (...args: unknown[]) => unknown> = {
  "bots:getCanonicalPhoto": () => null,
};

export interface BotTestIpcCall {
  channel: string;
  args: unknown[];
}

/**
 * Replaces the preload IPC bridge with an in-memory fake. Each invoke is
 * recorded in order and answered by `handlers[channel]`; an unhandled channel
 * rejects the way Electron does for a missing `ipcMain.handle`.
 */
export function installBotTestIpc(
  handlers: Record<string, (...args: unknown[]) => unknown> = {},
): BotTestIpcCall[] {
  const calls: BotTestIpcCall[] = [];
  (window as unknown as { aidenAPI: unknown }).aidenAPI = {
    ipc: {
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args });
        const handler = handlers[channel] ?? BOT_TEST_IPC_DEFAULTS[channel];
        if (!handler) {
          throw new Error(
            `Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`,
          );
        }
        return handler(...args);
      },
      onNotification: () => () => undefined,
    },
  };
  return calls;
}

installBotTestDom();
installBotTestIpc();
