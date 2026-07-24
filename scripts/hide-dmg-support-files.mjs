/* global console, process */

import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

const DMG_SUPPORT_FILES = Object.freeze([".background.tiff", ".VolumeIcon.icns"]);
const STAGING_SYSTEM_DIRECTORIES = Object.freeze([".fseventsd"]);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`${path.basename(command)} failed (${code ?? signal}).`));
    });
  });
}

async function assertRegularFile(file, description) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(file)) !== file) {
    throw new Error(`${description} must be a regular, non-symlinked file: ${file}`);
  }
}

async function markStagingSystemDirectoryHidden(mount, name) {
  const directory = path.join(mount, name);
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unexpected DMG staging path: ${directory}`);
  }
  await run("/usr/bin/xcrun", ["SetFile", "-a", "V", directory]);
}

export function isDmgArtifact(artifact) {
  return typeof artifact?.file === "string" && artifact.file.toLowerCase().endsWith(".dmg");
}

export async function hideDmgSupportFiles(artifact) {
  if (!isDmgArtifact(artifact)) return;
  if (process.platform !== "darwin") {
    throw new Error("DMG Finder metadata can only be finalized on macOS.");
  }

  const dmg = path.resolve(artifact.file);
  await assertRegularFile(dmg, "DMG artifact");

  const staging = await mkdtemp(path.join(path.dirname(dmg), ".aiden-dmg-layout-"));
  const writableImage = path.join(staging, "writable.dmg");
  const finalizedImage = path.join(staging, "finalized.dmg");
  const mount = path.join(staging, "mount");
  let mounted = false;

  try {
    await run("/usr/bin/hdiutil", ["convert", dmg, "-format", "UDRW", "-o", writableImage, "-quiet"]);
    await mkdir(mount);
    await run("/usr/bin/hdiutil", [
      "attach",
      "-readwrite",
      "-noverify",
      "-nobrowse",
      "-mountpoint",
      mount,
      writableImage,
    ]);
    mounted = true;

    for (const name of DMG_SUPPORT_FILES) {
      const file = path.join(mount, name);
      await assertRegularFile(file, "DMG support file");
      await run("/usr/bin/xcrun", ["SetFile", "-a", "V", file]);
    }

    // FSEvents may create this directory during the writable-mount phase.
    // Keep the system-owned directory invisible in the sealed Finder layout.
    for (const name of STAGING_SYSTEM_DIRECTORIES) {
      await markStagingSystemDirectoryHidden(mount, name);
    }
    await run("/usr/bin/hdiutil", ["detach", "-quiet", mount]);
    mounted = false;
    await run("/usr/bin/hdiutil", [
      "convert",
      writableImage,
      "-format",
      "UDZO",
      "-imagekey",
      "zlib-level=9",
      "-o",
      finalizedImage,
      "-quiet",
    ]);
    await assertRegularFile(finalizedImage, "Finalized DMG");
    await rename(finalizedImage, dmg);
    console.log(`Finalized hidden Finder support files in ${dmg}`);
  } finally {
    if (mounted) {
      try {
        await run("/usr/bin/hdiutil", ["detach", "-quiet", mount]);
      } catch {
        await run("/usr/bin/hdiutil", ["detach", "-force", mount]);
      }
    }
    await rm(staging, { force: true, recursive: true });
  }
}

export default hideDmgSupportFiles;
