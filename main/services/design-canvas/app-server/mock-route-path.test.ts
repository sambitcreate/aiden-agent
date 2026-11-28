// The design app's own router (resources/design-app-template/src/aiden/route-path.ts)
// and main's TanStack rule must agree on every page (design mode v2 Phase 3d,
// S108): a frame main places at `/settings` has to be the page the design app
// shows at `/settings`.

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { routePath } from "../../../../resources/design-app-template/src/aiden/route-path.js";
import { isConcreteRoute } from "../../../../renderer/shared/design-canvas/app-routes.js";
import { routeFromFile } from "./app-routes-core.js";

const FILES = [
  "index.tsx",
  "settings.tsx",
  "settings-v2.tsx",
  "settings.index.tsx",
  "settings/index.tsx",
  "billing.index.tsx",
  "billing/plans.tsx",
  "billing.plans.jsx",
  "a.b.c.tsx",
  "posts_.edit.tsx",
  "posts.lazy.tsx",
  "about.route.tsx",
  "file[.]json.tsx",
  "v1[.]2.tsx",
  "café.tsx",
  "dashboard.ts",
  "notes.js",
  "$slug.tsx",
  "blog.$slug.tsx",
  "_layout.tsx",
  "_auth.login.tsx",
  "__root.tsx",
  "(marketing).tsx",
  "(marketing)/pricing.tsx",
  "-components/Card.tsx",
  "{-$lang}.tsx",
  "index.css",
  "README.md",
  "settings.test.tsx",
  "a..b.tsx",
  "[unclosed.tsx",
  "with space.tsx",
  "q?.tsx",
  "hash#.tsx",
  "pct%41.tsx",
  "%2e.tsx",
  "%2E%2e.tsx",
  "zero\u200bwidth.tsx",
  "tab\tname.tsx",
  "_auth.login.tsx",
  "_auth/profile.tsx",
  "a/_b/c.tsx",
  "a._b.tsx",
  "_x/index.tsx",
  "__x.y.tsx",
  "(marketing)/pricing.tsx",
  "index.index.tsx",
  "a.index.b.tsx",
  "x_.tsx",
  "_.tsx",
  "route.tsx",
  "lazy.tsx",
  "_.x.tsx",
  "__root.x.tsx",
  "__root/x.tsx",
  "().x.tsx",
  "(a)b.x.tsx",
  "_[x].y.tsx",
  "_a_.b.tsx",
  "{x}.tsx",
  "a.-b.tsx",
  "a.$.tsx",
  `${"x".repeat(2100)}.tsx`,
];

async function fixtureFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await fixtureFiles(path.join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

test("the template's routePath agrees with main's rule on every concrete route", async () => {
  const fixtures = [
    ...(await fixtureFiles(path.resolve("tests/fixtures/design-live-routes/src/routes"))),
    ...(await fixtureFiles(path.resolve("tests/fixtures/design-mock-routes/src/routes"))),
  ];
  assert.ok(fixtures.length >= 6, "the fixtures are read");
  let concrete = 0;
  for (const file of [...FILES, ...fixtures]) {
    const main = routeFromFile("tanstack", `src/routes/${file}`);
    const mine = routePath(file);
    if (main !== null && isConcreteRoute(main)) {
      concrete += 1;
      assert.equal(mine, main, file);
    } else {
      assert.equal(mine, null, `${file}: main gives ${String(main)}`);
    }
  }
  assert.ok(concrete >= 12, `enough concrete rows (${concrete})`);
});

test("routePath's own answers for the pages a design app starts with", () => {
  assert.equal(routePath("index.tsx"), "/");
  assert.equal(routePath("settings.tsx"), "/settings");
  assert.equal(routePath("billing.index.tsx"), "/billing");
  assert.equal(routePath("billing/plans.tsx"), "/billing/plans");
  assert.equal(routePath("file[.]json.tsx"), "/file.json");
  assert.equal(routePath("$slug.tsx"), null);
  assert.equal(routePath("_layout.tsx"), null);
});
