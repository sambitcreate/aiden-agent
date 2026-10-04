import { build } from "esbuild";
import process from "node:process";
import { pathToFileURL } from "node:url";

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
 */
export function electronBuildOptions({ production = false } = {}) {
  const common = {
    bundle: true,
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
      outfile: "build/main/index.js",
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
      entryPoints: ["main/services/parakeet-worker.ts"],
      outfile: "build/main/parakeet-worker.js",
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
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const production = process.argv.includes("--production");
  await Promise.all(electronBuildOptions({ production }).map((options) => build(options)));
}
