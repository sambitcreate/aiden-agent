import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertPreparedSubagentFileMutation,
  type SubagentFileInspection,
  canonicalSubagentFileRelativePath,
  MAX_SUBAGENT_FILE_CONTENT_BYTES,
  pinSubagentWorkspaceRoot,
  SubagentFileMutationPreparer,
  SubagentFilePreparationError,
} from "./subagent-file-mutation-core.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function workspace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-effect-core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function inspection(
  root: Awaited<ReturnType<typeof pinSubagentWorkspaceRoot>>,
  effectId: string,
  relativePath: string,
  currentContent?: string,
): SubagentFileInspection {
  return Object.freeze({
    version: 1,
    effectId,
    workspaceRoot: root,
    relativePath,
    expectedRevision:
      currentContent === undefined ? "absent" : sha256(currentContent),
    ...(currentContent === undefined ? {} : { currentContent }),
  });
}

test("pins an exact canonical decimal workspace identity", async (t) => {
  const root = await workspace(t);
  const pinned = await pinSubagentWorkspaceRoot(root);
  assert.equal(pinned.canonicalPath, await realpath(root));
  assert.match(pinned.device, /^(?:0|[1-9][0-9]*)$/u);
  assert.match(pinned.inode, /^(?:0|[1-9][0-9]*)$/u);
  assert.equal(Object.isFrozen(pinned), true);
});

test("write preparation binds the full postimage and exact effect identity", async (t) => {
  const root = await pinSubagentWorkspaceRoot(await workspace(t));
  const preparer = new SubagentFileMutationPreparer({ allocateEffectId: () => "effect-fixed" });
  const effectId = preparer.createEffectId();
  const effect = preparer.prepareWrite({
    inspection: inspection(root, effectId, "src/file.ts"),
    content: "export const value = 1;\n",
  });
  assert.equal(effect.effectId, "effect-fixed");
  assert.match(effect.effectDigest, /^[a-f0-9]{64}$/u);
  assert.equal(effect.relativePath, "src/file.ts");
  assert.equal(effect.postimage.sha256, sha256(effect.postimage.content));
  assert.equal(effect.postimage.bytes, Buffer.byteLength(effect.postimage.content));
  assert.equal(Object.isFrozen(effect), true);
  assert.equal(Object.isFrozen(effect.postimage), true);
  assert.doesNotThrow(() => assertPreparedSubagentFileMutation(effect));

  const tampered = {
    ...effect,
    postimage: { ...effect.postimage, content: "different\n" },
  };
  assert.throws(
    () => assertPreparedSubagentFileMutation(tampered),
    (error) =>
      error instanceof SubagentFilePreparationError && error.failure === "invalid_input",
  );
});

test("effect digest changes with the path, revision, content, and effect ID", async (t) => {
  const root = await pinSubagentWorkspaceRoot(await workspace(t));
  const prepare = (effectId: string, relativePath: string, content: string) =>
    new SubagentFileMutationPreparer().prepareWrite({
      inspection: inspection(root, effectId, relativePath),
      content,
    });
  const baseline = prepare("effect-one", "file.txt", "one\n");
  assert.equal(
    baseline.effectDigest,
    prepare("effect-one", "file.txt", "one\n").effectDigest,
  );
  assert.notEqual(baseline.effectDigest, prepare("effect-two", "file.txt", "one\n").effectDigest);
  assert.notEqual(baseline.effectDigest, prepare("effect-one", "other.txt", "one\n").effectDigest);
  assert.notEqual(baseline.effectDigest, prepare("effect-one", "file.txt", "two\n").effectDigest);
});

test("edit preparation requires the expected revision and one exact match", async (t) => {
  const root = await pinSubagentWorkspaceRoot(await workspace(t));
  const current = "before\ntarget\nafter\n";
  const preparer = new SubagentFileMutationPreparer({ allocateEffectId: () => "effect-edit" });
  const editInspection = inspection(
    root,
    preparer.createEffectId(),
    "file.txt",
    current,
  );
  const effect = preparer.prepareEdit({
    inspection: editInspection,
    oldString: "target",
    newString: "replacement",
  });
  assert.equal(effect.operation, "edit");
  assert.equal(effect.postimage.content, "before\nreplacement\nafter\n");

  for (const [index, input] of [
    { currentContent: "target target" },
    { currentContent: "aaa", oldString: "aa" },
    { currentContent: "missing" },
  ].entries()) {
    assert.throws(
      () =>
        preparer.prepareEdit({
          inspection: inspection(
            root,
            `effect-conflict-${index}`,
            "file.txt",
            input.currentContent,
          ),
          oldString: input.oldString ?? "target",
          newString: "replacement",
        }),
      (error) => error instanceof SubagentFilePreparationError && error.failure === "conflict",
    );
  }
});

test("relative paths and text remain strictly bounded and canonical", async (t) => {
  assert.equal(canonicalSubagentFileRelativePath("src/file.ts"), "src/file.ts");
  for (const candidate of ["", "/absolute", "a/../b", "a//b", "a\\b", "./file"]) {
    assert.throws(() => canonicalSubagentFileRelativePath(candidate));
  }
  const root = await pinSubagentWorkspaceRoot(await workspace(t));
  const preparer = new SubagentFileMutationPreparer({ allocateEffectId: () => "effect-limit" });
  assert.throws(
    () =>
      preparer.prepareWrite({
        inspection: inspection(root, preparer.createEffectId(), "large.txt"),
        content: "x".repeat(MAX_SUBAGENT_FILE_CONTENT_BYTES + 1),
      }),
    (error) =>
      error instanceof SubagentFilePreparationError && error.failure === "invalid_input",
  );
});
