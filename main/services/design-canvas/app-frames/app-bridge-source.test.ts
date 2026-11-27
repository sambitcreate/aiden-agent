// The live app bridge, run in a happy-dom page on an app origin with a
// stand-in parent and a fake importer (design mode v2 Phase 3a, D12, D13,
// S11). happy-dom has no layout, so `elementFromPoint` is stubbed.

import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

import { parseAppBridgeMessage, type AppBridgeMessage } from "../../../../renderer/shared/design-canvas/app-bridge-messages.js";
import { APP_BRIDGE_SOURCE, appBridgeInjection } from "./app-bridge-source.js";

const ORIGIN = "http://127.0.0.1:5173";

type Page = {
  window: Window;
  raw: Array<Record<string, unknown>>;
  sent: AppBridgeMessage[];
  imported: string[];
  run(nonce: string): void;
  send(data: unknown, source?: unknown): void;
  pointAt(selector: string | null): void;
  hot: { fire(event: string): void };
};

function page(html: string, options: { url?: string; nonce?: string | null; before?: (window: Window) => void } = {}): Page {
  const window = new Window({ url: options.url ?? `${ORIGIN}/pricing` });
  window.document.write(html);
  options.before?.(window);
  const raw: Array<Record<string, unknown>> = [];
  const sent: AppBridgeMessage[] = [];
  const parent = {
    postMessage(data: unknown) {
      const copy = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
      raw.push(copy);
      const message = parseAppBridgeMessage(copy, ORIGIN);
      assert.ok(message, `the canvas can read ${JSON.stringify(copy)}`);
      sent.push(message);
    },
  };
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  let pointed: unknown = null;
  window.document.elementFromPoint = () => pointed as never;
  const imported: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const importer = async (url: string) => {
    imported.push(url);
    return {
      createHotContext(owner: string) {
        assert.equal(owner, "/@aiden/bridge");
        return { on: (event: string, callback: () => void) => listeners.set(event, [...(listeners.get(event) ?? []), callback]) };
      },
    };
  };
  const run = (nonce: string) => {
    new Function("window", "importer", `return void (${APP_BRIDGE_SOURCE})(${JSON.stringify(nonce)}, importer)`)(window, importer);
  };
  if (options.nonce !== null) run(options.nonce ?? "nonce-1");
  return {
    window,
    raw,
    sent,
    imported,
    run,
    send(data, source = parent) {
      const event = new window.MessageEvent("message", { data });
      Object.defineProperty(event, "source", { value: source });
      window.dispatchEvent(event);
    },
    pointAt(selector) {
      pointed = selector ? window.document.querySelector(selector) : null;
    },
    hot: { fire: (event) => (listeners.get(event) ?? []).forEach((callback) => callback()) },
  };
}

const PRICING = `<!doctype html><html><head><title>Pricing</title></head><body><main><h1>Pricing</h1><p id="plan">Pro</p></main></body></html>`;
const of = <T extends AppBridgeMessage["type"]>(view: Page, type: T) =>
  view.sent.filter((message): message is Extract<AppBridgeMessage, { type: T }> => message.type === type);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("the once-guard installs once per nonce; a guessed value doesn't stop it; a new nonce installs again", () => {
  const view = page(PRICING);
  assert.equal(of(view, "route").length, 1);
  view.run("nonce-1");
  assert.equal(of(view, "route").length, 1, "the same document's second injection installs nothing");
  view.window.dispatchEvent(new view.window.Event("load"));
  assert.equal(of(view, "ready").length, 1, "one ready once the page has loaded");
  view.run("nonce-2");
  assert.equal(of(view, "route").length, 2, "a new document's nonce installs");

  const guessed = page(PRICING, { before: (window) => Object.assign(window, { __aidenAppBridge: "guess" }) });
  assert.equal(of(guessed, "route").length, 1);
});

test("the injected expression's value is undefined, even with Promise.prototype.then replaced", () => {
  const window = new Window({ url: `${ORIGIN}/` });
  Object.defineProperty(window, "parent", { value: { postMessage() {} }, configurable: true });
  const then = Promise.prototype.then;
  let value: unknown = "unset";
  try {
    Promise.prototype.then = function () {
      return "page-controlled";
    } as unknown as typeof then;
    value = new Function("window", `return ${appBridgeInjection("n")}`)(window);
  } finally {
    Promise.prototype.then = then;
  }
  assert.equal(value, undefined);
});

