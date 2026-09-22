import assert from "node:assert/strict";
import test from "node:test";
import { AssetDeliveryGrantRegistry } from "./asset-delivery-core.js";
import {
  CREATE_IMAGES_FEATURE_FLAG,
  createImagesEnabled,
  createWhenImagesEnabled,
} from "./feature-flag.js";
import {
  buildGeminiInteractionsRequest,
  GEMINI_INTERACTIONS_ENDPOINT,
  GEMINI_IMAGE_MODELS,
  validateGeminiImageRequest,
} from "./providers/gemini-interactions-core.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";

function fakeOwner(
  documentId: string,
  id = 1,
): {
  owner: RendererDocumentOwner;
  invalidate(): void;
} {
  let destroyed = false;
  const listeners = new Set<() => void>();
  return {
    owner: {
      id,
      documentId,
      isDestroyed: () => destroyed,
      send: () => undefined,
      onInvalidated: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    invalidate: () => {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

function fakeLease(expiresAt = Number.MAX_SAFE_INTEGER, released?: () => void) {
  return { expiresAt, release: released ?? (() => undefined) };
}

test("Create Images feature flag is fail-closed and does not construct services while disabled", () => {
  assert.equal(createImagesEnabled({}), false);
  assert.equal(createImagesEnabled({ [CREATE_IMAGES_FEATURE_FLAG]: "0" }), false);
  assert.equal(createImagesEnabled({ [CREATE_IMAGES_FEATURE_FLAG]: "true" }), false);
  assert.equal(createImagesEnabled({ [CREATE_IMAGES_FEATURE_FLAG]: " 1 " }), true);
  let constructed = 0;
  assert.equal(
    createWhenImagesEnabled(() => {
      constructed += 1;
      return "service";
    }, {}),
    undefined,
  );
  assert.equal(constructed, 0);
});

test("asset delivery grants are opaque, document-bound, expiring, and revocable", () => {
  let now = 1_000;
  const registry = new AssetDeliveryGrantRegistry(() => now, 1_000, 2);
  const firstOwner = fakeOwner("123:45:frame-token", 123);
  const otherOwner = fakeOwner("124:46:other-frame", 124);
  const authorized = new Set(["asset-1", "asset-2"]);
  const first = registry.mint(
    firstOwner.owner,
    "asset-1",
    (assetId) => authorized.has(assetId),
    fakeLease(),
  );
  assert.doesNotMatch(first.token, /asset-1|frame-token/u);
  assert.equal(registry.resolve(first.token, otherOwner.owner), undefined);
  assert.equal(registry.resolve(first.token, firstOwner.owner), "asset-1");
  assert.equal(registry.revoke(first.token, otherOwner.owner), false);
  assert.equal(registry.revoke(first.token, firstOwner.owner), true);

  const second = registry.mint(
    firstOwner.owner,
    "asset-2",
    (assetId) => authorized.has(assetId),
    fakeLease(),
  );
  now += 1_000;
  assert.equal(registry.resolve(second.token, firstOwner.owner), undefined);
  assert.equal(registry.size(), 0);
});

test("asset delivery grants enforce authorization and revoke on document invalidation", () => {
  const registry = new AssetDeliveryGrantRegistry();
  const current = fakeOwner("123:45:frame-token", 123);
  const allowed = new Set(["asset-1"]);
  assert.throws(
    () =>
      registry.mint(current.owner, "asset-denied", (assetId) => allowed.has(assetId), fakeLease()),
    /not authorized/u,
  );
  const grant = registry.mint(
    current.owner,
    "asset-1",
    (assetId) => allowed.has(assetId),
    fakeLease(),
  );
  allowed.clear();
  assert.equal(registry.resolve(grant.token, current.owner), undefined);
  const next = registry.mint(current.owner, "asset-1", () => true, fakeLease());
  current.invalidate();
  assert.equal(registry.resolve(next.token, current.owner), undefined);
  assert.equal(registry.size(), 0);
});

test("asset delivery grants enforce a bounded registry", () => {
  let now = 1_000;
  const registry = new AssetDeliveryGrantRegistry(() => now, 60_000, 2);
  const current = fakeOwner("123:45:frame-token", 123);
  const first = registry.mint(current.owner, "asset-1", () => true, fakeLease());
  now += 1;
  const second = registry.mint(current.owner, "asset-2", () => true, fakeLease());
  now += 1;
  registry.mint(current.owner, "asset-3", () => true, fakeLease());
  assert.equal(registry.resolve(first.token, current.owner), undefined);
  assert.equal(registry.resolve(second.token, current.owner), "asset-2");
  assert.equal(registry.revokeDocument(current.owner), 2);
});

test("every grant deletion path releases its resource exactly once", () => {
  let now = 1_000;
  const released: string[] = [];
  const registry = new AssetDeliveryGrantRegistry(() => now, 1_000, 1);
  const firstOwner = fakeOwner("123:45:first", 123);
  const secondOwner = fakeOwner("124:46:second", 124);
  const first = registry.mint(
    firstOwner.owner,
    "asset-1",
    () => true,
    fakeLease(2_000, () => released.push("first")),
  );
  registry.mint(
    firstOwner.owner,
    "asset-2",
    () => true,
    fakeLease(2_000, () => released.push("evicted")),
  );
  assert.equal(registry.resolve(first.token, firstOwner.owner), undefined);
  assert.deepEqual(released, ["first"]);
  firstOwner.invalidate();
  assert.deepEqual(released, ["first", "evicted"]);

  const expiring = registry.mint(
    secondOwner.owner,
    "asset-3",
    () => true,
    fakeLease(2_000, () => released.push("expired")),
  );
  now = 2_000;
  assert.equal(registry.resolve(expiring.token, secondOwner.owner), undefined);
  assert.deepEqual(released, ["first", "evicted", "expired"]);
});

test("asset protocol delivery requires an exact-frame one-time authorization ticket", () => {
  const registry = new AssetDeliveryGrantRegistry();
  const current = fakeOwner("123:45:frame-token", 123);
  const grant = registry.mint(current.owner, "asset-1", () => true, fakeLease());
  assert.equal(registry.consumeProtocolRequest(grant.token), undefined);
  assert.equal(
    registry.authorizeProtocolRequest(grant.token, 123, "123:45:different-frame"),
    false,
  );
  assert.equal(registry.authorizeProtocolRequest(grant.token, 123, "123:45:frame-token"), true);
  assert.equal(registry.consumeProtocolRequest(grant.token), "asset-1");
  assert.equal(registry.consumeProtocolRequest(grant.token), undefined);
});

test("Gemini contract uses the fixed Interactions origin and contains no credential fields", () => {
  assert.equal(
    GEMINI_INTERACTIONS_ENDPOINT,
    "https://generativelanguage.googleapis.com/v1beta/interactions",
  );
  assert.deepEqual(
    GEMINI_IMAGE_MODELS.map((model) => model.id),
    ["gemini-3.1-flash-lite-image", "gemini-3.1-flash-image", "gemini-3-pro-image"],
  );
  const request = buildGeminiInteractionsRequest({
    providerId: "gemini",
    modelId: "gemini-3.1-flash-image",
    prompt: "  Draw a quiet harbor at dawn.  ",
    aspectRatio: "16:9",
    imageSize: "2K",
    outputMime: "image/png",
    count: 1,
    references: [
      {
        assetId: "asset-1",
        bytes: new Uint8Array([0, 1, 2, 3]),
        mimeType: "image/png",
      },
    ],
  });
  assert.deepEqual(request, {
    model: "gemini-3.1-flash-image",
    input: [
      { type: "text", text: "Draw a quiet harbor at dawn." },
      { type: "image", mime_type: "image/png", data: "AAECAw==" },
    ],
    response_format: {
      type: "image",
      aspect_ratio: "16:9",
      image_size: "2K",
    },
    store: false,
    background: false,
  });
  assert.doesNotMatch(JSON.stringify(request), /api.?key|authorization|credential/iu);

  const jpegRequest = buildGeminiInteractionsRequest({
    providerId: "gemini",
    modelId: "gemini-3.1-flash-image",
    prompt: "Draw a quiet harbor at dawn.",
    aspectRatio: "16:9",
    imageSize: "2K",
    outputMime: "image/jpeg",
    count: 1,
    references: [],
  });
  assert.equal(jpegRequest.response_format.mime_type, "image/jpeg");
});

test("Gemini contract rejects arbitrary models, excess output count, and empty media", () => {
  const base = {
    providerId: "gemini",
    modelId: "gemini-3.1-flash-image",
    prompt: "prompt",
    aspectRatio: "1:1" as const,
    imageSize: "1K" as const,
    outputMime: "image/png" as const,
    count: 1,
    references: [],
  };
  assert.throws(
    () => validateGeminiImageRequest({ ...base, modelId: "attacker/model" }),
    /not supported/u,
  );
  assert.throws(() => validateGeminiImageRequest({ ...base, count: 2 }), /one output/u);
  assert.throws(
    () =>
      validateGeminiImageRequest({
        ...base,
        references: [{ assetId: "asset-1", bytes: new Uint8Array(), mimeType: "image/png" }],
      }),
    /between 1 byte/u,
  );
});
