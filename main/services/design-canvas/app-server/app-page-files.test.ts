// The owner walk, raw reads and confined targets on disk (design mode v2
// Phase 3c, S95): which file owns each pattern, read without following a
// link, and where a copy may be written.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ownerOf } from "./app-page-files-core.js";
import { confinedTarget, createPageFile, readRegularFileBytes, removeCreatedFile, routeFiles, writeConfinedFile } from "./app-page-files.js";
import { readRouteFile, routeFs, type RouteFs } from "./app-routes.js";

async function workspace(t: TestContext, files: Record<string, string | Buffer>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "aiden-page-files-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return root;
}

/** A route fs that records every folder it lists and every file it reads. */
function spy(): { fs: RouteFs; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    fs: routeFs({
      readdir: async (dir) => {
        paths.push(dir);
        return readdir(dir, { withFileTypes: true });
      },
      readFile: async (file, cap) => {
        paths.push(file);
        return readRouteFile(file, cap);
      },
    }),
  };
}

const plain = (files: Map<string, { appRelPath: string; convention: string }[]> | undefined) =>
  Object.fromEntries([...(files ?? new Map()).entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

test("routeFiles maps patterns to files without following links", async (t) => {
  const outside = await workspace(t, { "secret.tsx": "", "inner/leak.tsx": "" });
  const root = await workspace(t, {
    "apps/web/src/routes/__root.tsx": "",
    "apps/web/src/routes/index.tsx": "",
    "apps/web/src/routes/pricing.tsx": "",
    "apps/web/src/routes/blog.$slug.tsx": "",
    "apps/web/src/routes/-components/Card.tsx": "",
    "apps/other/src/routes/other.tsx": "",
  });
  await symlink(path.join(outside, "secret.tsx"), path.join(root, "apps/web/src/routes/linked.tsx"));
  await symlink(path.join(outside, "inner"), path.join(root, "apps/web/src/routes/out"));
  const recorded = spy();
  const walk = await routeFiles(recorded.fs, root, "apps/web", "tanstack-router");
  assert.ok(walk);
  assert.deepEqual(plain(walk.files), {
    "/": [{ appRelPath: "src/routes/index.tsx", convention: "tanstack" }],
    "/blog/[slug]": [{ appRelPath: "src/routes/blog.$slug.tsx", convention: "tanstack" }],
    "/pricing": [{ appRelPath: "src/routes/pricing.tsx", convention: "tanstack" }],
  });
  assert.deepEqual([...walk.layouts], []);
  assert.equal(walk.truncated, false);
  assert.equal(walk.configRouter, false);
  assert.ok(recorded.paths.length > 0);
  const appRoot = path.join(root, "apps/web");
  for (const entry of recorded.paths) {
    const relative = path.relative(appRoot, entry);
    assert.ok(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)), `read outside the app root: ${entry}`);
  }
  // A linked app root is never walked.
  await symlink(path.join(root, "apps/web"), path.join(root, "apps/alias"));
  assert.equal(await routeFiles(routeFs(), root, "apps/alias", "tanstack-router"), null);
});

test("routeFiles: Next's two routers, and siblings from the walk", async (t) => {
  const root = await workspace(t, {
    "app/page.tsx": "",
    "app/layout.tsx": "",
    "app/pricing/page.tsx": "",
    "app/pricing/layout.tsx": "",
    "app/pricing/PriceCard.tsx": "",
    "pages/about.tsx": "",
    "pages/about/index.tsx": "",
  });
  const walk = await routeFiles(routeFs(), root, ".", "next");
  assert.ok(walk);
  assert.deepEqual(ownerOf("/pricing", walk), { owner: { appRelPath: "app/pricing/page.tsx", convention: "next-app" } });
  assert.deepEqual(ownerOf("/about", walk), { refused: "several-files" });
  assert.deepEqual((await walk.siblings("app/pricing/page.tsx")).sort(), ["PriceCard.tsx", "layout.tsx", "page.tsx"]);
  assert.deepEqual((await walk.siblings("app/page.tsx")).sort(), ["layout.tsx", "page.tsx"]);
});

