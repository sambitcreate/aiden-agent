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
    await promisify(execFile)(electron, [entry], {
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        AIDEN_BROWSER_CRASH_ROOT: root,
        AIDEN_CONFIG_DIR: path.join(root, "config"),
      },
    });
  } finally {
    await rm(temporaryBuild, { recursive: true, force: true });
  }
  const report = JSON.parse(
    await readFile(path.join(root, "result.json"), "utf8"),
  );
  expect(report.before).toEqual({
    nativeCrashed: true,
    nativeLoading: true,
    crashed: true,
    loading: false,
  });
  expect(report.requests).toBe(2);
  expect(new URL(report.url).pathname).toBe("/first");
});
