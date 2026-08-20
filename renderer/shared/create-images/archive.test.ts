import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_IMAGES_ARCHIVE_MAX_ASSET_BYTES,
  CREATE_IMAGES_ARCHIVE_MAX_MANIFEST_BYTES,
  CREATE_IMAGES_ARCHIVE_FORMAT,
  CREATE_IMAGES_ARCHIVE_MAX_ENTRIES,
  CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
  CREATE_IMAGES_ARCHIVE_VERSION,
  CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH,
  parseCreateImagesArchiveManifestBytes,
  parseCreateImagesArchiveManifest,
  validateCreateImagesArchiveBootstrap,
  validateCreateImagesArchiveExtractedEntries,
  validateCreateImagesArchiveInventory,
  validateCreateImagesArchiveWorkflowAssets,
  type CreateImagesArchiveManifestV1,
} from "./archive.js";
import { createStarterWorkflow } from "./schema.js";

const digest = "a".repeat(64);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
const manifest: CreateImagesArchiveManifestV1 = {
  format: CREATE_IMAGES_ARCHIVE_FORMAT,
  version: CREATE_IMAGES_ARCHIVE_VERSION,
  exportedAt: "2026-08-11T12:00:00.000Z",
  workflow: { path: CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH, sha256: "b".repeat(64), byteLength: 240 },
  assets: [
    {
      assetId: digest,
      sha256: digest,
      path: `assets/${digest}.png`,
      mediaType: "image/png",
      byteLength: 1_024,
      width: 32,
      height: 32,
    },
  ],
};

test("native Create Images archive manifest is strict and content addressed", () => {
  assert.deepEqual(parseCreateImagesArchiveManifest(manifest), { success: true, value: manifest });
  assert.equal(parseCreateImagesArchiveManifest({ ...manifest, future: true }).success, false);
  assert.equal(
    parseCreateImagesArchiveManifest({
      ...manifest,
      assets: [{ ...manifest.assets[0], assetId: "c".repeat(64) }],
    }).success,
    false,
  );
});

test("native archive accepts the asset-store byte ceiling and rejects one byte beyond it", () => {
  const boundaryAsset = {
    ...manifest.assets[0]!,
    byteLength: CREATE_IMAGES_ARCHIVE_MAX_ASSET_BYTES,
  };
  assert.equal(
    parseCreateImagesArchiveManifest({ ...manifest, assets: [boundaryAsset] }).success,
    true,
  );
  assert.equal(
    parseCreateImagesArchiveManifest({
      ...manifest,
      assets: [{ ...boundaryAsset, byteLength: CREATE_IMAGES_ARCHIVE_MAX_ASSET_BYTES + 1 }],
    }).success,
    false,
  );
});

test("archive bootstrap validates the sole manifest before any member is read", () => {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestEntry = {
    path: CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
    kind: "file" as const,
    encrypted: false,
    compressionMethod: 0,
    compressedBytes: manifestBytes.byteLength,
    uncompressedBytes: manifestBytes.byteLength,
    crc32: crc32(manifestBytes),
  };
  assert.deepEqual(validateCreateImagesArchiveBootstrap([manifestEntry]), []);
  assert.deepEqual(parseCreateImagesArchiveManifestBytes(manifestBytes, manifestEntry), {
    success: true,
    value: manifest,
  });

  const hostile = validateCreateImagesArchiveBootstrap([
    {
      ...manifestEntry,
      kind: "symlink",
      encrypted: true,
      compressionMethod: 99,
      compressedBytes: 1,
      uncompressedBytes: CREATE_IMAGES_ARCHIVE_MAX_MANIFEST_BYTES + 1,
    },
    { ...manifestEntry },
    {
      ...manifestEntry,
      compressedBytes: 1,
      uncompressedBytes: CREATE_IMAGES_ARCHIVE_MAX_MANIFEST_BYTES,
    },
  ]);
  for (const code of [
    "unsupported_entry",
    "encrypted_entry",
    "compression_method",
    "size_limit",
    "duplicate_entry",
    "compression_limit",
  ]) {
    assert.ok(
      hostile.some((issue) => issue.code === code),
      `missing ${code}`,
    );
  }
  assert.ok(
    validateCreateImagesArchiveBootstrap([
      { ...manifestEntry, path: CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH },
    ]).some((issue) => issue.code === "missing_entry"),
  );
  assert.equal(
    parseCreateImagesArchiveManifestBytes(manifestBytes, {
      ...manifestEntry,
      crc32: manifestEntry.crc32 ^ 1,
    }).success,
    false,
  );
});

