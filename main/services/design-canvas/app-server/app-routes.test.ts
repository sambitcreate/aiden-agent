// Route discovery's disk walk (design mode v2 Phase 3b, S78): what each
// convention reads, strict no-follow confinement to the app root, and the caps.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { discoverRoutes, routeForWrittenFile, type RouteFs } from "./app-routes.js";
import { readBounded } from "./app-detect.js";
import { readdir } from "node:fs/promises";

async function workspace(t: TestContext, files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "aiden-routes-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return root;
}

/** A spy over the reads that can leak: every listed folder and every read file. */
function spy(): { fs: Partial<RouteFs>; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    fs: {
      readdir: async (dir) => {
        paths.push(dir);
        return readdir(dir, { withFileTypes: true });
      },
      readBounded: async (file, cap) => {
        paths.push(file);
        return readBounded(file, cap);
      },
    },
  };
}

function assertAllUnder(paths: readonly string[], root: string): void {
  for (const recorded of paths) {
    const relative = path.relative(root, recorded);
    assert.ok(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)), `read outside the app root: ${recorded}`);
  }
}

test("a Next app lists both app/ and src/pages/ routes", async (t) => {
  const root = await workspace(t, {
    "app/page.tsx": "",
    "app/pricing/page.tsx": "",
    "app/pricing/PriceCard.tsx": "",
    "app/layout.tsx": "",
    "src/pages/about.tsx": "",
    "src/pages/_app.tsx": "",
  });
  const found = await discoverRoutes(root, ".", "next");
  assert.deepEqual(found?.patterns.sort(), ["/", "/about", "/pricing"]);
  assert.equal(found?.truncated, false);
});

test("TanStack: routeTree.gen.ts wins over a stray route file; without it the folder is walked", async (t) => {
  const tree = "export interface FileRoutesByFullPath {\n  '/': typeof IndexRoute\n  '/pricing': typeof PricingRoute\n}\n";
  const root = await workspace(t, { "src/routeTree.gen.ts": tree, "src/routes/old.tsx": "", "src/routes/index.tsx": "" });
  assert.deepEqual((await discoverRoutes(root, ".", "tanstack-router"))?.patterns, ["/", "/pricing"]);
  const walked = await workspace(t, {
    "src/routes/__root.tsx": "",
    "src/routes/index.tsx": "",
    "src/routes/posts.tsx": "",
    "src/routes/posts.index.tsx": "",
    "src/routes/posts.$postId.tsx": "",
    "src/routes/-components/x.tsx": "",
  });
  assert.deepEqual((await discoverRoutes(walked, ".", "tanstack-start"))?.patterns.sort(), ["/", "/posts", "/posts/[postId]"]);
});

test("React Router: a literal routes.ts wins, flatRoutes() walks, other code is null", async (t) => {
  const literal = await workspace(t, {
    "app/routes.ts": 'export default [index("routes/home.tsx"), route("about", "routes/about.tsx")] satisfies RouteConfig;',
    "app/routes/ignored.tsx": "",
  });
  assert.deepEqual((await discoverRoutes(literal, ".", "react-router"))?.patterns, ["/", "/about"]);
  const flat = await workspace(t, {
    "app/routes.ts": "export default flatRoutes() satisfies RouteConfig;",
    "app/routes/_index.tsx": "",
    "app/routes/concerts.$city.tsx": "",
  });
  assert.deepEqual((await discoverRoutes(flat, ".", "react-router"))?.patterns.sort(), ["/", "/concerts/[city]"]);
  const code = await workspace(t, { "app/routes.ts": "export default pages.map((page) => route(page, page));", "app/routes/_index.tsx": "" });
  assert.equal(await discoverRoutes(code, ".", "react-router"), null);
  const remix = await workspace(t, { "app/routes/_index.tsx": "", "app/routes/about.tsx": "" });
  assert.deepEqual((await discoverRoutes(remix, ".", "remix"))?.patterns.sort(), ["/", "/about"]);
});

test("an app root reads only its own folder", async (t) => {
  const root = await workspace(t, { "apps/web/app/page.tsx": "", "apps/web/app/a/page.tsx": "", "app/outside/page.tsx": "" });
  const recorded = spy();
  const found = await discoverRoutes(root, "apps/web", "next", { fs: recorded.fs });
  assert.deepEqual(found?.patterns.sort(), ["/", "/a"]);
  assert.ok(recorded.paths.length > 0);
  assertAllUnder(recorded.paths, path.join(root, "apps/web"));
});

test("no convention, or an app root that isn't a plain folder, is null", async (t) => {
  const root = await workspace(t, { "src/main.tsx": "", "file.txt": "" });
  assert.equal(await discoverRoutes(root, ".", "vite"), null);
  assert.equal(await discoverRoutes(root, ".", undefined), null);
  assert.equal(await discoverRoutes(root, "missing", "next"), null);
  assert.equal(await discoverRoutes(root, "file.txt", "next"), null);
  assert.equal(await discoverRoutes(root, "../x", "next"), null);
});

