import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render } from "@testing-library/react";
import { MessageAttachments } from "../components/message-attachments";
import { attachmentsWithBytes } from "./stored-attachments";
import type { Attachment } from "./types";

afterEach(() => cleanup());

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SHA = "a".repeat(64);

function stored(id: string, extra: Partial<Attachment> = {}): Attachment {
  return { id, name: `${id}.png`, mimeType: "image/png", kind: "image", size: 70, sha256: SHA, ...extra };
}

test("a stored image draws from its private link at its recorded size", () => {
  const url = `aiden-attachment://image/chat-1/${SHA}`;
  const view = render(
    <MessageAttachments attachments={[stored("photo", { url, width: 640, height: 480 })]} role="assistant" />,
  );
  const image = view.container.querySelector("img");
  assert.equal(image?.getAttribute("src"), url);
  assert.equal(image?.getAttribute("width"), "640");
  assert.equal(image?.getAttribute("height"), "480");
});

test("an image link from anywhere else is never drawn", () => {
  const view = render(
    <MessageAttachments
      attachments={[stored("remote", { url: "https://example.com/tracker.png" }), stored("bare")]}
      role="assistant"
    />,
  );
  assert.ok(!view.container.querySelector("img"), "no image is drawn");
});

test("reusing stored images loads their bytes and leaves out any that can no longer be read", async () => {
  const loads: string[] = [];
  const text: Attachment = { id: "notes", name: "notes.md", mimeType: "text/markdown", kind: "text", size: 3, text: "# A" };
  const ready = await attachmentsWithBytes(
    "chat-1",
    [stored("photo", { url: "aiden-attachment://image/chat-1/x", width: 1, height: 1 }), stored("gone"), text, stored("inline", { data: PNG })],
    async (chatId, attachmentId) => {
      loads.push(`${chatId}/${attachmentId}`);
      if (attachmentId === "gone") throw new Error("missing");
      return { data: PNG };
    },
  );
  assert.deepEqual(loads.sort(), ["chat-1/gone", "chat-1/photo"]);
  assert.deepEqual(ready, [
    { id: "photo", name: "photo.png", mimeType: "image/png", kind: "image", size: 70, data: PNG },
    text,
    { id: "inline", name: "inline.png", mimeType: "image/png", kind: "image", size: 70, data: PNG },
  ]);
});
