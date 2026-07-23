/* global console, process */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");

export function automaticReleaseVersion(baseVersion, runNumber) {
  const match = /^(\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?$/u.exec(baseVersion);
  if (!match) throw new Error(`Invalid base release version: ${baseVersion}`);
  if (!/^[1-9]\d*$/u.test(String(runNumber))) {
    throw new Error(`GitHub run number must be a positive integer: ${runNumber}`);
  }
  return `${Number(match[1])}.${Number(match[2])}.${Number(runNumber)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  console.log(automaticReleaseVersion(packageJson.version, process.argv[2]));
}
