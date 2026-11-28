// Which file owns a page, the copy's name, and TanStack's route literal
// (design mode v2 Phase 3c, S95, S101). Every expected value is written by
// hand from the frameworks' documented conventions (Next.js App and Pages
// Router, TanStack Router file-based routing and its `createFileRoute`
// literal, Remix v2 / React Router v7 flat routes, Astro pages), never derived
// from the rules under test.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ownerOf,
  pagePath,
  relativeImportsMoved,
  rewriteTanstackLiteral,
  specialFilesLost,
  tanstackRouteId,
  variantBase,
  variantPathCandidates,
  workspaceRelPath,
  type OwnerFile,
} from "./app-page-files-core.js";
import { routeFromFile, scanTsTokens } from "./app-routes-core.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("workspace paths", () => {
  assert.equal(workspaceRelPath(".", "src/routes/a.tsx"), "src/routes/a.tsx");
  assert.equal(workspaceRelPath("apps/web", "src/routes/a.tsx"), "apps/web/src/routes/a.tsx");
});

test("page paths", () => {
  assert.deepEqual(pagePath("/pricing/"), { path: "/pricing", query: "" });
  assert.deepEqual(pagePath("/pricing?tab=a"), { path: "/pricing", query: "?tab=a" });
  assert.deepEqual(pagePath("/pricing/?tab=a"), { path: "/pricing", query: "?tab=a" });
  assert.deepEqual(pagePath("/"), { path: "/", query: "" });
  assert.deepEqual(pagePath("/?plan=pro"), { path: "/", query: "?plan=pro" });
  assert.deepEqual(pagePath("/docs#intro"), { path: "/docs", query: "#intro" });
});

test("variant bases", () => {
  assert.equal(variantBase("/pricing-v2"), "/pricing");
  assert.equal(variantBase("/pricing-v9"), "/pricing");
  assert.equal(variantBase("/"), "/index");
  assert.equal(variantBase("/index-v3"), "/index");
  assert.equal(variantBase("/pricing-v10"), "/pricing-v10");
  assert.equal(variantBase("/pricing"), "/pricing");
  assert.equal(variantBase("/blog/post-v2"), "/blog/post");
  assert.equal(variantBase("/v2-pricing"), "/v2-pricing");
});

/** The first candidate whose own route is `wanted`, as the caller picks it. */
function accepted(owner: OwnerFile, n: number, wanted: string): { appRelPath: string; newFolder?: string } | undefined {
  return variantPathCandidates(owner, n).find((candidate) => routeFromFile(owner.convention, candidate.appRelPath) === wanted);
}