test("archive inventory blocks zip-slip, links, duplicates, extras, and bombs", () => {
  const validEntries = [
    {
      path: CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
      kind: "file" as const,
      encrypted: false,
      compressionMethod: 8,
      compressedBytes: 100,
      uncompressedBytes: 200,
      crc32: 1,
    },
    {
      path: CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH,
      kind: "file" as const,
      encrypted: false,
      compressionMethod: 8,
      compressedBytes: 120,
      uncompressedBytes: 240,
      crc32: 2,
    },
    {
      path: manifest.assets[0]!.path,
      kind: "file" as const,
      encrypted: false,
      compressionMethod: 0,
      compressedBytes: 1_024,
      uncompressedBytes: 1_024,
      crc32: 3,
    },
  ];
  assert.deepEqual(validateCreateImagesArchiveInventory(manifest, validEntries), []);

  const issues = validateCreateImagesArchiveInventory(manifest, [
    ...validEntries,
    {
      path: "../escape",
      kind: "file",
      encrypted: false,
      compressionMethod: 8,
      compressedBytes: 1,
      uncompressedBytes: 2,
      crc32: 4,
    },
    {
      path: "assets/link",
      kind: "symlink",
      encrypted: false,
      compressionMethod: 8,
      compressedBytes: 1,
      uncompressedBytes: 2,
      crc32: 5,
    },
    { ...validEntries[0]!, compressedBytes: 0, uncompressedBytes: 20_000 },
    {
      path: "unexpected.json",
      kind: "file",
      encrypted: true,
      compressionMethod: 99,
      compressedBytes: 1,
      uncompressedBytes: 2,
      crc32: 6,
    },
  ]);
  assert.ok(issues.some((issue) => issue.code === "unsafe_path"));
  assert.ok(issues.some((issue) => issue.code === "unsupported_entry"));
  assert.ok(issues.some((issue) => issue.code === "duplicate_entry"));
  assert.ok(issues.some((issue) => issue.code === "unexpected_entry"));
  assert.ok(issues.some((issue) => issue.code === "encrypted_entry"));
  assert.ok(issues.some((issue) => issue.code === "compression_method"));
});

test("archive validation bounds central-directory entries before per-entry work", () => {
  const oversized = Array.from({ length: CREATE_IMAGES_ARCHIVE_MAX_ENTRIES + 1 }, (_, index) => ({
    path: `unexpected/${index}`,
    kind: "file" as const,
    encrypted: false,
    compressionMethod: 8,
    compressedBytes: 1,
    uncompressedBytes: 1,
    crc32: 0,
  }));
  assert.deepEqual(validateCreateImagesArchiveInventory(manifest, oversized), [
    {
      path: "entries",
      code: "entry_count",
      message: `Archive contains more than ${CREATE_IMAGES_ARCHIVE_MAX_ENTRIES} entries.`,
    },
  ]);
});

test("quarantine measurements must match declared sizes, CRCs, and content digests", () => {
  const inventory = [
    {
      path: CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
      kind: "file" as const,
      encrypted: false,
      compressionMethod: 8,
      compressedBytes: 100,
      uncompressedBytes: 200,
      crc32: 1,
    },
    {
      path: CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH,
      kind: "file" as const,
      encrypted: false,
      compressionMethod: 8,
      compressedBytes: 120,
      uncompressedBytes: 240,
      crc32: 2,
    },
    {
      path: manifest.assets[0]!.path,
      kind: "file" as const,
      encrypted: false,
      compressionMethod: 0,
      compressedBytes: 1_024,
      uncompressedBytes: 1_024,
      crc32: 3,
    },
  ];
  const extracted = [
    {
      path: CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
      byteLength: 200,
      crc32: 1,
      sha256: "c".repeat(64),
    },
    {
      path: CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH,
      byteLength: 240,
      crc32: 2,
      sha256: manifest.workflow.sha256,
    },
    {
      path: manifest.assets[0]!.path,
      byteLength: 1_024,
      crc32: 3,
      sha256: manifest.assets[0]!.sha256,
    },
  ];
  assert.deepEqual(validateCreateImagesArchiveExtractedEntries(manifest, inventory, extracted), []);
  const tampered = extracted.map((entry) => ({ ...entry }));
  tampered[1] = { ...tampered[1]!, byteLength: 239, crc32: 9, sha256: "d".repeat(64) };
  const issues = validateCreateImagesArchiveExtractedEntries(manifest, inventory, tampered);
  assert.ok(issues.some((issue) => issue.code === "actual_size_mismatch"));
  assert.ok(issues.some((issue) => issue.code === "checksum_mismatch"));
  assert.ok(issues.some((issue) => issue.code === "digest_mismatch"));
});

