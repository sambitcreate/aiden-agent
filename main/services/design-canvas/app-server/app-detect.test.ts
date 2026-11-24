import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { detectWebApp, readBounded } from "./app-detect.js";
import { designTarget, installCommand, type DetectedApp, type WebAppDetection } from "./app-server-core.js";

type TreeValue = string | Record<string, unknown> | { symlink: string } | { dir: true };

/** Writes objects as JSON and strings as is; `{ dir: true }` makes a folder and `{ symlink }` a link. */
async function writeTree(base: string, tree: Record<string, TreeValue>): Promise<void> {
  for (const [rel, value] of Object.entries(tree)) {
    const target = path.join(base, rel);
    await mkdir(path.dirname(target), { recursive: true });
    if (typeof value === "string") await writeFile(target, value);
    else if ("symlink" in value && typeof value.symlink === "string") await symlink(value.symlink, target);
    else if ("dir" in value && value.dir === true) await mkdir(target, { recursive: true });
    else await writeFile(target, JSON.stringify(value));
  }
}

async function withBase(run: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), "aiden-app-detect-"));
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/** Detection rooted at `base/rel`, never reading `base` or above. */
function detect(base: string, rel = "ws"): Promise<WebAppDetection> {
  return detectWebApp(path.join(base, rel), { stopAt: base, homeDir: base });
}

function app(detection: WebAppDetection, root: string): DetectedApp {
  const found = detection.apps.find((candidate) => candidate.root === root);
  assert.ok(found, `no app at ${root}; found ${detection.apps.map((candidate) => candidate.root).join(", ")}`);
  return found;
}

const viteReact = (name = "web") => ({
  name,
  dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
  devDependencies: { vite: "^6.0.0" },
  scripts: { dev: "vite", build: "vite build" },
});

// ---- basic shapes ----

test("a single Vite React app at the root is the one web app and counts as installed", async () => {
  await withBase(async (base) => {
    await writeTree(base, { "ws/package.json": viteReact(), "ws/package-lock.json": "{}", "ws/node_modules": { dir: true } });
    const detection = await detect(base);
    assert.deepEqual(detection, {
      apps: [
        {
          root: ".",
          name: "web",
          kind: "web",
          reason: "ok",
          framework: "vite",
          script: "dev",
          scripts: ["dev", "build"],
          usesReact: true,
          packageManager: { name: "npm", source: "lockfile", lockfile: "package-lock.json", lockfileLevelsUp: 0 },
          installRoot: ".",
          installed: true,
        },
      ],
      truncated: false,
    });
    assert.deepEqual(designTarget(detection), { kind: "single", app: detection.apps[0] });
  });
});

test("the design-live-app fixture shape counts as installed through a symlinked node_modules", async () => {
  await withBase(async (base) => {
    await writeTree(base, { "shared/node_modules/vite/package.json": { name: "vite" }, "ws/package.json": viteReact() });
    await symlink(path.join(base, "shared/node_modules"), path.join(base, "ws/node_modules"));
    const web = app(await detect(base), ".");
    assert.equal(web.kind, "web");
    assert.deepEqual(web.packageManager, { name: "npm", source: "none", lockfileLevelsUp: 0 });
    assert.equal(web.installed, true);
  });
});

test("a dangling node_modules symlink is not installed and does not throw", async () => {
  await withBase(async (base) => {
    await writeTree(base, { "ws/package.json": viteReact(), "ws/node_modules": { symlink: path.join(base, "gone") } });
    assert.equal(app(await detect(base), ".").installed, false);
  });
});

test("an Electron app shaped like Aiden is react-nonweb, and packages without React are none", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "ws/package.json": {
        name: "aiden-agent",
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies: { electron: "43.0.0", vite: "^6.0.0" },
        scripts: { dev: "vite" },
      },
      "ws/packages/cli/package.json": { name: "cli", dependencies: { yaml: "2.9.0" } },
    });
    const detection = await detect(base);
    assert.equal(app(detection, ".").kind, "react-nonweb");
    assert.equal(app(detection, ".").desktopShell, "electron");
    assert.equal(app(detection, "packages/cli").kind, "none");
    assert.deepEqual(designTarget(detection), { kind: "react-nonweb", apps: [app(detection, ".")] });
  });
});

