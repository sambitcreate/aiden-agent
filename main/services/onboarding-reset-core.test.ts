import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteEveryCredential,
  OnboardingResetError,
  performOnboardingReset,
  type OnboardingResetOperations,
} from "./onboarding-reset-core.js";

test("credential cleanup attempts every provider after an individual deletion fails", async () => {
  const deleted: string[] = [];
  await assert.rejects(
    deleteEveryCredential(["alpha", "beta", "gamma"], async (providerId) => {
      deleted.push(providerId);
      if (providerId === "beta") throw new Error("locked credential");
    }),
    /not fully cleared/u,
  );
  assert.deepEqual(new Set(deleted), new Set(["alpha", "beta", "gamma"]));
});

function operations(
  events: string[],
  failures: Partial<Record<keyof OnboardingResetOperations, Error>> = {},
): OnboardingResetOperations {
  const run = async (name: keyof OnboardingResetOperations): Promise<void> => {
    events.push(name);
    const failure = failures[name];
    if (failure) throw failure;
  };
  return {
    disconnectArtificialAnalysis: () => run("disconnectArtificialAnalysis"),
    clearModelInsights: () => run("clearModelInsights"),
    resetConfiguration: () => run("resetConfiguration"),
    clearLegacySecrets: () => run("clearLegacySecrets"),
    clearPiCredentials: () => run("clearPiCredentials"),
    clearMcpOAuth: () => run("clearMcpOAuth"),
  };
}

test("reset disconnects model data before clearing every setup-owned store", async () => {
  const events: string[] = [];

  await performOnboardingReset(operations(events));

  assert.deepEqual(
    new Set(events.slice(0, 2)),
    new Set(["disconnectArtificialAnalysis", "clearModelInsights"]),
  );
  assert.deepEqual(
    new Set(events.slice(2)),
    new Set(["resetConfiguration", "clearLegacySecrets", "clearPiCredentials", "clearMcpOAuth"]),
  );
});

test("reset attempts every cleanup and returns a retryable aggregate failure", async () => {
  const events: string[] = [];
  const credentialFailure = new Error("credential sentinel");
  const oauthFailure = new Error("oauth sentinel");

  await assert.rejects(
    performOnboardingReset(
      operations(events, {
        clearPiCredentials: credentialFailure,
        clearMcpOAuth: oauthFailure,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof OnboardingResetError);
      assert.match(error.message, /Retry Reset onboarding/u);
      assert.doesNotMatch(error.message, /sentinel/u);
      assert.deepEqual(error.failures, [credentialFailure, oauthFailure]);
      return true;
    },
  );

  assert.deepEqual(
    new Set(events),
    new Set([
      "disconnectArtificialAnalysis",
      "clearModelInsights",
      "resetConfiguration",
      "clearLegacySecrets",
      "clearPiCredentials",
      "clearMcpOAuth",
    ]),
  );
});