test("candidate paths per framework", () => {
  const rows: Array<[OwnerFile, number, string, { appRelPath: string; newFolder?: string }]> = [
    // Next App Router: a folder per segment, so the folder is renamed, or a child folder for the root.
    [{ appRelPath: "app/pricing/page.tsx", convention: "next-app" }, 2, "/pricing-v2", { appRelPath: "app/pricing-v2/page.tsx", newFolder: "app/pricing-v2" }],
    [{ appRelPath: "app/page.tsx", convention: "next-app" }, 2, "/index-v2", { appRelPath: "app/index-v2/page.tsx", newFolder: "app/index-v2" }],
    [{ appRelPath: "src/app/(shop)/cart/page.tsx", convention: "next-app" }, 4, "/cart-v4", { appRelPath: "src/app/(shop)/cart-v4/page.tsx", newFolder: "src/app/(shop)/cart-v4" }],
    // Next Pages Router: the file is the route.
    [{ appRelPath: "pages/pricing.tsx", convention: "next-pages" }, 2, "/pricing-v2", { appRelPath: "pages/pricing-v2.tsx" }],
    [{ appRelPath: "pages/pricing-v2.tsx", convention: "next-pages" }, 3, "/pricing-v3", { appRelPath: "pages/pricing-v3.tsx" }],
    [{ appRelPath: "pages/blog/index.tsx", convention: "next-pages" }, 2, "/blog-v2", { appRelPath: "pages/blog-v2/index.tsx", newFolder: "pages/blog-v2" }],
    // TanStack: flat dots, `index` and `route` markers, folders.
    [{ appRelPath: "src/routes/pricing.tsx", convention: "tanstack" }, 2, "/pricing-v2", { appRelPath: "src/routes/pricing-v2.tsx" }],
    [{ appRelPath: "src/routes/blog.index.tsx", convention: "tanstack" }, 2, "/blog-v2", { appRelPath: "src/routes/blog-v2.index.tsx" }],
    [{ appRelPath: "src/routes/pricing/route.tsx", convention: "tanstack" }, 2, "/pricing-v2", { appRelPath: "src/routes/pricing-v2/route.tsx", newFolder: "src/routes/pricing-v2" }],
    [{ appRelPath: "src/routes/about.lazy.tsx", convention: "tanstack" }, 2, "/about-v2", { appRelPath: "src/routes/about-v2.lazy.tsx" }],
    [{ appRelPath: "src/routes/index.tsx", convention: "tanstack" }, 2, "/index-v2", { appRelPath: "src/routes/index-v2.tsx" }],
    // Remix / React Router flat routes.
    [{ appRelPath: "app/routes/pricing.tsx", convention: "react-router-flat" }, 2, "/pricing-v2", { appRelPath: "app/routes/pricing-v2.tsx" }],
    [{ appRelPath: "app/routes/blog._index.tsx", convention: "react-router-flat" }, 2, "/blog-v2", { appRelPath: "app/routes/blog-v2._index.tsx" }],
    [{ appRelPath: "app/routes/_index.tsx", convention: "react-router-flat" }, 2, "/index-v2", { appRelPath: "app/routes/index-v2.tsx" }],
    // Astro: the file is the route.
    [{ appRelPath: "src/pages/index.astro", convention: "astro" }, 2, "/index-v2", { appRelPath: "src/pages/index-v2.astro" }],
    [{ appRelPath: "src/pages/about.md", convention: "astro" }, 5, "/about-v5", { appRelPath: "src/pages/about-v5.md" }],
  ];
  for (const [owner, n, wanted, expected] of rows) {
    const found = accepted(owner, n, wanted);
    assert.deepEqual(found, expected, `${owner.appRelPath} → ${wanted}`);
    assert.equal(routeFromFile(owner.convention, found!.appRelPath), wanted);
  }
});

test("owners", () => {
  const walk = {
    files: new Map<string, OwnerFile[]>([
      ["/pricing", [{ appRelPath: "src/routes/pricing.tsx", convention: "tanstack" }]],
      ["/posts", [{ appRelPath: "src/routes/posts.index.tsx", convention: "tanstack" }]],
      ["/blog/[slug]", [{ appRelPath: "src/routes/blog.$slug.tsx", convention: "tanstack" }]],
      ["/docs/[...rest]", [{ appRelPath: "src/routes/docs.$.tsx", convention: "tanstack" }]],
      [
        "/about",
        [
          { appRelPath: "pages/about.tsx", convention: "next-pages" },
          { appRelPath: "pages/about/index.tsx", convention: "next-pages" },
        ],
      ],
    ]),
    // `blog.tsx` beside `blog.$slug.tsx`, and `posts.tsx` beside `posts.index.tsx`, are layouts.
    layouts: new Set(["/blog", "/posts"]),
  };
  assert.deepEqual(ownerOf("/pricing", walk), { owner: { appRelPath: "src/routes/pricing.tsx", convention: "tanstack" } });
  assert.deepEqual(ownerOf("/posts", walk), { owner: { appRelPath: "src/routes/posts.index.tsx", convention: "tanstack" } });
  assert.deepEqual(ownerOf("/blog/hello", walk), { refused: "dynamic" });
  assert.deepEqual(ownerOf("/docs/a/b", walk), { refused: "dynamic" });
  assert.deepEqual(ownerOf("/blog", walk), { refused: "layout" });
  assert.deepEqual(ownerOf("/about", walk), { refused: "several-files" });
  assert.deepEqual(ownerOf("/contact", walk), { refused: "no-file" });
  assert.deepEqual(ownerOf("/docs", walk), { refused: "no-file" }, "a catch-all needs one segment");
  const optional = { files: new Map([["/shop/[[...all]]", [{ appRelPath: "app/shop/[[...all]]/page.tsx", convention: "next-app" as const }]]]), layouts: new Set<string>() };
  assert.deepEqual(ownerOf("/shop", optional), { refused: "dynamic" });
});

