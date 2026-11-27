/* global console, process */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export function buildSwiftHelperApp({
  projectRoot,
  packagePath,
  scratchPath,
  moduleCachePath,
  destination,
  executableName,
  product,
  deploymentTarget,
  developerDir,
  label,
  fail,
}) {
  const destinationExecutable = path.join(destination, "Contents", "MacOS", executableName);
  const infoPlist = path.join(packagePath, "Info.plist");

  fs.mkdirSync(scratchPath, { recursive: true });
  fs.mkdirSync(moduleCachePath, { recursive: true });
  fs.rmSync(destination, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(destinationExecutable), { recursive: true });

  const helperBuildEnv = {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: moduleCachePath,
    DEVELOPER_DIR: developerDir,
    SWIFT_MODULECACHE_PATH: moduleCachePath,
    MACOSX_DEPLOYMENT_TARGET: deploymentTarget,
  };
  const commonArgs = [
    "swift",
    "build",
    "--disable-sandbox",
    "--package-path",
    packagePath,
    "--scratch-path",
    scratchPath,
    "--configuration",
    "release",
    "--product",
    product,
  ];

  const build = spawnSync("xcrun", commonArgs, {
    cwd: projectRoot,
    env: helperBuildEnv,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (build.error || build.status !== 0) {
    fail(`Could not build the ${label}.`, build.status ?? 1);
  }

  const binPath = spawnSync("xcrun", [...commonArgs, "--show-bin-path"], {
    cwd: projectRoot,
    env: helperBuildEnv,
    encoding: "utf8",
  });
  if (binPath.error || binPath.status !== 0) {
    fail(`Could not locate the built ${label}.`, binPath.status ?? 1);
  }

  const source = path.join(binPath.stdout.trim(), product);
  if (!fs.existsSync(source)) {
    fail(`The ${label} build completed without an executable.`);
  }

  fs.copyFileSync(source, destinationExecutable);
  fs.copyFileSync(infoPlist, path.join(destination, "Contents", "Info.plist"));
  fs.chmodSync(destinationExecutable, 0o755);
  const sign = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", destination], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (sign.error || sign.status !== 0) {
    fail(`Could not sign the ${label} app.`, sign.status ?? 1);
  }
  console.log(`${label}: ${path.relative(projectRoot, destination)}`);
}
