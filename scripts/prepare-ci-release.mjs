/* global console, process */

import { appendFile, readFile } from "node:fs/promises";
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

export async function writeReleaseSelectionGithubOutput(selection, outputPath) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new Error("GITHUB_OUTPUT must be set when using --github-output");
  }
  await appendFile(
    outputPath,
    `version=${selection.version}\ntag=${selection.tag}\npublish=${selection.publish}\n`,
    "utf8",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const baseTagExistsArgument = process.argv[2];
  if (baseTagExistsArgument !== "true" && baseTagExistsArgument !== "false") {
    throw new Error("Declared tag existence must be provided as true or false");
  }
  const flags = new Set(process.argv.slice(3));
  for (const flag of flags) {
    if (flag !== "--github-output" && flag !== "--announce-existing") {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }
  const selection = mainPushReleaseSelection(
    packageJson.version,
    baseTagExistsArgument === "true",
  );
  if (flags.has("--github-output")) {
    await writeReleaseSelectionGithubOutput(selection, process.env.GITHUB_OUTPUT);
    if (flags.has("--announce-existing") && !selection.publish) {
      console.log(`${selection.tag} already exists; skipping release without changing its version.`);
    }
  } else {
    console.log(JSON.stringify(selection));
  }
}