test("a folder with no package.json anywhere gives no apps and target none", async () => {
  await withBase(async (base) => {
    await writeTree(base, { "ws/README.md": "hi", "ws/apps/notes/README.md": "hi" });
    const detection = await detect(base);
    assert.deepEqual(detection, { apps: [], truncated: false });
    assert.deepEqual(designTarget(detection), { kind: "none", apps: [] });
  });
});

test("a missing root folder gives no apps instead of throwing", async () => {
  await withBase(async (base) => {
    assert.deepEqual(await detect(base, "missing"), { apps: [], truncated: false });
  });
});

// ---- workspaces and install roots ----

test("a pnpm monorepo lists apps/web, apps/docs and packages/ui, with the root's manager and install root", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "ws/package.json": { name: "mono", private: true },
      "ws/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
      "ws/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "ws/node_modules/.modules.yaml": "",
      "ws/apps/web/package.json": { name: "web", dependencies: { next: "15.0.0", react: "^19.0.0" }, scripts: { dev: "next dev" } },
      "ws/apps/docs/package.json": { name: "docs", dependencies: { astro: "^5.0.0" }, scripts: { dev: "astro dev" } },
      "ws/packages/ui/package.json": { name: "ui", peerDependencies: { react: "^19.0.0" }, devDependencies: { react: "^19.0.0" } },
    });
    const detection = await detect(base);
    assert.deepEqual(detection.apps.map((candidate) => candidate.root), [".", "apps/docs", "apps/web", "packages/ui"]);
    for (const candidate of detection.apps) {
      assert.equal(candidate.installRoot, ".", candidate.root);
      assert.equal(candidate.packageManager.name, "pnpm", candidate.root);
      assert.equal(candidate.installed, true, candidate.root);
    }
    assert.equal(app(detection, "apps/web").framework, "next");
    assert.equal(app(detection, "apps/docs").framework, "astro");
    assert.equal(app(detection, "packages/ui").kind, "react-nonweb");
    assert.deepEqual(designTarget(detection), { kind: "choose", apps: [app(detection, "apps/docs"), app(detection, "apps/web")] });
  });
});

test("npm workspaces hoist: a member without node_modules is installed when the root has it", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "ws/package.json": { name: "mono", private: true, workspaces: ["apps/*"] },
      "ws/package-lock.json": "{}",
      "ws/node_modules": { dir: true },
      "ws/apps/web/package.json": viteReact(),
    });
    const web = app(await detect(base), "apps/web");
    assert.equal(web.installRoot, ".");
    assert.equal(web.installed, true);
    assert.equal(web.packageManager.lockfile, "package-lock.json");
  });
});

test("an excluded workspace pattern drops that folder", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "ws/package.json": { name: "mono", private: true, workspaces: ["packages/*", "!packages/legacy"] },
      "ws/packages/site/package.json": viteReact("site"),
      "ws/packages/legacy/package.json": viteReact("legacy"),
    });
    assert.deepEqual((await detect(base)).apps.map((candidate) => candidate.root), [".", "packages/site"]);
  });
});

test("a turbo monorepo root is workspace-runner and its apps are found", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "ws/package.json": { name: "mono", private: true, workspaces: ["apps/*"], devDependencies: { turbo: "^2.0.0" }, scripts: { dev: "turbo dev" } },
      "ws/turbo.json": {},
      "ws/apps/web/package.json": viteReact(),
    });
    const detection = await detect(base);
    assert.equal(app(detection, ".").reason, "workspace-runner");
    assert.equal(app(detection, "apps/web").kind, "web");
    assert.equal(designTarget(detection).kind, "single");
  });
});