test("React Router: flatRoutes() walks files; a literal routes.ts is a config router", async (t) => {
  const flat = await workspace(t, {
    "app/routes.ts": 'import { flatRoutes } from "@react-router/fs-routes";\nexport default flatRoutes() satisfies RouteConfig;\n',
    "app/routes/_index.tsx": "",
    "app/routes/pricing.tsx": "",
  });
  const walked = await routeFiles(routeFs(), flat, ".", "react-router");
  assert.equal(walked?.configRouter, false);
  assert.deepEqual(plain(walked?.files), {
    "/": [{ appRelPath: "app/routes/_index.tsx", convention: "react-router-flat" }],
    "/pricing": [{ appRelPath: "app/routes/pricing.tsx", convention: "react-router-flat" }],
  });

  const literal = await workspace(t, {
    "app/routes.ts": 'export default [index("routes/home.tsx"), route("pricing", "routes/pricing.tsx")] satisfies RouteConfig;\n',
    "app/routes/pricing.tsx": "",
  });
  const config = await routeFiles(routeFs(), literal, ".", "react-router");
  assert.equal(config?.configRouter, true);
  assert.equal(config?.files.size, 0);

  // Flat routes under a prefix, or beside explicit routes, aren't served where the files say: a config router too.
  for (const routes of [
    'export default [prefix("admin", [...(await flatRoutes())])] satisfies RouteConfig;\n',
    'export default [route("pricing", "routes/alt.tsx"), ...(await flatRoutes())] satisfies RouteConfig;\n',
    'export default [layout("routes/shell.tsx", [...(await flatRoutes())])] satisfies RouteConfig;\n',
  ]) {
    const mixed = await workspace(t, { "app/routes.ts": routes, "app/routes/pricing.tsx": "" });
    const walkedMixed = await routeFiles(routeFs(), mixed, ".", "react-router");
    assert.deepEqual([walkedMixed?.configRouter, walkedMixed?.files.size], [true, 0], routes);
  }
  const spread = await workspace(t, { "app/routes.ts": "export default [...(await flatRoutes())] satisfies RouteConfig;\n", "app/routes/pricing.tsx": "" });
  assert.equal((await routeFiles(routeFs(), spread, ".", "react-router"))?.configRouter, false, "a lone spread is still flat");

  const code = await workspace(t, { "app/routes.ts": "export default makeRoutes();\n", "app/routes/pricing.tsx": "" });
  assert.equal((await routeFiles(routeFs(), code, ".", "react-router"))?.configRouter, true);

  const outside = await workspace(t, { "routes.ts": "export default flatRoutes();\n" });
  const linked = await workspace(t, { "app/routes/pricing.tsx": "" });
  await symlink(path.join(outside, "routes.ts"), path.join(linked, "app/routes.ts"));
  assert.equal((await routeFiles(routeFs(), linked, ".", "react-router"))?.configRouter, true, "a linked routes.ts is refused");

  const missing = await workspace(t, { "app/routes/pricing.tsx": "" });
  assert.equal((await routeFiles(routeFs(), missing, ".", "react-router"))?.files.has("/pricing"), true);

  // A framework with no file convention is a config router too.
  assert.equal((await routeFiles(routeFs(), missing, ".", "vite"))?.configRouter, true);
  assert.equal((await routeFiles(routeFs(), missing, ".", undefined))?.configRouter, true);
});

test("a TanStack layout file is listed as a layout", async (t) => {
  const root = await workspace(t, {
    "src/routes/blog.tsx": "",
    "src/routes/blog.$slug.tsx": "",
    "src/routes/posts.tsx": "",
    "src/routes/posts.index.tsx": "",
    "src/routes/_auth.tsx": "",
    "src/routes/_auth.login.tsx": "",
  });
  const walk = await routeFiles(routeFs(), root, ".", "tanstack-start");
  assert.ok(walk);
  assert.deepEqual([...walk.layouts].sort(), ["/blog", "/posts"]);
  assert.deepEqual(plain(walk.files), {
    "/blog/[slug]": [{ appRelPath: "src/routes/blog.$slug.tsx", convention: "tanstack" }],
    "/login": [{ appRelPath: "src/routes/_auth.login.tsx", convention: "tanstack" }],
    "/posts": [{ appRelPath: "src/routes/posts.index.tsx", convention: "tanstack" }],
  });
  assert.deepEqual(ownerOf("/blog", walk), { refused: "layout" });
  assert.deepEqual(ownerOf("/posts", walk), { owner: { appRelPath: "src/routes/posts.index.tsx", convention: "tanstack" } });
});

