/* global console, process */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Backport https://github.com/electron-userland/electron-builder/pull/10101.
// Remove when the locked stable builder includes the keychain-password fix.
const expectedVersion = "26.15.3";
const replacements = [
  [
    "importCerts(keychainFile, certPaths, cscPasswords)",
    "importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)",
  ],
  [
    "async function importCerts(keychainFile, paths, keyPasswords)",
    "async function importCerts(keychainFile, paths, keyPasswords, keychainPassword)",
  ],
  ['"-s", "-k", password, keychainFile', '"-s", "-k", keychainPassword, keychainFile'],
];

export function patchKeychainSource(source) {
  let result = source;
  for (const [before, after] of replacements) {
    const beforeCount = result.split(before).length - 1;
    const afterCount = result.split(after).length - 1;
    if (beforeCount === 1 && afterCount === 0) result = result.replace(before, after);
    else if (beforeCount !== 0 || afterCount !== 1) {
      throw new Error(
        "Electron builder keychain implementation changed; review the signing backport.",
      );
    }
  }
  return result;
}

export async function patchElectronBuilderKeychain(projectRoot) {
  const root = path.join(projectRoot, "node_modules", "app-builder-lib");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Expected app-builder-lib ${expectedVersion}; review the signing backport before upgrading.`,
    );
  }
  const file = path.join(root, "out", "codeSign", "macCodeSign.js");
  const original = await readFile(file, "utf8");
  const patched = patchKeychainSource(original);
  if (original !== patched) await writeFile(file, patched);
  return { changed: original !== patched };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  patchElectronBuilderKeychain(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))
    .then(() => console.log("Electron builder keychain signing fix is current."))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
