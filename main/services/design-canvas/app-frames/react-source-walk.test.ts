// The React source walk the live-app bridge runs in the page (D14): the
// source-map decoder against a real Vite/Oxc map, and the walk over fake
// React 18 and React 19 fibers in happy-dom.

import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { transformWithOxc } from "vite";
import { decodeSourceMapLine, walkReactSource } from "./react-source-walk.js";

const ORIGIN = "http://127.0.0.1:5173";

const MODULE = ["export function Title() {", "  return <h1 className=\"title\">Pricing</h1>;", "}"].join("\n");

async function compiled() {
  const result = await transformWithOxc(MODULE, "/app/src/Title.tsx", {
    lang: "tsx",
    jsx: { runtime: "automatic", development: true },
    sourcemap: true,
  });
  assert.ok(result.map, "Oxc returned a source map");
  return { code: result.code, map: result.map as unknown as { mappings: string; sources: string[] } };
}

function position(code: string, needle: string): { line: number; column: number } {
  const lines = code.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const at = lines[index].indexOf(needle);
    if (at >= 0) return { line: index + 1, column: at + 1 };
  }
  throw new Error(`${needle} isn't in the compiled module`);
}

test("decodeSourceMapLine maps a generated position of a real Oxc JSX map to the original line", async () => {
  const { code, map } = await compiled();
  const h1 = position(code, '"h1"');
  const mapped = decodeSourceMapLine(map, h1.line, h1.column);
  assert.ok(mapped, "the h1 call maps");
  assert.equal(mapped.line, 2, "the <h1> is on the module's second line");
  assert.match(mapped.source, /Title\.tsx$/u);

  const header = position(code, "function Title");
  assert.equal(decodeSourceMapLine(map, header.line, header.column)?.line, 1);
});

test("decodeSourceMapLine refuses positions and maps it can't read", () => {
  assert.equal(decodeSourceMapLine({ mappings: "AAAA", sources: ["a.ts"] }, 5, 1), null, "a line past the mappings");
  assert.equal(decodeSourceMapLine({ mappings: "AAAA", sources: ["a.ts"] }, 0, 1), null, "line 0");
  assert.equal(decodeSourceMapLine({ mappings: "!!!!", sources: ["a.ts"] }, 1, 1), null, "not VLQ");
  assert.equal(decodeSourceMapLine({ mappings: 7, sources: [] } as never, 1, 1), null, "no mappings string");
});

type Fiber = {
  type: unknown;
  return?: Fiber | null;
  _debugOwner?: Fiber | null;
  _debugSource?: { fileName: string; lineNumber: number };
  _debugStack?: Error;
};

function page(html: string) {
  const window = new Window({ url: `${ORIGIN}/pricing` });
  window.document.write(html);
  return window;
}

function attach(element: unknown, fiber: Fiber) {
  Object.defineProperty(element as object, "__reactFiber$abc123", { value: fiber, enumerable: true });
}

function App() {}
function Layout() {}
function Pricing() {}

function components() {
  const app: Fiber = { type: App, return: null, _debugOwner: null };
  const layout: Fiber = { type: Layout, return: app, _debugOwner: app };
  const pricing: Fiber = { type: Pricing, return: layout, _debugOwner: layout };
  return { app, layout, pricing };
}

const noFetch = async () => {
  throw new Error("no fetch expected");
};

test("a React 18 fiber gives the component, its owners and _debugSource's path and line", async () => {
  const window = page("<main><h1>Pricing</h1></main>");
  const h1 = window.document.querySelector("h1");
  const { pricing } = components();
  attach(h1, { type: "h1", return: pricing, _debugOwner: pricing, _debugSource: { fileName: "src/Pricing.tsx", lineNumber: 14 } });
  const result = await walkReactSource(h1, ORIGIN, noFetch);
  assert.deepEqual(result, { component: "Pricing", owners: ["Layout", "App"], path: "src/Pricing.tsx", line: 14 });
});

test("a React 18 absolute file system path gives no path", async () => {
  const window = page("<h1>Pricing</h1>");
  const h1 = window.document.querySelector("h1");
  const { pricing } = components();
  attach(h1, { type: "h1", return: pricing, _debugSource: { fileName: "/Users/me/app/src/Pricing.tsx", lineNumber: 14 } });
  const result = await walkReactSource(h1, ORIGIN, noFetch);
  assert.equal(result.component, "Pricing");
  assert.equal(result.path, undefined);
});

