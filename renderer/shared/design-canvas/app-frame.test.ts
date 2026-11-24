// Live app frames' pure rules (design mode v2 Phase 3a, D15): routes, app
// roots, the frame box, the iframe name token and the bridge's source paths.

import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_FRAME_ALLOW,
  APP_FRAME_SANDBOX,
  appFrameBox,
  appFrameName,
  appSourcePath,
  DESIGN_FRAME_HEADER_PX,
  isAppRoot,
  isAppRoute,
  isAppSourcePath,
  parseAppFrameName,
  roundAppScale,
} from "./app-frame.js";
import { canDesignGuide, designMinSize, isDesignPrintable } from "./schema.js";
import { parseDesignAppFrameEvent, parseDesignAppFrameMountResult } from "./app-frame-events.js";

test("isAppRoute accepts paths from the app's own origin and refuses everything else", () => {
  for (const route of ["/", "/pricing", "/blog/hello-world?x=1"]) assert.equal(isAppRoute(route), true, route);
  const refused: unknown[] = [
    "",
    "pricing",
    "//evil.com",
    "/\\evil",
    "http://x/",
    "/a\nb",
    "/a‮b",
    "/a​b",
    `/${"a".repeat(2048)}`,
    7,
    null,
    "/a#frag",
  ];
  for (const route of refused) assert.equal(isAppRoute(route), false, JSON.stringify(route));
  assert.equal(isAppRoute(`/${"a".repeat(2047)}`), true, "2 048 characters is the limit");
});

test("isAppRoot accepts the workspace folder and plain relative folders", () => {
  for (const root of [".", "web", "apps/site"]) assert.equal(isAppRoot(root), true, root);
  for (const root of ["..", "./web", "/abs", "web/../x", "a\\b", "", "web/", ".hidden", 3]) {
    assert.equal(isAppRoot(root), false, JSON.stringify(root));
  }
});

test("appFrameBox is the viewport times the scale, rounded, plus the title row", () => {
  assert.deepEqual(appFrameBox({ width: 1280, height: 800 }, 0.5), { w: 640, h: 400 + DESIGN_FRAME_HEADER_PX });
  assert.deepEqual(appFrameBox({ width: 1333, height: 777 }, 0.3333), { w: 444, h: 259 + DESIGN_FRAME_HEADER_PX });
});

test("roundAppScale keeps 4 decimals", () => {
  assert.equal(roundAppScale(0.333333), 0.3333);
  assert.equal(roundAppScale(0.66666), 0.6667);
  assert.equal(roundAppScale(2), 2);
});

test("the iframe name round-trips and refuses anything else", () => {
  const token = "Zx9_a-Q2w3e4r5t6y7u8";
  assert.deepEqual(parseAppFrameName(appFrameName("frame-1", token)), { frameId: "frame-1", mountToken: token });
  assert.equal(parseAppFrameName(`aiden-design:frame-1:${token}`), null, "another prefix");
  assert.equal(parseAppFrameName(`aiden-app:frame-1:${token}:extra`), null, "an extra part");
  assert.equal(parseAppFrameName(`aiden-app:${"f".repeat(129)}:${token}`), null, "an over-long id");
  assert.equal(parseAppFrameName("aiden-app:frame-1:short"), null, "a short token");
  assert.equal(parseAppFrameName("aiden-app::" + token), null, "no id");
  assert.equal(parseAppFrameName(""), null);
  assert.throws(() => appFrameName("frame:1", token), /frame id/u);
});

test("appSourcePath gives the module path relative to the frame's origin, or null", () => {
  const origin = "http://127.0.0.1:5173";
  assert.equal(appSourcePath(origin, `${origin}/src/A.tsx?t=1`), "src/A.tsx");
  assert.equal(appSourcePath(origin, `${origin}/src/pages/Home.tsx`), "src/pages/Home.tsx");
  for (const url of [
    `${origin}/@fs/Users/me/x.tsx`,
    `${origin}/node_modules/react/index.js`,
    `${origin}/@id/virtual:x`,
    "http://127.0.0.1:9999/src/A.tsx",
    `${origin}/src/../../etc/passwd`,
    `${origin}/src/%2e%2e/x.ts`,
    `${origin}/`,
    "not a url",
  ]) {
    assert.equal(appSourcePath(origin, url), null, url);
  }
});

test("isAppSourcePath accepts only bounded relative POSIX paths", () => {
  assert.equal(isAppSourcePath("src/A.tsx"), true);
  for (const path of ["/src/A.tsx", "../x", "src/../x", "@fs/x", "node_modules/x", "src/A.tsx?x", "src/A.tsx#y", "a\\b", "x".repeat(513), ""]) {
    assert.equal(isAppSourcePath(path), false, path);
  }
});

