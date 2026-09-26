import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import playwrightTest from "@playwright/test";
import type * as PlaywrightTestModule from "@playwright/test";

const { expect, test } =
  playwrightTest as unknown as typeof PlaywrightTestModule;

// Deliberately no Aiden/Playwright Electron fixture: its CDP target attachment
// rejects when a guest crashes before the first commit, masking native recovery.
test("current native crash before the first commit retries its pending URL", async () => {
  const testInfo = test.info();
  const root = testInfo.outputPath("native");
  await mkdir(path.resolve("build"), { recursive: true });
  const temporaryBuild = await mkdtemp(path.resolve("build/native-crash-"));
  let output = "";
  const entry = path.join(temporaryBuild, "initial-crash.mjs");
  try {
    await build({
      entryPoints: [path.resolve("tests/e2e/browser-initial-crash-native.ts")],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      external: ["electron"],
      tsconfigRaw: { compilerOptions: {} },
      logLevel: "silent",
    });
    const electron = createRequire(import.meta.url)("electron") as string;
    // Match the Aiden Electron fixture's GPU switch: hosted runners have no GPU,
    // and a software GPU process under Linux's namespace sandbox can stall
    // startup long enough to starve this timing-sensitive fixture.
    // SIGKILL on timeout: Chromium turns SIGTERM into a clean exit 0, which
    // would hide a hang behind a missing result file instead of its stderr.
    const run = await promisify(execFile)(electron, ["--disable-gpu", entry], {
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: {
        PATH: process.env.PATH,
        AIDEN_BROWSER_CRASH_ROOT: root,
        AIDEN_CONFIG_DIR: path.join(root, "config"),
        // The crash fixture bypasses the Electron fixture's environment
        // assembly, so forward the display session itself on Linux.
        ...(process.platform === "linux"
          ? Object.fromEntries(
              ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE"]
                .filter((name) => process.env[name] !== undefined)
                .map((name) => [name, process.env[name]]),
            )
          : {}),
      },
    });
    output = `${run.stdout}${run.stderr}`;
  } finally {
    await rm(temporaryBuild, { recursive: true, force: true });
  }
  const result = await readFile(path.join(root, "result.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      throw new Error(`Native crash fixture exited without a result:\n${output}`);
    },
  );
  const report = JSON.parse(result);
  expect(report.before).toEqual({
    nativeCrashed: true,
    nativeLoading: true,
    crashed: true,
    loading: false,
  });
  expect(report.requests).toBe(2);
  expect(new URL(report.url).pathname).toBe("/first");
});
