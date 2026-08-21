import assert from "node:assert/strict";
import test from "node:test";
import {
  createImagesGeminiProviderStatus,
  resolveCreateImagesGeminiApiKeyAuth,
  type GeminiProviderCredentialAuthority,
} from "./gemini-provider-status-core.js";

function authority(
  kind: "api_key" | "oauth" | undefined,
  apiKey?: string,
): GeminiProviderCredentialAuthority {
  return {
    credentialKind: async () => kind,
    requestAuth: async () => (apiKey === undefined ? undefined : { auth: { apiKey } }),
  };
}

test("Gemini image status requires an exact stored API-key credential", async () => {
  assert.equal(
    (await createImagesGeminiProviderStatus(authority(undefined))).connectionState,
    "disconnected",
  );
  assert.deepEqual(await createImagesGeminiProviderStatus(authority("oauth", "oauth-token")), {
    schemaVersion: 1,
    providerId: "gemini",
    displayName: "Google Gemini",
    connectionState: "unavailable",
    safeErrorCode: "credential-scope-unverified",
  });
  assert.equal(
    (await createImagesGeminiProviderStatus(authority("api_key"))).safeErrorCode,
    "credential-invalid",
  );
  const connected = await createImagesGeminiProviderStatus(authority("api_key", "test-key"));
  assert.equal(connected.connectionState, "connected");
  assert.equal(connected.credentialKind, "google-api-key");
  assert.equal(connected.capabilitySnapshot?.models.length, 3);
  assert.equal(JSON.stringify(connected).includes("test-key"), false);
});

test("Gemini request auth rejects missing, OAuth, and malformed credentials", async () => {
  await assert.rejects(resolveCreateImagesGeminiApiKeyAuth(authority(undefined)), /Connect/u);
  await assert.rejects(resolveCreateImagesGeminiApiKeyAuth(authority("oauth", "token")), /OAuth/u);
  await assert.rejects(
    resolveCreateImagesGeminiApiKeyAuth(authority("api_key", "bad key")),
    /invalid/u,
  );
  assert.deepEqual(await resolveCreateImagesGeminiApiKeyAuth(authority("api_key", "valid-key")), {
    auth: { apiKey: "valid-key" },
  });
});
