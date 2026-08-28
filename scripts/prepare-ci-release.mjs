/* global console, process */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");

export function mainPushReleaseSelection(baseVersion, baseTagExists) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(baseVersion)) {
    throw new Error(`Invalid declared release version: ${baseVersion}`);
  }
  if (typeof baseTagExists !== "boolean") {
    throw new Error("Declared tag existence must be a boolean");
  }
  return Object.freeze({
    version: baseVersion,
    tag: `v${baseVersion}`,
    publish: !baseTagExists,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const baseTagExistsArgument = process.argv[2];
  if (baseTagExistsArgument !== "true" && baseTagExistsArgument !== "false") {
    throw new Error("Declared tag existence must be provided as true or false");
  }
  console.log(
    JSON.stringify(mainPushReleaseSelection(
      packageJson.version,
      baseTagExistsArgument === "true",
    )),
  );
}