test("native manifest byte lengths must match inventory and extracted bytes", () => {
  const inventory = [
    {
      path: CREATE_IMAGES_ARCHIVE_MANIFEST_PATH,
      kind: "file" as const,
      encrypted: false,
      compressionMethod: 8,
      compressedBytes: 100,
      uncompressedBytes: 200,
      crc32: 1,
    },
    {
      path: CREATE_IMAGES_ARCHIVE_WORKFLOW_PATH,
      kind: "file" as const,
      encrypted: false,
      compressionMethod: 8,
      compressedBytes: 120,
      uncompressedBytes: manifest.workflow.byteLength + 1,
      crc32: 2,
    },
    {
      path: manifest.assets[0]!.path,
      kind: "file" as const,
      encrypted: false,
      compressionMethod: 0,
      compressedBytes: manifest.assets[0]!.byteLength - 1,
      uncompressedBytes: manifest.assets[0]!.byteLength - 1,
      crc32: 3,
    },
  ];
  const inventoryIssues = validateCreateImagesArchiveInventory(manifest, inventory);
  assert.equal(inventoryIssues.filter((issue) => issue.code === "actual_size_mismatch").length, 2);

  const extracted = inventory.map((entry) => ({
    path: entry.path,
    byteLength: entry.uncompressedBytes,
    crc32: entry.crc32,
    sha256:
      entry.path === manifest.workflow.path
        ? manifest.workflow.sha256
        : entry.path === manifest.assets[0]!.path
          ? manifest.assets[0]!.sha256
          : "c".repeat(64),
  }));
  const extractedIssues = validateCreateImagesArchiveExtractedEntries(
    manifest,
    inventory,
    extracted,
  );
  assert.equal(extractedIssues.filter((issue) => issue.code === "actual_size_mismatch").length, 2);
});

test("native manifest accepts the full asset quota plus workflow envelope and rejects one extra asset", () => {
  const asset = manifest.assets[0]!;
  const atAssetQuota = {
    ...manifest,
    assets: Array.from({ length: 160 }, (_, index) => {
      const assetId = index.toString(16).padStart(64, "0");
      return {
        ...asset,
        assetId,
        sha256: assetId,
        path: `assets/${assetId}.png`,
        byteLength: CREATE_IMAGES_ARCHIVE_MAX_ASSET_BYTES,
      };
    }),
  };
  assert.equal(parseCreateImagesArchiveManifest(atAssetQuota).success, true);

  const extraAssetId = "f".repeat(64);
  assert.equal(
    parseCreateImagesArchiveManifest({
      ...atAssetQuota,
      assets: [
        ...atAssetQuota.assets,
        {
          ...asset,
          assetId: extraAssetId,
          sha256: extraAssetId,
          path: `assets/${extraAssetId}.png`,
          byteLength: 1,
        },
      ],
    }).success,
    false,
  );
});

test("workflow, native manifest, and deeply validated asset descriptors must agree", () => {
  const workflow = createStarterWorkflow({
    workflowId: "archive-workflow",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-1",
    outputEdgeId: "edge-2",
    now: "2026-08-11T12:00:00.000Z",
  });
  workflow.nodes.push({
    id: "image-1",
    type: "image-input",
    position: { x: 0, y: 0 },
    data: { assetId: digest },
  });
  workflow.assetRefs = [digest];
  const validated = [
    {
      assetId: digest,
      mediaType: "image/png" as const,
      byteLength: 1_024,
      width: 32,
      height: 32,
    },
  ];
  assert.deepEqual(validateCreateImagesArchiveWorkflowAssets(manifest, workflow, validated), []);
  assert.ok(
    validateCreateImagesArchiveWorkflowAssets(
      manifest,
      { ...workflow, nodes: workflow.nodes.filter((node) => node.id !== "image-1"), assetRefs: [] },
      [{ ...validated[0]!, width: 31, mediaType: "image/jpeg" }],
    ).some((issue) => issue.code === "asset_contract_mismatch"),
  );
});
