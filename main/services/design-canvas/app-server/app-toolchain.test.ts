import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createExecutableCache, resolveExecutable, type ExecutableResolutionDeps } from "../../node-toolchain.js";
import { clearAppToolchainCache, defaultAppToolchainDeps, resolveAppToolchain, toolchainProblemMessage } from "./app-toolchain.js";
import type { PackageManagerInfo } from "./app-server-core.js";

function fakeDeps(executables: string[], options: { PATH?: string; shellAnswer?: () => string | null } = {}): ExecutableResolutionDeps & { calls: number } {
  const deps = {
    calls: 0,
    env: { PATH: options.PATH ?? "/usr/bin", SHELL: "/bin/zsh" },
    isExecutable: async (filePath: string) => {
      deps.calls += 1;
      return executables.includes(filePath);
    },
    loginShellLookup: async () => {
      deps.calls += 1;
      return options.shellAnswer?.() ?? null;
    },
  };
  return deps;
}

const manager = (name: PackageManagerInfo["name"], extra: Partial<PackageManagerInfo> = {}) => ({
  packageManager: { name, source: "lockfile", lockfileLevelsUp: 0, ...extra } as PackageManagerInfo,
});

test("with Node and pnpm found, the toolchain gives both paths", async () => {
  const result = await resolveAppToolchain(manager("pnpm"), {
    node: fakeDeps(["/opt/node/bin/node"], { PATH: "/usr/bin:/opt/node/bin" }),
    manager: fakeDeps(["/Users/me/Library/pnpm/pnpm"], { shellAnswer: () => "/Users/me/Library/pnpm/pnpm\n" }),
  });
  assert.deepEqual(result, { ok: true, node: "/opt/node/bin/node", manager: { name: "pnpm", path: "/Users/me/Library/pnpm/pnpm" } });
});

test("npm next to the resolved Node wins over another npm on PATH", async () => {
  const result = await resolveAppToolchain(manager("npm"), {
    node: fakeDeps(["/a/bin/node"], { shellAnswer: () => "/a/bin/node\n" }),
    manager: fakeDeps(["/usr/bin/npm", "/a/bin/npm"]),
  });
  assert.deepEqual(result, { ok: true, node: "/a/bin/node", manager: { name: "npm", path: "/a/bin/npm" } });
  // Without an npm beside Node, the usual lookup finds one.
  const fallback = await resolveAppToolchain(manager("npm"), {
    node: fakeDeps(["/a/bin/node"], { shellAnswer: () => "/a/bin/node\n" }),
    manager: fakeDeps(["/usr/bin/npm"]),
  });
  assert.deepEqual(fallback, { ok: true, node: "/a/bin/node", manager: { name: "npm", path: "/usr/bin/npm" } });
});

test("without a usable Node the problem is node-missing, even when the manager exists", async () => {
  const managerDeps = fakeDeps(["/usr/bin/pnpm"]);
  assert.deepEqual(await resolveAppToolchain(manager("pnpm"), { node: fakeDeps([]), manager: managerDeps }), {
    ok: false,
    problem: "node-missing",
  });
});

test("Node older than 22 is not usable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiden-app-toolchain-"));
  try {
    const node = path.join(dir, "node");
    await writeFile(node, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ node: "20.19.0", electron: false })}'\n`);
    await chmod(node, 0o755);
    const npm = path.join(dir, "npm");
    await writeFile(npm, "#!/bin/sh\n");
    await chmod(npm, 0o755);
    const defaults = defaultAppToolchainDeps({ PATH: dir });
    // The real checks, kept to the temp folder so a Node installed on this machine can't answer.
    const inDir = (deps: ExecutableResolutionDeps): ExecutableResolutionDeps => ({
      ...deps,
      isExecutable: async (filePath) => path.dirname(filePath) === dir && (await deps.isExecutable(filePath)),
    });
    assert.deepEqual(await resolveAppToolchain(manager("npm"), { node: inDir(defaults.node), manager: inDir(defaults.manager) }), {
      ok: false,
      problem: "node-missing",
    });
    // The same folder with a current Node passes, so the version is what failed.
    await writeFile(node, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ node: "22.12.0", electron: false })}'\n`);
    assert.deepEqual(await resolveAppToolchain(manager("npm"), { node: inDir(defaults.node), manager: inDir(defaults.manager) }), {
      ok: true,
      node,
      manager: { name: "npm", path: npm },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a project whose manager isn't installed gets manager-missing with that manager, and never falls back to npm", async () => {
  const result = await resolveAppToolchain(manager("pnpm"), {
    node: fakeDeps(["/opt/node/bin/node"], { PATH: "/opt/node/bin" }),
    manager: fakeDeps(["/opt/node/bin/npm", "/usr/bin/npm"], { PATH: "/usr/bin:/opt/node/bin" }),
  });
  assert.deepEqual(result, { ok: false, problem: "manager-missing", manager: "pnpm" });
});

