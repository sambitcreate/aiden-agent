/* global console, process */

// Backports earendil-works/pi#11142 (keep the prompt cache across tool changes on
// OpenAI Responses, Codex and Azure) onto the pinned pi-ai 1.3.0 dist. The hunks
// live in patches/pi-ai-1.3.0-responses-tool-cache.patch. Remove this script, the
// patch and its callers once Pi ships a release that contains #11142.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PI_AI_VERSION = "1.3.0";
const PI_PACKAGE_PATH = path.join("node_modules", "@earendil-works", "pi-ai");
const PATCH_PATH = path.join("patches", "pi-ai-1.3.0-responses-tool-cache.patch");

// Hunk bodies are read by the line counts in their @@ header, so content lines
// that look like headers ("--- ", "+++ ") or blank lines cannot end a hunk early.
export function parseUnifiedPatch(text) {
  const lines = text.split("\n");
  const files = [];
  let file;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("+++ ")) {
      file = { path: line.slice(4).replace(/^b\//u, ""), hunks: [] };
      files.push(file);
      continue;
    }
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u.exec(line);
    if (!header) continue;
    if (!file) throw new Error("Patch hunk appears before a file header.");
    let beforeLeft = Number(header[1] ?? 1);
    let afterLeft = Number(header[2] ?? 1);
    const before = [];
    const after = [];
    while (beforeLeft > 0 || afterLeft > 0) {
      index += 1;
      if (index >= lines.length) throw new Error(`Patch hunk for ${file.path} is truncated.`);
      const body = lines[index];
      if (body.startsWith("\\")) continue;
      const content = body.slice(1);
      if (body[0] === " ") {
        before.push(content);
        after.push(content);
        beforeLeft -= 1;
        afterLeft -= 1;
      } else if (body[0] === "-") {
        before.push(content);
        beforeLeft -= 1;
      } else if (body[0] === "+") {
        after.push(content);
        afterLeft -= 1;
      } else {
        throw new Error(`Unexpected patch line in ${file.path}: ${body}`);
      }
      if (beforeLeft < 0 || afterLeft < 0) throw new Error(`Patch hunk for ${file.path} exceeds its header counts.`);
    }
    file.hunks.push({ before: before.join("\n"), after: after.join("\n") });
  }
  return files;
}

function count(source, text) {
  return source.split(text).length - 1;
}

function applyHunk(source, { before, after }, label) {
  const beforeCount = count(source, before);
  const afterCount = count(source, after);
  if (beforeCount === 1 && afterCount === 0) return source.replace(before, () => after);
  if (beforeCount === 0 && afterCount === 1) return source;
  throw new Error(`pi-ai ${label} changed unexpectedly; review the #11142 backport.`);
}

export async function patchPiAiToolCache(projectRoot, packageRoot = path.join(projectRoot, PI_PACKAGE_PATH)) {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (packageJson.version !== PI_AI_VERSION) {
    throw new Error(
      `Expected @earendil-works/pi-ai ${PI_AI_VERSION}, received ${String(packageJson.version)}. ` +
        "Drop the #11142 backport once the new Pi release contains it, or review it before upgrading Pi.",
    );
  }

  const patch = parseUnifiedPatch(await readFile(path.join(projectRoot, PATCH_PATH), "utf8"));
  // Compute every file first so a drifted hunk leaves the package untouched.
  const writes = [];
  for (const file of patch) {
    const filePath = path.join(packageRoot, file.path);
    const original = await readFile(filePath, "utf8");
    let next = original;
    for (const [index, hunk] of file.hunks.entries()) {
      next = applyHunk(next, hunk, `${file.path} hunk ${index + 1}`);
    }
    if (next !== original) writes.push([filePath, next]);
  }
  for (const [filePath, contents] of writes) await writeFile(filePath, contents);
  return { changed: writes.length > 0 };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  patchPiAiToolCache(projectRoot)
    .then(({ changed }) => {
      console.log(changed ? "Applied the Pi #11142 tool-cache backport." : "Pi #11142 tool-cache backport is current.");
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
