import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppKind, DetectedApp, WebAppDetection } from "./app-server/app-server-core.js";
import {
  CANVAS_CONFIG_MAX_BYTES,
  CANVAS_CONFIG_PATH,
  configuredRoots,
  describedRoots,
  inspectCanvasConfig,
  isSafeWorkspaceRelativePath,
  parseCanvasConfig,
  parseCanvasConfigObject,
  readCanvasConfig,
  readCanvasConfigText,
  type CanvasConfig,
} from "./canvas-config.js";

function detected(...apps: Array<[string, AppKind]>): WebAppDetection {
  return {
    truncated: false,
    apps: apps.map(
      ([root, kind]): DetectedApp => ({
        root,
        kind,
        reason: kind === "web" ? "framework" : kind === "react-nonweb" ? "react-without-web" : "no-package",
        scripts: [],
        usesReact: kind !== "none",
        packageManager: { name: "npm", source: "default" },
        installRoot: root,
        installed: true,
      }) as unknown as DetectedApp,
    ),
  };
}

const config = (...apps: CanvasConfig["apps"]): CanvasConfig => ({ version: 1, apps });

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "aiden-canvas-config-"));
}

async function writeConfig(root: string, text: string): Promise<void> {
  await mkdir(path.join(root, ".aiden"), { recursive: true });
  await writeFile(path.join(root, CANVAS_CONFIG_PATH), text);
}

test("a config lists its apps with root, script and designMd", () => {
  assert.equal(CANVAS_CONFIG_PATH, ".aiden/canvas.json");
  assert.deepEqual(
    parseCanvasConfig(
      JSON.stringify({ apps: [{ root: "web", script: "dev", designMd: "web/design/DESIGN.md" }, { root: "." }] }),
    ),
    config({ root: "web", script: "dev", designMd: "web/design/DESIGN.md" }, { root: "." }),
  );
});

test("a missing version or version 1 is understood, and any other version isn't", () => {
  for (const text of ['{"apps":[{"root":"web"}]}', '{"version":1,"apps":[{"root":"web"}]}']) {
    const inspection = inspectCanvasConfig(text);
    assert.equal(inspection.status, "ok", text);
    assert.deepEqual(parseCanvasConfig(text), config({ root: "web" }));
  }
  for (const version of [2, 0, "1", 1.5, null, true]) {
    const raw = { version, apps: [{ root: "web" }] };
    const text = JSON.stringify(raw);
    const inspection = inspectCanvasConfig(text);
    assert.equal(inspection.status, "unsupported-version", text);
    assert.deepEqual((inspection as { raw: unknown }).raw, raw);
    assert.equal(parseCanvasConfig(text), null, text);
  }
  assert.deepEqual(inspectCanvasConfig("{not json"), { status: "invalid" });
  assert.deepEqual(inspectCanvasConfig("[1]"), { status: "invalid" });
});

test("configured roots are only the scripted entries detection sees as web apps, in file order", () => {
  assert.deepEqual(
    configuredRoots(
      config({ root: "b", script: "dev" }, { root: "docs", script: "dev" }, { root: "a", script: "start" }, { root: "c" }, { root: "b", script: "dev" }),
      detected(["a", "web"], ["b", "web"], ["c", "web"], ["docs", "react-nonweb"]),
    ),
    ["b", "a"],
  );
  assert.deepEqual(configuredRoots(config({ root: "old", script: "dev" }), detected(["site", "web"])), [], "no fallback to detection");
  assert.deepEqual(configuredRoots(config(), detected(["site", "web"])), []);
  assert.deepEqual(configuredRoots(null, detected(["site", "web"])), [], "no config, or one Aiden can't read");
});

test("described roots are scripted entries that detection also sees as web apps, else detection", () => {
  assert.deepEqual(
    describedRoots(
      config({ root: "web", script: "dev" }, { root: "docs", script: "dev" }),
      detected(["web", "web"], ["docs", "react-nonweb"]),
    ),
    ["web"],
  );
  assert.deepEqual(describedRoots(config({ root: "old", script: "dev" }), detected(["site", "web"])), ["site"]);
  assert.deepEqual(describedRoots(config({ root: "a" }), detected(["b", "web"], ["a", "web"])), ["b", "a"]);
  assert.deepEqual(describedRoots(config(), detected(["mobile", "react-nonweb"])), ["."]);
  assert.deepEqual(describedRoots(config(), detected()), ["."]);
  assert.deepEqual(
    describedRoots(
      config({ root: "b", script: "dev" }, { root: "a", script: "start" }, { root: "b", script: "dev" }),
      detected(["a", "web"], ["b", "web"]),
    ),
    ["b", "a"],
  );
  assert.deepEqual(describedRoots(null, detected(["site", "web"])), ["site"]);
  assert.deepEqual(describedRoots(null, detected(["a", "web"], ["b", "web"])), ["a", "b"]);
});

test("fields DM doesn't know are ignored by the parser but kept in the raw object", () => {
  const raw = {
    future: 1,
    apps: [{ root: "web", script: "dev", routes: ["/"], params: { id: "1" }, url: "http://localhost:3000", mock: true }],
  };
  const text = JSON.stringify(raw);
  assert.deepEqual(parseCanvasConfigObject(text), raw);
  assert.deepEqual(parseCanvasConfig(text), config({ root: "web", script: "dev" }));
  const inspection = inspectCanvasConfig(text);
  assert.equal(inspection.status, "ok");
  assert.deepEqual((inspection as { raw: unknown }).raw, raw);
});

