// A chat's view of the shared canvas: which page it looks at and where.

import assert from "node:assert/strict";
import test from "node:test";
import { emptyDesignCanvas } from "./schema.js";
import { chatPageId, DESIGN_FRESH_VIEWPORT, parseDesignChatView, viewPageId } from "./view.js";

const twoPages = { pages: [{ id: "a", name: "A" }, { id: "b", name: "B" }] };

test("viewPageId falls back to the first page when the view's page is gone, or there is no view", () => {
  assert.equal(viewPageId(twoPages, { pageId: "b" }), "b");
  assert.equal(viewPageId(twoPages, { pageId: "deleted-by-another-chat" }), "a");
  assert.equal(viewPageId(twoPages, {}), "a");
  assert.equal(viewPageId(twoPages, null), "a");
  assert.equal(viewPageId(twoPages), "a");
  assert.equal(viewPageId(emptyDesignCanvas(), undefined), "page-1");
});

test("chatPageId prefers the view's page, then the claim, then the first page, skipping pages that are gone", () => {
  const doc = { ...twoPages, pages: [...twoPages.pages, { id: "c", name: "C" }], chatPages: { "chat-1": "c", "chat-2": "gone" } };
  assert.equal(chatPageId(doc, { pageId: "b" }, "chat-1"), "b");
  assert.equal(chatPageId(doc, { pageId: "deleted" }, "chat-1"), "c");
  assert.equal(chatPageId(doc, null, "chat-1"), "c");
  assert.equal(chatPageId(doc, undefined, "chat-2"), "a", "a claim on a page that is gone is skipped");
  assert.equal(chatPageId(doc, { pageId: "deleted" }, "chat-3"), "a");
});

test("parseDesignChatView clamps zoom to 0.1–4 and refuses a missing pageId or a non-finite viewport", () => {
  assert.deepEqual(parseDesignChatView({ pageId: "a", viewport: { x: 10, y: -20, zoom: 9 } }), {
    pageId: "a",
    viewport: { x: 10, y: -20, zoom: 4 },
  });
  assert.equal(parseDesignChatView({ pageId: "a", viewport: { x: 0, y: 0, zoom: 0.001 } })?.viewport.zoom, 0.1);
  assert.deepEqual(
    parseDesignChatView({ pageId: "a", viewport: { x: 0, y: 0, zoom: 1 }, size: { w: 800, h: 600 } })?.size,
    { w: 800, h: 600 },
  );
  // A size that is not two positive finite numbers is left out, not fatal.
  assert.equal(parseDesignChatView({ pageId: "a", viewport: { x: 0, y: 0, zoom: 1 }, size: { w: -1, h: 5 } })?.size, undefined);

  for (const bad of [
    null,
    "view",
    [],
    { viewport: { x: 0, y: 0, zoom: 1 } },
    { pageId: "", viewport: { x: 0, y: 0, zoom: 1 } },
    { pageId: 4, viewport: { x: 0, y: 0, zoom: 1 } },
    { pageId: "a" },
    { pageId: "a", viewport: { x: Number.NaN, y: 0, zoom: 1 } },
    { pageId: "a", viewport: { x: 0, y: Number.POSITIVE_INFINITY, zoom: 1 } },
    { pageId: "a", viewport: { x: 0, y: 0, zoom: "1" } },
  ]) {
    assert.equal(parseDesignChatView(bad), null, JSON.stringify(bad));
  }
});

test("a fresh viewport looks at the origin at full size", () => {
  assert.deepEqual(DESIGN_FRESH_VIEWPORT, { x: 0, y: 0, zoom: 1 });
});
