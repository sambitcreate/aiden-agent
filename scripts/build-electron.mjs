import { build } from "esbuild";
import * as fs from "node:fs/promises";

const common = {
  bundle: true,
  sourcemap: true,
  platform: "node",
  target: "node22",
  logLevel: "info",
};

await fs.rm("build/main", { recursive: true, force: true });

await Promise.all([
  build({
    ...common,
    entryPoints: ["main/services/pi-vcc/worker.ts"],
    outfile: "build/main/pi-vcc-worker.js",
    format: "esm",
    packages: "external",
  }),
  build({
    ...common,
    entryPoints: ["main/bootstrap.ts"],
    outfile: "build/main/index.js",
    // Preserve main's singleton initialization order and sibling worker paths.
    // Only the packaged acceptance runner needs a separate lazy module.
    plugins: [{
      name: "lazy-create-images-acceptance",
      setup(builder) {
        builder.onResolve({ filter: /\/packaged-canvas-acceptance-runner\.js$/ }, () => ({
          path: "./create-images-packaged-acceptance-runner.js",
          external: true,
        }));
      },
    }],
    format: "esm",
    packages: "external",
  }),
  build({
    ...common,
    entryPoints: ["main/services/create-images/packaged-canvas-acceptance-runner.ts"],
    outfile: "build/main/create-images-packaged-acceptance-runner.js",
    format: "esm",
    packages: "external",
  }),
  build({
    ...common,
    entryPoints: ["main/services/subagents/subagent-inference-worker-bootstrap.ts"],
    outfile: "build/main/subagent-inference-worker.js",
    format: "esm",
    packages: "external",
    external: ["./subagent-inference-worker-runtime.js"],
  }),
  build({
    ...common,
    entryPoints: ["main/services/subagents/subagent-inference-worker.ts"],
    outfile: "build/main/subagent-inference-worker-runtime.js",
    format: "esm",
    packages: "external",
  }),
  build({
    ...common,
    entryPoints: ["main/services/parakeet-worker.ts"],
    outfile: "build/main/parakeet-worker.js",
    format: "esm",
    packages: "external",
  }),
  build({
    ...common,
    entryPoints: ["renderer/preload.ts"],
    outfile: "build/preload/preload.cjs",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["renderer/preload-pill.ts"],
    outfile: "build/preload/preload-pill.cjs",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["renderer/preload-create-images-image-decoder.ts"],
    outfile: "build/preload/create-images-image-decoder.cjs",
    format: "cjs",
    external: ["electron"],
  }),
]);