test("special files are lost only by a sibling folder copy", () => {
  const pricing: OwnerFile = { appRelPath: "app/pricing/page.tsx", convention: "next-app" };
  assert.equal(specialFilesLost(pricing, { newFolder: "app/pricing-v2" }, ["page.tsx", "layout.tsx"]), true);
  for (const special of ["template.tsx", "loading.js", "error.tsx", "not-found.jsx"]) {
    assert.equal(specialFilesLost(pricing, { newFolder: "app/pricing-v2" }, ["page.tsx", special]), true, special);
  }
  assert.equal(specialFilesLost(pricing, { newFolder: "app/pricing-v2" }, ["page.tsx", "PriceCard.tsx", "layout.css"]), false);
  const root: OwnerFile = { appRelPath: "app/page.tsx", convention: "next-app" };
  assert.equal(specialFilesLost(root, { newFolder: "app/index-v2" }, ["page.tsx", "layout.tsx"]), false, "a child folder inherits app/layout.tsx");
  assert.equal(specialFilesLost({ appRelPath: "pages/pricing.tsx", convention: "next-pages" }, {}, ["layout.tsx"]), false);
  assert.equal(specialFilesLost({ appRelPath: "src/routes/pricing/route.tsx", convention: "tanstack" }, { newFolder: "src/routes/pricing-v2" }, ["layout.tsx"]), false);
});

test("relative imports", () => {
  // The same folder: nothing can move, so nothing is scanned (this text doesn't even tokenize).
  assert.equal(relativeImportsMoved('import x from "./x', "src/routes", "src/routes", "ts"), false);
  const sibling = (source: string) => relativeImportsMoved(source, "app/pricing", "app/pricing-v2", "ts");
  assert.equal(sibling('import { cn } from "../lib/x";\n'), false);
  assert.equal(sibling('import Hero from "./Hero";\n'), true);
  assert.equal(sibling('import "./pricing.css";\n'), true);
  const deeper = (source: string) => relativeImportsMoved(source, "app", "app/index-v2", "ts");
  assert.equal(deeper('import x from "../x";\n'), true);
  assert.equal(sibling('const x = require("./x");\n'), true);
  assert.equal(sibling('const m = await import("./m");\n'), true);
  assert.equal(sibling('export { a } from "./a";\n'), true);
  assert.equal(sibling('export * from "./b";\n'), true);
  assert.equal(sibling('import type { T } from "./types";\n'), true);
  assert.equal(sibling('import React from "react";\nimport x from "@/x";\nimport y from "~/y";\n'), false);
  assert.equal(sibling('// import "./x";\n/* require("./y") */\nconst label = "./not-an-import";\n'), false);
  assert.equal(sibling("const a = `x ${"), true, "an unterminated template fails closed");
  // Astro: only the frontmatter is code; the body's apostrophes are page text.
  const astro = (source: string) => relativeImportsMoved(source, "src/pages/blog", "src/pages/blog-v2", "astro");
  assert.equal(astro('---\nimport Layout from "../../layouts/Base.astro";\n---\n<h1>It\'s here</h1>\n'), false);
  assert.equal(astro('---\nimport Hero from "./Hero.astro";\n---\n<Hero />\n'), true);
  assert.equal(astro("<h1>No frontmatter</h1>\n"), false);
});

