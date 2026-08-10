import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentInlineBytesRemaining,
  attachmentSlotsRemaining,
  MAX_ATTACHMENT_INLINE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "./attachment-contract.js";

test("attachment picker requests respect the cumulative message cap", () => {
  assert.equal(attachmentSlotsRemaining(18), 2);
  assert.equal(attachmentSlotsRemaining(MAX_ATTACHMENTS_PER_MESSAGE), 0);
  assert.equal(attachmentSlotsRemaining(MAX_ATTACHMENTS_PER_MESSAGE + 1), 0);
  assert.equal(attachmentSlotsRemaining(0), MAX_ATTACHMENTS_PER_MESSAGE);
  assert.equal(attachmentSlotsRemaining(Number.NaN), 0);
});

test("attachment data capacity survives repeated picker batches", () => {
  assert.equal(
    attachmentInlineBytesRemaining([
      { kind: "image", size: 8 * 1024 * 1024 },
      { kind: "text", size: 999_999, text: "hello" },
    ]),
    MAX_ATTACHMENT_INLINE_BYTES - 8 * 1024 * 1024 - 5,
  );
  assert.equal(
    attachmentInlineBytesRemaining([{ kind: "image", size: MAX_ATTACHMENT_INLINE_BYTES }]),
    0,
  );
});