test("confinement: a linked app root or parent is never followed", async (t) => {
  const outside = await workspace(t, { "app/secret/page.tsx": "" });
  const root = await workspace(t, { "real/app/page.tsx": "", "apps/.keep": "" });
  await symlink(outside, path.join(root, "apps/out"));
  await symlink(path.join(root, "real"), path.join(root, "apps/in"));
  await symlink(path.join(root, "real"), path.join(root, "linked"));
  for (const appRoot of ["apps/out", "apps/in", "linked"]) {
    const recorded = spy();
    assert.equal(await discoverRoutes(root, appRoot, "next", { fs: recorded.fs }), null, appRoot);
    assert.deepEqual(recorded.paths, [], `${appRoot} read nothing`);
  }
  const parent = await workspace(t, { "elsewhere/web/app/page.tsx": "" });
  await symlink(path.join(parent, "elsewhere"), path.join(parent, "apps"));
  assert.equal(await discoverRoutes(parent, "apps/web", "next"), null);
});

test("confinement: a linked convention folder gives no routes, the others still read", async (t) => {
  const outside = await workspace(t, { "secret.tsx": "", "index.tsx": "" });
  const root = await workspace(t, { "src/routes/index.tsx": "", "inside/about.tsx": "" });
  await symlink(outside, path.join(root, "src/routes/out"));
  const recorded = spy();
  assert.deepEqual((await discoverRoutes(root, ".", "tanstack-router", { fs: recorded.fs }))?.patterns, ["/"]);
  assertAllUnder(recorded.paths, root);

  const linkedRoutes = await workspace(t, { "inside/about.tsx": "", "src/.keep": "" });
  await symlink(path.join(linkedRoutes, "inside"), path.join(linkedRoutes, "src/routes"));
  assert.deepEqual(await discoverRoutes(linkedRoutes, ".", "tanstack-router"), { patterns: [], truncated: false });

  const next = await workspace(t, { "app/page.tsx": "", "app/x/page.tsx": "" });
  assert.deepEqual((await discoverRoutes(next, ".", "next"))?.patterns.sort(), ["/", "/x"], "no pages/ or src/ (ENOENT)");
  const pagesFile = await workspace(t, { "app/page.tsx": "", pages: "not a folder" });
  assert.deepEqual((await discoverRoutes(pagesFile, ".", "next"))?.patterns, ["/"]);
  const linkedApp = await workspace(t, { "real/page.tsx": "", "pages/about.tsx": "" });
  await symlink(path.join(linkedApp, "real"), path.join(linkedApp, "app"));
  assert.deepEqual((await discoverRoutes(linkedApp, ".", "next"))?.patterns, ["/about"]);
});

test("confinement: linked parsed files and linked route files are never read", async (t) => {
  const tree = "export interface FileRoutesByFullPath {\n  '/from-link': typeof X\n}\n";
  const root = await workspace(t, { "real-tree.ts": tree, "src/routes/index.tsx": "", "src/routes/pricing.tsx": "" });
  await symlink(path.join(root, "real-tree.ts"), path.join(root, "src/routeTree.gen.ts"));
  await symlink(path.join(root, "src/routes/pricing.tsx"), path.join(root, "src/routes/about.tsx"));
  assert.deepEqual((await discoverRoutes(root, ".", "tanstack-router"))?.patterns.sort(), ["/", "/pricing"]);

  const rr = await workspace(t, { "real-routes.ts": 'export default [index("a.tsx")];', "app/routes/_index.tsx": "" });
  await symlink(path.join(rr, "real-routes.ts"), path.join(rr, "app/routes.ts"));
  assert.equal(await discoverRoutes(rr, ".", "react-router"), null);
});

test("a directory link loop is skipped and the walk ends", async (t) => {
  const root = await workspace(t, { "src/routes/index.tsx": "", "src/routes/a/b.tsx": "" });
  await symlink(path.join(root, "src/routes"), path.join(root, "src/routes/a/loop"));
  assert.deepEqual((await discoverRoutes(root, ".", "tanstack-router"))?.patterns.sort(), ["/", "/a/b"]);
});

test("caps: a big tree is truncated quickly; node_modules and hidden folders are never listed", async (t) => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 2100; index += 1) files[`app/p${index}/page.tsx`] = "";
  files["node_modules/x/app/page.tsx"] = "";
  const root = await workspace(t, files);
  const started = performance.now();
  const found = await discoverRoutes(root, ".", "next");
  assert.ok(performance.now() - started < 2000);
  assert.equal(found?.truncated, true);
  assert.ok((found?.patterns.length ?? 0) <= 500);

  const hidden = await workspace(t, { "app/page.tsx": "", "app/.next/server/app/x/page.js": "", "app/node_modules/y/page.tsx": "" });
  const recorded = spy();
  assert.deepEqual((await discoverRoutes(hidden, ".", "next", { fs: recorded.fs }))?.patterns, ["/"]);
  assert.ok(!recorded.paths.some((entry) => entry.includes(".next") || entry.includes("node_modules")));
});

test("an aborted signal rejects with AbortError", async (t) => {
  const root = await workspace(t, { "app/page.tsx": "" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverRoutes(root, ".", "next", { signal: controller.signal }), { name: "AbortError" });
});

test("routeForWrittenFile maps a written path under its root without reading disk", () => {
  assert.equal(routeForWrittenFile("apps/web", "next", "apps/web/app/pricing/page.tsx"), "/pricing");
  assert.equal(routeForWrittenFile("apps/web", "next", "apps/web/app/pricing/Card.tsx"), null);
  assert.equal(routeForWrittenFile("apps/web", "next", "docs/app/page.tsx"), null);
  assert.equal(routeForWrittenFile("apps/web", "next", "apps/webby/app/page.tsx"), null);
  assert.equal(routeForWrittenFile(".", "tanstack-router", "src/routes/about.tsx"), "/about");
  assert.equal(routeForWrittenFile(".", "vite", "src/routes/about.tsx"), null);
});
