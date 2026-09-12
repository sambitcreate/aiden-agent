import { build } from "esbuild";

const common = {
  bundle: true,
  sourcemap: true,
  platform: "node",
  target: "node22",
  logLevel: "info",
};

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
]);