test("a capped walk is truncated", async (t) => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 2100; index += 1) files[`app/p${index}/page.tsx`] = "";
  const root = await workspace(t, files);
  const walk = await routeFiles(routeFs(), root, ".", "next");
  assert.equal(walk?.truncated, true);
});

test("readRegularFileBytes returns raw bytes and mode, and tells too-large from not-regular", async (t) => {
  const raw = Buffer.from([0xff, 0x00, 0xc3, 0x28, 0x0a, 0xe2, 0x82]);
  const root = await workspace(t, { "raw.bin": raw, "big.tsx": Buffer.alloc(600 * 1024, 0x61), "real/page.tsx": "x" });
  await chmod(path.join(root, "raw.bin"), 0o640);
  const read = await readRegularFileBytes(path.join(root, "raw.bin"), 512 * 1024);
  assert.equal(read.ok, true);
  assert.ok(read.ok);
  assert.ok(read.bytes.equals(raw), "byte for byte");
  assert.equal(read.mode, 0o640);

  assert.deepEqual(await readRegularFileBytes(path.join(root, "big.tsx"), 512 * 1024), { ok: false, reason: "too-large" });
  await symlink(path.join(root, "raw.bin"), path.join(root, "link.bin"));
  assert.deepEqual(await readRegularFileBytes(path.join(root, "link.bin"), 512 * 1024), { ok: false, reason: "not-regular" });
  await symlink(path.join(root, "real"), path.join(root, "linked-folder"));
  assert.deepEqual(await readRegularFileBytes(path.join(root, "linked-folder/page.tsx"), 512 * 1024), { ok: false, reason: "not-regular" }, "a linked parent");
  assert.deepEqual(await readRegularFileBytes(path.join(root, "real"), 512 * 1024), { ok: false, reason: "not-regular" });
  assert.deepEqual(await readRegularFileBytes(path.join(root, "absent.tsx"), 512 * 1024), { ok: false, reason: "missing" });
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    assert.deepEqual(await readRegularFileBytes(path.join(root, "pipe"), 512 * 1024), { ok: false, reason: "not-regular" });
  }
});

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

test("confinedTarget refuses a link anywhere on the path and creates one folder at most", async (t) => {
  const outside = await workspace(t, {});
  const root = await workspace(t, { "app/pricing/page.tsx": "pricing", "real/page.tsx": "" });
  await symlink(outside, path.join(root, "app/pricing-v2"));
  assert.deepEqual(await confinedTarget(root, "app/pricing-v2/page.tsx", { create: true }), { ok: false, reason: "link" });
  assert.deepEqual(await writeConfinedFile(root, "app/pricing-v2/page.tsx", Buffer.from("copy"), 0o644, { create: true }), { ok: false, reason: "link" });
  assert.deepEqual(await readdir(outside), [], "nothing is written outside");

  await symlink(path.join(root, "real"), path.join(root, "linked"));
  assert.deepEqual(await confinedTarget(root, "linked/page.tsx", { create: false }), { ok: false, reason: "link" });
  await symlink(path.join(root, "app/pricing/page.tsx"), path.join(root, "app/pricing/alias.tsx"));
  assert.deepEqual(await confinedTarget(root, "app/pricing/alias.tsx", { create: false }), { ok: false, reason: "link" });

  // An existing folder: nothing created.
  assert.deepEqual(await confinedTarget(root, "app/pricing/page.tsx", { create: false }), { ok: true, absolute: path.resolve(root, "app/pricing/page.tsx") });
  // A new folder: exactly that one.
  const made = await confinedTarget(root, "app/pricing-v3/page.tsx", { create: true });
  assert.deepEqual(made, { ok: true, absolute: path.resolve(root, "app/pricing-v3/page.tsx"), createdFolder: path.resolve(root, "app/pricing-v3") });
  assert.equal((await lstat(path.join(root, "app/pricing-v3"))).isDirectory(), true);
  // Without `create`, a missing folder refuses and nothing is made.
  assert.equal((await confinedTarget(root, "app/pricing-v4/page.tsx", { create: false })).ok, false);
  assert.equal(await exists(path.join(root, "app/pricing-v4")), false);
  // A missing grandparent refuses: never more than one level.
  assert.equal((await confinedTarget(root, "app/missing/deeper/page.tsx", { create: true })).ok, false);
  assert.equal(await exists(path.join(root, "app/missing")), false);
  for (const bad of ["../x.tsx", "/etc/x.tsx", "app/../../x.tsx", "app//x.tsx", "app\\x.tsx", ""]) {
    assert.deepEqual(await confinedTarget(root, bad, { create: true }), { ok: false, reason: "outside" }, JSON.stringify(bad));
  }
});

