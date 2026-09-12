import assert from "node:assert/strict";
import test from "node:test";
import { generationEmergencyUserError } from "./generation-emergency-outcome.js";

test("irreducible active context returns stable remediation instead of ordinary success", () => {
  assert.equal(
    generationEmergencyUserError({
      kind: "active_payload_replaced",
      category: "active_context_too_large",
      requiresDurableCheckpoint: false,
    }),
    "The active request is too large for this model context. Retry with a larger-context model or fewer/lower-size attachments.",
  );
  assert.equal(
    generationEmergencyUserError({
      kind: "active_payload_reduced",
      truncatedToolResults: 1,
      compactedToolResults: 0,
      requiresDurableCheckpoint: false,
    }),
    null,
  );
});
