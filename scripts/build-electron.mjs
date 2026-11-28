/* global console, URL */
import { build } from "esbuild";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { analyticsBuildConfigPlugin, resolveAnalyticsBuildConfig } from "./analytics-build-config.mjs";

/**
 * Removes prior `.js` and `.map` build outputs from `outdir` before emitting
 * split ESM chunks so incremental builds never leave obsolete chunks behind in
 * `build/main` (which `electron-builder` packs via `build/main/**\/*`).
 */
export function cleanMainBuildOutput(outdir = "build/main") {
  if (!existsSync(outdir)) return;
  for (const entry of readdirSync(outdir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".js") || entry.name.endsWith(".map")) {
      rmSync(path.join(outdir, entry.name), { force: true });
    }
  }
}

/**
 * Returns the esbuild option sets for the main-process, worker, and preload
 * bundles.
 *
 * Development output stays readable with linked source maps. Production
 * output (`npm run build`, which packaging and e2e use) strips whitespace and
 * simplifies syntax but never mangles identifiers, so function and class names
 * survive in stack traces and serialized code. Its maps are external: written
 * beside each bundle for release symbolication, never referenced from it, and
 * excluded from app.asar by the packager's `!**\/*.map` rule.
 *
 * `analytics` is the product-analytics build configuration of a distribution
 * build (see analytics-build-config.mjs); every other build keeps the
 * committed keyless module.
 */
export function electronBuildOptions({ production = false, analytics } = {}) {
  const common = {
    bundle: true,
    ...(analytics ? { plugins: [analyticsBuildConfigPlugin(analytics)] } : {}),
    platform: "node",
    target: "node22",
    logLevel: "info",
    ...(production
      ? { sourcemap: "external", minifyWhitespace: true, minifySyntax: true }
      : { sourcemap: true }),
  };
  return [
    {
      ...common,
      entryPoints: ["main/services/pi-vcc/worker.ts"],
      outfile: "build/main/pi-vcc-worker.js",
      format: "esm",
      packages: "external",
    },
    {
      ...common,
      entryPoints: ["main/bootstrap.ts"],
      entryNames: "index",
      chunkNames: "chunk-[hash]",
      outdir: "build/main",
      splitting: true,
      format: "esm",
      packages: "external",
    },
    {
      ...common,
      entryPoints: ["main/services/subagents/subagent-inference-worker-bootstrap.ts"],
      outfile: "build/main/subagent-inference-worker.js",
      format: "esm",
      packages: "external",
      external: ["./subagent-inference-worker-runtime.js"],
    },
    {
      ...common,
      entryPoints: ["main/services/subagents/subagent-inference-worker.ts"],
      outfile: "build/main/subagent-inference-worker-runtime.js",
      format: "esm",
      packages: "external",
    },
    {
      ...common,
      entryPoints: ["main/services/local-speech-worker.ts"],
      outfile: "build/main/local-speech-worker.js",
      format: "esm",
      packages: "external",
    },
    {
      ...common,
      entryPoints: ["renderer/preload.ts"],
      outfile: "build/preload/preload.cjs",
      format: "cjs",
      external: ["electron"],
    },
    {
      ...common,
      entryPoints: ["renderer/preload-pill.ts"],
      outfile: "build/preload/preload-pill.cjs",
      format: "cjs",
      external: ["electron"],
    },
    {
      ...common,
      entryPoints: ["renderer/preload-quick-chat.ts"],
      outfile: "build/preload/preload-quick-chat.cjs",
      format: "cjs",
      external: ["electron"],
    },
    {
      ...common,
      entryPoints: ["renderer/preload-bot-bubbles.ts"],
      outfile: "build/preload/preload-bot-bubbles.cjs",
      format: "cjs",
      external: ["electron"],
    },
  ];
}

export async function buildElectronBundles({ production = false, analytics, mainOutdir = "build/main" } = {}) {
  cleanMainBuildOutput(mainOutdir);
  await Promise.all(
    electronBuildOptions({ production, analytics }).map((options) => {
      if (mainOutdir !== "build/main") {
        if (options.outdir === "build/main") {
          return build({ ...options, outdir: mainOutdir });
        }
        if (typeof options.outfile === "string" && options.outfile.startsWith("build/main/")) {
          return build({
            ...options,
            outfile: path.join(mainOutdir, path.relative("build/main", options.outfile)),
          });
        }
      }
      return build(options);
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const production = process.argv.includes("--production");
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const analytics = resolveAnalyticsBuildConfig({ env: process.env, version });
  if (analytics?.warning) console.warn(`warning: ${analytics.warning}`);
  await buildElectronBundles({ production, analytics: analytics?.config });
}
