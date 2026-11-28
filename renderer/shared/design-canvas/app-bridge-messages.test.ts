// What the canvas accepts from a live app frame's bridge (design mode v2
// Phase 3a, D12, S11): known shapes only, every field checked and bounded.

import assert from "node:assert/strict";
import test from "node:test";

import { APP_BREAKPOINT_LIMITS, APP_BRIDGE_LIMITS, isAppSourcePath, parseAppBridgeMessage, postToAppPage } from "./app-bridge-messages.ts";

const ORIGIN = "http://127.0.0.1:5173";
const parse = (data: unknown, origin = ORIGIN) => parseAppBridgeMessage(data, origin);
const element = { selector: "main > h1", text: "Pricing", tag: "h1", rect: { x: 1, y: 2, w: 3, h: 4 } };

test("each message type's valid shape is accepted as sent", () => {
  const valid: Array<[unknown, unknown]> = [
    [{ type: "aiden-app:ready" }, { type: "ready" }],
    [{ type: "aiden-app:hmr" }, { type: "hmr" }],
    [{ type: "aiden-app:escape" }, { type: "escape" }],
    [{ type: "aiden-app:route", path: "/pricing?plan=pro" }, { type: "route", path: "/pricing?plan=pro" }],
    [
      { type: "aiden-app:error", kind: "overlay", message: "Unexpected token", at: { path: "src/Pricing.tsx", line: 13 } },
      { type: "error", kind: "overlay", message: "Unexpected token", at: { path: "src/Pricing.tsx", line: 13 } },
    ],
    [{ type: "aiden-app:error", kind: "rejection", message: "" }, { type: "error", kind: "rejection", message: "" }],
    [
      { type: "aiden-app:source", requestId: "r1", component: "Pricing", owners: ["App"], path: "src/Pricing.tsx", line: 13 },
      { type: "source", requestId: "r1", component: "Pricing", owners: ["App"], path: "src/Pricing.tsx", line: 13 },
    ],
    [{ type: "aiden-app:source", requestId: "r2", owners: [] }, { type: "source", requestId: "r2", owners: [] }],
    [
      { type: "aiden-app:source", requestId: "r3", owners: [], path: "src/renderer/Hero.tsx", line: 4, base: "workspace" },
      { type: "source", requestId: "r3", owners: [], path: "src/renderer/Hero.tsx", line: 4, base: "workspace" },
    ],
    [
      { type: "aiden-app:picked", requestId: "p1", element, point: [5, 6] },
      { type: "picked", requestId: "p1", element, point: [5, 6] },
    ],
    [
      { type: "aiden-app:anchors", requestId: "a1", results: { c1: { candidates: [] } } },
      { type: "anchors", requestId: "a1", results: { c1: { candidates: [] } } },
    ],
  ];
  for (const [data, expected] of valid) assert.deepEqual(parse(data), expected, JSON.stringify(data));
  for (const origin of ["http://localhost:3000", "http://[::1]:5173"]) assert.deepEqual(parse({ type: "aiden-app:ready" }, origin), { type: "ready" });
});

test("a wrong prefix, an unknown type, wrong field types or a non-app origin are dropped", () => {
  const dropped: unknown[] = [
    null,
    "aiden-app:ready",
    [{ type: "aiden-app:ready" }],
    { type: "aiden-design:ready", docHeight: 10 },
    { type: "aiden-design:picked", requestId: "p1", element, point: [5, 6] },
    { type: "aiden-app:set-tweaks" },
    { type: "aiden-app:edit-end" },
    { type: "aiden-app:route", path: 42 },
    { type: "aiden-app:route", path: "pricing" },
    { type: "aiden-app:route", path: "" },
    { type: "aiden-app:error", kind: "panic", message: "x" },
    { type: "aiden-app:error", kind: "error", message: 7 },
    { type: "aiden-app:source", requestId: 1, owners: [] },
    { type: "aiden-app:source", requestId: "r", owners: "App" },
    { type: "aiden-app:source", requestId: "r", owners: [3] },
    { type: "aiden-app:source", requestId: "r", owners: [], component: 9 },
    { type: "aiden-app:picked", requestId: "p1", element: { tag: "h1" }, point: [5, 6] },
  ];
  for (const data of dropped) assert.equal(parse(data), null, JSON.stringify(data));
  for (const origin of ["file://", "null", "https://127.0.0.1:5173", "http://example.com:80", "http://127.0.0.1"]) {
    assert.equal(parse({ type: "aiden-app:ready" }, origin), null, origin);
  }
});

test("oversized strings and lists are dropped, at their limits accepted", () => {
  const route = (length: number) => parse({ type: "aiden-app:route", path: `/${"a".repeat(length - 1)}` });
  assert.ok(route(APP_BRIDGE_LIMITS.route));
  assert.equal(route(APP_BRIDGE_LIMITS.route + 1), null);
  const error = (length: number) => parse({ type: "aiden-app:error", kind: "error", message: "m".repeat(length) });
  assert.ok(error(APP_BRIDGE_LIMITS.message));
  assert.equal(error(APP_BRIDGE_LIMITS.message + 1), null);
  const owners = (count: number) => parse({ type: "aiden-app:source", requestId: "r", owners: Array.from({ length: count }, (_, index) => `C${index}`) });
  assert.ok(owners(8));
  assert.equal(owners(9), null, "9 owners");
  assert.equal(parse({ type: "aiden-app:source", requestId: "r", owners: [], component: "C".repeat(121) }), null);
  assert.equal(parse({ type: "aiden-app:source", requestId: "r", owners: ["C".repeat(121)] }), null);
  assert.equal(parse({ type: "aiden-app:source", requestId: "r".repeat(129), owners: [] }), null);
});

