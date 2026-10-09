import assert from "node:assert/strict";
import test from "node:test";
import {
  isVisualSnapshotAttachmentId,
  parseVisualSnapshots,
  VISUAL_SNAPSHOT_ID_PREFIX,
  withoutVisualSnapshots,
} from "./visual-snapshots.js";

const SNAPSHOT_ID = `${VISUAL_SNAPSHOT_ID_PREFIX}${"a".repeat(64)}`;

test("snapshot attachment ids are recognised only by their reserved prefix", () => {
  assert.equal(isVisualSnapshotAttachmentId(SNAPSHOT_ID), true);
  for (const id of ["attachment-1", "visual-snapshot", `x${SNAPSHOT_ID}`, 3, undefined]) {
    assert.equal(isVisualSnapshotAttachmentId(id), false, String(id));
  }
});

test("snapshot references parse leniently and only point at reserved attachments", () => {
  assert.deepEqual(
    parseVisualSnapshots([
      { visualId: "ui-1", attachmentId: SNAPSHOT_ID },
      { visualId: "ui-1", attachmentId: SNAPSHOT_ID.replace(/a$/u, "b") },
      { visualId: "ui-2", attachmentId: "attachment-1" },
      { visualId: "", attachmentId: SNAPSHOT_ID },
      { visualId: "html_x", attachmentId: SNAPSHOT_ID.replace(/a$/u, "c"), extra: true },
    ]),
    [
      { visualId: "ui-1", attachmentId: SNAPSHOT_ID },
      { visualId: "html_x", attachmentId: SNAPSHOT_ID.replace(/a$/u, "c") },
    ],
  );
  assert.equal(parseVisualSnapshots("nope"), undefined);
  assert.equal(parseVisualSnapshots([]), undefined);
});

test("snapshot attachments are hidden from lists of ordinary attachments", () => {
  const ordinary = { id: "attachment-1" };
  assert.deepEqual(withoutVisualSnapshots([ordinary, { id: SNAPSHOT_ID }]), [ordinary]);
  const untouched = [ordinary];
  assert.equal(withoutVisualSnapshots(untouched), untouched, "unchanged lists keep identity");
});
