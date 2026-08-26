import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readBoundedJsonFile, verifyPerformanceReceipt } from "./performance-receipt.mjs";
import { writeBoundReceipt } from "./performance-package-identity.mjs";

const MODEL_IDS = new Set(["parakeet-v2", "parakeet-v3"]);
const MAX_MODEL_BYTES = 1024 * 1024 * 1024;
const REQUIRED_MODEL_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
];

export async function computePerformanceVoiceModelIdentity(modelRoot, modelId) {
  if (!MODEL_IDS.has(modelId)) throw new Error("Unknown performance voice model.");
  const resolved = path.resolve(modelRoot);
  if ((await realpath(resolved)) !== resolved) {
    throw new Error("The performance voice model must not use symlinks.");
  }
  const root = await lstat(resolved);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("The performance voice model must be a real directory.");
  }
  const digest = createHash("sha256");
  let bytes = 0;
  const observedFiles = [];
  for (const name of REQUIRED_MODEL_FILES) {
    const file = path.join(resolved, name);
    const handle = await open(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.size < 1n ||
        before.size > BigInt(MAX_MODEL_BYTES) ||
        before.size > BigInt(Number.MAX_SAFE_INTEGER) ||
        bytes + Number(before.size) > MAX_MODEL_BYTES
      ) {
        throw new Error("The performance voice model exceeds its byte budget.");
      }
      bytes += Number(before.size);
      observedFiles.push({ file, before });
      digest.update(name).update("\0").update(before.size.toString()).update("\0");
      const stream = handle.createReadStream({ autoClose: false, start: 0 });
      for await (const chunk of stream) digest.update(chunk);
      const after = await handle.stat({ bigint: true });
      const currentPath = await lstat(file, { bigint: true });
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        currentPath.dev !== after.dev ||
        currentPath.ino !== after.ino ||
        currentPath.size !== after.size ||
        currentPath.mtimeNs !== after.mtimeNs ||
        currentPath.ctimeNs !== after.ctimeNs ||
        (await realpath(file)) !== file
      ) {
        throw new Error("The performance voice model changed while it was hashed.");
      }
    } finally {
      await handle.close();
    }
  }
  const currentRoot = await lstat(resolved);
  if (
    currentRoot.dev !== root.dev ||
    currentRoot.ino !== root.ino ||
    !currentRoot.isDirectory() ||
    currentRoot.isSymbolicLink() ||
    (await realpath(resolved)) !== resolved
  ) {
    throw new Error("The performance voice model root changed while it was hashed.");
  }
  for (const { file, before } of observedFiles) {
    const current = await lstat(file, { bigint: true });
    if (
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size ||
      current.mtimeNs !== before.mtimeNs ||
      current.ctimeNs !== before.ctimeNs ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      (await realpath(file)) !== file
    ) {
      throw new Error("The performance voice model changed while it was hashed.");
    }
  }
  return {
    schemaVersion: 1,
    catalogVersion: 1,
    modelId,
    files: REQUIRED_MODEL_FILES.length,
    bytes,
    sha256: digest.digest("hex"),
  };
}

async function main() {
  const value = (flag) => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const receiptPath = value("--receipt");
  const fixtureRoot = value("--fixture-root");
  const modelId = value("--model-id");
  if (!receiptPath || !fixtureRoot || !modelId) {
    throw new Error(
      "Usage: performance-voice-model.mjs --receipt <receipt.json> --fixture-root <path> --model-id <parakeet-v2|parakeet-v3>",
    );
  }
  const receipt = (await readBoundedJsonFile(receiptPath, 512 * 1024)).value;
  verifyPerformanceReceipt(receipt);
  if (receipt.scenario !== "voice-long") {
    throw new Error("Voice model binding is valid only for the voice-long scenario.");
  }
  const modelRoot = path.join(
    path.dirname(path.resolve(fixtureRoot)),
    "runtime",
    "profile",
    "parakeet-models",
    modelId,
  );
  const voiceModelIdentity = await computePerformanceVoiceModelIdentity(modelRoot, modelId);
  const bound = { ...receipt, voiceModelIdentity };
  verifyPerformanceReceipt(bound);
  await writeBoundReceipt(receiptPath, bound);
  process.stdout.write("Performance receipt bound to the exact installed voice model.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