test('a root of exactly "." is allowed, and other "." segments aren\'t', () => {
  assert.equal(isSafeWorkspaceRelativePath("."), true);
  assert.equal(isSafeWorkspaceRelativePath("apps/web"), true);
  for (const value of ["./web", "web/.", "a/./b"]) assert.equal(isSafeWorkspaceRelativePath(value), false, value);
});

test("unsafe paths are dropped", () => {
  const unsafe = ["/abs", "..", "a/../b", "a//b", "my app", 'x"y', "a\u0007b", "a".repeat(201), "", "web/", 5, null];
  for (const value of unsafe) assert.equal(isSafeWorkspaceRelativePath(value), false, JSON.stringify(value));
  assert.equal(isSafeWorkspaceRelativePath("a".repeat(200)), true);
  assert.equal(isSafeWorkspaceRelativePath("web/DESIGN.md", { extension: ".md" }), true);
  assert.equal(isSafeWorkspaceRelativePath("web/DESIGN.txt", { extension: ".md" }), false);
  assert.equal(isSafeWorkspaceRelativePath(".", { extension: ".md" }), false);

  const parsed = parseCanvasConfig(
    JSON.stringify({
      apps: [
        { root: "../outside", script: "dev" },
        { root: "/abs" },
        { root: "web", script: "-x", designMd: "web/DESIGN.txt" },
        { root: "site", script: "s".repeat(101), designMd: "." },
        { root: "docs", script: 7, designMd: 7 },
        { root: 7 },
        "web",
      ],
    }),
  );
  assert.deepEqual(parsed, config({ root: "web" }, { root: "site" }, { root: "docs" }));
});

test("bad JSON, an array, or apps that isn't an array gives no apps", () => {
  assert.equal(parseCanvasConfig("{"), null);
  assert.equal(parseCanvasConfig("[]"), null);
  assert.equal(parseCanvasConfigObject("[]"), null);
  assert.deepEqual(parseCanvasConfig('{"apps":{"root":"web"}}'), config());
  assert.deepEqual(parseCanvasConfig('\uFEFF{"apps":[{"root":"web"}]}'), config({ root: "web" }));
  const many = JSON.stringify({ apps: Array.from({ length: 40 }, (_, index) => ({ root: `app${index}` })) });
  const kept = parseCanvasConfig(many)!.apps.map((entry) => entry.root);
  assert.equal(kept.length, 32);
  assert.equal(kept[0], "app0");
  assert.equal(kept[31], "app31");
});

test("the reader says why it refused a symlinked, oversized, folder or FIFO config, without hanging", async () => {
  const root = await tempWorkspace();
  try {
    assert.deepEqual(await readCanvasConfigText(root), { status: "missing" });
    await mkdir(path.join(root, ".aiden"));
    assert.deepEqual(await readCanvasConfigText(root), { status: "missing" });

    const elsewhere = path.join(root, "elsewhere.json");
    await writeFile(elsewhere, '{"apps":[{"root":"web"}]}');
    await symlink(elsewhere, path.join(root, CANVAS_CONFIG_PATH));
    assert.deepEqual(await readCanvasConfigText(root), { status: "link" });
    await rm(path.join(root, CANVAS_CONFIG_PATH));

    await writeConfig(root, JSON.stringify({ apps: [{ root: "x".repeat(CANVAS_CONFIG_MAX_BYTES) }] }));
    assert.deepEqual(await readCanvasConfigText(root), { status: "too-large" });
    await rm(path.join(root, CANVAS_CONFIG_PATH));

    await mkdir(path.join(root, CANVAS_CONFIG_PATH));
    assert.deepEqual(await readCanvasConfigText(root), { status: "unreadable" });
    await rm(path.join(root, CANVAS_CONFIG_PATH), { recursive: true });

    execFileSync("mkfifo", [path.join(root, CANVAS_CONFIG_PATH)]);
    assert.deepEqual(await readCanvasConfigText(root), { status: "unreadable" });
    await rm(path.join(root, CANVAS_CONFIG_PATH));

    await writeConfig(root, '{"apps":[]}');
    assert.deepEqual(await readCanvasConfigText(root), { status: "ok", text: '{"apps":[]}' });

    // A symlinked .aiden folder leading out of the workspace isn't followed.
    const outside = await tempWorkspace();
    try {
      await writeConfig(outside, '{"apps":[{"root":"web"}]}');
      await rm(path.join(root, ".aiden"), { recursive: true });
      await symlink(path.join(outside, ".aiden"), path.join(root, ".aiden"));
      assert.deepEqual(await readCanvasConfigText(root), { status: "link" });
      assert.equal(await readCanvasConfig(root), null);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    await rm(path.join(root, ".aiden"));
    await writeFile(path.join(root, ".aiden"), "not a folder");
    assert.deepEqual(await readCanvasConfigText(root), { status: "unreadable" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing config is null, and a present one is read", async () => {
  const root = await tempWorkspace();
  try {
    assert.equal(await readCanvasConfig(root), null);
    await writeConfig(root, '{"version":1,"apps":[{"root":"web","script":"dev"}]}');
    assert.deepEqual(await readCanvasConfig(root), config({ root: "web", script: "dev" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
