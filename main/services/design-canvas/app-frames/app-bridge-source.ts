// The live app bridge (design mode v2 Phase 3a, D12, D13, S11): the script
// main runs in each admitted app frame's own document, in the page's main
// world, through `webFrameMain.executeJavaScript(code, false)`.
//
// It is a function of `(nonce, importer)`. The nonce is per frame document
// (main makes a new one on each committed navigation), so the two injection
// points install once per document; the importer is a closure argument, so the
// page can't intercept it. The injected expression is `void (...)(...)`, which
// evaluates to `undefined` whatever the page did to `Promise` first.
//
// Everything here is page-reported and untrusted: the page runs first and can
// replace any global. The canvas parses each message defensively
// (`parseAppBridgeMessage`), checks `event.source` and rate-limits; nothing
// security-related reads the bridge.
//
// Messages to the canvas (`aiden-app:` + type):
// - `ready` once the page has loaded;
// - `route` {path}: pathname plus search, at most 2 048 characters, at start
//   and after each `pushState`, `replaceState` and `popstate`;
// - `error` {kind, message, at?}: a thrown error, an unhandled rejection, the
//   Vite or Next.js error overlay, or a module that failed to load. The message
//   is at most 500 characters; `at` is the first stack frame on the frame's own
//   origin, as a path relative to it and a line;
// - `hmr` {}: Vite applied an update (D13);
// - `escape` {}: an unmodified Escape keydown, so the canvas can leave the frame;
// - `source` {requestId, component?, owners, path?, line?}: the React
//   component under a point (D14);
// - `picked` and `anchors`, as the design bridge's core sends them.
// Messages from the canvas:
// - `hover-at`, `pick-at`, `locate`, `highlight`, as the design bridge's core;
// - `source-at` {requestId, x, y};
// - `set-scheme` {dark}: sets `color-scheme`, `data-theme="dark"` and
//   `class="dark"` on `<html>`, and puts back exactly what it changed when off.

import { DESIGN_BRIDGE_CORE_SOURCE } from "../bridge-core-source.js";
import { REACT_SOURCE_WALK_SOURCE } from "./react-source-walk.js";

export const APP_BRIDGE_PREFIX = "aiden-app:";

