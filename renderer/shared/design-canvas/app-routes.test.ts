// The shared route shapes (design mode v2 Phase 3b, S79, S81): Next-style
// bracket patterns, filling them with values, and what counts as a route.

import assert from "node:assert/strict";
import test from "node:test";
import { fillRoute, isConcreteRoute, isParamValue, isRoutePattern, patternParams } from "./app-routes.js";

test("a pattern is a route only once every bracket is filled", () => {
  assert.equal(isConcreteRoute("/blog/[slug]"), false);
  assert.equal(isConcreteRoute("/blog/x"), true);
  assert.equal(isConcreteRoute("/checkout?step=2"), true);
  assert.equal(isConcreteRoute("//x"), false);
});

test("a concrete route has no dot or empty segments, which would name another page's URL", () => {
  for (const route of ["/a/../b", "/..", "/.", "/a/./b", "/a//b", "/../?x=1"]) assert.equal(isConcreteRoute(route), false, route);
  // A trailing slash, and dots inside a segment or after `?`, are a page's own.
  for (const route of ["/pricing/", "/v1.2/notes", "/files?path=../x", "/a?b=//c"]) assert.equal(isConcreteRoute(route), true, route);
});

test("a percent-encoded dot segment is a dot segment: the URL parser resolves it to another page", () => {
  for (const route of ["/a/%2e%2e/admin", "/a/%2E%2e/admin", "/%2e/x", "/a/.%2E/b", "/a/%2e./b", "/a/%2E"]) {
    assert.equal(isConcreteRoute(route), false, route);
    // The oracle: the browser's own parser names a different path.
    assert.notEqual(new URL(route, "http://x.invalid").pathname, route.split("?")[0], route);
  }
  for (const route of ["/v%2e1", "/%2e%2e%2e", "/caf\u00e9"]) assert.equal(isConcreteRoute(route), true, route);
  assert.equal(isRoutePattern("/a/%2e%2e/[id]"), false);
});

test("pattern shapes: whole-segment brackets only, rooted, no empty segments", () => {
  assert.equal(isRoutePattern("/"), true);
  assert.equal(isRoutePattern("/blog/[slug]"), true);
  assert.equal(isRoutePattern("/docs/[...rest]"), true);
  assert.equal(isRoutePattern("/shop/[[...all]]"), true);
  assert.equal(isRoutePattern("/a/[b"), false);
  assert.equal(isRoutePattern("//x"), false);
  assert.equal(isRoutePattern("blog/[slug]"), false);
  assert.equal(isRoutePattern("/a//b"), false);
  assert.equal(isRoutePattern("/a/[b]c"), false);
  assert.equal(isRoutePattern("/a/[]"), false);
  assert.equal(isRoutePattern("/a/../b"), false);
  assert.equal(isRoutePattern("/a?x=[y]"), false);
});

test("patternParams names each parameter and its kind", () => {
  assert.deepEqual(patternParams("/[org]/p/[id]"), [
    { name: "org", catchAll: false, optional: false },
    { name: "id", catchAll: false, optional: false },
  ]);
  assert.deepEqual(patternParams("/docs/[...rest]"), [{ name: "rest", catchAll: true, optional: false }]);
  assert.deepEqual(patternParams("/shop/[[...all]]"), [{ name: "all", catchAll: true, optional: true }]);
  assert.deepEqual(patternParams("/about"), []);
});

test("fillRoute percent-encodes one segment and refuses unsafe values", () => {
  assert.equal(fillRoute("/blog/[slug]", { slug: "a b" }), "/blog/a%20b");
  assert.equal(fillRoute("/blog/[slug]", { slug: "hello-world" }), "/blog/hello-world");
  for (const slug of ["a/b", ".", "..", "", "a​b", "a‮b"]) {
    assert.equal(fillRoute("/blog/[slug]", { slug }), null, JSON.stringify(slug));
  }
  assert.equal(fillRoute("/blog/[slug]", {}), null);
});

test("fillRoute joins a catch-all's segments and drops an empty optional one", () => {
  assert.equal(fillRoute("/docs/[...rest]", { rest: "a/b" }), "/docs/a/b");
  assert.equal(fillRoute("/docs/[...rest]", { rest: "a//b" }), null);
  assert.equal(fillRoute("/docs/[...rest]", { rest: "a/../b" }), null);
  assert.equal(fillRoute("/docs/[...rest]", { rest: "" }), null);
  assert.equal(fillRoute("/shop/[[...all]]", {}), "/shop");
  assert.equal(fillRoute("/shop/[[...all]]", { all: "" }), "/shop");
  assert.equal(fillRoute("/[[...all]]", {}), "/");
  assert.equal(fillRoute("/shop/[[...all]]", { all: "x/y" }), "/shop/x/y");
});

test("fillRoute fills several parameters", () => {
  assert.equal(fillRoute("/[org]/p/[id]", { org: "o", id: "1" }), "/o/p/1");
  assert.equal(fillRoute("/[org]/p/[id]", { org: "o" }), null);
});

test("isParamValue: segment rules, with / only inside a catch-all", () => {
  assert.equal(isParamValue("hello", false), true);
  assert.equal(isParamValue("a/b", false), false);
  assert.equal(isParamValue("a/b", true), true);
  assert.equal(isParamValue("x".repeat(200), false), true);
  assert.equal(isParamValue("x".repeat(201), false), false);
  assert.equal(isParamValue("a/./b", true), false);
  assert.equal(isParamValue("tab\tx", false), false);
});