test("the sandbox grants scripts, same-origin and forms, and nothing else", () => {
  assert.deepEqual(new Set(APP_FRAME_SANDBOX.split(" ")), new Set(["allow-scripts", "allow-same-origin", "allow-forms"]));
});

test("the allow list turns every powerful feature off", () => {
  const entries = new Map(
    APP_FRAME_ALLOW.split(";").map((entry) => {
      const [feature, ...value] = entry.trim().split(/\s+/u);
      return [feature, value.join(" ")] as const;
    }),
  );
  for (const feature of [
    "camera",
    "microphone",
    "geolocation",
    "display-capture",
    "clipboard-read",
    "clipboard-write",
    "payment",
    "usb",
    "serial",
    "hid",
    "bluetooth",
    "midi",
    "publickey-credentials-get",
    "publickey-credentials-create",
    "screen-wake-lock",
    "xr-spatial-tracking",
    "picture-in-picture",
    "fullscreen",
    "window-management",
    "local-fonts",
    "idle-detection",
    "storage-access",
    "web-share",
    "otp-credentials",
    "identity-credentials-get",
    "direct-sockets",
    "autoplay",
  ]) {
    assert.equal(entries.get(feature), "'none'", feature);
  }
  assert.ok([...entries.values()].every((value) => value === "'none'"), "nothing is granted");
});

test("an app frame isn't printable, takes layout guides, and its smallest box is 10", () => {
  assert.equal(isDesignPrintable("app"), false);
  assert.equal(canDesignGuide("app"), true);
  assert.equal(designMinSize("app"), 10);
});

test("parseDesignAppFrameEvent keeps only well-formed events from main", () => {
  const key = { frameId: "frame-1", mountToken: "abcdefghijklmnop" };
  assert.deepEqual(parseDesignAppFrameEvent({ kind: "blocked", ...key, count: 3, hosts: ["example.com", 7, "x".repeat(254)] }), {
    kind: "blocked",
    ...key,
    count: 3,
    hosts: ["example.com"],
  });
  const many = parseDesignAppFrameEvent({ kind: "blocked", ...key, count: 40, hosts: Array.from({ length: 30 }, (_, i) => `h${i}`) });
  assert.equal(many?.kind === "blocked" && many.hosts.length, 20);
  assert.equal(parseDesignAppFrameEvent({ kind: "blocked", ...key, count: 0, hosts: [] }), null);
  assert.equal(parseDesignAppFrameEvent({ kind: "blocked", ...key, count: 1.5, hosts: [] }), null);
  assert.deepEqual(parseDesignAppFrameEvent({ kind: "navigation-refused", ...key, url: "https://example.com/" }), {
    kind: "navigation-refused",
    ...key,
    url: "https://example.com/",
  });
  assert.equal(parseDesignAppFrameEvent({ kind: "navigation-refused", ...key, url: "x".repeat(2049) }), null);
  assert.deepEqual(parseDesignAppFrameEvent({ kind: "dialog-suppressed", ...key, dialog: "alert" }), { kind: "dialog-suppressed", ...key, dialog: "alert" });
  assert.equal(parseDesignAppFrameEvent({ kind: "dialog-suppressed", ...key, dialog: "open" }), null);
  assert.equal(parseDesignAppFrameEvent({ kind: "blocked", frameId: "a b", mountToken: key.mountToken, count: 1, hosts: [] }), null);
  assert.equal(parseDesignAppFrameEvent({ kind: "blocked", frameId: "a", mountToken: "short", count: 1, hosts: [] }), null);
  assert.equal(parseDesignAppFrameEvent({ kind: "other", ...key }), null);
  assert.equal(parseDesignAppFrameEvent(null), null);
});

test("parseDesignAppFrameMountResult accepts a loopback origin or a known error", () => {
  assert.deepEqual(parseDesignAppFrameMountResult({ origin: "http://127.0.0.1:5173" }), { origin: "http://127.0.0.1:5173" });
  assert.deepEqual(parseDesignAppFrameMountResult({ origin: "http://[::1]:5173" }), { origin: "http://[::1]:5173" });
  assert.deepEqual(parseDesignAppFrameMountResult({ origin: "https://example.com" }), { error: "unavailable" });
  assert.deepEqual(parseDesignAppFrameMountResult({ origin: "http://127.0.0.1:5173/x" }), { error: "unavailable" });
  assert.deepEqual(parseDesignAppFrameMountResult({ error: "too-many-frames" }), { error: "too-many-frames" });
  assert.deepEqual(parseDesignAppFrameMountResult({ error: "nope" }), { error: "unavailable" });
  assert.deepEqual(parseDesignAppFrameMountResult(undefined), { error: "unavailable" });
});
