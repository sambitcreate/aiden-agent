import assert from "node:assert/strict";
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createExecutableCache,
  isStandaloneNodeExecutable,
  loginShellCommandLookup,
  nodeCommandEnvironment,
  resolveExecutable,
  type ExecutableResolutionDeps,
  type LoginShellExecFile,
  type ToolCommand,
} from "./node-toolchain.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "aiden-node-toolchain-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A shell script that records its argv, one argument per line, then runs `body`. */
async function recordingShell(dir: string, body: string, name = "shell"): Promise<{ shell: string; argv: () => Promise<string[]> }> {
  const shell = path.join(dir, name);
  const out = path.join(dir, `${name}.argv`);
  await writeFile(shell, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\n${body}\n`);
  await chmod(shell, 0o755);
  return { shell, argv: async () => (await readFile(out, "utf8")).split("\n").filter(Boolean) };
}

const executable = (paths: string[]) => async (filePath: string) => paths.includes(filePath);

test("resolveExecutable finds pnpm on PATH, then through the login shell, then in Homebrew, and passes the command to the lookup", async () => {
  const lookups: Array<[string, ToolCommand]> = [];
  const loginShellLookup = async (shell: string, command: ToolCommand) => {
    lookups.push([shell, command]);
    return "Welcome back!\n/Users/me/Library/pnpm/pnpm\n";
  };
  const env = { PATH: "relative:/usr/bin:/opt/tools/bin", SHELL: "/bin/zsh" };

  // A relative entry never counts, even when a file there would pass the check.
  assert.equal(
    await resolveExecutable("pnpm", { env, isExecutable: executable(["relative/pnpm", "/opt/tools/bin/pnpm"]), loginShellLookup }),
    "/opt/tools/bin/pnpm",
  );
  assert.deepEqual(lookups, []);

  assert.equal(
    await resolveExecutable("pnpm", {
      env,
      isExecutable: executable(["/Users/me/Library/pnpm/pnpm", "/opt/homebrew/bin/pnpm"]),
      loginShellLookup,
    }),
    "/Users/me/Library/pnpm/pnpm",
  );
  assert.deepEqual(lookups, [["/bin/zsh", "pnpm"]]);

  assert.equal(
    await resolveExecutable("pnpm", { env, isExecutable: executable(["/opt/homebrew/bin/pnpm"]), loginShellLookup }),
    "/opt/homebrew/bin/pnpm",
  );
  assert.equal(
    await resolveExecutable("pnpm", { env, isExecutable: executable(["/usr/local/bin/pnpm"]), loginShellLookup }),
    "/usr/local/bin/pnpm",
  );
  assert.equal(await resolveExecutable("pnpm", { env, isExecutable: executable([]), loginShellLookup }), null);
});

test("the login-shell lookup runs the shell with -ilc and command -v for the asked command", async () => {
  await withTempDir(async (dir) => {
    const { shell, argv } = await recordingShell(dir, "printf '/x/bun\\n'");
    const lookup = loginShellCommandLookup({ env: { PATH: "/usr/bin:/bin" } });
    assert.equal(await lookup(shell, "bun"), "/x/bun\n");
    assert.deepEqual(await argv(), ["-ilc", "command -v bun"]);
  });
});

test("the login-shell lookup refuses a command outside the fixed set without starting the shell", async () => {
  await withTempDir(async (dir) => {
    const marker = path.join(dir, "started");
    const { shell } = await recordingShell(dir, `touch '${marker}'\nprintf '/x/npm\\n'`);
    const lookup = loginShellCommandLookup({ env: { PATH: "/usr/bin:/bin" } });
    assert.equal(await lookup(shell, "npm; touch x" as ToolCommand), null);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  });
});

test("the login-shell lookup gives null when the shell fails, times out, or prints more than 1 MiB with no maxBuffer", async () => {
  await withTempDir(async (dir) => {
    const env = { PATH: "/usr/bin:/bin" };
    const failing = await recordingShell(dir, "printf '/x/node\\n'\nexit 1", "failing");
    assert.equal(await loginShellCommandLookup({ env })(failing.shell, "node"), null);

    const slow = await recordingShell(dir, "sleep 2\nprintf '/x/node\\n'", "slow");
    const started = Date.now();
    assert.equal(await loginShellCommandLookup({ env, timeoutMs: 200 })(slow.shell, "node"), null);
    assert.ok(Date.now() - started < 1_500, "the timeout ends the lookup early");

    const loud = await recordingShell(dir, `head -c ${1536 * 1024} /dev/zero | tr '\\0' 'a'`, "loud");
    assert.equal(await loginShellCommandLookup({ env })(loud.shell, "node"), null);
  });
});

test("the lookup's timeout defaults to five seconds, and maxBuffer reaches execFile only when given", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const execFile: LoginShellExecFile = (_file, _args, options, callback) => {
    seen.push({ ...options });
    callback(null, "/x/yarn\n");
  };
  const env = { PATH: "/usr/bin:/bin" };
  assert.equal(await loginShellCommandLookup({ env, execFile })("/bin/zsh", "yarn"), "/x/yarn\n");
  await loginShellCommandLookup({ env, execFile, timeoutMs: 200, maxBuffer: 16_384 })("/bin/zsh", "yarn");
  assert.equal(seen[0].timeout, 5_000);
  assert.equal("maxBuffer" in seen[0], false);
  assert.equal(seen[0].env, env);
  assert.equal(seen[1].timeout, 200);
  assert.equal(seen[1].maxBuffer, 16_384);
});

function countingDeps(answer: () => string | null, valid: () => string[]): ExecutableResolutionDeps & { calls: ToolCommand[] } {
  const calls: ToolCommand[] = [];
  return {
    calls,
    env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
    isExecutable: async (filePath) => valid().includes(filePath),
    loginShellLookup: async (_shell, command) => {
      calls.push(command);
      return answer();
    },
  };
}

test("with a cache, a validated login-shell path is kept and the shell isn't asked again", async () => {
  const cache = createExecutableCache();
  const deps = countingDeps(() => "/Users/me/.bun/bin/tool\n", () => ["/Users/me/.bun/bin/tool"]);
  assert.equal(await resolveExecutable("pnpm", { ...deps, cache }), "/Users/me/.bun/bin/tool");
  assert.equal(await resolveExecutable("pnpm", { ...deps, cache }), "/Users/me/.bun/bin/tool");
  assert.deepEqual(deps.calls, ["pnpm"]);
  // Another command has its own entry.
  await resolveExecutable("bun", { ...deps, cache });
  assert.deepEqual(deps.calls, ["pnpm", "bun"]);
  // Clearing forgets everything, which 2c's Retry relies on.
  cache.clear();
  await resolveExecutable("pnpm", { ...deps, cache });
  assert.deepEqual(deps.calls, ["pnpm", "bun", "pnpm"]);
});

test("junk login-shell output is never cached", async () => {
  const cache = createExecutableCache();
  const deps = countingDeps(() => "pnpm: aliased to pnpx\n/broken/pnpm\n", () => []);
  assert.equal(await resolveExecutable("pnpm", { ...deps, cache }), null);
  assert.equal(await resolveExecutable("pnpm", { ...deps, cache }), null);
  assert.deepEqual(deps.calls, ["pnpm", "pnpm"]);
});

test("a cached path that stops passing the check is dropped and looked up again", async () => {
  const cache = createExecutableCache();
  let answer = "/old/pnpm";
  let valid = ["/old/pnpm"];
  const deps = countingDeps(() => `${answer}\n`, () => valid);
  assert.equal(await resolveExecutable("pnpm", { ...deps, cache }), "/old/pnpm");
  answer = "/new/pnpm";
  valid = ["/new/pnpm"];
  assert.equal(await resolveExecutable("pnpm", { ...deps, cache }), "/new/pnpm");
  assert.equal(await resolveExecutable("pnpm", { ...deps, cache }), "/new/pnpm");
  assert.deepEqual(deps.calls, ["pnpm", "pnpm"]);
});

test("without a cache, resolveExecutable asks the login shell every time", async () => {
  const deps = countingDeps(() => "/Users/me/.nvm/bin/node\n", () => ["/Users/me/.nvm/bin/node"]);
  await resolveExecutable("node", deps);
  await resolveExecutable("node", deps);
  assert.deepEqual(deps.calls, ["node", "node"]);
});

test("isStandaloneNodeExecutable takes the minimum major version", async () => {
  await withTempDir(async (dir) => {
    const candidate = path.join(dir, "node");
    // The probe must run with Electron's Node mode cleared, so this candidate fails when it is set.
    await writeFile(
      candidate,
      `#!/bin/sh\nif [ -n "\${ELECTRON_RUN_AS_NODE+x}" ]; then exit 1; fi\nprintf '%s\\n' '${JSON.stringify({ node: "20.19.0", electron: false })}'\n`,
    );
    await chmod(candidate, 0o755);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    assert.equal(await isStandaloneNodeExecutable(candidate, env, { minMajor: 20, isElectron: false }), true);
    assert.equal(await isStandaloneNodeExecutable(candidate, env, { minMajor: 22, isElectron: false }), false);
  });
});