test("the bridge answers only its parent, and only aiden-app requests", () => {
  const view = page(PRICING);
  view.pointAt("h1");
  view.send({ type: "aiden-app:pick-at", requestId: "r1", x: 1, y: 1 }, { postMessage() {} });
  view.send({ type: "aiden-design:pick-at", requestId: "r2", x: 1, y: 1 });
  assert.deepEqual(of(view, "picked"), []);
  view.send({ type: "aiden-app:pick-at", requestId: "r3", x: 1, y: 1 });
  assert.deepEqual(of(view, "picked").map((message) => message.requestId), ["r3"]);
  assert.ok(view.raw.every((message) => String(message.type).startsWith("aiden-app:")), "every message is prefixed");
});

test("the shared core answers pick-at and locate as the design bridge does", () => {
  const view = page(PRICING);
  view.pointAt("#plan");
  view.send({ type: "aiden-app:pick-at", requestId: "r1", x: 3, y: 4 });
  const [picked] = of(view, "picked");
  assert.equal(picked?.element?.selector, "#plan");
  assert.equal(picked?.element?.text, "Pro");
  assert.deepEqual(picked?.point, [3, 4]);
  view.send({ type: "aiden-app:locate", requestId: "l1", items: [{ commentId: "c1", selector: "#plan", text: "Pro", tag: "p" }] });
  const [anchors] = of(view, "anchors");
  assert.equal(anchors?.results.c1?.candidates[0]?.selectorMatch, true);
});

test("route posts the path at start and after pushState, replaceState and popstate; a long path is cut", () => {
  const view = page(PRICING, { url: `${ORIGIN}/pricing?plan=pro` });
  view.window.history.pushState({}, "", "/checkout");
  view.window.history.replaceState({}, "", "/checkout?step=2");
  view.window.happyDOM.setURL(`${ORIGIN}/back`);
  view.window.dispatchEvent(new view.window.PopStateEvent("popstate", { state: null }));
  view.window.history.pushState({}, "", `/${"x".repeat(3000)}`);
  const paths = of(view, "route").map((message) => message.path);
  assert.deepEqual(paths.slice(0, 4), ["/pricing?plan=pro", "/checkout", "/checkout?step=2", "/back"]);
  assert.equal(paths[4]?.length, 2048);
});

test("errors: thrown, rejected, Vite's and Next.js's overlays and a failed module each post their kind", async () => {
  const view = page(`${PRICING.replace("</head>", '<script type="module" src="/src/main.tsx"></script></head>')}`);
  const own = Object.assign(new Error("boom"), { stack: `Error: boom\n    at render (${ORIGIN}/src/Pricing.tsx?t=1:13:5)\n    at x (${ORIGIN}/src/main.tsx:1:1)` });
  view.window.dispatchEvent(new view.window.ErrorEvent("error", { message: "Uncaught Error: boom", error: own }));
  const foreign = Object.assign(new Error("far"), { stack: "Error: far\n    at y (https://cdn.example/lib.js:4:2)" });
  view.window.dispatchEvent(new view.window.ErrorEvent("error", { message: "m".repeat(2000), error: foreign }));
  const rejection = new view.window.Event("unhandledrejection");
  Object.defineProperty(rejection, "reason", { value: new Error("nope") });
  view.window.dispatchEvent(rejection);
  view.window.document.body.appendChild(view.window.document.createElement("vite-error-overlay"));
  view.window.document.body.appendChild(view.window.document.createElement("nextjs-portal"));
  view.window.document.querySelector("script[type=module]")!.dispatchEvent(new view.window.Event("error"));
  await settle();
  const errors = of(view, "error");
  // The overlays are seen by a MutationObserver, so after the rest.
  assert.deepEqual(errors.map((message) => message.kind).sort(), ["error", "error", "module", "overlay", "overlay", "rejection"]);
  assert.deepEqual(errors[0]!.at, { path: "src/Pricing.tsx", line: 13 });
  assert.equal(errors[1]!.message.length, 500, "a 2 000-character message is cut");
  assert.equal(errors[1]!.at, undefined, "a frame on another origin gives no at");
  assert.equal(errors[2]!.message, "nope");
  assert.match(errors.find((message) => message.kind === "module")!.message, /\/src\/main\.tsx/u);
});

