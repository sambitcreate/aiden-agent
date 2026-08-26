import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { computePerformanceVoiceModelIdentity } from "./performance-voice-model.mjs";

test("voice benchmark identity binds the exact bounded model contents", async () => {
  const parent = await mkdtemp(path.join(process.cwd(), "build", "aiden-voice-model-test-"));
  const root = path.join(parent, "parakeet-v3");
  try {
    await mkdir(root);
    await writeFile(path.join(root, "encoder.int8.onnx"), "encoder-v1");
    await writeFile(path.join(root, "decoder.int8.onnx"), "decoder-v1");
    await writeFile(path.join(root, "joiner.int8.onnx"), "joiner-v1");
    await writeFile(path.join(root, "tokens.txt"), "tokens-v1");
    const first = await computePerformanceVoiceModelIdentity(root, "parakeet-v3");
    assert.equal(first.modelId, "parakeet-v3");
    assert.equal(first.files, 4);
    await writeFile(path.join(root, "encoder.int8.onnx"), "encoder-v2");
    const second = await computePerformanceVoiceModelIdentity(root, "parakeet-v3");
    assert.notEqual(second.sha256, first.sha256);
    await rm(path.join(root, "tokens.txt"));
    await symlink(path.join(root, "encoder.int8.onnx"), path.join(root, "tokens.txt"));
    await assert.rejects(() => computePerformanceVoiceModelIdentity(root, "parakeet-v3"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
