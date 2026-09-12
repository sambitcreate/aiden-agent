import * as fs from "fs/promises";
import * as path from "path";

/**
 * Mirror node-pty's runtime rewrite from Electron's virtual ASAR path to the
 * real unpacked directory. Electron's patched `stat` can report an unpacked
 * placeholder inside `app.asar` as a regular non-executable file, but `chmod`
 * on that virtual path fails with ENOTDIR. Normalize before either operation.
 */
export function resolveNodePtyDiskPackageDir(packageDir: string): string {
  return packageDir
    .replace(/([/\\])app\.asar([/\\])/u, "$1app.asar.unpacked$2")
    .replace(/([/\\])node_modules\.asar([/\\])/u, "$1node_modules.asar.unpacked$2");
}

/**
 * Resolve the real filesystem helpers below a node-pty package directory.
 *
 * The directory-reader seam lets the regression test exercise the exact
 * production lookup without requiring an Electron ASAR mount. Normalization
 * deliberately happens before readdir so neither discovery nor chmod can ever
 * target Electron's virtual `app.asar` path.
 */
export async function resolveNodePtySpawnHelperPaths(
  packageDir: string,
  readDirectory: (directory: string) => Promise<readonly string[]> = fs.readdir,
): Promise<string[]> {
  const diskPackageDir = resolveNodePtyDiskPackageDir(packageDir);
  const compiledHelper = path.join(diskPackageDir, "build", "Release", "spawn-helper");
  const prebuildsDir = path.join(diskPackageDir, "prebuilds");
  let entries: readonly string[];
  try {
    entries = await readDirectory(prebuildsDir);
  } catch {
    return [compiledHelper];
  }
  return [
    compiledHelper,
    ...entries.map((entry) => path.join(prebuildsDir, entry, "spawn-helper")),
  ];
}
