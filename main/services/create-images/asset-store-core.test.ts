import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AssetStoreError,
  ContentAddressedAssetStore,
  DEFAULT_ASSET_STORE_LIMITS,
  type AssetMetadataDto,
  type AssetDeepValidator,
  type AssetReferenceAuthority,
  type AssetReferenceSnapshot,
  type AssetStoreLimits,
  type AssetThumbnailGenerator,
} from "./asset-store-core.js";
import { AssetDeliveryGrantRegistry } from "./asset-delivery-core.js";
import { AssetImageValidationError, validateImageBytes } from "./asset-image-validation-core.js";
import { ByteBoundedLru } from "./asset-thumbnail-cache-core.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";

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

function u32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const checksumInput = new Uint8Array(typeBytes.byteLength + data.byteLength);
  checksumInput.set(typeBytes);
  checksumInput.set(data, typeBytes.byteLength);
  const result = new Uint8Array(12 + data.byteLength);
  result.set(u32(data.byteLength));
  result.set(checksumInput, 4);
  result.set(u32(crc32(checksumInput)), result.byteLength - 4);
  return result;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function makePng(width = 1, height = 1, variant = 0): Uint8Array {
  const header = new Uint8Array(13);
  header.set(u32(width));
  header.set(u32(height), 4);
  header[8] = 8;
  header[9] = 6;
  return concat(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Uint8Array.from([0x78, 0x9c, variant & 0xff, 0, 0, 0, 0, 1])),
    pngChunk("IEND", new Uint8Array()),
  );
}

function makeJpeg(width = 1, height = 1): Uint8Array {
  const frame = Uint8Array.from([
    0xff,
    0xc0,
    0,
    11,
    8,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    1,
    1,
    0x11,
    0,
  ]);
  const scan = Uint8Array.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 1, 2, 3, 0xff, 0xd9]);
  return concat(Uint8Array.from([0xff, 0xd8]), frame, scan);
}

async function* chunks(
  bytes: Uint8Array,
  chunkSize = bytes.byteLength,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
  }
}

class FakeReferenceAuthority implements AssetReferenceAuthority {
  snapshot: AssetReferenceSnapshot = {
    epoch: "epoch-0",
    completeKinds: ["workflow", "run", "export"],
    records: [],
  };

  async withSnapshot<Result>(
    callback: (snapshot: AssetReferenceSnapshot) => Promise<Result>,
  ): Promise<Result> {
    return callback(structuredClone(this.snapshot));
  }
}

const acceptingDecoder: AssetDeepValidator = {
  async validate({ descriptor }) {
    return { width: descriptor.width, height: descriptor.height };
  },
};

function limits(overrides: Partial<AssetStoreLimits> = {}): AssetStoreLimits {
  return {
    ...structuredClone(DEFAULT_ASSET_STORE_LIMITS),
    ...overrides,
    thumbnailSizes: overrides.thumbnailSizes ?? [...DEFAULT_ASSET_STORE_LIMITS.thumbnailSizes],
  };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-assets-test-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function createStore(
  root: string,
  authority = new FakeReferenceAuthority(),
  options: {
    limits?: AssetStoreLimits;
    now?: () => number;
    deepValidator?: AssetDeepValidator;
    thumbnailGenerator?: AssetThumbnailGenerator;
    onAssetPublished?: (asset: AssetMetadataDto) => Promise<void> | void;
  } = {},
): ContentAddressedAssetStore {
  return new ContentAddressedAssetStore(root, authority, {
    deepValidator: options.deepValidator ?? acceptingDecoder,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.thumbnailGenerator ? { thumbnailGenerator: options.thumbnailGenerator } : {}),
    ...(options.onAssetPublished ? { onAssetPublished: options.onAssetPublished } : {}),
  });
}

