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

// A standalone native guest avoids starting unrelated application services.
test("hidden browser scheduling is owned by active automation and capture", async () => {
  const testInfo = test.info();
  const root = testInfo.outputPath("native");
  await mkdir(path.resolve("build"), { recursive: true });
  const temporaryBuild = await mkdtemp(path.resolve("build/native-throttling-"));
  let output = "";
  const entry = path.join(temporaryBuild, "throttling.mjs");
  try {
    await build({
      entryPoints: [path.resolve("tests/e2e/browser-throttling-native.ts")],
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
    // Match the Aiden Electron fixture's GPU switch; hosted runners have no GPU.
    // SIGKILL on timeout: Chromium turns SIGTERM into a clean exit 0, which
    // would hide a hang behind a missing result file instead of its stderr.
    const run = await promisify(execFile)(electron, ["--disable-gpu", entry], {
      timeout: 60_000,
      killSignal: "SIGKILL",
      env: {
        PATH: process.env.PATH,
        AIDEN_BROWSER_THROTTLING_ROOT: root,
        AIDEN_CONFIG_DIR: path.join(root, "config"),
        // This fixture bypasses the Electron fixture's environment
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
      throw new Error(`Native scheduling fixture exited without a result:\n${output}`);
    },
  );
  expect(JSON.parse(result)).toMatchObject({
    idlePolicy: true, timerResult: "timer", cancellationRestored: true,
    failureRestored: true, crashRestored: true,
  });
});