test("a React 19 fiber's _debugStack is mapped through the module's inline source map", async () => {
  const { code, map } = await compiled();
  const h1Position = position(code, '"h1"');
  const moduleText = `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`;
  const stack = [
    "Error: react-stack-top-frame",
    `    at exports.jsxDEV (${ORIGIN}/.vite-cache/deps/react_jsx-dev-runtime.js?v=1:250:30)`,
    `    at Pricing (${ORIGIN}/src/Pricing.tsx?t=1:${h1Position.line}:${h1Position.column})`,
    `    at Object.react_stack_bottom_frame (${ORIGIN}/node_modules/.vite/deps/react-dom_client.js?v=1:100:1)`,
  ].join("\n");
  const window = page("<h1>Pricing</h1>");
  const h1 = window.document.querySelector("h1");
  const { pricing } = components();
  attach(h1, { type: "h1", return: pricing, _debugOwner: pricing, _debugStack: Object.assign(new Error("x"), { stack }) });
  const fetched: string[] = [];
  const result = await walkReactSource(h1, ORIGIN, async (url) => {
    fetched.push(url);
    return moduleText;
  });
  assert.deepEqual(fetched, [`${ORIGIN}/src/Pricing.tsx?t=1`], "only the app's own module is fetched");
  assert.deepEqual(result, { component: "Pricing", owners: ["Layout", "App"], path: "src/Pricing.tsx", line: 2 });
});

test("a stack frame under /@fs/, /node_modules/ or another origin gives no path and fetches nothing", async () => {
  for (const url of [`${ORIGIN}/@fs/Users/me/lib/Card.tsx`, `${ORIGIN}/node_modules/lib/Card.js`, "http://127.0.0.1:9999/src/Card.tsx"]) {
    const window = page("<h1>Card</h1>");
    const h1 = window.document.querySelector("h1");
    const { pricing } = components();
    attach(h1, { type: "h1", return: pricing, _debugStack: Object.assign(new Error("x"), { stack: `Error\n    at Card (${url}:3:5)` }) });
    const fetched: string[] = [];
    const result = await walkReactSource(h1, ORIGIN, async (target) => {
      fetched.push(target);
      return "";
    });
    assert.equal(result.path, undefined, url);
    assert.deepEqual(fetched, [], url);
    assert.equal(result.component, "Pricing");
  }
});

test("a module without an inline map still gives its path, without a line", async () => {
  const window = page("<h1>Pricing</h1>");
  const h1 = window.document.querySelector("h1");
  const { pricing } = components();
  attach(h1, { type: "h1", return: pricing, _debugStack: Object.assign(new Error("x"), { stack: `Error\n    at Pricing (${ORIGIN}/src/Pricing.tsx:3:5)` }) });
  const result = await walkReactSource(h1, ORIGIN, async () => "export {}");
  assert.equal(result.path, "src/Pricing.tsx");
  assert.equal(result.line, undefined);
});

test("with no fiber the data-aiden-src stamp on the element or an ancestor is used, else nothing", async () => {
  const window = page('<section data-aiden-src="src/Hero.tsx:7"><p><b>Hi</b></p></section><p id="bare">x</p>');
  const stamped = await walkReactSource(window.document.querySelector("b"), ORIGIN, noFetch);
  assert.deepEqual(stamped, { owners: [], path: "src/Hero.tsx", line: 7 });
  const bare = await walkReactSource(window.document.querySelector("#bare"), ORIGIN, noFetch);
  assert.deepEqual(bare, { owners: [] });
});

test("owners stop at 8 and names are bounded", async () => {
  const window = page("<h1>x</h1>");
  const h1 = window.document.querySelector("h1");
  let owner: Fiber | null = null;
  for (let index = 0; index < 20; index += 1) {
    const type = Object.assign(() => undefined, { displayName: `Owner${index}${"x".repeat(200)}` });
    owner = { type, _debugOwner: owner };
  }
  const leaf: Fiber = { type: Pricing, _debugOwner: owner };
  attach(h1, { type: "h1", return: leaf });
  const result = await walkReactSource(h1, ORIGIN, noFetch);
  assert.equal(result.owners.length, 8);
  assert.ok(result.owners.every((name) => name.length <= 120));
});
