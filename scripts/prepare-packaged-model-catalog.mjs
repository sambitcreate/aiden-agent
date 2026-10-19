/* global Buffer, process */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_MODELS_DEV_SNAPSHOT_BYTES,
  validateModelsDevSnapshot,
} from "./model-snapshot-core.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");

export const SOURCE_MODEL_CATALOG = path.join(
  repositoryRoot,
  "resources",
  "model-capabilities.json",
);
export const PACKAGED_MODEL_CATALOG = path.join(
  repositoryRoot,
  "build",
  "package-resources",
  "model-capabilities.json",
);

export function compactModelCatalog(source) {
  if (Buffer.byteLength(source, "utf8") > MAX_MODELS_DEV_SNAPSHOT_BYTES) {
    throw new Error("Source models.dev capability snapshot exceeds the packaged byte limit.");
  }
  const snapshot = validateModelsDevSnapshot(JSON.parse(source));
  const compact = JSON.stringify(snapshot);
  if (Buffer.byteLength(compact, "utf8") > MAX_MODELS_DEV_SNAPSHOT_BYTES) {
    throw new Error("Packaged models.dev capability snapshot exceeds the packaged byte limit.");
  }
  return compact;
}

export async function preparePackagedModelCatalog({
  source = SOURCE_MODEL_CATALOG,
  destination = PACKAGED_MODEL_CATALOG,
} = {}) {
  const sourceInfo = await lstat(source);
  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink() ||
    sourceInfo.size > MAX_MODELS_DEV_SNAPSHOT_BYTES
  ) {
    throw new Error("Source models.dev capability snapshot must be a bounded regular file.");
  }
  const compact = compactModelCatalog(await readFile(source, "utf8"));
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(temporary, compact, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    sourceBytes: sourceInfo.size,
    packagedBytes: Buffer.byteLength(compact, "utf8"),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const sizes = await preparePackagedModelCatalog();
  process.stdout.write(
    `Prepared offline packaged model catalog: ${sizes.sourceBytes} -> ${sizes.packagedBytes} bytes.\n`,
  );
}
