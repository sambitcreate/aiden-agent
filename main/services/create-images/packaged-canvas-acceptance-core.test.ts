import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  CREATE_IMAGES_PACKAGED_ACCEPTANCE_CONTROL_FILENAME,
  CREATE_IMAGES_PACKAGED_ACCEPTANCE_ENV,
  CREATE_IMAGES_PACKAGED_ACCEPTANCE_ROOT_PREFIX,
  CREATE_IMAGES_PACKAGED_ACCEPTANCE_SWITCH,
  countCreateImagesProductFileMutations,
  createImagesPhaseTwoProductFileEvidence,
  isCreateImagesDurableWorkflowPublication,
  loadCreateImagesPackagedAcceptanceSession,
  snapshotCreateImagesProductFiles,
} from "./packaged-canvas-acceptance-core.js";
import { createStarterWorkflow } from "../../../renderer/shared/create-images/schema.js";

async function fixture(): Promise<{ root: string; controlPath: string; nonce: string }> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), CREATE_IMAGES_PACKAGED_ACCEPTANCE_ROOT_PREFIX),
  );
  await fs.chmod(root, 0o700);
  const controlPath = path.join(root, CREATE_IMAGES_PACKAGED_ACCEPTANCE_CONTROL_FILENAME);
  const nonce = randomBytes(32).toString("base64url");
  await fs.writeFile(controlPath, JSON.stringify({ version: 1, nonce }), {
    mode: 0o600,
    flag: "wx",
  });
  await fs.chmod(controlPath, 0o600);
  return { root, controlPath, nonce };
}

test("durable publication accepts serialized autosaves without hard-coding one revision", () => {
  const workflow = createStarterWorkflow({
    workflowId: "workflow-1",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "prompt-edge",
    outputEdgeId: "output-edge",
    now: "2026-08-11T12:00:00.000Z",
  });
  const prompt = workflow.nodes.find((node) => node.type === "prompt");
  assert.ok(prompt?.type === "prompt");
  prompt.data.text = "Durable edit";
  workflow.revision = 3;

  assert.equal(isCreateImagesDurableWorkflowPublication(workflow, 1, "Durable edit"), true);
  assert.equal(isCreateImagesDurableWorkflowPublication(workflow, 3, "Durable edit"), false);
  assert.equal(isCreateImagesDurableWorkflowPublication(workflow, 1, "Other edit"), false);
});

test("packaged canvas acceptance is one-shot, private, and opt-in", async (context) => {
  const value = await fixture();
  context.after(() => fs.rm(value.root, { recursive: true, force: true }));
  assert.equal(
    await loadCreateImagesPackagedAcceptanceSession({
      isPackaged: true,
      argv: [`${CREATE_IMAGES_PACKAGED_ACCEPTANCE_SWITCH}=${value.controlPath}`],
      environment: {},
    }),
    undefined,
  );
  const session = await loadCreateImagesPackagedAcceptanceSession({
    isPackaged: true,
    argv: [`${CREATE_IMAGES_PACKAGED_ACCEPTANCE_SWITCH}=${value.controlPath}`],
    environment: { [CREATE_IMAGES_PACKAGED_ACCEPTANCE_ENV]: "1" },
  });
  assert.equal(session?.control.nonce, value.nonce);
  assert.equal(session?.root, await fs.realpath(value.root));
});

