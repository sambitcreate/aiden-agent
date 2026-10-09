import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render } from "@testing-library/react";
import { MessageAttachments } from "./message-attachments";
import { attachmentsShownWithVisuals, VISUAL_SNAPSHOT_ID_PREFIX } from "../shared/visual-snapshots";

afterEach(() => cleanup());

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const image = (id: string, name: string) => ({ id, name, mimeType: "image/png", kind: "image" as const, size: 70, data: PNG });

test("the desktop never shows a visual's snapshot as a second image", () => {
  const snapshot = image(`${VISUAL_SNAPSHOT_ID_PREFIX}${"a".repeat(64)}`, "Board.png");
  const drawn = { uiVisuals: [{ id: "ui-1" }], visualSnapshots: [{ visualId: "ui-1", attachmentId: snapshot.id }] };
  const only = render(
    <MessageAttachments attachments={attachmentsShownWithVisuals({ ...drawn, attachments: [snapshot] })} role="assistant" />,
  );
  assert.equal(only.container.querySelector("img"), null);
  only.unmount();
  const mixed = render(
    <MessageAttachments
      attachments={attachmentsShownWithVisuals({ ...drawn, attachments: [snapshot, image("photo-1", "Photo.png")] })}
      role="assistant"
    />,
  );
  const images = [...mixed.container.querySelectorAll("img")];
  assert.equal(images.length, 1);
  assert.equal(images[0]!.getAttribute("alt")?.includes("Board") ?? false, false);
});

test("a paired Mac's visual shows as its snapshot image on this desktop", () => {
  const snapshot = image(`${VISUAL_SNAPSHOT_ID_PREFIX}${"b".repeat(64)}`, "Board.png");
  const shown = render(<MessageAttachments attachments={attachmentsShownWithVisuals({ attachments: [snapshot] })} role="assistant" />);
  const images = [...shown.container.querySelectorAll("img")];
  assert.equal(images.length, 1);
});
