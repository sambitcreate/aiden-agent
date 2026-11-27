/* global console, URL */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { analyticsBuildConfigPlugin, resolveAnalyticsBuildConfig } from "./analytics-build-config.mjs";

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
  const mainBundle = (entryPoint, outfile, extra = {}) => ({
    ...common,
    entryPoints: [entryPoint],
    outfile,
    format: "esm",
    packages: "external",
    ...extra,
  });
  const preloadBundle = (entryPoint, outfile) => ({
    ...common,
    entryPoints: [entryPoint],
    outfile,
    format: "cjs",
    external: ["electron"],
  });
  return [
    mainBundle("main/services/pi-vcc/worker.ts", "build/main/pi-vcc-worker.js"),
    mainBundle("main/bootstrap.ts", "build/main/index.js"),
    mainBundle(
      "main/services/subagents/subagent-inference-worker-bootstrap.ts",
      "build/main/subagent-inference-worker.js",
      { external: ["./subagent-inference-worker-runtime.js"] },
    ),
    mainBundle(
      "main/services/subagents/subagent-inference-worker.ts",
      "build/main/subagent-inference-worker-runtime.js",
    ),
    mainBundle("main/services/local-speech-worker.ts", "build/main/local-speech-worker.js"),
    preloadBundle("renderer/preload.ts", "build/preload/preload.cjs"),
    preloadBundle("renderer/preload-pill.ts", "build/preload/preload-pill.cjs"),
    preloadBundle("renderer/preload-quick-chat.ts", "build/preload/preload-quick-chat.cjs"),
    preloadBundle("renderer/preload-bot-bubbles.ts", "build/preload/preload-bot-bubbles.cjs"),
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const production = process.argv.includes("--production");
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const analytics = resolveAnalyticsBuildConfig({ env: process.env, version });
  if (analytics?.warning) console.warn(`warning: ${analytics.warning}`);
  await Promise.all(
    electronBuildOptions({ production, analytics: analytics?.config }).map((options) => build(options)),
  );
}