test("validates static PNG/JPEG structure, declarations, truncation, and dimension bombs", () => {
  const imageLimits = { maxWidth: 10_000, maxHeight: 10_000, maxPixels: 1_000_000 };
  assert.deepEqual(validateImageBytes(makePng(4, 5), "image/png", "safe.png", imageLimits), {
    mediaType: "image/png",
    extension: "png",
    width: 4,
    height: 5,
    pixels: 20,
  });
  assert.deepEqual(validateImageBytes(makeJpeg(7, 9), "image/jpeg", "safe.jpeg", imageLimits), {
    mediaType: "image/jpeg",
    extension: "jpg",
    width: 7,
    height: 9,
    pixels: 63,
  });
  const jpeg = makeJpeg(7, 9);
  const exif = Uint8Array.from([0xff, 0xe1, 0, 8, 69, 120, 105, 102, 0, 0]);
  assert.equal(
    validateImageBytes(
      concat(jpeg.subarray(0, 2), exif, jpeg.subarray(2)),
      "image/jpeg",
      "exif.jpg",
      imageLimits,
    ).width,
    7,
  );
  assert.throws(
    () => validateImageBytes(makePng().subarray(0, 40), "image/png", "x.png", imageLimits),
    (error: unknown) =>
      error instanceof AssetImageValidationError && error.code === "truncated_image",
  );
  assert.throws(
    () => validateImageBytes(makeJpeg().subarray(0, -1), "image/jpeg", "x.jpg", imageLimits),
    (error: unknown) =>
      error instanceof AssetImageValidationError && error.code === "truncated_image",
  );
  assert.throws(
    () => validateImageBytes(makePng(), "image/jpeg", "x.png", imageLimits),
    (error: unknown) =>
      error instanceof AssetImageValidationError && error.code === "mime_mismatch",
  );
  assert.throws(
    () => validateImageBytes(makePng(), "image/png", "x.jpg", imageLimits),
    (error: unknown) =>
      error instanceof AssetImageValidationError && error.code === "extension_mismatch",
  );
  assert.throws(
    () =>
      validateImageBytes(
        new TextEncoder().encode("<svg><script>alert(1)</script></svg>"),
        "image/svg+xml",
        "x.svg",
        imageLimits,
      ),
    (error: unknown) =>
      error instanceof AssetImageValidationError && error.code === "unsupported_format",
  );
  assert.throws(
    () => validateImageBytes(makePng(2_000, 2_000), "image/png", "x.png", imageLimits),
    (error: unknown) =>
      error instanceof AssetImageValidationError && error.code === "image_dimensions_exceeded",
  );
});

test("byte-bounded LRU evicts exactly and never retains an oversized value", () => {
  const cache = new ByteBoundedLru<{ byteLength: number; value: string }>(10);
  cache.set("a", { byteLength: 4, value: "a" });
  cache.set("b", { byteLength: 6, value: "b" });
  assert.equal(cache.byteLength, 10);
  assert.equal(cache.get("a")?.value, "a");
  cache.set("c", { byteLength: 5, value: "c" });
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.byteLength, 9);
  cache.set("huge", { byteLength: 11, value: "huge" });
  assert.equal(cache.get("huge"), undefined);
  assert.equal(cache.byteLength, 9);
});

