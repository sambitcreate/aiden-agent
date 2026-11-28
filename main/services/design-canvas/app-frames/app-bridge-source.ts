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
// - `breakpoints` {widths}: the page's viewport-width breakpoints (Phase 3c,
//   S91), read from its same-origin style rules at `ready` (on `load`) and
//   after each Vite update, sent only when the list changed;
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

// Breakpoints (Phase 3c, S91), as a script evaluated to
// `{breakpointsOf, collect}`:
//
// - `breakpointsOf(mediaText)` gives a tick for each `width`, `min-width` or
//   `max-width` comparison in `px`, `em` or `rem` (em and rem are x 16, the
//   initial font size media queries use): `min-width: N` and `width >= N` tick
//   at ceil(N), `max-width: N`, `width <= N` and `width > N` at floor(N) + 1,
//   `width < N` at ceil(N), and `N op width` as its mirror. A chained range
//   `A op width op B` ticks once per side. Every other feature is ignored, and
//   each width part of an `and`/`or`/`,` list counts. It is a small tokenizer
//   over the bounded, lower-cased text, with no regular expression.
// - `collect(document)` walks `document.styleSheets` within caps (64 sheets,
//   4 000 rules, 8 levels of nesting, media text up to 1 024 characters),
//   skipping a sheet whose `cssRules` throws (cross-origin). It recurses into
//   media, supports, layer-block, scope and style rules (CSS nesting, as
//   Tailwind v4 emits its breakpoints) and into an import's sheet after its
//   own media list, with a WeakSet of visited sheets; container rules are
//   skipped. It returns the ticks in 200–4000, deduplicated, ascending, at
//   most 24.
//
// Rule kinds come from the constructor's name or the legacy `type`, so the
// walk reads rule classes an engine doesn't expose as globals.
export const APP_BREAKPOINTS_SOURCE = String.raw`(function () {
  "use strict";
  const MAX_SHEETS = 64;
  const MAX_RULES = 4000;
  const MAX_DEPTH = 8;
  const MAX_MEDIA_TEXT = 1024;
  const MIN_TICK = 200;
  const MAX_TICK = 4000;
  const MAX_TICKS = 24;
  const FONT_SIZE = 16;
  const Visited = WeakSet;

  const isDigit = (code) => code >= 48 && code <= 57;
  const isNameCode = (code) => (code >= 97 && code <= 122) || isDigit(code) || code === 45 || code === 95;
  const isSpace = (code) => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

  const tokenize = (text) => {
    const tokens = [];
    let index = 0;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      const next = text.charCodeAt(index + 1);
      if (isSpace(code)) {
        index += 1;
        continue;
      }
      const signed = (code === 43 || code === 45) && (isDigit(next) || (next === 46 && isDigit(text.charCodeAt(index + 2))));
      if (isDigit(code) || (code === 46 && isDigit(next)) || signed) {
        let end = index + 1;
        while (end < text.length && (isDigit(text.charCodeAt(end)) || text.charCodeAt(end) === 46)) end += 1;
        let unitEnd = end;
        while (unitEnd < text.length && isNameCode(text.charCodeAt(unitEnd))) unitEnd += 1;
        tokens.push({ kind: "number", value: Number(text.slice(index, end)), unit: text.slice(end, unitEnd) });
        index = unitEnd;
        continue;
      }
      if (isNameCode(code)) {
        let end = index + 1;
        while (end < text.length && isNameCode(text.charCodeAt(end))) end += 1;
        tokens.push({ kind: "name", text: text.slice(index, end) });
        index = end;
        continue;
      }
      if ((code === 60 || code === 62) && next === 61) {
        tokens.push({ kind: "op", text: text.slice(index, index + 2) });
        index += 2;
        continue;
      }
      tokens.push({ kind: code === 60 || code === 62 || code === 61 ? "op" : "char", text: text.charAt(index) });
      index += 1;
    }
    return tokens;
  };

  const pxOf = (token) => {
    if (!token || token.kind !== "number" || !isFinite(token.value)) return null;
    if (token.unit === "px") return token.value;
    if (token.unit === "em" || token.unit === "rem") return token.value * FONT_SIZE;
    return null;
  };
  // The first width where "width op N" changes.
  const tickOf = (op, token) => {
    const value = pxOf(token);
    if (value === null) return null;
    if (op === ">=" || op === "<") return Math.ceil(value);
    if (op === "<=" || op === ">") return Math.floor(value) + 1;
    return null;
  };
  const MIRROR = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
  const isWidth = (token) => !!token && token.kind === "name" && token.text === "width";
  const isOp = (token) => !!token && token.kind === "op" && token.text !== "=";
  const push = (out, tick) => {
    if (tick !== null) out.push(tick);
  };

  // One parenthesised feature, with no parentheses inside it.
  const feature = (group, out) => {
    const [first, second, third, fourth, fifth] = group;
    if (group.length === 3 && first.kind === "name" && second.kind === "char" && second.text === ":") {
      if (first.text === "min-width") push(out, tickOf(">=", third));
      else if (first.text === "max-width") push(out, tickOf("<=", third));
      return;
    }
    if (group.length === 3 && isOp(second)) {
      if (isWidth(first)) push(out, tickOf(second.text, third));
      else if (isWidth(third)) push(out, tickOf(MIRROR[second.text], first));
      return;
    }
    if (group.length === 5 && isWidth(third) && isOp(second) && isOp(fourth)) {
      push(out, tickOf(MIRROR[second.text], first));
      push(out, tickOf(fourth.text, fifth));
    }
  };

  const breakpointsOf = (mediaText) => {
    const out = [];
    if (typeof mediaText !== "string" || mediaText.length > MAX_MEDIA_TEXT) return out;
    const tokens = tokenize(mediaText.toLowerCase());
    let group = null;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.kind === "char" && token.text === "(") group = [];
      else if (token.kind === "char" && token.text === ")") {
        if (group) feature(group, out);
        group = null;
      } else if (group) group.push(token);
    }
    return out;
  };

  const nameOf = (rule) => {
    try {
      const constructor = rule.constructor;
      return constructor && typeof constructor.name === "string" ? constructor.name : "";
    } catch {
      return "";
    }
  };
  const typeOf = (rule) => {
    try {
      return typeof rule.type === "number" ? rule.type : 0;
    } catch {
      return 0;
    }
  };
  const GROUPS = { CSSSupportsRule: true, CSSLayerBlockRule: true, CSSScopeRule: true, CSSStyleRule: true };
  const kindOf = (rule) => {
    const name = nameOf(rule);
    if (name === "CSSContainerRule") return "";
    const type = typeOf(rule);
    if (name === "CSSImportRule" || type === 3) return "import";
    if (name === "CSSMediaRule" || type === 4) return "media";
    if (GROUPS[name] === true || type === 1 || type === 12) return "group";
    return "";
  };
  const attempt = (get) => {
    try {
      return get();
    } catch {
      return null;
    }
  };

  const collect = (doc) => {
    const marks = [];
    const visited = new Visited();
    let sheets = 0;
    let rules = 0;
    const mark = (mediaText) => {
      if (typeof mediaText !== "string" || mediaText.length > MAX_MEDIA_TEXT) return;
      const ticks = breakpointsOf(mediaText);
      for (let index = 0; index < ticks.length; index += 1) {
        const tick = ticks[index];
        if (tick >= MIN_TICK && tick <= MAX_TICK) marks[tick] = true;
      }
    };
    const visitList = (list, depth) => {
      if (!list || depth > MAX_DEPTH) return;
      const length = attempt(() => Number(list.length)) || 0;
      for (let index = 0; index < length && rules < MAX_RULES; index += 1) {
        rules += 1;
        const rule = attempt(() => list[index]);
        if (rule && typeof rule === "object") visitRule(rule, depth);
      }
    };
    const visitSheet = (sheet, depth) => {
      if (!sheet || typeof sheet !== "object" || sheets >= MAX_SHEETS || visited.has(sheet)) return;
      visited.add(sheet);
      sheets += 1;
      let list;
      try {
        list = sheet.cssRules;
      } catch {
        return;
      }
      visitList(list, depth);
    };
    const visitRule = (rule, depth) => {
      const kind = kindOf(rule);
      if (!kind) return;
      if (kind === "import" || kind === "media") mark(attempt(() => rule.media.mediaText));
      if (kind === "import") visitSheet(attempt(() => rule.styleSheet), depth + 1);
      else visitList(attempt(() => rule.cssRules), depth + 1);
    };
    const list = attempt(() => doc.styleSheets);
    const length = list ? attempt(() => Number(list.length)) || 0 : 0;
    for (let index = 0; index < length && sheets < MAX_SHEETS; index += 1) visitSheet(attempt(() => list[index]), 1);
    const widths = [];
    for (let width = MIN_TICK; width <= MAX_TICK && widths.length < MAX_TICKS; width += 1) {
      if (marks[width] === true) widths.push(width);
    }
    return widths;
  };

  return { breakpointsOf, collect };
})()`;

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
      // A dependency's or another origin's frame is skipped for the app's own code below it.
      if (path && Number.isInteger(number) && number > 0) return { path, line: number };
    }
    return null;
  };
  const report = (kind, message, stack) => {
    const payload = { kind, message: cut(message, MAX_MESSAGE) };
    const at = stack ? atOf(stack) : null;
    if (at) payload.at = at;
    send("error", payload);
  };

  // Breakpoints (S91): an unchanged list, or no breakpoints from the start,
  // isn't sent; a list that empties is sent once, as [].
  const breakpoints = ${APP_BREAKPOINTS_SOURCE};
  let sentBreakpoints = "";
  const postBreakpoints = () => {
    let widths;
    try {
      widths = breakpoints.collect(doc);
    } catch {
      return;
    }
    const key = widths.join(",");
    if (key === sentBreakpoints) return;
    sentBreakpoints = key;
    send("breakpoints", { widths });
  };

  const onReady = () => {
    send("ready", {});
    postBreakpoints();
  };
  if (doc.readyState === "complete") onReady();
  else window.addEventListener("load", onReady, { once: true });

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
          if (hot && typeof hot.on === "function") hot.on("vite:afterUpdate", () => {
            send("hmr", {});
            postBreakpoints();
          });
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
