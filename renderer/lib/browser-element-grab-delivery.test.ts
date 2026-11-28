import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../shared/attachment-contract.js";
import {
  GRABBED_ELEMENT_SCHEMA_VERSION,
  grabbedElementThumbnailId,
  MAX_GRABBED_ELEMENTS_PER_MESSAGE,
  type GrabbedElementCapture,
  type GrabbedElementContextV1,
} from "../shared/browser-element-grab.js";
import {
  BrowserElementGrabDeliveryRegistry,
  grabbedElementThumbnailAttachments,
  materializeGrabbedElementDraft,
} from "./browser-element-grab-delivery.js";
import type { Attachment } from "./types.js";

// Valid 1x1 PNG header base64
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function makeElement(overrides: Partial<GrabbedElementContextV1> = {}): GrabbedElementContextV1 {
  const id = overrides.id ?? "el_1";
  return {
    version: GRABBED_ELEMENT_SCHEMA_VERSION,
    id,
    label: "<HeroCard />",
    framework: "react",
    componentName: "HeroCard",
    tagName: "div",
    selector: "main > div.hero-card",
    htmlSnippet: '<div class="hero-card">Hello</div>',
    boundingBox: { x: 0, y: 0, width: 200, height: 100 },
    pageUrl: "http://localhost:3000/",
    capturedAt: 1000,
    ...overrides,
  };
}

function makeCapture(
  overrides: Partial<GrabbedElementContextV1> = {},
  withThumbnail = true,
): GrabbedElementCapture {
  return {
    element: makeElement(overrides),
    ...(withThumbnail
      ? {
          thumbnail: {
            data: VALID_PNG_BASE64,
            mimeType: "image/png" as const,
            width: 200,
            height: 100,
          },
        }
      : {}),
  };
}

test("BrowserElementGrabDeliveryRegistry delivers once to the single available workspace composer", () => {
  const registry = new BrowserElementGrabDeliveryRegistry();
  const received: GrabbedElementCapture[] = [];
  registry.register({
    workspaceId: "ws-1",
    chatId: "chat-1",
    available: () => true,
    receive: (capture) => {
      received.push(capture);
      return true;
    },
  });
  const recipient = registry.capture("ws-1");
  assert.ok(recipient);
  assert.equal(recipient.chatId, "chat-1");
  const capture = makeCapture();
  assert.equal(recipient.deliver(capture), true);
  assert.equal(recipient.deliver(capture), false);
  assert.equal(received.length, 1);
});

test("materializeGrabbedElementDraft adds element + linked thumbnail and deduplicates in place", () => {
  const first = materializeGrabbedElementDraft(makeCapture({ id: "el_a" }), [], []);
  assert.equal(first.accepted, true);
  assert.equal(first.replaced, false);
  assert.equal(first.thumbnailSkipped, false);
  assert.equal(first.elements.length, 1);
  assert.equal(first.elements[0].thumbnailAttachmentId, grabbedElementThumbnailId("el_a"));
  assert.equal(first.attachments.length, 1);
  assert.equal(first.attachments[0].id, grabbedElementThumbnailId("el_a"));
  assert.equal(first.attachments[0].name, "HeroCard.png");

  // Re-grabbing the same element (same URL + selector + componentName) refreshes in place and replaces the old thumbnail.
  const refreshed = materializeGrabbedElementDraft(
    makeCapture({ id: "el_b", textPreview: "Updated" }),
    first.elements,
    first.attachments,
  );
  assert.equal(refreshed.accepted, true);
  assert.equal(refreshed.replaced, true);
  assert.equal(refreshed.elements.length, 1);
  assert.equal(refreshed.elements[0].id, "el_b");
  assert.equal(refreshed.elements[0].textPreview, "Updated");
  assert.equal(refreshed.attachments.length, 1);
  assert.equal(refreshed.attachments[0].id, grabbedElementThumbnailId("el_b"));
});

test("materializeGrabbedElementDraft enforces element limit and degrades thumbnail cleanly when attachment slots are full", () => {
  const fullAttachments: Attachment[] = Array.from(
    { length: MAX_ATTACHMENTS_PER_MESSAGE },
    (_, index) => ({
      id: `file_${index}`,
      name: `file_${index}.txt`,
      kind: "text",
      mimeType: "text/plain",
      text: "hello",
      size: 5,
    }),
  );
  const degraded = materializeGrabbedElementDraft(
    makeCapture({ id: "el_no_slot" }),
    [],
    fullAttachments,
  );
  assert.equal(degraded.accepted, true);
  assert.equal(degraded.thumbnailSkipped, true);
  assert.equal(degraded.elements[0].thumbnailAttachmentId, undefined);
  assert.equal(degraded.attachments.length, MAX_ATTACHMENTS_PER_MESSAGE);

  const fullElements = Array.from({ length: MAX_GRABBED_ELEMENTS_PER_MESSAGE }, (_, index) =>
    makeElement({ id: `el_${index}`, selector: `div.item-${index}` }),
  );
  const rejected = materializeGrabbedElementDraft(
    makeCapture({ id: "el_over", selector: "div.overflow" }),
    fullElements,
    [],
  );
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "limit");
  assert.equal(rejected.elements.length, MAX_GRABBED_ELEMENTS_PER_MESSAGE);
});

test("grabbedElementThumbnailAttachments rejects invalid image magic headers", () => {
  const bad = grabbedElementThumbnailAttachments(
    {
      element: makeElement({ id: "el_bad_img" }),
      thumbnail: { data: "AAAA", mimeType: "image/png", width: 10, height: 10 },
    },
    [],
  );
  assert.equal(bad.attachments.length, 0);
  assert.equal(bad.imageSkipped, true);
});
