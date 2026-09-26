import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_DEVICE,
  DEVICE_HUB,
  DeviceToolchainInstallError,
  deviceToolPaths,
  ensureTool,
  installedToolVersions,
  isToolInstalled,
  pruneOldToolVersions,
  resolveNpm,
  type NpmRunner,
  type ToolSpec,
} from "./device-toolchain.js";

async function withBaseDir(run: (baseDir: string) => Promise<void>): Promise<void> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "aiden-devices-toolchain-"));
  try {
    await run(baseDir);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

/** A fake npm that materializes the tool's entry file inside `--prefix`. */
function fakeNpm(
  spec: ToolSpec,
  options: { writeEntry?: boolean; code?: number; onRun?: (prefix: string) => Promise<void> } = {},
): { runNpm: NpmRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runNpm: NpmRunner = async (args) => {
    calls.push(args);
    const prefix = args[args.indexOf("--prefix") + 1];
    await options.onRun?.(prefix);
    if (options.writeEntry !== false) {
      const entry = path.join(prefix, "node_modules", spec.name, ...spec.entry);
      await mkdir(path.dirname(entry), { recursive: true });
      await writeFile(entry, "export {};\n");
    }
    return { code: options.code ?? 0, stderr: options.code ? "npm ERR! 404" : "" };
  };
  return { runNpm, calls };
}

async function stagingDirs(baseDir: string, spec: ToolSpec): Promise<string[]> {
  const names = await readdir(path.join(baseDir, "tools", spec.name)).catch(() => []);
  return names.filter((name) => name.startsWith(".staging-"));
}

test("installs pass exact pinned npm arguments and publish a sentinel", async () => {
  await withBaseDir(async (baseDir) => {
    const npm = fakeNpm(DEVICE_HUB);
    const entryPath = await ensureTool(baseDir, DEVICE_HUB, npm);
    assert.equal(npm.calls.length, 1);
    const [args] = npm.calls;
    const staging = args[2];
    assert.equal(path.dirname(staging), path.join(baseDir, "tools", "expo-device-hub"));
    assert.match(path.basename(staging), /^\.staging-/u);
    assert.deepEqual(args, [
      "install",
      "--prefix",
      staging,
      "--no-fund",
      "--no-audit",
      "--ignore-scripts=false",
      "expo-device-hub@0.12.0",
    ]);
    assert.ok(!args.some((arg) => /[\^~*]|latest/u.test(arg)));
    const paths = deviceToolPaths(baseDir, DEVICE_HUB);
    assert.equal(entryPath, paths.entryPath);
    assert.equal(
      entryPath,
      path.join(baseDir, "tools/expo-device-hub/0.12.0/node_modules/expo-device-hub/dist/server/cli.mjs"),
    );
    assert.equal(await readFile(paths.sentinel, "utf8"), "0.12.0\n");
    assert.equal(await isToolInstalled(baseDir, DEVICE_HUB), true);
    assert.deepEqual(await stagingDirs(baseDir, DEVICE_HUB), []);
  });
});

test("a missing entry after npm exits 0 is refused and nothing is published", async () => {
  await withBaseDir(async (baseDir) => {
    const npm = fakeNpm(AGENT_DEVICE, { writeEntry: false });
    await assert.rejects(ensureTool(baseDir, AGENT_DEVICE, npm), (error: unknown) => {
      assert.ok(error instanceof DeviceToolchainInstallError);
      assert.equal(
        error.message,
        "Installing agent-device failed while verifying the installed entry point.",
      );
      return true;
    });
    assert.equal(await isToolInstalled(baseDir, AGENT_DEVICE), false);
    assert.deepEqual(await stagingDirs(baseDir, AGENT_DEVICE), []);
  });
});

test("a failing npm exit reports its code and cleans the staging directory", async () => {
  await withBaseDir(async (baseDir) => {
    const npm = fakeNpm(DEVICE_HUB, { code: 1 });
    await assert.rejects(
      ensureTool(baseDir, DEVICE_HUB, npm),
      /Installing expo-device-hub failed while running npm install \(exit code 1\)\./u,
    );
    assert.deepEqual(await stagingDirs(baseDir, DEVICE_HUB), []);
  });
});

test("a spawn failure cleans the staging directory", async () => {
  await withBaseDir(async (baseDir) => {
    const runNpm: NpmRunner = async () => {
      throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
    };
    await assert.rejects(ensureTool(baseDir, DEVICE_HUB, { runNpm }), /running npm install\./u);
    assert.deepEqual(await stagingDirs(baseDir, DEVICE_HUB), []);
  });
});

test("a published sentinel short-circuits later installs", async () => {
  await withBaseDir(async (baseDir) => {
    await ensureTool(baseDir, DEVICE_HUB, fakeNpm(DEVICE_HUB));
    const second = fakeNpm(DEVICE_HUB);
    await ensureTool(baseDir, DEVICE_HUB, second);
    assert.equal(second.calls.length, 0);
  });
});

test("a stale install without a matching sentinel is replaced", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = deviceToolPaths(baseDir, DEVICE_HUB);
    await mkdir(path.dirname(paths.entryPath), { recursive: true });
    await writeFile(paths.entryPath, "partial");
    const npm = fakeNpm(DEVICE_HUB);
    await ensureTool(baseDir, DEVICE_HUB, npm);
    assert.equal(npm.calls.length, 1);
    assert.equal(await readFile(paths.entryPath, "utf8"), "export {};\n");
  });
});