test("TanStack route ids", () => {
  assert.equal(tanstackRouteId("src/routes/pricing.tsx"), "/pricing");
  assert.equal(tanstackRouteId("src/routes/blog.index.tsx"), "/blog/");
  assert.equal(tanstackRouteId("src/routes/blog/index.tsx"), "/blog/");
  assert.equal(tanstackRouteId("src/routes/index.tsx"), "/");
  assert.equal(tanstackRouteId("src/routes/pricing/route.tsx"), "/pricing");
  assert.equal(tanstackRouteId("src/routes/posts.$postId.tsx"), "/posts/$postId");
  assert.equal(tanstackRouteId("src/routes/about.lazy.tsx"), "/about");
  assert.equal(tanstackRouteId("src/routes/_auth.dashboard.tsx"), "/_auth/dashboard");
  // The copies' own literals.
  assert.equal(tanstackRouteId("src/routes/pricing-v2.tsx"), "/pricing-v2");
  assert.equal(tanstackRouteId("src/routes/blog-v2.index.tsx"), "/blog-v2/");
  assert.equal(tanstackRouteId("src/routes/index-v2.tsx"), "/index-v2");
  assert.equal(tanstackRouteId("app/routes/pricing.tsx"), null, "not a TanStack route file");
});

const rewrite = (text: string | Buffer, from: string, to: string) => rewriteTanstackLiteral(Buffer.isBuffer(text) ? text : Buffer.from(text), from, to);

test("the TanStack literal is rewritten at its call site, or refused", async () => {
  const pricing = [
    'import { createFileRoute, Link } from "@tanstack/react-router"',
    "",
    "export const Route = createFileRoute('/pricing')({ component: Pricing })",
    "",
    "function Pricing() {",
    '  return <Link to="/pricing">Pricing</Link>',
    "}",
    "",
  ].join("\n");
  const pricingCopy = [
    'import { createFileRoute, Link } from "@tanstack/react-router"',
    "",
    "export const Route = createFileRoute('/pricing-v2')({ component: Pricing })",
    "",
    "function Pricing() {",
    '  return <Link to="/pricing">Pricing</Link>',
    "}",
    "",
  ].join("\n");
  assert.deepEqual(rewrite(pricing, "/pricing", "/pricing-v2"), { bytes: Buffer.from(pricingCopy) });

  const about = 'import { createLazyFileRoute } from "@tanstack/react-router"\n\nexport const Route = createLazyFileRoute("/about")({\n  component: About,\n})\n';
  const aboutCopy = 'import { createLazyFileRoute } from "@tanstack/react-router"\n\nexport const Route = createLazyFileRoute("/about-v2")({\n  component: About,\n})\n';
  assert.deepEqual(rewrite(about, "/about", "/about-v2"), { bytes: Buffer.from(aboutCopy) });

  const blog = "export const Route = createFileRoute('/blog/')({ component: Blog })\n";
  assert.deepEqual(rewrite(blog, "/blog/", "/blog-v2/"), { bytes: Buffer.from("export const Route = createFileRoute('/blog-v2/')({ component: Blog })\n") });

  // A member call with the same name isn't the route's call site.
  const member = "export const Route = createFileRoute('/pricing')({})\nconst other = api.createFileRoute('/pricing')\n";
  assert.deepEqual(rewrite(member, "/pricing", "/pricing-v2"), {
    bytes: Buffer.from("export const Route = createFileRoute('/pricing-v2')({})\nconst other = api.createFileRoute('/pricing')\n"),
  });

  // A byte-order mark stays.
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("export const Route = createFileRoute('/pricing')({})\n")]);
  const bomCopy = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("export const Route = createFileRoute('/pricing-v2')({})\n")]);
  assert.deepEqual(rewrite(bom, "/pricing", "/pricing-v2"), { bytes: bomCopy });

  // @tanstack/router-core's own route example (data-loading/SKILL.md), as a file.
  const doc = await readFile(path.join(here, "fixtures/tanstack-route.tsx"));
  const docCopy = Buffer.from(doc.toString("utf8").replace("createFileRoute('/posts')(", "createFileRoute('/posts-v2')("));
  assert.notDeepEqual(docCopy, doc);
  assert.deepEqual(rewrite(doc, "/posts", "/posts-v2"), { bytes: docCopy });

  // No call site: the same bytes.
  for (const plain of [
    "export default function Pricing() {\n  return <h1>Pricing</h1>\n}\n",
    // JSX text the tokenizer can't read (an apostrophe) is fine when the file names no route.
    "export default function Pricing() {\n  return <p>We're hiring</p>\n}\n",
    'import { createFileRoute } from "@tanstack/react-router"\nexport default function Pricing() {}\n',
  ]) {
    assert.deepEqual(rewrite(plain, "/pricing", "/pricing-v2"), { bytes: Buffer.from(plain) });
  }

  const refused = { refused: "route-literal" };
  const rows: Array<[string, string | Buffer]> = [
    ["two call sites", "export const Route = createFileRoute('/pricing')({})\nexport const Other = createFileRoute('/pricing')({})\n"],
    ["an aliased import", "import { createFileRoute as route } from '@tanstack/react-router'\nexport const Route = route('/pricing')({})\n"],
    ["an aliased lazy import", "import { createLazyFileRoute as lazy } from '@tanstack/react-router'\nexport const Route = createLazyFileRoute('/pricing')({})\n"],
    ["a namespace import", "import * as Router from '@tanstack/react-router'\nexport const Route = Router.createFileRoute('/pricing')({})\n"],
    ["a template literal","export const Route = createFileRoute(`/pricing`)({})\n"],
    ["a non-string argument", "const path = '/pricing'\nexport const Route = createFileRoute(path)({})\n"],
    ["no argument", "export const Route = createFileRoute()({})\n"],
    ["a joined string", "export const Route = createFileRoute('/pricing' + '')({})\n"],
    ["an escaped literal", "export const Route = createFileRoute('\\/pricing')({})\n"],
    ["a different path", "export const Route = createFileRoute('/other')({})\n"],
    ["text that doesn't scan", "export const Route = createFileRoute('/pricing')({})\nconst open = 'never closed\n"],
    ["invalid UTF-8", Buffer.concat([Buffer.from("export const Route = createFileRoute('/pricing')({}) // "), Buffer.from([0xff, 0xfe, 0x0a])])],
  ];
  for (const [label, text] of rows) assert.deepEqual(rewrite(text, "/pricing", "/pricing-v2"), refused, label);
});

