// Route discovery's pure rules (design mode v2 Phase 3b, S78–S81). Every
// expected value is written by hand from the framework's own documented
// examples (Next.js App and Pages Router, TanStack Router file-based routing,
// Remix v2 / React Router v7 flat routes and routes.ts, Astro pages), never
// derived from the rules themselves.

import assert from "node:assert/strict";
import test from "node:test";
import {
  conventionsFor,
  mergeRouteList,
  parseReactRouterConfig,
  parseTanStackRouteTree,
  ROUTE_LIMITS,
  routeFromFile,
  routesFromFiles,
  scanTsTokens,
} from "./app-routes-core.js";

function rows(convention: Parameters<typeof routeFromFile>[0], table: Array<[string, string | null]>): void {
  for (const [path, expected] of table) assert.equal(routeFromFile(convention, path), expected, `${convention} ${path}`);
}

test("next-app: page files, groups dropped, private, slots and intercepts skipped", () => {
  rows("next-app", [
    ["app/page.tsx", "/"],
    ["app/pricing/page.tsx", "/pricing"],
    ["src/app/(shop)/cart/page.tsx", "/cart"],
    ["app/blog/[slug]/page.mdx", "/blog/[slug]"],
    ["app/docs/[...rest]/page.tsx", "/docs/[...rest]"],
    ["app/shop/[[...all]]/page.js", "/shop/[[...all]]"],
    ["app/layout.tsx", null],
    ["app/loading.tsx", null],
    ["app/error.tsx", null],
    ["app/api/x/route.ts", null],
    ["app/_components/Card.tsx", null],
    ["app/@modal/page.tsx", null],
    ["app/(.)photo/page.tsx", null],
    ["app/feed/(..)photo/[id]/page.tsx", null],
    ["app/pricing/PriceCard.tsx", null],
    ["pages/index.tsx", null],
  ]);
});

test("next-pages: files are routes, index is the folder, special files and api skipped", () => {
  rows("next-pages", [
    ["pages/index.tsx", "/"],
    ["pages/about.tsx", "/about"],
    ["pages/blog/[id].tsx", "/blog/[id]"],
    ["pages/blog/index.tsx", "/blog"],
    ["src/pages/post/[...all].js", "/post/[...all]"],
    ["pages/_app.tsx", null],
    ["pages/_document.tsx", null],
    ["pages/_error.tsx", null],
    ["pages/404.tsx", null],
    ["pages/500.tsx", null],
    ["pages/api/hello.ts", null],
    ["pages/styles.css", null],
    ["app/page.tsx", null],
  ]);
});

test("tanstack (single file): flat dots, index, params, pathless and groups", () => {
  rows("tanstack", [
    ["src/routes/index.tsx", "/"],
    ["src/routes/about.tsx", "/about"],
    ["src/routes/posts.$postId.tsx", "/posts/[postId]"],
    ["src/routes/posts/$postId/edit.tsx", "/posts/[postId]/edit"],
    ["src/routes/_auth/settings.tsx", "/settings"],
    ["src/routes/(marketing)/pricing.tsx", "/pricing"],
    ["src/routes/files/$.tsx", "/files/[...splat]"],
    ["src/routes/posts.index.tsx", "/posts"],
    ["src/routes/posts.tsx", "/posts"],
    ["src/routes/posts_.$postId.deep.tsx", "/posts/[postId]/deep"],
    ["src/routes/about.lazy.tsx", "/about"],
    ["src/routes/__root.tsx", null],
    ["src/routes/-components/x.tsx", null],
    ["src/routes/posts/-utils.ts", null],
    ["src/routes/_auth.tsx", null],
    ["src/components/Banner.tsx", null],
  ]);
});

test("tanstack (whole tree): a layout with children counts once, a leaf route.tsx stays", () => {
  assert.deepEqual(routesFromFiles("tanstack", ["src/routes/posts.tsx", "src/routes/posts.index.tsx", "src/routes/posts.$postId.tsx"]), [
    "/posts",
    "/posts/[postId]",
  ]);
  assert.deepEqual(routesFromFiles("tanstack", ["src/routes/dashboard/route.tsx"]), ["/dashboard"]);
  assert.deepEqual(routesFromFiles("tanstack", ["src/routes/dashboard/route.tsx", "src/routes/dashboard/stats.tsx"]), ["/dashboard/stats"]);
  assert.deepEqual(routesFromFiles("tanstack", ["src/routes/__root.tsx", "src/routes/index.tsx", "src/routes/about.tsx"]), ["/", "/about"]);
});