test("an Nx integrated repo with no member package.json gives one workspace-runner root and target none", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "ws/package.json": { name: "nx-repo", dependencies: { react: "^19.0.0" }, devDependencies: { nx: "^20.0.0", vite: "^6.0.0" }, scripts: {} },
      "ws/nx.json": {},
      "ws/apps/web/project.json": {},
    });
    const detection = await detect(base);
    assert.deepEqual(detection.apps.map((candidate) => [candidate.root, candidate.kind, candidate.reason]), [[".", "none", "workspace-runner"]]);
    assert.deepEqual(designTarget(detection), { kind: "none", apps: detection.apps });
  });
});

test("a standalone frontend folder with its own lockfile is its own install root", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "ws/pyproject.toml": "[project]\n",
      "ws/frontend/package.json": viteReact("frontend"),
      "ws/frontend/yarn.lock": "# yarn lockfile v1\n",
    });
    const detection = await detect(base);
    assert.equal(detection.apps.length, 1);
    const frontend = app(detection, "frontend");
    assert.equal(frontend.installRoot, "frontend");
    assert.deepEqual(frontend.packageManager, { name: "yarn", source: "lockfile", lockfile: "yarn.lock", lockfileLevelsUp: 0, yarn: "classic" });
  });
});

// ---- lockfiles and conflicts ----

test("conflicting lockfiles leave the app web with no manager", async () => {
  await withBase(async (base) => {
    await writeTree(base, { "ws/package.json": viteReact(), "ws/package-lock.json": "{}", "ws/yarn.lock": "" });
    const detection = await detect(base);
    const web = app(detection, ".");
    assert.equal(web.kind, "web");
    assert.equal(web.packageManager.name, null);
    assert.deepEqual(web.packageManager.conflict, ["npm", "yarn"]);
    assert.equal(designTarget(detection).kind, "single");
  });
});

test("a conflict is settled by the one manager that installed node_modules", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "ws/package.json": viteReact(),
      "ws/package-lock.json": "{}",
      "ws/yarn.lock": "",
      "ws/node_modules/.package-lock.json": "{}",
    });
    const { packageManager } = app(await detect(base), ".");
    assert.equal(packageManager.name, "npm");
    assert.equal(packageManager.source, "installed");
    assert.deepEqual(packageManager.conflict, ["npm", "yarn"]);
  });
});

test("a yarn.lock without the v1 header is berry", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "ws/package.json": viteReact(),
      "ws/yarn.lock": `# This file is generated by running "yarn install" inside your project.\n\n__metadata:\n  version: 8\n${"x".repeat(2048)}`,
    });
    assert.equal(app(await detect(base), ".").packageManager.yarn, "berry");
  });
});

test("a Yarn PnP install counts as installed", async () => {
  await withBase(async (base) => {
    await writeTree(base, { "ws/package.json": viteReact(), "ws/.yarnrc.yml": "", "ws/yarn.lock": "", "ws/.pnp.cjs": "" });
    const web = app(await detect(base), ".");
    assert.equal(web.packageManager.yarn, "berry");
    assert.equal(web.installed, true);
  });
});

// ---- the enclosing walk ----

test("a workspace opened inside a pnpm monorepo takes the enclosing lockfile", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "repo/pnpm-lock.yaml": "",
      "repo/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "repo/.git": { dir: true },
      "repo/apps/web/package.json": viteReact(),
    });
    const web = app(await detect(base, "repo/apps/web"), ".");
    assert.deepEqual(web.packageManager, { name: "pnpm", source: "enclosing", lockfile: "pnpm-lock.yaml", lockfileLevelsUp: 2 });
    assert.equal(web.installRoot, ".");
    assert.equal(web.installed, false);
  });
});