test("Phase 2 product evidence is exact, content-addressed, and rejects recovery debris", () => {
  const assetId = "a".repeat(64);
  const workflowId = "packaged-phase-two";
  const workflowDigest = "b".repeat(64);
  const base = "user-data/create-images";
  const firstPredecessorDigest = "1".repeat(64);
  const secondPredecessorDigest = "2".repeat(64);
  const thirdPredecessorDigest = "3".repeat(64);
  const files = [
    {
      path: `${base}/.asset-index.json.${firstPredecessorDigest}.11111111-1111-4111-8111-111111111111.previous`,
      bytes: 440,
      digest: firstPredecessorDigest,
    },
    {
      path: `${base}/.asset-index.json.${secondPredecessorDigest}.22222222-2222-4222-8222-222222222222.previous`,
      bytes: 520,
      digest: secondPredecessorDigest,
    },
    {
      path: `${base}/.asset-index.json.${thirdPredecessorDigest}.33333333-3333-4333-8333-333333333333.previous`,
      bytes: 560,
      digest: thirdPredecessorDigest,
    },
    { path: `${base}/asset-index.json`, bytes: 600, digest: "c".repeat(64) },
    {
      path: `${base}/assets/sha256/aa/${assetId}.png`,
      bytes: 4096,
      digest: assetId,
    },
    { path: `${base}/index.json`, bytes: 240, digest: "d".repeat(64) },
    { path: `${base}/run-index.json`, bytes: 72, digest: "9".repeat(64) },
    { path: `${base}/thumbnails/${assetId}/512.png`, bytes: 1200, digest: "e".repeat(64) },
    {
      path: `${base}/workflows/${workflowId}/workflow.json`,
      bytes: 900,
      digest: workflowDigest,
    },
    {
      path: `${base}/workflows/${workflowId}/workflow.last-known-good.json`,
      bytes: 900,
      digest: workflowDigest,
    },
  ];
  assert.deepEqual(
    createImagesPhaseTwoProductFileEvidence([], files, {
      workflowId,
      assetId,
      assetExtension: "png",
    }),
    [...files].sort((left, right) => left.path.localeCompare(right.path)),
  );
  assert.throws(
    () =>
      createImagesPhaseTwoProductFileEvidence(
        [],
        [
          ...files,
          {
            path: `${base}/workflows/${workflowId}/workflow.autosave.json`,
            bytes: 20,
            digest: "f".repeat(64),
          },
        ],
        { workflowId, assetId, assetExtension: "png" },
      ),
    /unexpected (?:durable files|file mutations)/u,
  );
  assert.throws(
    () =>
      createImagesPhaseTwoProductFileEvidence(
        [],
        files.map((entry) =>
          entry.path.endsWith("workflow.last-known-good.json")
            ? { ...entry, digest: "f".repeat(64) }
            : entry,
        ),
        { workflowId, assetId, assetExtension: "png" },
      ),
    /content-addressed relationships/u,
  );
});

test("product-file snapshots detect durable writes but ignore Chromium-only files", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-image-snapshot-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, "portable");
  const userDataDir = path.join(root, "user-data");
  await fs.mkdir(path.join(userDataDir, "Cache"), { recursive: true });
  await fs.mkdir(path.join(userDataDir, "logs"), { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "config.json"), "{}", "utf8");
  await fs.writeFile(path.join(userDataDir, "config.json"), '{"user":true}', "utf8");
  await fs.writeFile(path.join(userDataDir, "usage.json"), '{"usage":[]}', "utf8");
  const before = await snapshotCreateImagesProductFiles({ configDir, userDataDir });
  assert.deepEqual(
    before.map((entry) => entry.path),
    ["config/config.json", "user-data/config.json", "user-data/usage.json"],
  );
  await fs.writeFile(path.join(userDataDir, "Cache", "entry"), "ignored", "utf8");
  await fs.writeFile(path.join(userDataDir, "logs", "aiden.log"), "ignored", "utf8");
  assert.equal(
    countCreateImagesProductFileMutations(
      before,
      await snapshotCreateImagesProductFiles({ configDir, userDataDir }),
    ),
    0,
  );
  await fs.writeFile(path.join(configDir, "config.json"), '{"changed":true}', "utf8");
  assert.equal(
    countCreateImagesProductFileMutations(
      before,
      await snapshotCreateImagesProductFiles({ configDir, userDataDir }),
    ),
    1,
  );
  await fs.writeFile(path.join(userDataDir, "provider-keys.json"), '{"secret":"changed"}', "utf8");
  assert.equal(
    countCreateImagesProductFileMutations(
      before,
      await snapshotCreateImagesProductFiles({ configDir, userDataDir }),
    ),
    2,
  );
});
