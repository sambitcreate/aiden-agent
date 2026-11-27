// The live app bridge, run in a happy-dom page on an app origin with a
// stand-in parent and a fake importer (design mode v2 Phase 3a, D12, D13,
// S11). happy-dom has no layout, so `elementFromPoint` is stubbed.

import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

import { parseAppBridgeMessage, type AppBridgeMessage } from "../../../../renderer/shared/design-canvas/app-bridge-messages.js";
import { APP_BREAKPOINTS_SOURCE, APP_BRIDGE_SOURCE, appBridgeInjection } from "./app-bridge-source.js";

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

// Breakpoints (Phase 3c, S91). happy-dom parses `@media`, `@supports`,
// `@scope` and `@container` from `<style>`, but drops `@layer` blocks,
// `@import` and media nested in a style rule, so those come from stub sheets
// whose rule classes carry the browser's constructor names.

class CSSMediaRule {
  constructor(readonly media: { mediaText: string }, readonly cssRules: unknown[] = []) {}
}
class CSSLayerBlockRule {
  constructor(readonly cssRules: unknown[]) {}
}
class CSSStyleRule {
  constructor(readonly cssRules: unknown[]) {}
}
class CSSContainerRule {
  constructor(readonly cssRules: unknown[]) {}
}
class CSSSupportsRule {
  constructor(readonly cssRules: unknown[]) {}
}
class CSSImportRule {
  constructor(readonly media: { mediaText: string }, public styleSheet: unknown) {}
}
const media = (text: string, rules: unknown[] = []) => new CSSMediaRule({ mediaText: text }, rules);
const sheet = (cssRules: unknown[]) => ({ cssRules });
/** Adds stub sheets after the page's own. */
const withSheets = (...extra: unknown[]) => (window: Window) => {
  const document = window.document;
  let getter: (() => ArrayLike<unknown>) | undefined;
  for (let proto: object | null = document; proto && !getter; proto = Object.getPrototypeOf(proto)) {
    getter = Object.getOwnPropertyDescriptor(proto, "styleSheets")?.get;
  }
  assert.ok(getter, "happy-dom has document.styleSheets");
  Object.defineProperty(document, "styleSheets", {
    configurable: true,
    get: () => [...Array.from(getter!.call(document)), ...extra],
  });
};
const styled = (css: string) => `<!doctype html><html><head><style>${css}</style></head><body><main>App</main></body></html>`;
const VITE = `<script type="module" src="/@vite/client"></script>`;
const loaded = (view: Page) => {
  view.window.dispatchEvent(new view.window.Event("load"));
  return view;
};
const ticks = (view: Page) => of(view, "breakpoints").map((message) => message.widths);
const latest = (view: Page): number[] | undefined => ticks(view)[ticks(view).length - 1];

test("breakpoints come from min-width, max-width and range queries", () => {
  const view = loaded(page(styled(`
    @media (min-width: 768px) { a { color: red } }
    @media (max-width: 767.98px) { a { color: blue } }
    @media (width >= 64rem) { a { color: green } }
    @media screen and (min-width: 40em) and (orientation: landscape) { a { color: gold } }
    @media (min-height: 500px) { a { color: pink } }
  `)));
  const ready = view.sent.findIndex((message) => message.type === "ready");
  const first = view.sent.findIndex((message) => message.type === "breakpoints");
  assert.ok(ready !== -1 && first > ready, "the list follows ready");
  assert.deepEqual(ticks(view), [[640, 768, 1024]]);
});

test("a chained range gives both ends", () => {
  const view = loaded(page(styled(`@media (640px <= width < 1024px) { a { color: red } }`)));
  assert.deepEqual(latest(view), [640, 1024]);
});

test("nested media inside @supports, @layer and @scope count; container queries don't", () => {
  const css = `
    @supports (display: grid) { @media (max-width: 499px) { a { color: red } } }
    @scope (.card) { @media (min-width: 900px) { a { color: red } } }
    @container (min-width: 400px) { a { color: red } }
  `;
  const stub = sheet([
    new CSSLayerBlockRule([media("(min-width: 1200px)"), new CSSStyleRule([media("(width >= 40rem)")])]),
    new CSSContainerRule([media("(min-width: 333px)")]),
  ]);
  const view = loaded(page(styled(css), { before: withSheets(stub) }));
  assert.deepEqual(latest(view), [500, 640, 900, 1200], "a media rule nested in a style rule counts; one in a container doesn't");
});

test("an @import's media and its sheet count, without looping", () => {
  const opened: string[] = [];
  const counted = (name: string, rules: unknown[]) => ({
    get cssRules() {
      opened.push(name);
      return rules;
    },
  });
  const firstRules: unknown[] = [];
  const first = counted("first", firstRules);
  const second = counted("second", [new CSSImportRule({ mediaText: "all" }, first), media("(min-width: 500px)")]);
  firstRules.push(new CSSImportRule({ mediaText: "screen and (min-width: 900px)" }, second), media("(max-width: 299px)"));
  const view = loaded(page(PRICING, { before: withSheets(first, second) }));
  assert.deepEqual(latest(view), [300, 500, 900]);
  assert.deepEqual(opened.sort(), ["first", "second"], "each sheet of the cycle is read once");
});

test("a cross-origin sheet is skipped without throwing", () => {
  const foreign = {
    get cssRules(): never {
      throw new Error("SecurityError: cannot access rules");
    },
  };
  const foreignImport = sheet([new CSSImportRule({ mediaText: "(min-width: 700px)" }, foreign)]);
  const view = loaded(page(styled(`@media (min-width: 600px) { a { color: red } }`), { before: withSheets(foreign, foreignImport) }));
  assert.deepEqual(latest(view), [600, 700], "the import's own media still counts");
  assert.deepEqual(of(view, "error"), []);
});