test("react-router-flat: Remix's documented flat route names", () => {
  rows("react-router-flat", [
    ["app/routes/_index.tsx", "/"],
    ["app/routes/about.tsx", "/about"],
    ["app/routes/concerts.$city.tsx", "/concerts/[city]"],
    ["app/routes/concerts._index.tsx", "/concerts"],
    ["app/routes/_auth.login.tsx", "/login"],
    ["app/routes/concerts_.mine.tsx", "/concerts/mine"],
    ["app/routes/sitemap[.]xml.tsx", "/sitemap.xml"],
    ["app/routes/files.$.tsx", "/files/[...splat]"],
    ["app/routes/dashboard/route.tsx", "/dashboard"],
    ["app/routes/($lang).about.tsx", "/[[...lang]]/about"],
    ["app/routes/_auth.tsx", null],
    ["app/routes/dashboard/chart.tsx", null],
    ["app/root.tsx", null],
  ]);
  assert.deepEqual(routesFromFiles("react-router-flat", ["app/routes/concerts.tsx", "app/routes/concerts.$city.tsx", "app/routes/concerts._index.tsx"]), [
    "/concerts/[city]",
    "/concerts",
  ]);
});

test("astro: page files, endpoints and _ files skipped", () => {
  rows("astro", [
    ["src/pages/index.astro", "/"],
    ["src/pages/blog/[slug].astro", "/blog/[slug]"],
    ["src/pages/[...path].astro", "/[...path]"],
    ["src/pages/about.md", "/about"],
    ["src/pages/docs/index.mdx", "/docs"],
    ["src/pages/api/x.ts", null],
    ["src/pages/feed.xml.js", null],
    ["src/pages/_draft.astro", null],
    ["src/pages/_partials/nav.astro", null],
    ["src/components/Nav.astro", null],
  ]);
});

test("conventionsFor maps framework ids to conventions, none for the rest", () => {
  assert.deepEqual(conventionsFor("next"), ["next-app", "next-pages"]);
  assert.deepEqual(conventionsFor("remix"), ["react-router-flat"]);
  assert.deepEqual(conventionsFor("react-router"), ["react-router-flat"]);
  assert.deepEqual(conventionsFor("tanstack-start"), ["tanstack"]);
  assert.deepEqual(conventionsFor("tanstack-router"), ["tanstack"]);
  assert.deepEqual(conventionsFor("astro"), ["astro"]);
  assert.deepEqual(conventionsFor("remix-3"), []);
  assert.deepEqual(conventionsFor("vite"), []);
  assert.deepEqual(conventionsFor(undefined), []);
});

const values = (tokens: ReturnType<typeof scanTsTokens>) => tokens?.map((token) => token.value);

test("scanTsTokens skips comments and keeps strings whole", () => {
  assert.deepEqual(values(scanTsTokens('route("a//b", "x.tsx") // route("evil", "y")')), ["route", "(", "a//b", ",", "x.tsx", ")"]);
  assert.deepEqual(values(scanTsTokens('/* route("c", "z") */')), []);
  assert.deepEqual(scanTsTokens('"a*/b"'), [{ kind: "str", value: "a*/b" }]);
  assert.deepEqual(scanTsTokens("'it\\'s'"), [{ kind: "str", value: "it's" }]);
  assert.deepEqual(values(scanTsTokens("a(`x ${`y ${z}`} w`, b)")), ["a", "(", ",", "b", ")"]);
  assert.deepEqual(values(scanTsTokens("...prefix")), ["...", "prefix"]);
});

test("scanTsTokens: an unterminated string, comment or template is null", () => {
  assert.equal(scanTsTokens('route("a'), null);
  assert.equal(scanTsTokens("/* open"), null);
  assert.equal(scanTsTokens("`x ${y"), null);
  assert.equal(scanTsTokens('"line\nbreak"'), null);
});

test("scanTsTokens and the readers stay linear on hostile text", () => {
  const text = "(".repeat(256 * 1024);
  const started = performance.now();
  assert.equal(parseReactRouterConfig(`export default [${text}`), null);
  assert.equal(parseTanStackRouteTree(`export interface FileRoutesByFullPath {${text}`), null);
  assert.equal(scanTsTokens(text), null, "past the token cap");
  assert.ok(performance.now() - started < 100, `took ${performance.now() - started} ms`);
  const deepTemplates = "`${".repeat(20_000);
  assert.equal(scanTsTokens(deepTemplates), null);
});

const ROUTE_TREE = `/* eslint-disable */
// This file was automatically generated by TanStack Router.
// '/fake': typeof FakeRoute
import { Route as rootRouteImport } from './routes/__root'
import { Route as AboutRouteImport } from './routes/about'

export interface FileRoutesByFullPath {
  '/': typeof IndexRoute
  '/about': typeof AboutRoute
  '/posts/$postId': typeof PostsPostIdRoute
  '/posts/': typeof PostsIndexRoute
  '/files/$': typeof FilesSplatRoute
}
export interface FileRoutesByTo {
  '/hidden': typeof HiddenRoute
}
`;

