/* global console, fetch, process */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(projectRoot, "resources", "model-capabilities.json");
const temporaryDestination = destination + ".tmp";

async function main() {
  const response = await fetch("https://models.dev/api.json", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Model catalog request failed with " + response.status + " " + response.statusText + ".");
  }

  const payload = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Model catalog returned an unexpected payload.");
  }

  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporaryDestination, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(temporaryDestination, destination);
  console.log(
    "Updated release model-capability snapshot at " +
      destination +
      " (" +
      Object.keys(payload).length +
      " providers).",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
