/* global console, process */

import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  beginMacDistribution,
  discardMacDistributionStaging,
  promoteMacDistribution,
} from "./prepare-macos-package-output.mjs";
import {
  assertSamePackagedArtifactIdentity,
  discoverPackagedApp,
  packagedArtifactIdentity,
  verifyMacPackage,
  verifyNotarizedMacPackage,
} from "./verify-macos-package.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`${path.basename(command)} failed (${code ?? signal}).`));
    });
  });
}

export async function discoverMacDistributionArchives(staging) {
  const entries = await readdir(staging, { withFileTypes: true });
  const archive = (suffix) =>
    entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix));
  const dmgs = archive(".dmg");
  const zips = archive(".zip");
  if (dmgs.length !== 1 || zips.length !== 1) {
    throw new Error(
      `The current macOS distribution must contain exactly one DMG and ZIP (found ${dmgs.length}/${zips.length}).`,
    );
  }
  return {
    dmg: path.join(staging, dmgs[0].name),
    zip: path.join(staging, zips[0].name),
  };
}

async function exactArchiveApp(root, source) {
  const appPath = path.join(root, "Aiden Agent.app");
  const info = await lstat(appPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${source} does not contain a regular top-level Aiden Agent.app.`);
  }
  return appPath;
}

async function verifyEmbeddedApp(appPath, expectedIdentity, source) {
  await verifyMacPackage(appPath);
  await verifyNotarizedMacPackage(appPath);
  assertSamePackagedArtifactIdentity(
    expectedIdentity,
    await packagedArtifactIdentity(appPath),
    source,
  );
}

export async function verifyDmgContainsStagingApp(dmg, expectedIdentity) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-verify-dmg-"));
  const canonicalTemporary = await realpath(temporary);
  const mount = path.join(canonicalTemporary, "mount");
  let mounted = false;
  let failure = null;
  try {
    await mkdir(mount);
    await runCommand("/usr/bin/hdiutil", ["verify", dmg]);
    await runCommand("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mount,
      dmg,
    ]);
    mounted = true;
    await verifyEmbeddedApp(await exactArchiveApp(mount, "DMG"), expectedIdentity, "DMG");
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors = [];
    if (mounted) {
      try {
        await runCommand("/usr/bin/hdiutil", ["detach", mount]);
        mounted = false;
      } catch (error) {
        cleanupErrors.push(error);
        try {
          await runCommand("/usr/bin/hdiutil", ["detach", "-force", mount]);
          mounted = false;
        } catch (forceError) {
          cleanupErrors.push(forceError);
        }
      }
    }
    if (!mounted) {
      try {
        await rm(canonicalTemporary, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      cleanupErrors.push(
        new Error(
          `Mounted DMG cleanup is still attached at ${mount}; temporary files were retained.`,
        ),
      );
    }
    if (cleanupErrors.length > 0) {
      failure = new AggregateError(
        [failure, ...cleanupErrors].filter(Boolean),
        "DMG verification cleanup failed.",
      );
    }
  }
  if (failure) throw failure;
}

export async function verifyZipContainsStagingApp(zip, expectedIdentity) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-verify-zip-"));
  const canonicalTemporary = await realpath(temporary);
  const extracted = path.join(canonicalTemporary, "extracted");
  try {
    await mkdir(extracted);
    await runCommand("/usr/bin/ditto", ["-x", "-k", zip, extracted]);
    await verifyEmbeddedApp(await exactArchiveApp(extracted, "ZIP"), expectedIdentity, "ZIP");
  } finally {
    await rm(canonicalTemporary, { recursive: true, force: true });
  }
}

export async function verifyMacDistributionArchives(
  staging,
  expectedIdentity,
  { verifyDmg = verifyDmgContainsStagingApp, verifyZip = verifyZipContainsStagingApp } = {},
) {
  const archives = await discoverMacDistributionArchives(staging);
  await verifyDmg(archives.dmg, expectedIdentity);
  await verifyZip(archives.zip, expectedIdentity);
  return archives;
}

export async function runDistributionTransaction({ prepare, build, verify, promote, discard }) {
  let prepared = false;
  try {
    const transaction = await prepare();
    prepared = true;
    await build(transaction);
    await verify(transaction);
    return await promote(transaction);
  } catch (error) {
    if (prepared) {
      try {
        await discard();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Distribution failed and staging cleanup failed.",
        );
      }
    }
    throw error;
  }
}

export async function runMacDistribution() {
  const npm = (script) => runCommand("/usr/bin/env", ["npm", "run", script]);
  return runDistributionTransaction({
    prepare: () => beginMacDistribution(repositoryRoot),
    build: async ({ staging }) => {
      await npm("release:preflight");
      await npm("release:update-model-capabilities");
      await npm("computer-use:vendor");
      await npm("build:native");
      await npm("build");
      await runCommand(path.join(repositoryRoot, "node_modules", ".bin", "electron-builder"), [
        "--mac",
        `--config.directories.output=${staging}`,
      ]);
    },
    verify: async ({ staging }) => {
      const appPath = await discoverPackagedApp(staging);
      await verifyMacPackage(appPath);
      await verifyNotarizedMacPackage(appPath);
      await verifyMacDistributionArchives(staging, await packagedArtifactIdentity(appPath));
    },
    promote: () => promoteMacDistribution(repositoryRoot),
    discard: () => discardMacDistributionStaging(repositoryRoot),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const output = await runMacDistribution();
  console.log(`Published verified macOS distribution output: ${output}`);
}
