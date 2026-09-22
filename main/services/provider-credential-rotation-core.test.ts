import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProviderCredentialLength,
  credentialAfterProviderRotation,
  MAX_PROVIDER_CREDENTIAL_ROTATION_JOURNAL_LENGTH,
  normalizeProviderCredentialInput,
  parsePendingProviderCredentialRotation,
  providerCredentialState,
  providerConnectionSnapshot,
  serializePendingProviderCredentialRotation,
  type PendingProviderCredentialRotationV1,
} from "./provider-credential-rotation-core.js";

const previous = {
  id: "custom-provider",
  kind: "openai",
  baseUrl: "https://old.example/v1",
  needsKey: true,
};
const target = {
  ...previous,
  baseUrl: "https://new.example/v1",
};
const pending: PendingProviderCredentialRotationV1 = {
  version: 1,
  providerId: previous.id,
  previous,
  target,
  previousKey: "old-key",
  targetKey: "new-key",
};

test("provider credential rotation chooses the key bound to the committed endpoint", () => {
  assert.deepEqual(credentialAfterProviderRotation(pending, previous), {
    resolved: true,
    key: "old-key",
  });
  assert.deepEqual(credentialAfterProviderRotation(pending, target), {
    resolved: true,
    key: "new-key",
  });
  assert.deepEqual(
    credentialAfterProviderRotation(pending, {
      ...target,
      baseUrl: "https://third.example/v1",
    }),
    { resolved: true, key: null },
  );
});

test("a provider rotation journal skipped by a later edit converges without reusing a stale key", () => {
  assert.deepEqual(
    credentialAfterProviderRotation(pending, {
      ...target,
      baseUrl: "https://later.example/v1",
    }),
    { resolved: true, key: null },
  );
});

test("a failed first provider save discards its staged credential", () => {
  assert.deepEqual(
    credentialAfterProviderRotation({ ...pending, previous: null, previousKey: null }, undefined),
    { resolved: true, key: null },
  );
});

test("an interrupted provider removal restores or deletes the key from config authority", () => {
  const removal = { ...pending, target: null, targetKey: null };
  assert.deepEqual(credentialAfterProviderRotation(removal, previous), {
    resolved: true,
    key: "old-key",
  });
  assert.deepEqual(credentialAfterProviderRotation(removal, undefined), {
    resolved: true,
    key: null,
  });
  assert.deepEqual(parsePendingProviderCredentialRotation(removal), removal);
});

test("pending provider credential rotations are strictly bounded and parsed", () => {
  assert.deepEqual(parsePendingProviderCredentialRotation(pending), pending);
  assert.throws(
    () =>
      parsePendingProviderCredentialRotation({ ...pending, target: { ...target, id: "other" } }),
    /Invalid pending provider credential rotation/u,
  );
  assert.deepEqual(
    providerConnectionSnapshot({ ...target, ignored: true } as typeof target),
    target,
  );
  assert.throws(
    () =>
      parsePendingProviderCredentialRotation({
        ...pending,
        target: { ...target, baseUrl: `https://example.test/${"x".repeat(4_096)}` },
      }),
    /Invalid pending provider credential rotation/u,
  );
  assert.throws(
    () =>
      parsePendingProviderCredentialRotation({
        ...pending,
        targetKey: "x".repeat(1_048_577),
      }),
    /Invalid pending provider credential rotation/u,
  );
});

test("an offline endpoint edit quarantines rather than rebinds the old key", () => {
  assert.deepEqual(providerCredentialState(true, null), {
    previousKey: null,
    mismatched: true,
  });
  assert.deepEqual(providerCredentialState(true, "key-bound-to-current-endpoint"), {
    previousKey: "key-bound-to-current-endpoint",
    mismatched: false,
  });
});

test("direct provider key writes share the durable rotation-journal bound", () => {
  assert.equal(normalizeProviderCredentialInput("  key  "), "key");
  assert.equal(normalizeProviderCredentialInput("   "), null);
  assert.throws(
    () => normalizeProviderCredentialInput("CANARY_SECRET\nSECOND"),
    /control characters/u,
  );
  assert.throws(
    () => normalizeProviderCredentialInput("x".repeat(1_048_577)),
    /cannot exceed 1048576 characters/u,
  );
  assert.doesNotThrow(() => assertProviderCredentialLength("x".repeat(1_048_576)));
  assert.throws(
    () => assertProviderCredentialLength("x".repeat(1_048_577)),
    /cannot exceed 1048576 characters/u,
  );
});

test("the durable rotation journal fits two independently maximum-size keys", () => {
  const maximumKey = "x".repeat(1_048_576);
  const encoded = serializePendingProviderCredentialRotation({
    ...pending,
    previousKey: maximumKey,
    targetKey: maximumKey,
  });

  assert.ok(encoded.length > 1_048_576);
  assert.ok(encoded.length <= MAX_PROVIDER_CREDENTIAL_ROTATION_JOURNAL_LENGTH);
  assert.deepEqual(
    parsePendingProviderCredentialRotation(JSON.parse(encoded)),
    JSON.parse(encoded),
  );
});
