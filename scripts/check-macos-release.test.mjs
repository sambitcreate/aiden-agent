import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDeveloperIdIdentity,
  checkMacReleaseEnvironment,
  notarizationCredentialStrategy,
} from "./check-macos-release.mjs";

const team = "5WP229CBB8";
const apiCredentials = {
  APPLE_API_KEY: "/private/key.p8",
  APPLE_API_KEY_ID: "KEY1234567",
  APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
};

test("release preflight accepts each complete notarization strategy", () => {
  assert.equal(notarizationCredentialStrategy(apiCredentials), "api-key");
  assert.equal(
    notarizationCredentialStrategy({
      APPLE_ID: "release@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_TEAM_ID: team,
    }),
    "apple-id",
  );
  assert.equal(
    notarizationCredentialStrategy({ APPLE_KEYCHAIN_PROFILE: "aiden-notary" }),
    "keychain-profile",
  );
});

test("release preflight rejects absent, partial, ambiguous, and wrong-team credentials", () => {
  assert.throws(() => notarizationCredentialStrategy({}), /requires Apple notarization/);
  assert.throws(
    () => notarizationCredentialStrategy({ APPLE_API_KEY_ID: "KEY1234567" }),
    /incomplete/,
  );
  assert.throws(
    () =>
      notarizationCredentialStrategy({
        APPLE_ID: "release@example.com",
        APPLE_APP_SPECIFIC_PASSWORD: "app-password",
        APPLE_TEAM_ID: "WRONGTEAM1",
      }),
    /pinned signing team/,
  );
  assert.throws(
    () => notarizationCredentialStrategy({ ...apiCredentials, APPLE_KEYCHAIN_PROFILE: "also" }),
    /exactly one/,
  );
});

test("release signing requires the pinned team's Developer ID Application identity", () => {
  assert.doesNotThrow(() =>
    assertDeveloperIdIdentity(
      `  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Sambit Biswas (${team})"`,
    ),
  );
  assert.throws(
    () =>
      assertDeveloperIdIdentity(
        `  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Sambit Biswas (${team})"`,
      ),
    /No valid Developer ID/,
  );
  assert.throws(
    () =>
      assertDeveloperIdIdentity(
        '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Other (WRONGTEAM1)"',
      ),
    /No valid Developer ID/,
  );
});

test("release environment preflight allows an imported cert but rejects bad local signing selection", async () => {
  await assert.doesNotReject(
    checkMacReleaseEnvironment({
      environment: { ...apiCredentials, CSC_LINK: "base64-certificate" },
      platform: "darwin",
      run: async () => {
        throw new Error("security should not run for an imported identity");
      },
    }),
  );
  await assert.rejects(
    checkMacReleaseEnvironment({
      environment: {
        ...apiCredentials,
        CSC_LINK: "base64-certificate",
        CSC_NAME: `Apple Development: Sambit Biswas (${team})`,
      },
      platform: "darwin",
    }),
    /non-Developer-ID/,
  );
});

test("release environment preflight validates a keychain identity", async () => {
  const result = await checkMacReleaseEnvironment({
    environment: apiCredentials,
    platform: "darwin",
    run: async () => ({
      stdout: `  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Sambit Biswas (${team})"`,
      stderr: "",
    }),
  });
  assert.deepEqual(result, { credentials: "api-key", signingSource: "keychain" });
});