test("writeConfinedFile writes wx, never over a file, and removes a folder it made when the write fails", async (t) => {
  const root = await workspace(t, { "app/pricing/page.tsx": "pricing" });
  const written = await writeConfinedFile(root, "app/pricing-v2/page.tsx", Buffer.from([0xff, 0x01]), 0o600, { create: true });
  const made = await lstat(path.join(root, "app/pricing-v2/page.tsx"));
  assert.deepEqual(written, {
    ok: true,
    absolute: path.resolve(root, "app/pricing-v2/page.tsx"),
    createdFolder: path.resolve(root, "app/pricing-v2"),
    created: { dev: made.dev, ino: made.ino },
  });
  assert.ok((await readFile(path.join(root, "app/pricing-v2/page.tsx"))).equals(Buffer.from([0xff, 0x01])));
  assert.equal((await lstat(path.join(root, "app/pricing-v2/page.tsx"))).mode & 0o777, 0o600);

  assert.deepEqual(await writeConfinedFile(root, "app/pricing/page.tsx", Buffer.from("over"), 0o644, { create: false }), { ok: false, reason: "exists" });
  assert.equal(await readFile(path.join(root, "app/pricing/page.tsx"), "utf8"), "pricing");

  // A case-insensitive volume answers EEXIST for `pricing-v3` when `Pricing-v3` is there.
  const clash = Object.assign(new Error("exists"), { code: "EEXIST" });
  const caseInsensitive = await writeConfinedFile(root, "app/pricing-v3/page.tsx", Buffer.from("x"), 0o644, {
    create: true,
    fs: { writeFile: async () => Promise.reject(clash) },
  });
  assert.deepEqual(caseInsensitive, { ok: false, reason: "exists" });
  assert.equal(await exists(path.join(root, "app/pricing-v3")), false, "the folder it made is removed");

  const failing = await writeConfinedFile(root, "app/pricing-v4/page.tsx", Buffer.from("x"), 0o644, {
    create: true,
    fs: { writeFile: async () => Promise.reject(Object.assign(new Error("disk"), { code: "EIO" })) },
  });
  assert.deepEqual(failing, { ok: false, reason: "io" });
  assert.equal(await exists(path.join(root, "app/pricing-v4")), false);
});

/** Whether `dir`'s volume finds a name under another case (APFS, NTFS), probed rather than assumed. */
async function caseInsensitive(dir: string): Promise<boolean> {
  await mkdir(path.join(dir, "Case-Probe"));
  try {
    return await exists(path.join(dir, "case-probe"));
  } finally {
    await rm(path.join(dir, "Case-Probe"), { recursive: true });
  }
}