test("an error thrown inside a dependency points at the first line of the app's own code below it", async () => {
  const view = page(PRICING);
  const stacks = [
    `Error: bad input\n    at parse (${ORIGIN}/node_modules/.vite/deps/zod.js?v=1:50:11)\n    at Pricing (${ORIGIN}/src/Pricing.tsx:12:5)`,
    `Error: x\n    at a (${ORIGIN}/@fs/Users/me/lib.js:3:1)\n    at b (https://cdn.example/lib.js:4:2)\n    at c (${ORIGIN}/src/Plans.tsx:40:9)`,
    `Error: y\n    at a (${ORIGIN}/node_modules/react-dom.js:1:1)\n    at b (https://cdn.example/lib.js:4:2)`,
  ];
  for (const stack of stacks) {
    view.window.dispatchEvent(new view.window.ErrorEvent("error", { message: "boom", error: Object.assign(new Error("boom"), { stack }) }));
  }
  await settle();
  assert.deepEqual(
    of(view, "error").map((message) => message.at),
    [{ path: "src/Pricing.tsx", line: 12 }, { path: "src/Plans.tsx", line: 40 }, undefined],
  );
});

test("hmr: only the page's own Vite client is imported, and its afterUpdate posts hmr", async () => {
  const vite = page(`<!doctype html><html><head><script type="module" src="/base/@vite/client"></script></head><body></body></html>`, { url: `${ORIGIN}/base/pricing` });
  await settle();
  assert.deepEqual(vite.imported, [`${ORIGIN}/base/@vite/client`]);
  vite.hot.fire("vite:afterUpdate");
  assert.equal(of(vite, "hmr").length, 1);

  for (const src of [null, "https://evil.example/@vite/client", "//evil.example/@vite/client"]) {
    const script = src === null ? "" : `<script type="module" src="${src}"></script>`;
    const other = page(`<!doctype html><html><head>${script}</head><body></body></html>`);
    await settle();
    assert.deepEqual(other.imported, [], String(src));
  }
});

test("an unmodified Escape posts escape; Shift+Escape doesn't", () => {
  const view = page(PRICING);
  view.window.document.body.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Escape", shiftKey: true, bubbles: true }));
  assert.equal(of(view, "escape").length, 0);
  view.window.document.body.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(of(view, "escape").length, 1);
});

test("set-scheme turns dark on and puts back exactly what it changed", () => {
  const view = page(PRICING);
  const root = view.window.document.documentElement;
  view.send({ type: "aiden-app:set-scheme", dark: true });
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.ok(root.classList.contains("dark"));
  view.send({ type: "aiden-app:set-scheme", dark: false });
  assert.equal(root.style.colorScheme, "");
  assert.equal(root.hasAttribute("data-theme"), false);
  assert.equal(root.classList.contains("dark"), false);

  const own = page(PRICING.replace("<html>", '<html class="dark" data-theme="brand">'));
  const ownRoot = own.window.document.documentElement;
  own.send({ type: "aiden-app:set-scheme", dark: true });
  assert.equal(ownRoot.getAttribute("data-theme"), "dark");
  own.send({ type: "aiden-app:set-scheme", dark: false });
  assert.ok(ownRoot.classList.contains("dark"), "the page's own class stays");
  assert.equal(ownRoot.getAttribute("data-theme"), "brand", "the page's own data-theme comes back");
});

test("source-at answers through the React walk, and with no element, owners only", async () => {
  const view = page(PRICING);
  function App() {}
  function Pricing() {}
  const owner = { type: App, _debugOwner: null };
  const component = { type: Pricing, _debugOwner: owner, _debugSource: { fileName: "src/Pricing.tsx", lineNumber: 13 }, return: owner };
  const fiber = { type: "h1", return: component, _debugOwner: component };
  Object.assign(view.window.document.querySelector("h1")!, { "__reactFiber$abc": fiber });
  view.pointAt("h1");
  view.send({ type: "aiden-app:source-at", requestId: "s1", x: 1, y: 1 });
  view.pointAt(null);
  view.send({ type: "aiden-app:source-at", requestId: "s2", x: 1, y: 1 });
  await settle();
  const sources = of(view, "source");
  assert.deepEqual(sources.find((message) => message.requestId === "s1"), {
    type: "source", requestId: "s1", component: "Pricing", owners: ["App"], path: "src/Pricing.tsx", line: 13,
  });
  assert.deepEqual(sources.find((message) => message.requestId === "s2"), { type: "source", requestId: "s2", owners: [] });
});
