// Main's record of each chat's canvas view: what Aiden's tools read as the
// page on screen, kept after the canvas unmounts.

import assert from "node:assert/strict";
import test from "node:test";
import type { DesignChatView } from "../../../renderer/shared/design-canvas/view.js";
import { DesignCanvasViews } from "./views.js";

const view = (pageId: string, x = 0): DesignChatView => ({ pageId, viewport: { x, y: 0, zoom: 1 } });

test("mounted counts only mounted canvases on that workspace", () => {
  const views = new DesignCanvasViews();
  views.set("chat-a", "ws-1", view("page-1"));
  views.set("chat-b", "ws-1", view("page-1"));
  views.set("chat-c", "ws-2", view("page-1"));
  assert.equal(views.mounted("ws-1"), 2);
  assert.equal(views.mounted("ws-2"), 1);
  views.set("chat-b", null, null);
  assert.equal(views.mounted("ws-1"), 1);
  assert.equal(views.mounted("ws-3"), 0);
  // Aiden showing a page for a chat with no canvas open does not count as one.
  views.showPage("chat-d", "ws-3", "page-2");
  assert.equal(views.mounted("ws-3"), 0);
});

test("set null keeps the last page but forget drops the chat", () => {
  const views = new DesignCanvasViews();
  views.set("chat-a", "ws-1", view("p2", 40));
  views.set("chat-a", null, null);
  assert.deepEqual(views.get("chat-a"), view("p2", 40), "the last page and viewport stay after unmount");
  views.forget("chat-a");
  assert.equal(views.get("chat-a"), undefined);
  assert.equal(views.kept("chat-a"), undefined);
  // An unmount for a chat main never heard of is nothing.
  views.set("never", null, null);
  assert.equal(views.get("never"), undefined);
});

test("switching chats A to B to A in one window restores A's kept page", () => {
  const views = new DesignCanvasViews();
  views.set("chat-a", "ws-1", view("pricing", 120));
  views.set("chat-a", null, null);
  views.set("chat-b", "ws-1", view("page-1"));
  views.set("chat-b", null, null);
  // The canvas for A asks main for A's view before it reads localStorage.
  assert.deepEqual(views.kept("chat-a"), { view: view("pricing", 120), focusId: 0 });
});

test("Aiden showing a page counts at once, with or without a canvas open, and keeps the canvas size", () => {
  const views = new DesignCanvasViews();
  assert.equal(views.showPage("chat-a", "ws-1", "p2"), 1);
  assert.deepEqual(views.get("chat-a"), { pageId: "p2", viewport: { x: 0, y: 0, zoom: 1 } });
  views.set("chat-a", "ws-1", { ...view("p2", 30), size: { w: 900, h: 600 } }, 1);
  assert.equal(views.showPage("chat-a", "ws-1", "p3"), 2);
  assert.deepEqual(views.get("chat-a"), { pageId: "p3", viewport: { x: 0, y: 0, zoom: 1 }, size: { w: 900, h: 600 } });
  // Showing the page it is already on keeps where it looks.
  views.set("chat-a", "ws-1", { ...view("p3", 70), size: { w: 900, h: 600 } }, 2);
  views.showPage("chat-a", "ws-1", "p3");
  assert.equal(views.get("chat-a")?.viewport.x, 70);
});

test("a report echoing an older focusId is ignored, and one that applied the latest is taken", () => {
  const views = new DesignCanvasViews();
  views.set("chat-a", "ws-1", view("page-1"), 0);
  const focusId = views.showPage("chat-a", "ws-1", "p2");
  // The renderer had not applied Aiden's page yet when it reported this pan.
  views.set("chat-a", "ws-1", view("page-1", 500), focusId - 1);
  assert.equal(views.get("chat-a")?.pageId, "p2");
  // A fresh mount that echoes nothing is ignored as well while Aiden's change is pending.
  views.set("chat-a", "ws-1", view("page-1", 500));
  assert.equal(views.get("chat-a")?.pageId, "p2");
  assert.equal(views.mounted("ws-1"), 1, "an ignored report still says the canvas is open");
  // Once the renderer applied it, its reports are the view again.
  views.set("chat-a", "ws-1", view("p2", 80), focusId);
  assert.deepEqual(views.get("chat-a"), view("p2", 80));
  assert.deepEqual(views.kept("chat-a"), { view: view("p2", 80), focusId });
});

test("when the window goes, every view is unmounted and every page kept", () => {
  const views = new DesignCanvasViews();
  views.set("chat-a", "ws-1", view("p2"));
  views.set("chat-b", "ws-2", view("p3"));
  views.unmountAll();
  assert.equal(views.mounted("ws-1"), 0);
  assert.equal(views.mounted("ws-2"), 0);
  assert.equal(views.get("chat-a")?.pageId, "p2");
  assert.equal(views.get("chat-b")?.pageId, "p3");
});
