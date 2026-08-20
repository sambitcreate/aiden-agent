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
    entryPoints: { index: "main/bootstrap.ts" },
    outdir: "build/main",
    entryNames: "[name]",
    chunkNames: "chunks/[name]-[hash]",
    splitting: true,
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