test("isStandaloneNodeExecutable rejects the app binary and its links without running it", async () => {
  await withTempDir(async (dir) => {
    const app = path.join(dir, "Aiden Agent");
    const marker = path.join(dir, "launched");
    await writeFile(app, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(app, 0o755);
    const symbolic = path.join(dir, "node");
    const hard = path.join(dir, "hard-node");
    await symlink(app, symbolic);
    await link(app, hard);
    for (const candidate of [app, symbolic, hard]) {
      assert.equal(
        await isStandaloneNodeExecutable(candidate, process.env, { minMajor: 22, appExecutable: app, isElectron: true }),
        false,
      );
    }
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.equal(
      await isStandaloneNodeExecutable(process.execPath, process.env, { minMajor: 22, appExecutable: app, isElectron: true }),
      true,
    );
  });
});

test("nodeCommandEnvironment puts every bin folder first, in order, with no empty PATH entry, and clears Electron mode", () => {
  const bins = ["/repo/node_modules/.bin", "/opt/node/bin"];
  for (const [inherited, expected] of [
    [undefined, "/repo/node_modules/.bin:/opt/node/bin"],
    ["", "/repo/node_modules/.bin:/opt/node/bin"],
    ["/usr/bin::/bin", "/repo/node_modules/.bin:/opt/node/bin:/usr/bin:/bin"],
  ] as const) {
    const source: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1", HOME: "/Users/me" };
    if (inherited !== undefined) source.PATH = inherited;
    const env = nodeCommandEnvironment(source, bins);
    assert.equal(env.PATH, expected);
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.HOME, "/Users/me");
    assert.equal(source.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(source.PATH, inherited);
  }
});
