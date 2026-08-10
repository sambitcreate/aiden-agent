import assert from "node:assert/strict";
import test from "node:test";
import {
  appendReconciliationFailureKind,
  appendReconciliationFailureMessage,
  isAppendReconciliationRequired,
} from "./chat-message-contract.js";

test("append reconciliation errors survive Electron error wrapping without false positives", () => {
  assert.equal(
    isAppendReconciliationRequired(
      new Error(`Error invoking remote method: ${appendReconciliationFailureMessage("current")}`),
    ),
    true,
  );
  assert.equal(
    appendReconciliationFailureKind(
      new Error(`Error invoking remote method: ${appendReconciliationFailureMessage("blocked")}`),
    ),
    "blocked",
  );
  assert.equal(
    appendReconciliationFailureKind(
      new Error('Shadowed by configured skill “AIDEN_APPEND_RECONCILIATION_REQUIRED”.'),
    ),
    null,
  );
  assert.equal(isAppendReconciliationRequired(new Error("ordinary append failure")), false);
});