test("an enclosing pnpm-workspace.yaml alone means pnpm", async () => {
  await withBase(async (base) => {
    await writeTree(base, { "repo/pnpm-workspace.yaml": "packages: ['apps/*']\n", "repo/apps/web/package.json": viteReact() });
    const { packageManager } = app(await detect(base, "repo/apps/web"), ".");
    assert.deepEqual(packageManager, { name: "pnpm", source: "enclosing", lockfileLevelsUp: 2 });
  });
});

test("a symlinked node_modules at the enclosing root counts as installed", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "store/node_modules": { dir: true },
      "repo/package.json": { name: "mono", private: true, workspaces: ["apps/*"] },
      "repo/package-lock.json": "{}",
      "repo/apps/web/package.json": viteReact(),
    });
    await symlink(path.join(base, "store/node_modules"), path.join(base, "repo/node_modules"));
    const web = app(await detect(base, "repo/apps/web"), ".");
    assert.equal(web.packageManager.source, "enclosing");
    assert.equal(web.installed, true);
  });
});

test("the walk stops at a .git folder and never reads above it", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "outer/pnpm-lock.yaml": "",
      "outer/pnpm-workspace.yaml": "packages:\n  - 'repo/apps/*'\n",
      "outer/repo/.git": { dir: true },
      "outer/repo/apps/web/package.json": viteReact(),
    });
    assert.deepEqual(app(await detect(base, "outer/repo/apps/web"), ".").packageManager, { name: "npm", source: "none", lockfileLevelsUp: 0 });
  });
});

test("the walk never runs when the workspace root holds .git", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "outer/package.json": { name: "mono", private: true, workspaces: ["ws"] },
      "outer/package-lock.json": "{}",
      "outer/ws/.git": "gitdir: elsewhere\n",
      "outer/ws/package.json": viteReact(),
    });
    assert.deepEqual(app(await detect(base, "outer/ws"), ".").packageManager, { name: "npm", source: "none", lockfileLevelsUp: 0 });
  });
});

test("the walk never reads stopAt or home, compared after realpath", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "real/package.json": { name: "mono", private: true, workspaces: ["ws"] },
      "real/package-lock.json": "{}",
      "real/ws/package.json": viteReact(),
    });
    await symlink(path.join(base, "real"), path.join(base, "alias"));
    const root = path.join(base, "real/ws");
    const none = { name: "npm", source: "none", lockfileLevelsUp: 0 };
    const viaStopAt = await detectWebApp(root, { stopAt: path.join(base, "alias"), homeDir: base });
    assert.deepEqual(app(viaStopAt, ".").packageManager, none);
    const viaHome = await detectWebApp(root, { stopAt: base, homeDir: path.join(base, "alias") });
    assert.deepEqual(app(viaHome, ".").packageManager, none);
    // Without those limits the same lockfile is found, so the limits are what stops it.
    const open = await detectWebApp(root, { stopAt: base, homeDir: base });
    assert.equal(app(open, ".").packageManager.source, "enclosing");
  });
});

test("an enclosing lockfile counts only when the workspace is one of that repo's members", async () => {
  await withBase(async (base) => {
    const nextApp = { name: "next-app", dependencies: { next: "15.0.0", react: "^19.0.0" }, scripts: { dev: "next dev" } };
    await writeTree(base, {
      // A library with an example app it doesn't list as a workspace.
      "lib/.git": { dir: true },
      "lib/package.json": { name: "lib" },
      "lib/package-lock.json": "{}",
      "lib/examples/next-app/package.json": nextApp,
      // A pnpm repo whose workspace file lists other folders.
      "mono/.git": { dir: true },
      "mono/package.json": { name: "mono", private: true },
      "mono/pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "mono/pnpm-lock.yaml": "",
      "mono/examples/next-app/package.json": nextApp,
      // A stray lockfile in a parent folder.
      "stray/package-lock.json": "{}",
      "stray/proj/package.json": viteReact(),
      // An npm repo that does list the folder.
      "npm-mono/package.json": { name: "npm-mono", private: true, workspaces: ["examples/*"] },
      "npm-mono/package-lock.json": "{}",
      "npm-mono/examples/next-app/package.json": nextApp,
    });
    for (const rel of ["lib/examples/next-app", "mono/examples/next-app", "stray/proj"]) {
      const { packageManager } = app(await detect(base, rel), ".");
      assert.deepEqual(packageManager, { name: "npm", source: "none", lockfileLevelsUp: 0 }, rel);
      assert.deepEqual(installCommand(packageManager), { command: "npm", args: ["install"] }, rel);
    }
    const member = app(await detect(base, "npm-mono/examples/next-app"), ".").packageManager;
    assert.deepEqual(member, { name: "npm", source: "enclosing", lockfile: "package-lock.json", lockfileLevelsUp: 2 });
    assert.deepEqual(installCommand(member), { command: "npm", args: ["ci"] });
  });
});