export const APP_BRIDGE_SOURCE = `(nonce, importer) => {
  "use strict";
  try {
    if (window.__aidenAppBridge === nonce) return;
    Object.defineProperty(window, "__aidenAppBridge", { value: nonce, configurable: true, writable: true });
  } catch {}
  const host = window.parent;
  const doc = window.document;
  const PREFIX = ${JSON.stringify(APP_BRIDGE_PREFIX)};
  if (!host || host === window) return;
  const send = (type, payload) => {
    try {
      host.postMessage(Object.assign({ type: PREFIX + type }, payload), "*");
    } catch {}
  };
${DESIGN_BRIDGE_CORE_SOURCE}
  const MAX_ROUTE = 2048;
  const MAX_MESSAGE = 500;
  const MAX_PATH = 512;
  const origin = () => {
    try {
      return String(window.location.origin);
    } catch {
      return "";
    }
  };
  const cut = (value, max) => {
    let text = "";
    try {
      text = String(value === undefined || value === null ? "" : value);
    } catch {}
    return text.slice(0, max);
  };
  // A path on the frame's own origin, relative to it, that the canvas may show
  // and Phase 4 may resolve under the app root.
  const ownPath = (url) => {
    let parsed;
    try {
      parsed = new window.URL(url);
    } catch {
      return null;
    }
    if (parsed.origin !== origin()) return null;
    let path;
    try {
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
    if (/^\\/(?:@fs|@id|node_modules)\\//.test(path) || path.split("/").indexOf("..") !== -1 || path.indexOf("\\\\") !== -1) return null;
    path = path.replace(/^\\/+/, "");
    return path && path.length <= MAX_PATH ? path : null;
  };
  const atOf = (stack) => {
    const lines = cut(stack, 20000).split("\\n");
    for (const line of lines) {
      const match = /((?:https?):\\/\\/[^\\s()]+?):(\\d+):(\\d+)\\)?\\s*$/.exec(line);
      if (!match) continue;
      const path = ownPath(match[1]);
      const number = Number(match[2]);
      return path && Number.isInteger(number) && number > 0 ? { path, line: number } : null;
    }
    return null;
  };
  const report = (kind, message, stack) => {
    const payload = { kind, message: cut(message, MAX_MESSAGE) };
    const at = stack ? atOf(stack) : null;
    if (at) payload.at = at;
    send("error", payload);
  };

  if (doc.readyState === "complete") send("ready", {});
  else window.addEventListener("load", () => send("ready", {}), { once: true });

  const postRoute = () => {
    try {
      send("route", { path: cut(window.location.pathname + window.location.search, MAX_ROUTE) });
    } catch {}
  };
  const history = window.history;
  for (const name of ["pushState", "replaceState"]) {
    const original = history && history[name];
    if (typeof original !== "function") continue;
    try {
      history[name] = function () {
        const result = original.apply(this, arguments);
        postRoute();
        return result;
      };
    } catch {}
  }
  window.addEventListener("popstate", postRoute);
  postRoute();

  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target !== window && target.nodeType === 1) {
      if (tagOf(target) === "script" && String(target.getAttribute("type") || "").toLowerCase() === "module") {
        report("module", "A module failed to load: " + cut(target.getAttribute("src"), MAX_MESSAGE));
      }
      return;
    }
    const error = event.error;
    report("error", event.message || (error && error.message) || "Error", error && error.stack);
  }, true);
  window.addEventListener("unhandledrejection", (event) => {
    let reason;
    try {
      reason = event.reason;
    } catch {}
    let message = "";
    let stack = null;
    try {
      message = reason && typeof reason === "object" && "message" in reason ? reason.message : reason;
      stack = reason && typeof reason === "object" ? reason.stack : null;
    } catch {}
    report("rejection", cut(message, MAX_MESSAGE) || "Unhandled rejection", stack);
  });
  const overlays = new WeakSet();
  const overlayText = (element) => {
    try {
      const shadow = element.shadowRoot;
      const body = shadow && shadow.querySelector(".message-body");
      return squash((body || shadow || element).textContent);
    } catch {
      return "";
    }
  };
  const checkOverlay = (node) => {
    if (!node || node.nodeType !== 1 || overlays.has(node)) return;
    const tag = tagOf(node);
    if (tag !== "vite-error-overlay" && tag !== "nextjs-portal") return;
    overlays.add(node);
    report("overlay", overlayText(node) || (tag === "vite-error-overlay" ? "Vite error overlay" : "Next.js error overlay"));
  };
  for (const node of doc.querySelectorAll("vite-error-overlay, nextjs-portal")) checkOverlay(node);
  if (typeof window.MutationObserver === "function" && doc.documentElement) {
    new window.MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) checkOverlay(node);
      }
    }).observe(doc.documentElement, { childList: true, subtree: true });
  }

  // HMR (D13): only the page's own Vite client, on the frame's own origin.
  try {
    const client = doc.querySelector('script[type="module"][src$="/@vite/client"]');
    if (client && typeof importer === "function") {
      const url = new window.URL(client.getAttribute("src"), window.location.href);
      if (url.origin === origin()) {
        Promise.resolve(importer(url.href)).then((module) => {
          const hot = module && typeof module.createHotContext === "function" ? module.createHotContext("/@aiden/bridge") : null;
          if (hot && typeof hot.on === "function") hot.on("vite:afterUpdate", () => send("hmr", {}));
        }).catch(() => {});
      }
    }
  } catch {}

  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) send("escape", {});
  }, true);

  // The Dark switch: put back exactly what was changed.
  const scheme = { style: null, theme: null, cls: false };
  const setScheme = (dark) => {
    const root = doc.documentElement;
    if (!root) return;
    if (dark) {
      if (!scheme.style && root.style.colorScheme !== "dark") {
        scheme.style = { prior: root.style.colorScheme || "" };
        root.style.colorScheme = "dark";
      }
      if (!scheme.theme && root.getAttribute("data-theme") !== "dark") {
        scheme.theme = { prior: root.getAttribute("data-theme") };
        root.setAttribute("data-theme", "dark");
      }
      if (!scheme.cls && !root.classList.contains("dark")) {
        scheme.cls = true;
        root.classList.add("dark");
      }
      return;
    }
    if (scheme.style) {
      if (root.style.colorScheme === "dark") root.style.colorScheme = scheme.style.prior;
      scheme.style = null;
    }
    if (scheme.theme) {
      if (root.getAttribute("data-theme") === "dark") {
        if (scheme.theme.prior === null) root.removeAttribute("data-theme");
        else root.setAttribute("data-theme", scheme.theme.prior);
      }
      scheme.theme = null;
    }
    if (scheme.cls) {
      root.classList.remove("dark");
      scheme.cls = false;
    }
  };

  const reactWalk = ${REACT_SOURCE_WALK_SOURCE};
  const fetchText = (url) => window.fetch(url, { credentials: "same-origin" }).then((response) => response.text());
  const sourceAt = (data) => {
    const requestId = data.requestId;
    const element = at(data.x, data.y);
    if (!element) {
      send("source", { requestId, owners: [] });
      return;
    }
    Promise.resolve()
      .then(() => reactWalk.walk(element, origin(), fetchText))
      .then((result) => send("source", Object.assign({}, result, { requestId })))
      .catch(() => send("source", { requestId, owners: [] }));
  };

  window.addEventListener("message", (event) => {
    if (event.source !== host) return;
    const data = event.data;
    if (!data || typeof data !== "object" || typeof data.type !== "string") return;
    const type = data.type.indexOf(PREFIX) === 0 ? data.type.slice(PREFIX.length) : "";
    if (!type || handleCore(type, data)) return;
    if (type === "source-at") sourceAt(data);
    else if (type === "set-scheme") setScheme(data.dark === true);
  });
}`;

/** The expression main runs in an app frame: its value is always `undefined`. */
export function appBridgeInjection(nonce: string): string {
  return `void (${APP_BRIDGE_SOURCE})(${JSON.stringify(nonce)}, (url) => import(url))`;
}
