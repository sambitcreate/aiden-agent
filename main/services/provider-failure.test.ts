import assert from "node:assert/strict";
import test from "node:test";
import {
  compactionFailureLogMetadata,
  providerFailureFromTerminalOutcome,
  providerFailureFromLegacyPiMessage,
  providerFailureChatMetadata,
  type ProviderFailureReason,
} from "./provider-failure.js";
import {
  parseProviderFailureV1,
  providerFailurePresentation,
} from "../../renderer/shared/provider-failure.js";

const PRIVATE_CANARY = "PRIVATE_PROVIDER_DETAIL_7dbfe9";

function classify(
  reason: ProviderFailureReason,
  errorMessage?: string,
  attempts = 1,
) {
  return providerFailureFromTerminalOutcome({
    kind: "provider_failed",
    reason,
    attempts,
    finalMessage: errorMessage
      ? { stopReason: "error", errorMessage }
      : undefined,
  });
}

test("provider failures map to a closed privacy-safe category", () => {
  const cases: Array<
    [ProviderFailureReason, string | undefined, string]
  > = [
    ["request-failed", `Connection error. ${PRIVATE_CANARY}`, "network"],
    ["request-failed", `request timed out ${PRIVATE_CANARY}`, "timeout"],
    ["request-failed", `503 service unavailable ${PRIVATE_CANARY}`, "service_unavailable"],
    ["request-failed", `429 rate limit ${PRIVATE_CANARY}`, "rate_limit"],
    ["request-failed", `401 unauthorized ${PRIVATE_CANARY}`, "authentication"],
    ["request-failed", `API key not valid. ${PRIVATE_CANARY}`, "authentication"],
    ["request-failed", `insufficient_quota ${PRIVATE_CANARY}`, "quota"],
    ["request-failed", `400 invalid_request ${PRIVATE_CANARY}`, "invalid_request"],
    ["request-failed", `maximum context length ${PRIVATE_CANARY}`, "context_window"],
    ["context-overflow", PRIVATE_CANARY, "context_window"],
    ["output-limit", PRIVATE_CANARY, "output_limit"],
    ["interrupted", PRIVATE_CANARY, "interrupted"],
    ["compaction-failed", PRIVATE_CANARY, "context_management"],
    ["request-failed", PRIVATE_CANARY, "unknown"],
  ];

  for (const [reason, errorMessage, expected] of cases) {
    const failure = classify(reason, errorMessage);
    assert.equal(failure.category, expected);
    assert.doesNotMatch(JSON.stringify(failure), new RegExp(PRIVATE_CANARY, "u"));
  }
});

test("legacy Pi terminals recover only closed failure metadata", () => {
  assert.deepEqual(
    providerFailureFromLegacyPiMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: `socket connection was closed ${PRIVATE_CANARY}`,
    }),
    {
      version: 1,
      category: "network",
      attempts: 0,
      retryExhausted: false,
    },
  );
  assert.deepEqual(
    providerFailureFromLegacyPiMessage({
      role: "assistant",
      stopReason: "length",
    })?.category,
    "output_limit",
  );
  for (const errorMessage of [
    "The app cancelled the model operation.",
    "The local agent runtime failed.",
  ]) {
    assert.equal(
      providerFailureFromLegacyPiMessage({
        role: "assistant",
        stopReason: "aborted",
        errorMessage,
      }),
      undefined,
    );
  }
  for (const stopReason of ["error", "aborted"]) {
    assert.equal(
      providerFailureFromLegacyPiMessage({
        role: "assistant",
        stopReason,
      }),
      undefined,
    );
  }
});

test("compaction log metadata drops raw provider text", () => {
  const metadata = compactionFailureLogMetadata({
    reason: "threshold",
    errorMessage: PRIVATE_CANARY,
  });
  assert.deepEqual(metadata, { reason: "threshold" });
  assert.doesNotMatch(JSON.stringify(metadata), new RegExp(PRIVATE_CANARY, "u"));
});

test("manual compaction logs only its closed reason", () => {
  const metadata = compactionFailureLogMetadata({
    reason: "manual",
    errorMessage: `manual failure ${PRIVATE_CANARY}`,
  });
  assert.deepEqual(metadata, { reason: "manual" });
  assert.doesNotMatch(JSON.stringify(metadata), new RegExp(PRIVATE_CANARY, "u"));
});

test("terminal retry exhaustion and attempt count survive canonicalization", () => {
  const metadata = providerFailureChatMetadata({
    kind: "provider_failed",
    reason: "request-failed",
    attempts: 2,
    finalMessage: {
      stopReason: "error",
      errorMessage: `network error ${PRIVATE_CANARY}`,
    },
  });
  assert.deepEqual(metadata, {
    providerFailure: {
      version: 1,
      category: "network",
      attempts: 2,
      retryExhausted: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(metadata), new RegExp(PRIVATE_CANARY, "u"));
});

test("persisted failure parsing drops unknown and malformed data", () => {
  assert.deepEqual(
    parseProviderFailureV1({
      version: 1,
      category: "timeout",
      attempts: 1,
      retryExhausted: false,
      rawError: PRIVATE_CANARY,
    }),
    {
      version: 1,
      category: "timeout",
      attempts: 1,
      retryExhausted: false,
    },
  );
  for (const invalid of [
    null,
    { version: 2, category: "network", attempts: 1, retryExhausted: false },
    { version: 1, category: "private-provider-code", attempts: 1, retryExhausted: false },
    { version: 1, category: "network", attempts: -1, retryExhausted: false },
    { version: 1, category: "network", attempts: 1, retryExhausted: true },
    { version: 1, category: "network", attempts: 1, retryExhausted: "yes" },
  ]) {
    assert.equal(parseProviderFailureV1(invalid), undefined);
  }
});

test("renderer presentation is fixed and content-free", () => {
  const failure = classify("request-failed", `network error ${PRIVATE_CANARY}`, 2);
  const presentation = providerFailurePresentation(failure);
  assert.equal(presentation.title, "Generation failed");
  assert.match(presentation.description, /after retrying/iu);
  assert.doesNotMatch(JSON.stringify(presentation), new RegExp(PRIVATE_CANARY, "u"));
});
