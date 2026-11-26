import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  discardComposerDraft,
  loadComposerDraft,
  loadComposerDraftGrabbedElements,
  loadComposerDraftGrabbedThumbnails,
  restoreUnsentMessage,
  saveComposerDraftGrabbedElements,
  saveComposerDraftText,
  stageComposerText,
  subscribeRestoredUnsentMessage,
  subscribeStagedComposerText,
} from "./composer-draft-store";
import {
  GRABBED_ELEMENT_SCHEMA_VERSION,
  grabbedElementThumbnailId,
  type GrabbedElementContextV1,
} from "../shared/browser-element-grab";
import type { Attachment } from "./types";

beforeEach(() => localStorage.clear());

test("staged text joins a closed chat's saved draft", () => {
  saveComposerDraftText("chat-a", "My own words");
  stageComposerText("chat-a", "Tell me more about B");
  assert.equal(loadComposerDraft("chat-a").text, "My own words\n\nTell me more about B");
});

test("a mounted composer receives staged text instead of storage", () => {
  const received: string[] = [];
  const unsubscribe = subscribeStagedComposerText("chat-b", (text) => received.push(text));
  stageComposerText("chat-b", "Drill into EMEA");
  stageComposerText("chat-other", "Elsewhere");
  unsubscribe();
  stageComposerText("chat-b", "After unmount");
  assert.deepEqual(received, ["Drill into EMEA"]);
  assert.equal(loadComposerDraft("chat-b").text, "After unmount");
  assert.equal(loadComposerDraft("chat-other").text, "Elsewhere");
});

test("staging the same request once adds it a single time, while plain staging appends again", () => {
  const request = "Please retry the helper.";
  stageComposerText("chat-once", request, { once: true });
  stageComposerText("chat-once", request, { once: true });
  assert.equal(loadComposerDraft("chat-once").text, request);

  stageComposerText("chat-twice", request);
  stageComposerText("chat-twice", request);
  assert.equal(loadComposerDraft("chat-twice").text, `${request}\n\n${request}`);
});

test("grabbed elements and thumbnails stay in memory per chat and never write to localStorage", () => {
  const element: GrabbedElementContextV1 = {
    version: GRABBED_ELEMENT_SCHEMA_VERSION,
    id: "el-1",
    label: "<Hero />",
    framework: "react",
    tagName: "section",
    selector: "section.hero",
    htmlSnippet: "<section></section>",
    boundingBox: { x: 0, y: 0, width: 100, height: 50 },
    pageUrl: "http://localhost:3000/",
    thumbnailAttachmentId: grabbedElementThumbnailId("el-1"),
    capturedAt: 1,
  };
  const thumb: Attachment = {
    id: grabbedElementThumbnailId("el-1"),
    name: "Hero.png",
    kind: "image",
    mimeType: "image/png",
    size: 4,
    data: "iVBORw0KGgo=",
  };

  saveComposerDraftGrabbedElements("chat-grab", [element], [thumb]);
  assert.equal(localStorage.length, 0, "grabbed elements never write to localStorage");
  assert.equal(loadComposerDraftGrabbedElements("chat-grab")[0]?.id, "el-1");
  assert.equal(loadComposerDraftGrabbedThumbnails("chat-grab")[0]?.id, thumb.id);

  discardComposerDraft("chat-grab");
  assert.deepEqual(loadComposerDraftGrabbedElements("chat-grab"), []);
  assert.deepEqual(loadComposerDraftGrabbedThumbnails("chat-grab"), []);

  const restored: Array<{ text: string; grabbedIds: string[] }> = [];
  const unsubscribe = subscribeRestoredUnsentMessage("chat-live", (payload) => {
    restored.push({
      text: payload.text,
      grabbedIds: (payload.grabbedElements ?? []).map((item) => item.id),
    });
  });
  restoreUnsentMessage("chat-live", "Retry this", [thumb], [element]);
  unsubscribe();
  assert.deepEqual(restored, [{ text: "Retry this", grabbedIds: ["el-1"] }]);

  restoreUnsentMessage("chat-closed", "Later", [thumb], [element]);
  assert.equal(loadComposerDraftGrabbedElements("chat-closed")[0]?.id, "el-1");
  discardComposerDraft("chat-closed");
});