test("a workspace root whose script hands off to a member leaves that member the one web app", async () => {
  await withBase(async (base) => {
    const member = (name: string) => ({ name, dependencies: { react: "^19.0.0" }, devDependencies: { vite: "^6.0.0" }, scripts: { dev: "vite" } });
    const roots: Record<string, Record<string, string>> = {
      npm: { dev: "npm run dev -w apps/web" },
      yarn: { dev: "yarn workspace web dev" },
      concurrently: { dev: 'concurrently "npm:dev:*"', "dev:web": "npm --prefix apps/web run dev" },
      // A root script that isn't the framework's own dev command hands off too.
      script: { dev: "node scripts/dev.js" },
    };
    for (const [name, scripts] of Object.entries(roots)) {
      await writeTree(base, {
        [`${name}/package.json`]: { name, private: true, workspaces: ["apps/*"], devDependencies: { vite: "^6.0.0" }, scripts },
        [`${name}/package-lock.json`]: "{}",
        [`${name}/apps/web/package.json`]: member("web"),
      });
      const detection = await detect(base, name);
      assert.equal(app(detection, ".").reason, "workspace-runner", name);
      assert.deepEqual(designTarget(detection), { kind: "single", app: app(detection, "apps/web") }, name);
    }
  });
});

// ---- bounded and hostile reads ----

test("a broken package.json is reported, not thrown", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "ws/package.json": { name: "mono", private: true },
      "ws/apps/broken/package.json": "{ not json",
      "ws/apps/huge/package.json": JSON.stringify({ name: "huge", description: "x".repeat(600 * 1024) }),
    });
    const detection = await detect(base);
    assert.equal(app(detection, "apps/broken").reason, "invalid-package-json");
    assert.equal(app(detection, "apps/huge").reason, "invalid-package-json");
  });
});

test("a FIFO named package.json is unreadable and the read returns at once", { timeout: 2_000 }, async () => {
  await withBase(async (base) => {
    await mkdir(path.join(base, "ws"), { recursive: true });
    execFileSync("mkfifo", [path.join(base, "ws/package.json")]);
    assert.equal(await readBounded(path.join(base, "ws/package.json"), 1024), null);
    assert.equal(app(await detect(base), ".").reason, "invalid-package-json");
  });
});

test("a symlinked package.json is unreadable, not followed", async () => {
  await withBase(async (base) => {
    await writeTree(base, { "elsewhere/package.json": viteReact(), "ws/package.json": { symlink: path.join(base, "elsewhere/package.json") } });
    assert.equal(app(await detect(base), ".").reason, "invalid-package-json");
  });
});

test("readBounded reads a file up to its cap and refuses anything longer", async () => {
  await withBase(async (base) => {
    await writeTree(base, { "a.txt": "12345" });
    assert.equal(await readBounded(path.join(base, "a.txt"), 5), "12345");
    assert.equal(await readBounded(path.join(base, "a.txt"), 4), null);
    assert.equal(await readBounded(path.join(base, "missing.txt"), 4), null);
    assert.equal(await readBounded(base, 4), null);
  });
});