test("scanTsTokens offsets don't change the default output", () => {
  const text = "export const Route = createFileRoute('/a')({ x: \"b\\\"c\" }) // 'skipped'";
  const today = [
    { kind: "id", value: "export" },
    { kind: "id", value: "const" },
    { kind: "id", value: "Route" },
    { kind: "punct", value: "=" },
    { kind: "id", value: "createFileRoute" },
    { kind: "punct", value: "(" },
    { kind: "str", value: "/a" },
    { kind: "punct", value: ")" },
    { kind: "punct", value: "(" },
    { kind: "punct", value: "{" },
    { kind: "id", value: "x" },
    { kind: "punct", value: ":" },
    { kind: "str", value: 'b"c' },
    { kind: "punct", value: "}" },
    { kind: "punct", value: ")" },
  ];
  assert.deepEqual(scanTsTokens(text), today);
  assert.deepEqual(scanTsTokens(text, undefined, {}), today);
  const withOffsets = scanTsTokens(text, undefined, { offsets: true });
  assert.ok(withOffsets);
  const strings = withOffsets.filter((token) => token.kind === "str");
  assert.deepEqual(
    strings.map((token) => text.slice(token.start, token.end)),
    ["'/a'", '"b\\"c"'],
  );
  assert.deepEqual(
    withOffsets.map(({ kind, value }) => ({ kind, value })),
    today,
  );
  assert.equal(scanTsTokens("'open", undefined, { offsets: true }), null);
});