test("a bad line or a path outside the app's files is trimmed off, keeping the rest", () => {
  for (const line of [-1, 0, 1.5, Number.NaN, "13"]) {
    assert.deepEqual(
      parse({ type: "aiden-app:error", kind: "error", message: "boom", at: { path: "src/a.ts", line } }),
      { type: "error", kind: "error", message: "boom" },
      String(line),
    );
    assert.deepEqual(
      parse({ type: "aiden-app:source", requestId: "r", owners: [], path: "src/a.ts", line }),
      { type: "source", requestId: "r", owners: [], path: "src/a.ts" },
      String(line),
    );
  }
  for (const path of ["/@fs/x", "@fs/x", "../x", "src/../../x", "/src/a.ts", "node_modules/react/index.js", "@id/react", "src/a.ts?t=1", "src/a.ts#x", "src\\a.ts", "src//a.ts", "./a.ts", "a\u0000b", "a".repeat(513)]) {
    assert.equal(isAppSourcePath(path), false, path);
    assert.deepEqual(
      parse({ type: "aiden-app:error", kind: "module", message: "x", at: { path, line: 3 } }),
      { type: "error", kind: "module", message: "x" },
      path,
    );
    assert.deepEqual(
      parse({ type: "aiden-app:source", requestId: "r", component: "Pricing", owners: [], path, line: 3 }),
      { type: "source", requestId: "r", component: "Pricing", owners: [] },
      path,
    );
  }
  assert.deepEqual(
    parse({ type: "aiden-app:source", requestId: "r", owners: [], line: 3 }),
    { type: "source", requestId: "r", owners: [] },
    "a line without its file",
  );
  assert.deepEqual(
    parse({ type: "aiden-app:source", requestId: "r", owners: [], base: "workspace" }),
    { type: "source", requestId: "r", owners: [] },
    "3d: a base without its file",
  );
  assert.deepEqual(
    parse({ type: "aiden-app:source", requestId: "r", owners: [], path: "src/a.ts", base: "root" }),
    { type: "source", requestId: "r", owners: [], path: "src/a.ts" },
    "3d: only the workspace base is kept",
  );
  assert.equal(isAppSourcePath("src/Pricing.tsx"), true);
  assert.equal(isAppSourcePath("app/(marketing)/page.tsx"), true);
});

test("postToAppPage prefixes the command and addresses it to the app's origin only", () => {
  const posted: Array<[unknown, string]> = [];
  const target = { postMessage: (data: unknown, origin: string) => posted.push([data, origin]) } as unknown as Window;
  postToAppPage(target, ORIGIN, { type: "set-scheme", dark: true });
  postToAppPage(target, ORIGIN, { type: "source-at", requestId: "r1", x: 4, y: 5 });
  postToAppPage(target, "*", { type: "set-scheme", dark: false });
  postToAppPage(target, "https://example.com", { type: "set-scheme", dark: false });
  postToAppPage(null, ORIGIN, { type: "set-scheme", dark: false });
  assert.deepEqual(posted, [
    [{ type: "aiden-app:set-scheme", dark: true }, ORIGIN],
    [{ type: "aiden-app:source-at", requestId: "r1", x: 4, y: 5 }, ORIGIN],
  ]);
  const gone = { postMessage: () => { throw new Error("detached"); } } as unknown as Window;
  postToAppPage(gone, ORIGIN, { type: "set-scheme", dark: true });
});

test("a breakpoints message keeps 0–24 strictly ascending integers in range", () => {
  const breakpoints = (widths: unknown) => parse({ type: "aiden-app:breakpoints", widths });
  assert.deepEqual(breakpoints([]), { type: "breakpoints", widths: [] }, "an empty list clears the ticks");
  assert.deepEqual(breakpoints([640, 768, 1024]), { type: "breakpoints", widths: [640, 768, 1024] });
  const full = Array.from({ length: APP_BREAKPOINT_LIMITS.count }, (_, index) => 300 + index);
  assert.deepEqual(breakpoints(full), { type: "breakpoints", widths: full });
  assert.deepEqual(breakpoints([APP_BREAKPOINT_LIMITS.min, APP_BREAKPOINT_LIMITS.max]), { type: "breakpoints", widths: [1, 8000] });
  const sent = [640, 768];
  const parsed = breakpoints(sent);
  sent.push(1);
  assert.deepEqual(parsed, { type: "breakpoints", widths: [640, 768] }, "the parsed list is its own copy");
});

test("unsorted, duplicate, fractional, 0, 9000, string or 25-entry lists are dropped", () => {
  const dropped: unknown[] = [
    [768, 640],
    [640, 640],
    [640.5],
    [0, 640],
    [640, 9000],
    ["640"],
    Array.from({ length: 25 }, (_, index) => 300 + index),
    "640,768",
    { 0: 640, length: 1 },
    null,
    undefined,
    [Number.NaN],
    [-1, 640],
  ];
  for (const widths of dropped) assert.equal(parse({ type: "aiden-app:breakpoints", widths }), null, JSON.stringify(widths) ?? String(widths));
  assert.equal(parse({ type: "aiden-app:breakpoints" }), null, "no widths");
});
