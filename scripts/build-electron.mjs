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
    entryPoints: ["main/index.ts"],
    outfile: "build/main/index.js",
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
    entryPoints: ["renderer/preload-assistant.ts"],
    outfile: "build/preload/preload-assistant.cjs",
    format: "cjs",
    external: ["electron"],
  }),
]);
