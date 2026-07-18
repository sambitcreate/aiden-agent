#!/usr/bin/env node

/**
 * Thin wrapper that resolves the glaze CLI from the Glaze SDK.
 * Uses explicit SDK paths so `npm run build` etc. work without
 * relying on PATH.
 */

import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const candidates = [
  // Glaze framework monorepo checkout.
  resolve(__dirname, "../glaze-core/cli/glaze.js"),
  // Glaze-managed app source checkout.
  resolve(__dirname, "../../../sdk/current/@glaze/core/cli/glaze.js"),
  // Standalone source checkout with Glaze's installed SDK cache.
  resolve(
    homedir(),
    "Library/Application Support/app.glaze.macos.main/sdk/current/@glaze/core/cli/glaze.js",
  ),
  // Standalone source checkout with the SDK bundled in Glaze.app.
  "/Applications/Glaze.app/Contents/Resources/sdk/@glaze/core/cli/glaze.js",
];

const cli = candidates.find(existsSync);
if (!cli) {
  console.error("[glaze] CLI not found. Searched:");
  candidates.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}

// TypeScript and ESLint run as child processes and do not use Glaze's runtime
// module-resolution hook. Give standalone checkouts a normal node_modules path
// to the installed SDK without copying or vendoring it into the repository.
const sdkCoreDir = resolve(dirname(cli), "..");
const localSdkScope = resolve(__dirname, "node_modules/@glaze");
const localSdkCore = resolve(localSdkScope, "core");
if (!existsSync(localSdkCore)) {
  mkdirSync(localSdkScope, { recursive: true });
  try {
    symlinkSync(sdkCoreDir, localSdkCore, "dir");
  } catch (error) {
    // Another concurrently running Glaze command may have created it first.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

await import(cli);