test("a conflict gives manager-conflict and a Deno project gives unsupported-manager, without looking a manager up", async () => {
  const node = () => fakeDeps(["/opt/node/bin/node"], { PATH: "/opt/node/bin" });
  const conflictDeps = fakeDeps(["/usr/bin/npm", "/usr/bin/yarn"]);
  assert.deepEqual(await resolveAppToolchain(manager(null, { conflict: ["npm", "yarn"] }), { node: node(), manager: conflictDeps }), {
    ok: false,
    problem: "manager-conflict",
    conflict: ["npm", "yarn"],
  });
  assert.deepEqual(
    await resolveAppToolchain(manager(null, { source: "packageManager", conflict: ["npm", "pnpm"], field: "pnpm" }), { node: node(), manager: conflictDeps }),
    { ok: false, problem: "manager-conflict", conflict: ["npm", "pnpm"], field: "pnpm" },
  );
  const denoDeps = fakeDeps(["/usr/bin/npm"]);
  assert.deepEqual(await resolveAppToolchain(manager(null, { source: "none", unsupported: "deno" }), { node: node(), manager: denoDeps }), {
    ok: false,
    problem: "unsupported-manager",
    manager: "deno",
  });
  assert.equal(conflictDeps.calls, 0);
  assert.equal(denoDeps.calls, 0);
});

test("after Node is installed, the next resolve finds it without a restart", async () => {
  const cache = createExecutableCache();
  let installed = false;
  const nodeDeps = { ...fakeDeps(["/Users/me/.nvm/versions/node/v22.12.0/bin/node"], { shellAnswer: () => (installed ? "/Users/me/.nvm/versions/node/v22.12.0/bin/node\n" : null) }), cache };
  const managerDeps = { ...fakeDeps(["/Users/me/.nvm/versions/node/v22.12.0/bin/npm"]), cache };
  assert.deepEqual(await resolveAppToolchain(manager("npm"), { node: nodeDeps, manager: managerDeps }), { ok: false, problem: "node-missing" });
  installed = true;
  assert.deepEqual(await resolveAppToolchain(manager("npm"), { node: nodeDeps, manager: managerDeps }), {
    ok: true,
    node: "/Users/me/.nvm/versions/node/v22.12.0/bin/node",
    manager: { name: "npm", path: "/Users/me/.nvm/versions/node/v22.12.0/bin/npm" },
  });
});

test("each problem has a message that names what to install or fix", () => {
  assert.match(toolchainProblemMessage({ problem: "node-missing" }), /Node\.js 22 or newer/u);
  const missing = toolchainProblemMessage({ problem: "manager-missing", manager: "pnpm" });
  assert.match(missing, /uses pnpm/u);
  assert.match(missing, /Install pnpm/u);
  const conflict = toolchainProblemMessage({ problem: "manager-conflict", conflict: ["npm", "yarn"] });
  assert.match(conflict, /npm and yarn/u);
  assert.match(conflict, /packageManager/u);
  assert.match(conflict, /Delete the one you don't use/u);
  assert.equal(
    toolchainProblemMessage({ problem: "manager-conflict", conflict: ["bun", "npm", "yarn"] }),
    "This app has lockfiles for bun, npm and yarn. Delete the ones you don't use, or set packageManager in package.json.",
  );
  assert.equal(
    toolchainProblemMessage({ problem: "manager-conflict", conflict: ["npm", "pnpm"], field: "pnpm" }),
    "packageManager says pnpm, but the lockfile is npm's. Delete the other lockfile or change packageManager.",
  );
  assert.equal(
    toolchainProblemMessage({ problem: "manager-conflict", conflict: ["npm", "pnpm", "yarn"], field: "pnpm" }),
    "packageManager says pnpm, but the lockfiles are npm's and yarn's. Delete the other lockfiles or change packageManager.",
  );
  assert.match(toolchainProblemMessage({ problem: "unsupported-manager", manager: "deno" }), /Deno/u);
});

test("the design resolvers keep a login-shell answer until clearAppToolchainCache", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiden-app-toolchain-cache-"));
  try {
    const pnpm = path.join(dir, "pnpm");
    await writeFile(pnpm, "#!/bin/sh\n");
    await chmod(pnpm, 0o755);
    const calls = path.join(dir, "calls");
    const shell = path.join(dir, "shell");
    await writeFile(shell, `#!/bin/sh\nprintf 'x' >> '${calls}'\nprintf '%s\\n' '${pnpm}'\n`);
    await chmod(shell, 0o755);
    const { manager } = defaultAppToolchainDeps({ PATH: path.join(dir, "empty"), SHELL: shell });
    const shellRuns = async () => (await readFile(calls, "utf8").catch(() => "")).length;

    assert.equal(await resolveExecutable("pnpm", manager), pnpm);
    assert.equal(await resolveExecutable("pnpm", manager), pnpm);
    assert.equal(await shellRuns(), 1);
    clearAppToolchainCache();
    assert.equal(await resolveExecutable("pnpm", manager), pnpm);
    assert.equal(await shellRuns(), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
