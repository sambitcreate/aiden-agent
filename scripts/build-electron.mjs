import { build } from "esbuild";
import { Buffer } from "node:buffer";
import process from "node:process";

const embeddedBuildIdentity = Object.freeze({
  schemaVersion: 1,
  commit: process.env.AIDEN_BUILD_COMMIT ?? "unavailable",
  dirtyStateHash: process.env.AIDEN_BUILD_DIRTY_HASH ?? "unavailable",
  buildMode: process.env.AIDEN_BUILD_MODE ?? "development",
  profilingBuild: process.env.AIDEN_REACT_PROFILING === "1",
});
const identityJson = JSON.stringify(embeddedBuildIdentity);

const common = {
  bundle: true,
  sourcemap: true,
  platform: "node",
  target: "node22",
  logLevel: "info",
  define: {
    __AIDEN_EMBEDDED_BUILD_IDENTITY__: JSON.stringify(identityJson),
  },
  banner: {
    js: `/* AIDEN_PERFORMANCE_BUILD_IDENTITY_V1 ${Buffer.from(identityJson, "utf8").toString("base64url")} */`,
  },
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["main/bootstrap.ts"],
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
]);