test("a new page's folder already taken under another case, or by a file, is a taken slot", async (t) => {
  const root = await workspace(t, { "app/Pricing-v2/page.tsx": "theirs", "app/pricing-v3": "a file, not a folder" });
  const copy = () => writeConfinedFile(root, "app/pricing-v2/page.tsx", Buffer.from("copy"), 0o644, { create: true });
  if (await caseInsensitive(root)) {
    // The volume finds `pricing-v2` as `Pricing-v2`, and native realpath names it so: a taken name, not a link.
    assert.deepEqual(await copy(), { ok: false, reason: "exists" });
  } else {
    // A case-sensitive volume has no clash: `pricing-v2` is a folder of its own.
    assert.equal((await copy()).ok, true);
    // check-aiden-rules: allow no-source-grep-test reads a page file in a temp workspace, not Aiden source
    assert.equal(await readFile(path.join(root, "app/pricing-v2/page.tsx"), "utf8"), "copy");
  }
  // check-aiden-rules: allow no-source-grep-test reads a page file in a temp workspace, not Aiden source
  assert.equal(await readFile(path.join(root, "app/Pricing-v2/page.tsx"), "utf8"), "theirs", "the other page is never touched");
  // A file where the new page's folder would go is taken on every volume.
  assert.deepEqual(await writeConfinedFile(root, "app/pricing-v3/page.tsx", Buffer.from("copy"), 0o644, { create: true }), { ok: false, reason: "exists" });
  // Not for a folder the path only passes through: that one is still a refusal.
  assert.deepEqual(await writeConfinedFile(root, "app/pricing-v3/deeper/page.tsx", Buffer.from("copy"), 0o644, { create: true }), { ok: false, reason: "io" });
});

/**
 * Swaps `app` for a link to `outside` and back around `during`, the way a
 * process racing the write would: the same folder (inode) comes back after.
 */
async function linkedOutDuring<T>(root: string, outside: string, during: () => Promise<T>): Promise<T> {
  const app = path.join(root, "app");
  const aside = path.join(root, "app-aside");
  await rename(app, aside);
  await symlink(outside, app);
  try {
    return await during();
  } finally {
    await rm(app);
    await rename(aside, app);
  }
}

/** The outside file's bytes, or none when it isn't there. */
const outsideBytes = async (file: string) => (await readFile(file).catch(() => Buffer.alloc(0))).length;

test("confinement: a folder above a new page linked out while the page is created gets none of its bytes", async (t) => {
  const outside = await workspace(t, { "routes/keep.tsx": "" });
  const root = await workspace(t, { "app/routes/home.tsx": "" });
  const swapped = { writeFile: (file: string, bytes: Buffer, mode: number) => linkedOutDuring(root, outside, () => createPageFile(file, bytes, mode)) };
  const written = await writeConfinedFile(root, "app/routes/pricing-v2.tsx", Buffer.from("the copy"), 0o644, { create: false, fs: swapped });
  assert.deepEqual(written, { ok: false, reason: "link" });
  assert.equal(await outsideBytes(path.join(outside, "routes/pricing-v2.tsx")), 0, "no byte outside the workspace");
  assert.equal(await exists(path.join(root, "app/routes/pricing-v2.tsx")), false);
});

/** Every entry under `dir`, recursively: what a create sent outside would leave, an empty file included. */
const entriesUnder = async (dir: string) => (await readdir(dir, { recursive: true })).sort();

for (const putBack of ["after the create", "at the end"] as const) {
  test(`confinement: a folder above a new page linked out from the folder's check until ${putBack} leaves nothing outside`, async (t) => {
    // Pullfrog r4724600691: the path names the outside for the create (and any check by path right after it), then is put back.
    const outside = await workspace(t, { "routes/keep.tsx": "" });
    const root = await workspace(t, { "app/routes/home.tsx": "" });
    let linked = false;
    const restore = async () => {
      if (!linked) return;
      linked = false;
      await rm(path.join(root, "app"));
      await rename(path.join(root, "app-aside"), path.join(root, "app"));
    };
    const racing = {
      writeFile: (file: string, bytes: Buffer, mode: number) =>
        createPageFile(file, bytes, mode, {
          beforeCreate: async () => {
            await rename(path.join(root, "app"), path.join(root, "app-aside"));
            await symlink(outside, path.join(root, "app"));
            linked = true;
          },
          ...(putBack === "after the create" ? { afterCreate: restore } : {}),
        }),
    };
    const written = await writeConfinedFile(root, "app/routes/pricing-v2.tsx", Buffer.from("the copy"), 0o644, { create: false, fs: racing }).finally(restore);
    assert.deepEqual(await entriesUnder(outside), ["routes", "routes/keep.tsx"], "nothing made outside the workspace, not even an empty file");
    if (written.ok) {
      // Linux creates through the folder's own handle: put back before the checks, the copy is in the workspace.
      assert.equal(putBack, "after the create");
      // check-aiden-rules: allow no-source-grep-test reads a page file in a temp workspace, not Aiden source
      assert.equal(await readFile(path.join(root, "app/routes/pricing-v2.tsx"), "utf8"), "the copy");
    } else {
      assert.deepEqual(written, { ok: false, reason: "link" });
      assert.deepEqual(await readdir(path.join(root, "app/routes")), ["home.tsx"], "nothing made, or left aside, in the workspace");
    }
  });
}