test("streams into quarantine, publishes by digest, deduplicates, and never returns a path", async () => {
  await withRoot(async (root) => {
    let decoderCalls = 0;
    const deepValidator: AssetDeepValidator = {
      async validate({ descriptor, filePath }) {
        decoderCalls += 1;
        assert.equal(path.isAbsolute(filePath), true);
        return { width: descriptor.width, height: descriptor.height };
      },
    };
    const store = createStore(root, new FakeReferenceAuthority(), { deepValidator });
    const bytes = makePng(11, 13);
    const first = await store.ingest(chunks(bytes, 7), {
      origin: { kind: "import" },
      declaredMimeType: "image/png",
      displayName: "/private/user/portrait.png",
    });
    assert.equal(first.asset.assetId, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(first.asset.displayName, "portrait.png");
    assert.equal(first.deduplicated, false);
    assert.equal(JSON.stringify(first).includes(root), false);
    const second = await store.ingest(chunks(bytes, 3), {
      origin: { kind: "import" },
      declaredMimeType: "image/png",
      displayName: "other.png",
    });
    assert.equal(second.deduplicated, true);
    assert.equal(second.asset.assetId, first.asset.assetId);
    assert.equal((await store.status()).assetCount, 1);
    assert.equal(decoderCalls, 2);
    const published = path.join(
      root,
      "assets",
      "sha256",
      first.asset.assetId.slice(0, 2),
      `${first.asset.assetId}.png`,
    );
    assert.deepEqual(new Uint8Array(await fs.readFile(published)), bytes);
    assert.deepEqual(await fs.readdir(path.join(root, "asset-quarantine")), []);
  });
});

test("notifies an optional observer only after CAS publication and outside its mutation fence", async () => {
  await withRoot(async (root) => {
    let store!: ContentAddressedAssetStore;
    let observed: AssetMetadataDto | undefined;
    let observedStatus: Awaited<ReturnType<ContentAddressedAssetStore["status"]>> | undefined;
    store = createStore(root, new FakeReferenceAuthority(), {
      onAssetPublished: async (asset) => {
        observed = asset;
        observedStatus = await store.status();
      },
    });
    const result = await store.ingest(chunks(makePng()), {
      origin: { kind: "import" },
      declaredMimeType: "image/png",
      displayName: "observed.png",
    });
    assert.equal(observed?.assetId, result.asset.assetId);
    assert.equal(observedStatus?.assetCount, 1);
  });
});

test("uses a main-owned canonical validation name while preserving the imported label", async () => {
  await withRoot(async (root) => {
    const store = createStore(root);
    const imported = await store.ingest(chunks(makePng()), {
      origin: { kind: "import" },
      displayName: "reference.webp",
      validationDisplayName: "reference.png",
      declaredMimeType: "image/png",
    });
    assert.equal(imported.asset.displayName, "reference.webp");
    assert.equal(imported.asset.mediaType, "image/png");
  });
});

test("a stale second store never deletes a digest already published by another store", async () => {
  await withRoot(async (root) => {
    const firstStore = createStore(root);
    const staleStore = createStore(root);
    await Promise.all([firstStore.status(), staleStore.status()]);
    const bytes = makePng();
    const first = await firstStore.ingest(chunks(bytes), {
      origin: { kind: "import" },
      displayName: "asset.png",
    });
    await assert.rejects(
      staleStore.ingest(chunks(bytes), {
        origin: { kind: "import" },
        displayName: "asset.png",
      }),
      /changed outside the app/u,
    );
    const published = path.join(
      root,
      "assets",
      "sha256",
      first.asset.assetId.slice(0, 2),
      `${first.asset.assetId}.png`,
    );
    assert.deepEqual(new Uint8Array(await fs.readFile(published)), bytes);
    assert.ok(await createStore(root).get(first.asset.assetId));
  });
});

test("refuses a symlinked digest directory instead of publishing outside the store", async () => {
  await withRoot(async (root) => {
    const store = createStore(root);
    await store.status();
    const bytes = makePng();
    const assetId = createHash("sha256").update(bytes).digest("hex");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-assets-outside-"));
    try {
      await fs.symlink(outside, path.join(root, "assets", "sha256", assetId.slice(0, 2)), "dir");
      await assert.rejects(
        store.ingest(chunks(bytes), {
          origin: { kind: "import" },
          displayName: "asset.png",
        }),
        (error: unknown) =>
          error instanceof AssetStoreError && error.code === "asset_store_repair_required",
      );
      assert.deepEqual(await fs.readdir(outside), []);
      assert.deepEqual(await fs.readdir(path.join(root, "asset-quarantine")), []);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test("deep decoder rejection leaves no published asset or quarantine temp", async () => {
  await withRoot(async (root) => {
    const store = createStore(root, new FakeReferenceAuthority(), {
      deepValidator: {
        async validate() {
          throw new Error("decoder rejected compressed payload");
        },
      },
    });
    await assert.rejects(
      store.ingest(chunks(makePng()), {
        origin: { kind: "import" },
        declaredMimeType: "image/png",
        displayName: "x.png",
      }),
      /decoder rejected/u,
    );
    assert.equal((await store.status()).assetCount, 0);
    assert.deepEqual(await fs.readdir(path.join(root, "asset-quarantine")), []);
  });
});

test("enforces per-ingest and aggregate quotas without charging a duplicate", async () => {
  await withRoot(async (root) => {
    const firstBytes = makePng(1, 1, 1);
    const secondBytes = makePng(1, 1, 2);
    const store = createStore(root, new FakeReferenceAuthority(), {
      limits: limits({
        maxImportBytes: firstBytes.byteLength,
        maxProviderResponseBytes: firstBytes.byteLength,
        totalAssetBytes: firstBytes.byteLength + 1,
        warningAssetBytes: firstBytes.byteLength,
      }),
    });
    const first = await store.ingest(chunks(firstBytes), {
      origin: { kind: "import" },
      displayName: "first.png",
    });
    assert.equal(first.quotaWarning, true);
    assert.equal(
      (
        await store.ingest(chunks(firstBytes), {
          origin: { kind: "import" },
          displayName: "first.png",
        })
      ).deduplicated,
      true,
    );
    await assert.rejects(
      store.ingest(chunks(secondBytes), {
        origin: { kind: "import" },
        displayName: "second.png",
      }),
      (error: unknown) =>
        error instanceof AssetStoreError && error.code === "asset_store_quota_exceeded",
    );
    await assert.rejects(
      store.ingest(chunks(concat(firstBytes, Uint8Array.from([1]))), {
        origin: { kind: "import" },
        displayName: "large.png",
      }),
      (error: unknown) =>
        error instanceof AssetStoreError && error.code === "asset_ingest_too_large",
    );
    assert.equal((await store.status()).assetCount, 1);
    assert.deepEqual(await fs.readdir(path.join(root, "asset-quarantine")), []);
  });
});

test("treats an otherwise valid over-budget asset index as unsafe", async () => {
  await withRoot(async (root) => {
    const firstBytes = makePng(1, 1, 1);
    const secondBytes = makePng(1, 1, 2);
    const store = createStore(root);
    await store.ingest(chunks(firstBytes), {
      origin: { kind: "import" },
      displayName: "first.png",
    });
    await store.ingest(chunks(secondBytes), {
      origin: { kind: "import" },
      displayName: "second.png",
    });

    const restarted = createStore(root, new FakeReferenceAuthority(), {
      limits: limits({
        totalAssetBytes: firstBytes.byteLength,
        warningAssetBytes: firstBytes.byteLength,
      }),
    });
    assert.equal((await restarted.status()).healthy, false);
    await assert.rejects(
      restarted.list(),
      (error: unknown) =>
        error instanceof AssetStoreError && error.code === "asset_store_repair_required",
    );
  });
});

test("repair stops before deep-decoding beyond the aggregate asset quota", async () => {
  await withRoot(async (root) => {
    const firstBytes = makePng(1, 1, 1);
    const secondBytes = makePng(1, 1, 2);
    const store = createStore(root);
    await store.ingest(chunks(firstBytes), {
      origin: { kind: "import" },
      displayName: "first.png",
    });
    await store.ingest(chunks(secondBytes), {
      origin: { kind: "import" },
      displayName: "second.png",
    });
    await fs.writeFile(path.join(root, "asset-index.json"), "{broken", "utf8");

    let decodeCalls = 0;
    const restarted = createStore(root, new FakeReferenceAuthority(), {
      limits: limits({
        totalAssetBytes: firstBytes.byteLength,
        warningAssetBytes: firstBytes.byteLength,
      }),
      deepValidator: {
        async validate({ descriptor }) {
          decodeCalls += 1;
          return { width: descriptor.width, height: descriptor.height };
        },
      },
    });
    await assert.rejects(
      restarted.repair({ apply: false }),
      (error: unknown) =>
        error instanceof AssetStoreError && error.code === "asset_store_quota_exceeded",
    );
    assert.equal(decodeCalls, 1);
  });
});

test("persists bounded reference accounting and rebuilds it from the authority", async () => {
  await withRoot(async (root) => {
    const authority = new FakeReferenceAuthority();
    const firstStore = createStore(root, authority);
    const imported = await firstStore.ingest(chunks(makePng()), {
      origin: { kind: "import" },
      displayName: "asset.png",
    });
    await firstStore.replaceReferences({ kind: "workflow", id: "workflow-1" }, [
      imported.asset.assetId,
    ]);
    assert.equal((await firstStore.get(imported.asset.assetId))?.referenceCount, 1);

    const restarted = createStore(root, authority);
    assert.equal((await restarted.get(imported.asset.assetId))?.referenceCount, 1);
    authority.snapshot = {
      epoch: "epoch-1",
      completeKinds: ["workflow", "run", "export"],
      records: [{ kind: "run", id: "run-1", assetIds: [imported.asset.assetId] }],
    };
    assert.deepEqual(await restarted.rebuildReferenceAccounting(), {
      missingAssetIds: [],
      revision: 3,
    });
    assert.equal((await restarted.get(imported.asset.assetId))?.referenceCount, 1);
  });
});

test("rejects reference snapshots beyond configured owner/link bounds", async () => {
  await withRoot(async (root) => {
    const authority = new FakeReferenceAuthority();
    authority.snapshot = {
      epoch: "epoch-1",
      completeKinds: ["workflow", "run", "export"],
      records: [
        { kind: "workflow", id: "workflow-1", assetIds: [] },
        { kind: "run", id: "run-1", assetIds: [] },
      ],
    };
    const store = createStore(root, authority, {
      limits: limits({ maxReferenceRecords: 1, maxReferenceLinks: 1 }),
    });
    await assert.rejects(store.rebuildReferenceAccounting(), /too many owners/u);
  });
});

test("preview leases are owner-bound, expiring, byte-bounded, and contain no path", async () => {
  await withRoot(async (root) => {
    let now = 10_000;
    const store = createStore(root, new FakeReferenceAuthority(), { now: () => now });
    const imported = await store.ingest(chunks(makePng()), {
      origin: { kind: "import" },
      displayName: "asset.png",
    });
    const lease = await store.acquirePreviewLease(imported.asset.assetId, "document-1", 1_000);
    await assert.rejects(
      store.readPreview(lease.token, "document-2"),
      (error: unknown) =>
        error instanceof AssetStoreError && error.code === "preview_lease_invalid",
    );
    await assert.rejects(
      store.readPreview(lease.token, "document-1", imported.asset.byteLength - 1),
      (error: unknown) => error instanceof AssetStoreError && error.code === "preview_too_large",
    );
    const preview = await store.readPreview(lease.token, "document-1");
    assert.equal(JSON.stringify(preview.asset).includes(root), false);
    assert.equal(preview.bytes.byteLength, imported.asset.byteLength);
    now += 1_001;
    await assert.rejects(
      store.readPreview(lease.token, "document-1"),
      (error: unknown) =>
        error instanceof AssetStoreError && error.code === "preview_lease_invalid",
    );
  });
});

test("thumbnail generation is validated, persisted, and cached under an exact byte budget", async () => {
  await withRoot(async (root) => {
    let generated = 0;
    const thumbnailGenerator: AssetThumbnailGenerator = {
      async generate({ maxDimension }) {
        generated += 1;
        return {
          bytes: makePng(maxDimension, maxDimension),
          width: maxDimension,
          height: maxDimension,
          mediaType: "image/png",
        };
      },
    };
    const store = createStore(root, new FakeReferenceAuthority(), {
      limits: limits({ thumbnailCacheBytes: 65, thumbnailSizes: [128, 256] }),
      thumbnailGenerator,
    });
    const first = await store.ingest(chunks(makePng(1, 1, 1)), {
      origin: { kind: "import" },
      displayName: "one.png",
    });
    const second = await store.ingest(chunks(makePng(1, 1, 2)), {
      origin: { kind: "import" },
      displayName: "two.png",
    });
    assert.equal((await store.getThumbnail(first.asset.assetId, 128)).byteLength, 65);
    assert.equal((await store.getThumbnail(first.asset.assetId, 128)).byteLength, 65);
    assert.equal(generated, 1);
    await store.getThumbnail(second.asset.assetId, 128);
    assert.deepEqual(store.thumbnailCacheStatus(), { entries: 1, byteLength: 65, maxBytes: 65 });
    assert.equal(generated, 2);

    const restarted = createStore(root, new FakeReferenceAuthority(), {
      limits: limits({ thumbnailCacheBytes: 65, thumbnailSizes: [128, 256] }),
      thumbnailGenerator,
    });
    await restarted.getThumbnail(first.asset.assetId, 128);
    assert.equal(generated, 2, "restart should use the validated derived file");
  });
});

test("rejects unsafe thumbnail generator output without publishing metadata", async () => {
  await withRoot(async (root) => {
    const store = createStore(root, new FakeReferenceAuthority(), {
      thumbnailGenerator: {
        async generate() {
          return {
            bytes: new TextEncoder().encode("not a PNG image"),
            width: 10,
            height: 10,
            mediaType: "image/png",
          };
        },
      },
    });
    const imported = await store.ingest(chunks(makePng()), {
      origin: { kind: "import" },
      displayName: "asset.png",
    });
    await assert.rejects(
      store.getThumbnail(imported.asset.assetId, 128),
      (error: unknown) =>
        error instanceof AssetStoreError && error.code === "thumbnail_unavailable",
    );
    assert.deepEqual((await store.get(imported.asset.assetId))?.thumbnailSizes, []);
  });
});

test("requires generated thumbnails to pass the injected deep decoder", async () => {
  await withRoot(async (root) => {
    const store = createStore(root, new FakeReferenceAuthority(), {
      deepValidator: {
        async validate({ descriptor, filePath }) {
          if (filePath.includes(`${path.sep}thumbnails${path.sep}`)) {
            throw new Error("decoder rejected thumbnail");
          }
          return { width: descriptor.width, height: descriptor.height };
        },
      },
      thumbnailGenerator: {
        async generate({ maxDimension }) {
          return {
            bytes: makePng(maxDimension, maxDimension),
            width: maxDimension,
            height: maxDimension,
            mediaType: "image/png",
          };
        },
      },
    });
    const imported = await store.ingest(chunks(makePng()), {
      origin: { kind: "import" },
      displayName: "asset.png",
    });
    await assert.rejects(
      store.getThumbnail(imported.asset.assetId, 128),
      (error: unknown) =>
        error instanceof AssetStoreError && error.code === "thumbnail_unavailable",
    );
    assert.deepEqual((await store.get(imported.asset.assetId))?.thumbnailSizes, []);
  });
});

test("GC plans are dry runs, stale on reference races, and recheck preview leases", async () => {
  await withRoot(async (root) => {
    let now = 1_000;
    const authority = new FakeReferenceAuthority();
    const store = createStore(root, authority, { now: () => now });
    const imported = await store.ingest(chunks(makePng()), {
      origin: { kind: "import" },
      displayName: "asset.png",
    });
    now = 3_000;
    const leasePlan = await store.planGarbageCollection(1_000);
    assert.deepEqual(leasePlan.candidateAssetIds, [imported.asset.assetId]);
    assert.ok(await store.get(imported.asset.assetId), "dry run does not delete");
    const lease = await store.acquirePreviewLease(imported.asset.assetId, "document-1", 10_000);
    const leaseResult = await store.applyGarbageCollection(leasePlan.planId);
    assert.deepEqual(leaseResult.skipped, [
      { assetId: imported.asset.assetId, reason: "lease_active" },
    ]);
    assert.ok(await store.get(imported.asset.assetId));
    await store.releasePreviewLease(lease.token, "document-1");

    const racedPlan = await store.planGarbageCollection(1_000);
    authority.snapshot = {
      epoch: "epoch-1",
      completeKinds: ["workflow", "run", "export"],
      records: [{ kind: "workflow", id: "workflow-1", assetIds: [imported.asset.assetId] }],
    };
    assert.equal((await store.applyGarbageCollection(racedPlan.planId)).stale, true);
    assert.ok(await store.get(imported.asset.assetId));

    authority.snapshot = {
      epoch: "epoch-2",
      completeKinds: ["workflow", "run", "export"],
      records: [],
    };
    const finalPlan = await store.planGarbageCollection(1_000);
    const applied = await store.applyGarbageCollection(finalPlan.planId);
    assert.deepEqual(applied.deletedAssetIds, [imported.asset.assetId]);
    assert.equal(await store.get(imported.asset.assetId), undefined);
  });
});

test("an opaque protocol grant keeps an unreferenced imported asset out of GC until revoke", async () => {
  await withRoot(async (root) => {
    let now = 1_000;
    const authority = new FakeReferenceAuthority();
    const store = createStore(root, authority, { now: () => now });
    const imported = await store.ingest(chunks(makePng()), {
      origin: { kind: "import" },
      displayName: "asset.png",
    });
    const owner: RendererDocumentOwner = {
      id: 42,
      documentId: "document-42",
      isDestroyed: () => false,
      send: () => undefined,
      onInvalidated: () => () => undefined,
    };
    const leaseOwnerId = "document-42";
    const lease = await store.acquirePreviewLease(imported.asset.assetId, leaseOwnerId, 10_000);
    let releasePromise: Promise<boolean> | undefined;
    const grants = new AssetDeliveryGrantRegistry(() => now, 10_000);
    const grant = grants.mint(owner, imported.asset.assetId, () => true, {
      expiresAt: lease.expiresAt,
      release: () => {
        releasePromise = store.releasePreviewLease(lease.token, leaseOwnerId);
      },
    });

    now = 3_000;
    assert.deepEqual((await store.planGarbageCollection(1_000)).candidateAssetIds, []);
    assert.equal(grants.revoke(grant.token, owner), true);
    await releasePromise;
    assert.deepEqual((await store.planGarbageCollection(1_000)).candidateAssetIds, [
      imported.asset.assetId,
    ]);
  });
});

test("repair dry-run rebuilds a corrupt index, quarantines hostile entries, and survives restart", async () => {
  await withRoot(async (root) => {
    const authority = new FakeReferenceAuthority();
    const store = createStore(root, authority);
    const imported = await store.ingest(chunks(makePng()), {
      origin: { kind: "import" },
      displayName: "asset.png",
    });
    const hostileDirectory = path.join(root, "assets", "sha256", "zz");
    await fs.mkdir(hostileDirectory, { recursive: true });
    await fs.writeFile(path.join(hostileDirectory, "evil.svg"), "<svg/>");
    await fs.writeFile(path.join(root, "asset-index.json"), "{broken", "utf8");

    const restarted = createStore(root, authority);
    assert.equal((await restarted.status()).healthy, false);
    await assert.rejects(
      restarted.list(),
      (error: unknown) =>
        error instanceof AssetStoreError && error.code === "asset_store_repair_required",
    );
    const dryRun = await restarted.repair({ apply: false });
    assert.equal(dryRun.applied, false);
    assert.deepEqual(dryRun.addedAssetIds, [imported.asset.assetId]);
    assert.equal(
      dryRun.invalidEntries.some((entry) => entry.entryId === "zz"),
      true,
    );
    assert.equal((await restarted.status()).healthy, false);

    const applied = await restarted.repair({ apply: true });
    assert.equal(applied.quarantinedEntryIds.includes("zz"), true);
    assert.equal((await restarted.status()).healthy, true);
    assert.ok(await restarted.get(imported.asset.assetId));
    const rootNames = await fs.readdir(root);
    assert.equal(
      rootNames.some((name) => name.startsWith("asset-index.json.invalid-")),
      true,
    );

    const secondRestart = createStore(root, authority);
    assert.ok(await secondRestart.get(imported.asset.assetId));
  });
});

test("repair reports an indexed asset whose binary disappeared", async () => {
  await withRoot(async (root) => {
    const authority = new FakeReferenceAuthority();
    const store = createStore(root, authority);
    const imported = await store.ingest(chunks(makePng()), {
      origin: { kind: "import" },
      displayName: "asset.png",
    });
    authority.snapshot = {
      epoch: "missing-source",
      completeKinds: ["workflow", "run", "export"],
      records: [{ kind: "workflow", id: "workflow-1", assetIds: [imported.asset.assetId] }],
    };
    await fs.rm(
      path.join(
        root,
        "assets",
        "sha256",
        imported.asset.assetId.slice(0, 2),
        `${imported.asset.assetId}.png`,
      ),
    );
    assert.deepEqual((await store.rebuildReferenceAccounting()).missingAssetIds, [
      imported.asset.assetId,
    ]);
    assert.equal(await store.getAvailable(imported.asset.assetId), undefined);
    await assert.rejects(
      () => store.acquirePreviewLease(imported.asset.assetId, "document-1"),
      (error: unknown) => error instanceof AssetStoreError && error.code === "asset_source_missing",
    );
    const report = await store.repair({ apply: false });
    assert.deepEqual(report.removedAssetIds, [imported.asset.assetId]);

    const healed = await store.ingest(chunks(makePng()), {
      origin: { kind: "import" },
      displayName: "restored-original.png",
    });
    assert.equal(healed.deduplicated, true);
    assert.equal(
      (await store.getAvailable(imported.asset.assetId))?.assetId,
      imported.asset.assetId,
    );
    assert.deepEqual((await store.rebuildReferenceAccounting()).missingAssetIds, []);
  });
});

test("exports a verified asset through a main-owned absolute destination", async () => {
  await withRoot(async (root) => {
    const store = createStore(root);
    const bytes = makePng(3, 2, 7);
    const imported = await store.ingest(chunks(bytes), {
      origin: { kind: "import" },
      declaredMimeType: "image/png",
      displayName: "reference.png",
    });
    const exportDirectory = path.join(root, "native-save-dialog-destination");
    await fs.mkdir(exportDirectory, { mode: 0o700 });
    const destination = path.join(exportDirectory, "saved-reference.png");

    const exported = await store.exportAssetToFile(imported.asset.assetId, destination);

    assert.deepEqual(exported, imported.asset);
    assert.deepEqual(await fs.readFile(destination), Buffer.from(bytes));
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
    assert.equal(Object.prototype.hasOwnProperty.call(exported, "filePath"), false);
    await assert.rejects(
      store.exportAssetToFile(imported.asset.assetId, "relative-output.png"),
      (error: unknown) =>
        error instanceof AssetStoreError && error.code === "invalid_asset_request",
    );
  });
});
