import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";

const handlerSource = fs.readFileSync(new URL("./attachments.ts", import.meta.url), "utf8");
const rendererIpcSource = fs.readFileSync(
  new URL("../../renderer/lib/ipc.ts", import.meta.url),
  "utf8",
);

test("attachment IPC combines native selection and bounded reading in main", () => {
  assert.match(handlerSource, /"attachments:pickAndRead"/);
  assert.match(handlerSource, /rendererDocumentOwner\(event/);
  assert.match(handlerSource, /dialog\.showOpenDialog\(parent/);
  assert.match(handlerSource, /readPickedAttachments\(selectedPaths/);
  assert.doesNotMatch(handlerSource, /attachments:read/);

  assert.match(rendererIpcSource, /"attachments:pickAndRead"/);
  assert.doesNotMatch(rendererIpcSource, /attachments:read/);
  assert.doesNotMatch(rendererIpcSource, /function pickFiles/);
});

test("every attachment ingestion channel uses process-owned owner-bound admission", () => {
  assert.equal(
    handlerSource.match(/\brunOwnedAttachmentIngestion\(/gu)?.length,
    3,
    "picker, drop, and clipboard admission calls must remain present",
  );
  assert.match(handlerSource, /async function runOwnedAttachmentIngestion<T>\(/u);
  assert.match(handlerSource, /owner\.onInvalidated\(lease\.cancel\)/u);
  assert.match(
    handlerSource,
    /finally \{\s+removeOwnerInvalidation\(\);\s+lease\.release\(\);\s+\}/u,
  );
  assert.match(handlerSource, /validateClipboardAttachmentPayload\(/u);
  assert.match(handlerSource, /materializeClipboardAttachments\(payload, isActive\)/u);
});