test("parseTanStackRouteTree reads FileRoutesByFullPath's keys only", () => {
  assert.deepEqual(parseTanStackRouteTree(ROUTE_TREE), ["/", "/about", "/posts/[postId]", "/posts", "/files/[...splat]"]);
  assert.equal(parseTanStackRouteTree("/* export interface FileRoutesByFullPath { '/x': 1 } */ export const a = 1"), null);
  assert.equal(parseTanStackRouteTree("export const routeTree = {}"), null);
});

test("parseReactRouterConfig reads a literal routes.ts", () => {
  const config = `import { type RouteConfig, index, prefix, route } from "@react-router/dev/routes";
export default [
  index("routes/home.tsx"),
  route("about", "routes/about.tsx"),
  ...prefix("blog", [route(":slug", "routes/post.tsx")]),
] satisfies RouteConfig;`;
  assert.deepEqual(parseReactRouterConfig(config), { routes: ["/", "/about", "/blog/[slug]"] });
  assert.deepEqual(parseReactRouterConfig('export default [layout("l.tsx", [prefix("a", [route(":id", "r.tsx")])])];'), {
    routes: ["/a/[id]"],
  });
  assert.deepEqual(
    parseReactRouterConfig('export default [route("dashboard", "d.tsx", { id: "dash" }, [index("i.tsx"), route("settings/:tab?", "s.tsx")]), route("*", "404.tsx")];'),
    { routes: ["/dashboard", "/dashboard/settings/[[...tab]]", "/[...splat]"] },
  );
});

test("parseReactRouterConfig: depth cap, flat routes and code it can't read", () => {
  const nested = (levels: number) => `export default [${'layout("l.tsx", ['.repeat(levels)}index("i.tsx")${"])".repeat(levels)}];`;
  assert.deepEqual(parseReactRouterConfig(nested(15)), { routes: ["/"] });
  assert.equal(parseReactRouterConfig(nested(17)), null);
  assert.deepEqual(parseReactRouterConfig('import { flatRoutes } from "@react-router/fs-routes";\nexport default flatRoutes() satisfies RouteConfig;'), {
    flat: true,
  });
  assert.deepEqual(parseReactRouterConfig('export default [route("/", "home.tsx"), ...(await flatRoutes())] satisfies RouteConfig;'), { flat: true });
  assert.equal(parseReactRouterConfig("export default pages.map((page) => route(page, `routes/${page}.tsx`)) satisfies RouteConfig;"), null);
  assert.equal(parseReactRouterConfig("const routes = [index('a.tsx')];\nexport default routes;"), null);
  assert.equal(parseReactRouterConfig('export default [route(name, "x.tsx")];'), null);
});

test("mergeRouteList: / first, then static, then by depth and name", () => {
  const list = mergeRouteList({ appRoot: ".", framework: "next", discovered: { patterns: ["/blog/[slug]", "/about", "/", "/a/b"], truncated: false } });
  assert.equal(list.source, "discovered");
  assert.equal(list.framework, "next");
  assert.deepEqual(
    list.routes.map((entry) => [entry.route, entry.pattern]),
    [
      ["/", undefined],
      ["/about", undefined],
      ["/a/b", undefined],
      ["/blog/[slug]", "/blog/[slug]"],
    ],
  );
});

test("mergeRouteList: params fill a single-parameter pattern right after it", () => {
  const list = mergeRouteList({
    appRoot: ".",
    discovered: { patterns: ["/blog/[slug]", "/[org]/p/[id]"], truncated: false },
    config: { params: { "/blog/[slug]": ["hello-world"], "/[org]/p/[id]": ["x"] } },
  });
  assert.deepEqual(list.routes, [
    { route: "/", source: "discovered" },
    { route: "/blog/[slug]", pattern: "/blog/[slug]", source: "discovered" },
    { route: "/blog/hello-world", pattern: "/blog/[slug]", source: "config" },
    { route: "/[org]/p/[id]", pattern: "/[org]/p/[id]", source: "discovered" },
  ]);
});

test("mergeRouteList: config routes replace discovery", () => {
  const list = mergeRouteList({ appRoot: "web", discovered: { patterns: ["/about"], truncated: true }, config: { routes: ["/", "/pricing"] } });
  assert.equal(list.source, "config");
  assert.equal(list.truncated, false);
  assert.deepEqual(
    list.routes.map((entry) => entry.route),
    ["/", "/pricing"],
  );
});

test("mergeRouteList: no convention and no config is the fallback /", () => {
  const list = mergeRouteList({ appRoot: ".", discovered: null });
  assert.equal(list.source, "fallback");
  assert.deepEqual(
    list.routes.map((entry) => entry.route),
    ["/"],
  );
  assert.equal(list.framework, undefined);
});

test("mergeRouteList caps the list at 200 entries", () => {
  const patterns = Array.from({ length: 300 }, (_, index) => `/p${String(index).padStart(3, "0")}`);
  const list = mergeRouteList({ appRoot: ".", discovered: { patterns, truncated: false } });
  assert.equal(list.routes.length, ROUTE_LIMITS.listed);
  assert.equal(list.truncated, true);
});