test("removeCreatedFile takes back only the file it made, with its bytes, through the folder's handle on Linux", async (t) => {
  const root = await workspace(t, { "app/routes/home.tsx": "" });
  const file = path.join(root, "app/routes/pricing-v2.tsx");
  const bytes = Buffer.from("the copy");
  const created = await createPageFile(file, bytes, 0o644);
  if (process.platform !== "linux") {
    // No handle-bound unlink: the caller moves the file to the Trash instead, and nothing is removed here.
    assert.equal(await removeCreatedFile(file, created, bytes), "unbound");
    assert.equal(await exists(file), true);
    return;
  }
  // Edited since: kept.
  await writeFile(file, "edited");
  assert.equal(await removeCreatedFile(file, created, bytes), "changed");
  assert.equal(await exists(file), true);
  // Another file of that name, with the same bytes (made while the first still holds its inode, so not a reused one): kept.
  await writeFile(`${file}.other`, bytes);
  await rename(`${file}.other`, file);
  assert.equal(await removeCreatedFile(file, created, bytes), "changed");
  await rm(file);
  // The file it made, unchanged: removed.
  const again = await createPageFile(file, bytes, 0o644);
  assert.equal(await removeCreatedFile(file, again, bytes), "removed");
  assert.equal(await exists(file), false);
  assert.equal(await removeCreatedFile(file, again, bytes), "missing");
});

test("removeCreatedFile never removes a file that took the name just before the take-back", async (t) => {
  // Pullfrog r4724860830: another process puts its own file (the same bytes, so only the inode tells) at the name.
  const root = await workspace(t, { "app/routes/home.tsx": "" });
  const file = path.join(root, "app/routes/pricing-v2.tsx");
  const bytes = Buffer.from("the copy");
  const created = await createPageFile(file, bytes, 0o644);
  const replace = async () => {
    await writeFile(`${file}.theirs`, bytes);
    await rename(`${file}.theirs`, file);
  };
  const result = await removeCreatedFile(file, created, bytes, { beforeTake: replace });
  if (process.platform !== "linux") {
    assert.equal(result, "unbound");
    return;
  }
  assert.equal(result, "changed");
  assert.notEqual((await lstat(file)).ino, created.ino, "the other file is the one at the name");
  assert.ok((await readFile(file)).equals(bytes), "and it survives");
  assert.deepEqual((await readdir(path.dirname(file))).sort(), ["home.tsx", "pricing-v2.tsx"], "nothing left aside");
});

test("removeCreatedFile leaves another file aside, never over the name, when the name is taken again meanwhile", async (t) => {
  const root = await workspace(t, { "app/routes/home.tsx": "" });
  const file = path.join(root, "app/routes/pricing-v2.tsx");
  const bytes = Buffer.from("the copy");
  const created = await createPageFile(file, bytes, 0o644);
  const result = await removeCreatedFile(file, created, bytes, {
    // One process's file takes the name before the take-back, and another's takes it again right after.
    beforeTake: async () => {
      await writeFile(`${file}.first`, "first");
      await rename(`${file}.first`, file);
    },
    afterTake: async () => {
      await writeFile(file, "second");
    },
  });
  if (process.platform !== "linux") {
    assert.equal(result, "unbound");
    return;
  }
  assert.ok(typeof result === "object" && result.aside.startsWith(".aiden-rollback-"), "the first file is left aside");
  // check-aiden-rules: allow no-source-grep-test reads page files in a temp workspace, not Aiden source
  assert.equal(await readFile(file, "utf8"), "second", "the name keeps the file that took it last");
  // check-aiden-rules: allow no-source-grep-test reads page files in a temp workspace, not Aiden source
  assert.equal(await readFile(path.join(path.dirname(file), (result as { aside: string }).aside), "utf8"), "first", "and the first survives, aside");
});