test("the walk stops at its caps", () => {
  const read: number[] = [];
  const rules = Array.from({ length: 5000 }, (_, index) => ({
    get constructor() {
      read.push(index);
      return CSSMediaRule;
    },
    media: { mediaText: `(min-width: ${index < 4000 ? 300 : 250}px)` },
    cssRules: [],
  }));
  const view = loaded(page(styled(""), { before: withSheets(sheet(rules)) }));
  assert.deepEqual(latest(view), [300], "5 000 rules still give a result");
  assert.ok(read.length > 0 && read.every((index) => index < 4000), "rules past 4 000 aren't read");

  const opened: number[] = [];
  const many = Array.from({ length: 70 }, (_, index) => ({
    get cssRules() {
      opened.push(index);
      return [media(`(min-width: ${1000 + index}px)`)];
    },
  }));
  const sheets = loaded(page(PRICING, { before: withSheets(...many) }));
  assert.equal(new Set(opened).size, 64, "64 sheets are read");
  assert.deepEqual([...new Set(opened)].sort((a, b) => a - b), Array.from({ length: 64 }, (_, index) => index), "the first 64");
  assert.equal(latest(sheets)?.length, 24);

  let nested: unknown = media("(min-width: 3000px)");
  for (let level = 0; level < 9; level += 1) nested = new CSSSupportsRule([nested]);
  const deep = sheet([nested, new CSSSupportsRule([media("(min-width: 400px)")])]);
  const long = media(`(min-width: 800px)${" ".repeat(1100)}`);
  const capped = loaded(page(styled(""), { before: withSheets(deep, sheet([long])) }));
  assert.deepEqual(latest(capped), [400], "past depth 8 and over 1 024 characters, nothing is read");
});

test("out-of-range ticks are dropped and the list is capped at 24 before posting", () => {
  const css = [
    ...Array.from({ length: 30 }, (_, index) => `@media (min-width: ${300 + index * 10}px) { a { color: red } }`),
    `@media (min-width: 120px) { a { color: red } }`,
    `@media (min-width: 4500px) { a { color: red } }`,
  ].join("\n");
  const view = loaded(page(styled(css)));
  const widths = latest(view)!;
  assert.equal(widths.length, 24);
  assert.ok(widths.every((width) => width >= 200 && width <= 4000), String(widths));
  assert.deepEqual(widths, Array.from({ length: 24 }, (_, index) => 300 + index * 10), "the narrowest 24, in order");

  const edges = loaded(page(styled(`@media (min-width: 199.5px) { a {} } @media (max-width: 3999px) { a {} } @media (max-width: 4000px) { a {} }`)));
  assert.deepEqual(latest(edges), [200, 4000]);
});

test("removing every media rule sends an empty list once", async () => {
  const view = loaded(page(`<!doctype html><html><head>${VITE}<style id="app">@media (min-width: 768px) { a { color: red } }</style></head><body></body></html>`));
  await settle();
  view.window.dispatchEvent(new view.window.Event("load"));
  view.hot.fire("vite:afterUpdate");
  assert.deepEqual(ticks(view), [[768]], "an unchanged list isn't sent again");

  view.window.document.getElementById("app")!.textContent = "@media (min-width: 1024px) { a { color: red } }";
  view.hot.fire("vite:afterUpdate");
  view.window.document.getElementById("app")!.remove();
  view.hot.fire("vite:afterUpdate");
  view.hot.fire("vite:afterUpdate");
  assert.deepEqual(ticks(view), [[768], [1024], []]);
  assert.equal(of(view, "hmr").length, 4, "each update still posts hmr");

  const plain = loaded(page(PRICING));
  assert.deepEqual(ticks(plain), [], "a page with no breakpoints sends none");
});

test("breakpointsOf follows the tick table: min and >= ceil, max and > floor + 1, < ceil", () => {
  const { breakpointsOf } = new Function(`return ${APP_BREAKPOINTS_SOURCE}`)() as { breakpointsOf(text: string): number[] };
  const cases: Array<[string, number[]]> = [
    ["(min-width: 600.5px)", [601]],
    ["(max-width: 600.5px)", [601]],
    ["(max-width: 600px)", [601]],
    ["(width >= 600px)", [600]],
    ["(600px <= width)", [600]],
    ["(width <= 600px)", [601]],
    ["(600px >= width)", [601]],
    ["(width > 600px)", [601]],
    ["(600px < width)", [601]],
    ["(width < 600px)", [600]],
    ["(600px > width)", [600]],
    ["(1024px > width >= 640px)", [1024, 640]],
    ["(MIN-WIDTH: 48EM)", [768]],
    ["(min-width:30rem)", [480]],
    ["not all and (min-width: 300px), print and (max-width: 299px)", [300, 300]],
    ["((min-width: 500px) or (max-width: 200px))", [500, 201]],
    ["(min-height: 600px), (orientation: portrait), (min-aspect-ratio: 16/9)", []],
    ["(min-device-width: 600px), (min-width: 50%), (min-width: 40vw), (min-width: 600)", []],
    ["(min-width: ), (min-width 600px), (width = 600px), width >= 600px", []],
    ["", []],
  ];
  for (const [text, expected] of cases) assert.deepEqual(breakpointsOf(text), expected, text);
});