test("symlinked candidate folders, node_modules and dot folders are never scanned", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "other/package.json": { name: "linked", dependencies: { next: "15.0.0" }, scripts: { dev: "next dev" } },
      "ws/package.json": { name: "mono", private: true, workspaces: ["apps/*", "packages/*", "packages/node_modules/*"] },
      "ws/apps/.cache/package.json": viteReact("cache"),
      "ws/packages/node_modules/x/package.json": viteReact("x"),
      "ws/web": { symlink: path.join(base, "other") },
    });
    await symlink(path.join(base, "other"), path.join(base, "ws/apps/linked"));
    assert.deepEqual((await detect(base)).apps.map((candidate) => candidate.root), ["."]);
  });
});

test("a packages folder that is a symlink to / is never listed", async () => {
  await withBase(async (base) => {
    await writeTree(base, { "ws/package.json": { name: "mono", private: true, workspaces: ["packages/*", "apps/*"] }, "ws/apps": { symlink: "/" } });
    await symlink("/", path.join(base, "ws/packages"));
    assert.deepEqual((await detect(base)).apps.map((candidate) => candidate.root), ["."]);
  });
});

test("the scan stops at 100 candidates and says so", async () => {
  await withBase(async (base) => {
    const tree: Record<string, TreeValue> = { "ws/package.json": { name: "mono", private: true } };
    for (let i = 0; i < 120; i++) tree[`ws/packages/p${String(i).padStart(3, "0")}/package.json`] = { name: `p${i}` };
    await writeTree(base, tree);
    const detection = await detect(base);
    assert.equal(detection.truncated, true);
    assert.equal(detection.apps.length, 100);
    assert.equal(detection.apps[0].root, ".");
    assert.equal(detection.apps[1].root, "packages/p000");
  });
});

test("results hold only relative paths", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "repo/pnpm-lock.yaml": "",
      "repo/apps/ws/package.json": { name: "mono", private: true, workspaces: ["apps/*"] },
      "repo/apps/ws/apps/web/package.json": viteReact(),
      "repo/apps/ws/frontend/package.json": viteReact("frontend"),
      "repo/apps/ws/frontend/package-lock.json": "{}",
    });
    const detection = await detect(base, "repo/apps/ws");
    assert.ok(detection.apps.length >= 3);
    for (const candidate of detection.apps) {
      for (const value of [candidate.root, candidate.installRoot, candidate.packageManager.lockfile ?? "x"]) {
        assert.ok(!path.isAbsolute(value) && !value.split("/").includes(".."), value);
      }
    }
    assert.equal(JSON.stringify(detection).includes(base), false);
  });
});

// ---- edge shapes ----

test("a Storybook-only repo, scripts as an array and a null dev script never give no-dev-script", async () => {
  await withBase(async (base) => {
    await writeTree(base, {
      "ws/package.json": { name: "mono", private: true },
      "ws/packages/stories/package.json": {
        dependencies: { react: "^19.0.0" },
        devDependencies: { vite: "^6.0.0", "@storybook/react-vite": "^8.0.0" },
        scripts: { storybook: "storybook dev -p 6006", "build-storybook": "storybook build" },
      },
      "ws/packages/array/package.json": { dependencies: { react: "^19.0.0" }, scripts: ["dev", "vite"] },
      "ws/packages/nulldev/package.json": { devDependencies: { vite: "^6.0.0" }, scripts: { dev: null, start: "vite" } },
    });
    const detection = await detect(base);
    assert.deepEqual(
      ["packages/stories", "packages/array", "packages/nulldev"].map((root) => [root, app(detection, root).kind, app(detection, root).reason]),
      [
        ["packages/stories", "react-nonweb", "no-web-framework"],
        ["packages/array", "react-nonweb", "no-web-framework"],
        ["packages/nulldev", "web", "ok"],
      ],
    );
  });
});