test("concurrent callers share one install", async () => {
  await withBaseDir(async (baseDir) => {
    const npm = fakeNpm(DEVICE_HUB);
    const results = await Promise.all([
      ensureTool(baseDir, DEVICE_HUB, npm),
      ensureTool(baseDir, DEVICE_HUB, npm),
      ensureTool(baseDir, DEVICE_HUB, npm),
    ]);
    assert.equal(npm.calls.length, 1);
    assert.equal(new Set(results).size, 1);
  });
});

test("a rename race where another process already published counts as success", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = deviceToolPaths(baseDir, DEVICE_HUB);
    const npm = fakeNpm(DEVICE_HUB, {
      // Publish a complete, non-empty install while ours is staging so rename fails.
      onRun: async () => {
        await mkdir(path.dirname(paths.entryPath), { recursive: true });
        await writeFile(paths.entryPath, "published elsewhere");
        await writeFile(paths.sentinel, "0.12.0\n");
      },
    });
    const entryPath = await ensureTool(baseDir, DEVICE_HUB, npm);
    assert.equal(entryPath, paths.entryPath);
    assert.equal(await readFile(paths.entryPath, "utf8"), "published elsewhere");
    assert.deepEqual(await stagingDirs(baseDir, DEVICE_HUB), []);
  });
});

test("a rename failure without a published install is an error", async () => {
  await withBaseDir(async (baseDir) => {
    const paths = deviceToolPaths(baseDir, DEVICE_HUB);
    const npm = fakeNpm(DEVICE_HUB, {
      onRun: async () => {
        await mkdir(path.join(paths.installDir, "occupied"), { recursive: true });
      },
    });
    await assert.rejects(ensureTool(baseDir, DEVICE_HUB, npm), /publishing the install\./u);
    assert.deepEqual(await stagingDirs(baseDir, DEVICE_HUB), []);
  });
});

test("pruning keeps only the pinned version and ignores foreign names", async () => {
  await withBaseDir(async (baseDir) => {
    const toolDir = path.join(baseDir, "tools", DEVICE_HUB.name);
    for (const name of ["0.11.0", "0.12.0", "0.13.0-beta.1", "notes"]) {
      await mkdir(path.join(toolDir, name), { recursive: true });
    }
    await pruneOldToolVersions(baseDir, DEVICE_HUB);
    assert.deepEqual((await readdir(toolDir)).sort(), ["0.12.0", "notes"]);
    await pruneOldToolVersions(path.join(baseDir, "missing"), DEVICE_HUB);
  });
});

test("installed versions list only completed installs", async () => {
  await withBaseDir(async (baseDir) => {
    assert.deepEqual(await installedToolVersions(baseDir, DEVICE_HUB), []);
    await ensureTool(baseDir, DEVICE_HUB, fakeNpm(DEVICE_HUB));
    await mkdir(path.join(baseDir, "tools", DEVICE_HUB.name, "0.11.0"), { recursive: true });
    assert.deepEqual(await installedToolVersions(baseDir, DEVICE_HUB), ["0.12.0"]);
  });
});

test("npm resolves from PATH, then the login shell, then Homebrew locations", async () => {
  const executable = (paths: string[]) => async (filePath: string) => paths.includes(filePath);
  let shellCalls = 0;
  const loginShellLookup = async () => {
    shellCalls += 1;
    return "Welcome!\n/Users/me/.nvm/versions/node/v22.22.3/bin/npm\n";
  };
  assert.equal(
    await resolveNpm({
      env: { PATH: "relative:/usr/bin:/opt/node/bin", SHELL: "/bin/zsh" },
      isExecutable: executable(["/opt/node/bin/npm", "/opt/homebrew/bin/npm"]),
      loginShellLookup,
    }),
    "/opt/node/bin/npm",
  );
  assert.equal(shellCalls, 0);
  assert.equal(
    await resolveNpm({
      env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
      isExecutable: executable([
        "/Users/me/.nvm/versions/node/v22.22.3/bin/npm",
        "/opt/homebrew/bin/npm",
      ]),
      loginShellLookup,
    }),
    "/Users/me/.nvm/versions/node/v22.22.3/bin/npm",
  );
  assert.equal(
    await resolveNpm({
      env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
      isExecutable: executable(["/usr/local/bin/npm"]),
      loginShellLookup: async () => {
        throw new Error("shell timed out");
      },
    }),
    "/usr/local/bin/npm",
  );
  assert.equal(
    await resolveNpm({ env: {}, isExecutable: executable([]), loginShellLookup }),
    null,
  );
});
