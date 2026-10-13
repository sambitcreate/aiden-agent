import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactPlacementLedger, imageAttachmentPlacements } from "./generative-ui-placements.js";
import { parseChatImagePlacements } from "../../renderer/shared/chat-artifacts.js";

test("placements use the timeline's public call ids, not raw provider ids", () => {
  const ledger = createArtifactPlacementLedger();
  ledger.record("media-a", "toolu_01RAWPROVIDERID");
  // The timeline exists by the time a tool executes; it publishes call-N ids.
  ledger.setResolver((raw) => (raw === "toolu_01RAWPROVIDERID" ? "call-3" : undefined));
  assert.equal(ledger.publicIdFor("media-a"), "call-3");
  assert.deepEqual(ledger.placementsFor([{ mediaId: "media-a" }]), [
    { mediaId: "media-a", toolCallId: "call-3" },
  ]);
});

test("the first producing call wins and unresolvable calls are omitted", () => {
  const ledger = createArtifactPlacementLedger();
  ledger.setResolver((raw) => ({ first: "call-1", second: "call-2" } as Record<string, string>)[raw]);
  ledger.record("media-a", "first");
  ledger.record("media-a", "second");
  ledger.record("media-b", "unknown");
  assert.equal(ledger.publicIdFor("media-a"), "call-1");
  assert.equal(ledger.publicIdFor("media-b"), undefined);
  assert.deepEqual(ledger.placementsFor([{ mediaId: "media-a" }, { mediaId: "media-b" }]), [
    { mediaId: "media-a", toolCallId: "call-1" },
  ]);
  assert.equal(ledger.placementsFor([]), undefined);
});

test("a revision keeps the first call's position but takes the latest layout", () => {
  const ledger = createArtifactPlacementLedger();
  ledger.setResolver((raw) => ({ first: "call-1", second: "call-2", third: "call-3" } as Record<string, string>)[raw]);
  ledger.record("media-a", "first");
  ledger.record("media-a", "second", "wide");
  ledger.record("media-b", "third", "column");
  assert.equal(ledger.layoutFor("media-a"), "wide");
  assert.deepEqual(ledger.placementsFor([{ mediaId: "media-a" }, { mediaId: "media-b" }]), [
    { mediaId: "media-a", toolCallId: "call-1", layout: "wide" },
    { mediaId: "media-b", toolCallId: "call-3" },
  ]);
  ledger.record("media-a", "third", "column");
  assert.deepEqual(ledger.placementsFor([{ mediaId: "media-a" }]), [
    { mediaId: "media-a", toolCallId: "call-1" },
  ]);
});

test("generated image placements persist only kept attachments with resolvable calls", () => {
  const ledger = createArtifactPlacementLedger();
  ledger.setResolver((raw) => ({ toolu_a: "call-1", toolu_b: "call-2" } as Record<string, string>)[raw]);
  ledger.record("img-a", "toolu_a");
  ledger.record("img-b", "toolu_b");
  ledger.record("img-lost", "toolu_unknown");
  const placements = imageAttachmentPlacements(ledger, [{ id: "img-b" }, { id: "img-lost" }, { id: "upload" }]);
  assert.deepEqual(placements, [{ attachmentId: "img-b", toolCallId: "call-2" }]);
  assert.equal(imageAttachmentPlacements(ledger, [{ id: "upload" }]), undefined);
  // Stored placements round-trip through the lenient parser; junk is dropped.
  assert.deepEqual(parseChatImagePlacements([...placements!, { attachmentId: 3 }, null, { attachmentId: "img-b", toolCallId: "call-9" }]), placements);
  assert.equal(parseChatImagePlacements("nope"), undefined);
});
