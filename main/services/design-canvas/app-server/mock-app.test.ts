// Writing a design app (design mode v2 Phase 3d, S107, S109, S110): temp
// workspaces, the real template folder and, where it says so, the real
// DESIGN.md worker.

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DesignMdReader } from "../design-md/reader.js";
import { createPageFile } from "./app-page-files.js";
import { MOCK_FOLDERS } from "./mock-app-core.js";
import { designAppTemplateDir, draftMockDesignMd, firstMockConfig, mockFiles, mockFolderStates, readMockInputs, readTemplate, writeMockApp } from "./mock-app.js";

const TEMPLATE = path.resolve("resources/design-app-template");
const admission = () => ({ signal: new AbortController().signal });

async function tempDir(t: TestContext, files: Record<string, string> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "aiden-mock-app-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return root;
}

async function template(): Promise<Map<string, Buffer>> {
  const read = await readTemplate(TEMPLATE);
  assert.ok(read.ok);
  return read.files;
}

async function listAll(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listAll(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

const exists = async (file: string) => lstat(file).then(() => true, () => false);

test("designAppTemplateDir is the packaged resource, or the repository's in development", () => {
  assert.equal(designAppTemplateDir({ isPackaged: true, resourcesPath: "/A.app/Contents/Resources", appPath: "/x" }), "/A.app/Contents/Resources/design-app-template");
  assert.equal(designAppTemplateDir({ isPackaged: false, resourcesPath: "/r", appPath: "/repo" }), "/repo/resources/design-app-template");
});

test("a starter scaffold writes the template's files exactly and adds the canvas.json entry", async (t) => {
  const ws = await tempDir(t, { ".aiden/canvas.json": JSON.stringify({ version: 1, apps: [{ root: "docs", note: "kept" }], extra: true }) });
  const files = await template();
  const config = await firstMockConfig(ws, { kind: "starter" });
  const result = await writeMockApp(ws, "design-app", mockFiles(files, config, { designMd: "starter", styleSources: [], reason: "no-tokens" }), { admission: admission() });
  assert.deepEqual(result, { ok: true, written: [...files.keys()], canvasConfig: "saved" });
  assert.deepEqual(await listAll(path.join(ws, "design-app")), [...files.keys()].sort());
  for (const [rel, bytes] of files) {
    // check-aiden-rules: allow no-source-grep-test compares a written temp-workspace file with the template's bytes
    assert.deepEqual(await readFile(path.join(ws, "design-app", rel)), bytes, rel);
  }
  // check-aiden-rules: allow no-source-grep-test reads the temp workspace's canvas.json
  const saved = JSON.parse(await readFile(path.join(ws, ".aiden/canvas.json"), "utf8"));
  assert.deepEqual(saved, { version: 1, apps: [{ root: "docs", note: "kept" }, { root: "design-app", script: "dev" }], extra: true });
  assert.equal(((await lstat(path.join(ws, "design-app/package.json"))).mode & 0o777) & 0o111, 0, "no file is executable");
});

test("a react-nonweb scaffold writes the alias, stubs and globals", async (t) => {
  const ws = await tempDir(t, {
    "package.json": JSON.stringify({ name: "desk", devDependencies: { electron: "43.0.0" }, dependencies: { react: "19.2.7" } }),
    "src/renderer/App.tsx": "export default () => null;\n",
    "src/preload.ts": 'import { contextBridge } from "electron";\ncontextBridge.exposeInMainWorld("api", { ping: () => 1 });\n',
    "node_modules/x/preload.ts": 'contextBridge.exposeInMainWorld("vendored", {});\n',
  });
  const config = await firstMockConfig(ws, { kind: "react-nonweb", source: ".", shell: "electron" });
  assert.deepEqual(config, {
    version: 1,
    kind: "react-nonweb",
    source: ".",
    aliases: { "@app": "src/renderer" },
    stubs: { electron: "src/stubs/electron.ts", "@electron/remote": "src/stubs/electron.ts" },
    globals: ["api"],
  });
  const result = await writeMockApp(ws, "design-app", mockFiles(await template(), config, { designMd: "starter", styleSources: [], reason: "no-tokens" }), { admission: admission() });
  assert.equal(result.ok, true);
  // check-aiden-rules: allow no-source-grep-test reads the temp workspace's written aiden.mock.json
  assert.deepEqual(JSON.parse(await readFile(path.join(ws, "design-app/aiden.mock.json"), "utf8")), config);

  // React Native gets the alias but no stubs; a UI folder that's a link isn't aliased.
  const native = await tempDir(t, { "apps/mobile/src/App.tsx": "", "apps/mobile/package.json": "{}" });
  assert.deepEqual(await firstMockConfig(native, { kind: "react-nonweb", source: "apps/mobile", reactNative: true }), {
    version: 1,
    kind: "react-nonweb",
    source: "apps/mobile",
    aliases: { "@app": "apps/mobile/src" },
    stubs: {},
    globals: [],
  });
  const outside = await tempDir(t, { "ui/App.tsx": "" });
  const linked = await tempDir(t, { "package.json": "{}" });
  await symlink(path.join(outside, "ui"), path.join(linked, "src"));
  assert.deepEqual((await firstMockConfig(linked, { kind: "react-nonweb", source: ".", shell: "tauri" })).aliases, {});
});

test("nothing is overwritten: a folder or file that appears first makes the write fail and stays as it was", async (t) => {
  const files = await template();
  const ws = await tempDir(t, { "design-app/README.md": "mine\n" });
  assert.deepEqual(await writeMockApp(ws, "design-app", files, { admission: admission() }), { ok: false, step: "write", kept: [] });
  // check-aiden-rules: allow no-source-grep-test reads the person's file in a temp workspace
  assert.equal(await readFile(path.join(ws, "design-app/README.md"), "utf8"), "mine\n");
  assert.deepEqual(await readdir(path.join(ws, "design-app")), ["README.md"]);
  // A folder the person made with nothing the template names is still theirs: nothing is added to it.
  const theirs = await tempDir(t, { "design-app/notes.txt": "mine\n" });
  assert.deepEqual(await writeMockApp(theirs, "design-app", files, { admission: admission() }), { ok: false, step: "write", kept: [] });
  assert.deepEqual(await readdir(path.join(theirs, "design-app")), ["notes.txt"]);

  // A file made inside the new folder, between its mkdir and the write.
  const raced = await tempDir(t);
  const result = await writeMockApp(raced, "design-app", files, {
    admission: admission(),
    afterFolder: async (rel) => {
      if (rel === "design-app") await writeFile(path.join(raced, "design-app/README.md"), "mine\n");
    },
  });
  assert.deepEqual(result, { ok: false, step: "write", kept: [] });
  // check-aiden-rules: allow no-source-grep-test reads the person's file in a temp workspace
  assert.equal(await readFile(path.join(raced, "design-app/README.md"), "utf8"), "mine\n");
  assert.deepEqual(await listAll(path.join(raced, "design-app")), ["README.md"], "everything written before it is gone");
});

test("a link anywhere on the path refuses and leaves its target untouched", async (t) => {
  const files = await template();
  const outside = await tempDir(t);
  const ws = await tempDir(t);
  await symlink(outside, path.join(ws, "design-app"));
  assert.equal((await writeMockApp(ws, "design-app", files, { admission: admission() })).ok, false);
  assert.deepEqual(await readdir(outside), []);

  const swapped = await tempDir(t);
  const result = await writeMockApp(swapped, "design-app", files, {
    admission: admission(),
    afterFolder: async (rel) => {
      if (rel !== "design-app/src") return;
      await rmdir(path.join(swapped, "design-app/src"));
      await symlink(outside, path.join(swapped, "design-app/src"));
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(await readdir(outside), [], "nothing went through the link");
});

test("a failure halfway removes only what was written and unchanged, and reports the rest", async (t) => {
  const files = await template();
  const ws = await tempDir(t);
  const order = [...files.keys()];
  let calls = 0;
  const result = await writeMockApp(ws, "design-app", files, {
    admission: admission(),
    fs: {
      writeFile: async (file, bytes, mode) => {
        calls += 1;
        if (calls === 5) {
          await writeFile(path.join(ws, "design-app", order[1]!), "changed meanwhile\n");
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
        await createPageFile(file, bytes, mode);
      },
    },
  });
  assert.deepEqual(result, { ok: false, step: "write", kept: [order[1]] });
  assert.deepEqual(await listAll(path.join(ws, "design-app")), [order[1]]);
  // check-aiden-rules: allow no-source-grep-test reads the changed file in a temp workspace
  assert.equal(await readFile(path.join(ws, "design-app", order[1]!), "utf8"), "changed meanwhile\n");
});

test("rollback never follows a link swapped in for a written file", async (t) => {
  const files = await template();
  const outside = await tempDir(t, { "secret.txt": "outside\n" });
  const ws = await tempDir(t);
  const order = [...files.keys()];
  let calls = 0;
  const result = await writeMockApp(ws, "design-app", files, {
    admission: admission(),
    fs: {
      writeFile: async (file, bytes, mode) => {
        calls += 1;
        if (calls === 4) {
          await rm(path.join(ws, "design-app", order[0]!));
          await symlink(path.join(outside, "secret.txt"), path.join(ws, "design-app", order[0]!));
          throw new Error("stop");
        }
        await createPageFile(file, bytes, mode);
      },
    },
  });
  assert.deepEqual(result, { ok: false, step: "write", kept: [order[0]] });
  assert.ok((await lstat(path.join(ws, "design-app", order[0]!))).isSymbolicLink(), "the link is left alone");
  // check-aiden-rules: allow no-source-grep-test reads a file outside the temp workspace
  assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "outside\n");
});

test("verification fails when a written file changed before it was checked", async (t) => {
  const files = await template();
  const ws = await tempDir(t);
  const result = await writeMockApp(ws, "design-app", files, {
    admission: admission(),
    beforeVerify: async () => writeFile(path.join(ws, "design-app/vite.config.js"), "export default {};\n"),
  });
  assert.deepEqual(result, { ok: false, step: "verify", kept: ["vite.config.js"] });
  assert.deepEqual(await listAll(path.join(ws, "design-app")), ["vite.config.js"]);
  assert.equal(await exists(path.join(ws, ".aiden/canvas.json")), false, "no entry for a failed scaffold");
});

test("a folder-path change mid-write aborts and rolls back", async (t) => {
  const files = await template();
  const ws = await tempDir(t);
  const controller = new AbortController();
  const result = await writeMockApp(ws, "design-app", files, {
    admission: { signal: controller.signal },
    afterFolder: async (rel) => {
      if (rel === "design-app/src/aiden") controller.abort();
    },
  });
  assert.deepEqual(result, { ok: false, step: "write", kept: [] });
  assert.equal(await exists(path.join(ws, "design-app")), false);
});

test("a canvas.json that can't be saved leaves the design app in place", async (t) => {
  const ws = await tempDir(t);
  const result = await writeMockApp(ws, "design-app", await template(), {
    admission: admission(),
    saveConfig: async () => {
      throw new Error("refused");
    },
  });
  assert.equal(result.ok && result.canvasConfig, "not-saved");
  assert.ok(await exists(path.join(ws, "design-app/package.json")));
});

test("the template is read bounded", async (t) => {
  const files = await template();
  assert.ok(files.size > 10 && files.size <= 64);
  assert.ok(files.has("package.json") && files.has(".npmrc") && files.has("src/aiden/route-path.ts"));

  const linked = await tempDir(t, { "package.json": "{}" });
  await symlink(path.join(linked, "package.json"), path.join(linked, "alias.json"));
  assert.deepEqual(await readTemplate(linked), { ok: false, problem: "template" });

  const big = await tempDir(t, { "package.json": "{}", "big.bin": "x".repeat(2 * 1024 * 1024) });
  assert.deepEqual(await readTemplate(big), { ok: false, problem: "template" });

  const many: Record<string, string> = { "package.json": "{}" };
  for (let index = 0; index < 64; index++) many[`f${index}.txt`] = "";
  assert.deepEqual(await readTemplate(await tempDir(t, many)), { ok: false, problem: "template" });

  const total: Record<string, string> = { "package.json": "{}" };
  for (let index = 0; index < 5; index++) total[`f${index}.txt`] = "x".repeat(250 * 1024);
  assert.deepEqual(await readTemplate(await tempDir(t, total)), { ok: false, problem: "template" }, "over 1 MiB in all");
  assert.deepEqual(await readTemplate(path.join(big, "missing")), { ok: false, problem: "template" });
});

test("folder states: missing, a design app, or taken; never through a link", async (t) => {
  const outside = await tempDir(t, { "package.json": JSON.stringify({ aiden: { designApp: 1 } }) });
  const ws = await tempDir(t, {
    "design-app/package.json": JSON.stringify({ name: "x" }),
    "design-app-2/package.json": JSON.stringify({ aiden: { designApp: 1 } }),
    "design-app-4": "a file",
  });
  await symlink(outside, path.join(ws, "design-app-3"));
  const states = await mockFolderStates(ws);
  assert.deepEqual(Object.fromEntries(states), {
    ...Object.fromEntries(MOCK_FOLDERS.map((folder) => [folder, "missing"])),
    "design-app": "taken",
    "design-app-2": "mock",
    "design-app-3": "taken",
    "design-app-4": "taken",
  });
  const inputs = await readMockInputs(ws);
  assert.deepEqual([inputs.config, inputs.patterns], [null, { include: [], exclude: [] }]);
  await writeFile(path.join(ws, "package.json"), JSON.stringify({ workspaces: ["packages/*", "!packages/old"] }));
  await mkdir(path.join(ws, ".aiden"));
  await writeFile(path.join(ws, ".aiden/canvas.json"), JSON.stringify({ version: 9 }));
  const again = await readMockInputs(ws);
  assert.deepEqual(again.patterns, { include: ["packages/*"], exclude: ["packages/old"] });
  assert.equal(again.config?.status, "unsupported-version");
});

// ---- DESIGN.md (S110) ----

const STYLES = ":root { --primary: #1a1c1e; --surface: #ffffff; --font-sans: Inter, sans-serif; }\n.dark { --primary: #fafafa; }\n";

test("the drafted DESIGN.md replaces the starter when the project has tokens, and theme.css is its css-vars export", async (t) => {
  const ws = await tempDir(t, { "package.json": "{}", "src/index.css": STYLES });
  const reader = new DesignMdReader();
  const draft = await draftMockDesignMd(ws, ".", { reader });
  assert.equal(draft.designMd, "drafted", JSON.stringify(draft));
  assert.ok(draft.designMd === "drafted");
  assert.deepEqual(draft.styleSources, ["src/index.css"]);
  const lint = await reader.lintContent(draft.files["DESIGN.md"].toString("utf8"));
  assert.ok(lint.status === "ok" && lint.summary.errors === 0);
  const exported = await reader.exportContent(draft.files["DESIGN.md"].toString("utf8"), "css-vars");
  assert.ok(exported.status === "ok");
  assert.equal(draft.files["src/theme.css"].toString("utf8"), exported.text);
  assert.match(exported.text, /#1a1c1e/iu);

  const files = mockFiles(await template(), await firstMockConfig(ws, { kind: "starter" }), draft);
  await writeMockApp(ws, "design-app", files, { admission: admission() });
  // check-aiden-rules: allow no-source-grep-test reads the written temp-workspace DESIGN.md
  assert.equal(await readFile(path.join(ws, "design-app/DESIGN.md"), "utf8"), draft.files["DESIGN.md"].toString("utf8"));
});

test("a project with no tokens keeps the starter pair", async (t) => {
  const ws = await tempDir(t, { "package.json": "{}", "src/App.tsx": "export default () => null;\n" });
  const draft = await draftMockDesignMd(ws, ".", { reader: new DesignMdReader() });
  assert.deepEqual(draft, { designMd: "starter", styleSources: [], reason: "no-tokens" });
  const starter = await template();
  const files = mockFiles(starter, await firstMockConfig(ws, { kind: "starter" }), draft);
  assert.deepEqual([files.get("DESIGN.md"), files.get("src/theme.css")], [starter.get("DESIGN.md"), starter.get("src/theme.css")]);
});

test("a worker that times out keeps the starter pair and says why", async (t) => {
  const ws = await tempDir(t, { "src/index.css": STYLES });
  const reader = {
    lintContent: async () => ({ status: "timed-out" as const }),
    exportContent: async () => assert.fail("no export after a failed lint"),
  };
  assert.deepEqual(await draftMockDesignMd(ws, ".", { reader }), { designMd: "starter", styleSources: ["src/index.css"], reason: "timeout" });
});

test("a draft whose export fails writes neither drafted file", async (t) => {
  const ws = await tempDir(t, { "src/index.css": STYLES });
  const real = new DesignMdReader();
  const reader = {
    lintContent: (content: string, signal?: AbortSignal) => real.lintContent(content, signal),
    exportContent: async () => {
      throw new Error("worker gone");
    },
  };
  const draft = await draftMockDesignMd(ws, ".", { reader });
  assert.deepEqual(draft, { designMd: "starter", styleSources: ["src/index.css"], reason: "export" });
  const starter = await template();
  const files = mockFiles(starter, await firstMockConfig(ws, { kind: "starter" }), draft);
  assert.deepEqual([files.get("DESIGN.md"), files.get("src/theme.css")], [starter.get("DESIGN.md"), starter.get("src/theme.css")]);
  const empty = { ...reader, exportContent: async () => ({ status: "ok" as const, text: "  \n" }) };
  assert.equal((await draftMockDesignMd(ws, ".", { reader: empty })).designMd, "starter", "empty CSS is no export");
});

test("a draft source that is a link out of the workspace is refused", async (t) => {
  const outside = await tempDir(t, { "src/index.css": STYLES });
  const ws = await tempDir(t);
  await symlink(outside, path.join(ws, "desk"));
  assert.deepEqual(await draftMockDesignMd(ws, "desk", { reader: new DesignMdReader() }), { designMd: "starter", styleSources: [], reason: "unavailable" });
});
