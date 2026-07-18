import { defineConfig, externalizePackage } from "@glaze/core/build";

// sherpa-onnx-node ships a prebuilt native addon and dylibs in a platform
// package (e.g. sherpa-onnx-darwin-arm64) that it loads from disk at runtime, so
// it can't be inlined into the esbuild bundle — externalize it and copy the full
// package tree (incl. the platform binaries) into build/main/node_modules.
const sherpa = externalizePackage("sherpa-onnx-node");

export default defineConfig({
  build: {
    external: [...sherpa.externals],
    plugins: [sherpa.plugin],
  },
});
