/* global console, process */
/**
 * Builds the four Aiden native helpers for the host platform and installs them
 * under `prebuilt/native/<target>/` (e.g. darwin-universal, linux-arm64) with a
 * checksum manifest. `packages/cli/scripts/build.mjs` prefers these over
 * compiling, so installs on supported platforms need no C toolchain.
 *
 *   node scripts/build-native-helpers.mjs            # host platform
 *   node scripts/build-native-helpers.mjs --docker linux/amd64 linux/arm64
 *
 * The --docker mode runs the same script inside `node:22` containers so Linux
 * binaries can be produced from a macOS host.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HELPERS, nativeHelperSourceHash, nativeHelperTarget, verifyNativeHelper } from "./native-helpers.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerTargets = process.argv.slice(2).flatMap((arg, index, argv) => (arg === "--docker" ? argv.slice(index + 1) : []));

if (dockerTargets.length > 0) {
  for (const target of dockerTargets) {
    // Debian bookworm image: cc + libssl-dev cover the OpenSSL-linked helpers.
    const result = spawnSync("docker", [
      "run", "--rm", "--platform", target,
      "-v", `${repositoryRoot}:/repo`, "-w", "/repo",
      "node:22-bookworm",
      "sh", "-c",
      "apt-get update -qq && apt-get install -y -qq build-essential libssl-dev >/dev/null && node scripts/build-native-helpers.mjs",
    ], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Docker build for ${target} failed.`);
  }
  process.exit(0);
}

const target = nativeHelperTarget();
if (!target) {
  console.log(`No native helper target for ${process.platform}/${process.arch}.`);
  process.exit(0);
}

const output = path.join(repositoryRoot, "prebuilt", "native", target);
mkdirSync(output, { recursive: true });

for (const helper of NATIVE_HELPERS) {
  const build = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts", `build-${helper}.mjs`)], { stdio: "inherit" });
  if (build.status !== 0) throw new Error(`Native ${helper} build failed.`);
  const built = path.join(repositoryRoot, "build", "native", `aiden-${helper}`);
  const staged = path.join(output, `aiden-${helper}`);
  copyFileSync(built, staged);
  if (!verifyNativeHelper(staged)) throw new Error(`Built ${staged} does not match ${process.platform}/${process.arch}.`);
}

const manifest = {
  target,
  builtAt: new Date().toISOString(),
  helpers: Object.fromEntries(NATIVE_HELPERS.map((helper) => {
    const file = path.join(output, `aiden-${helper}`);
    return [helper, {
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
      // The installer refuses a prebuilt whose sources moved on — prevents a
      // stale binary silently passing every check after a main.c edit.
      source: nativeHelperSourceHash(repositoryRoot, helper),
    }];
  })),
};
writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Installed prebuilt helpers at ${path.relative(repositoryRoot, output)}`);
