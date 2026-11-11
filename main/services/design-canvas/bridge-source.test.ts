// The bridge script, run in a happy-dom page with a stand-in parent: what it
// tells the canvas, and that it answers only its parent. happy-dom has no
// layout, so `elementFromPoint` is stubbed to return a chosen element.

import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { parseDesignBridgeMessage, type DesignBridgeMessage } from "../../../renderer/shared/design-canvas/bridge-messages.js";
import { DESIGN_BRIDGE_SOURCE } from "./bridge-source.js";

type Page = {
  window: Window;
  sent: DesignBridgeMessage[];
  send(data: unknown, source?: unknown): void;
  pointAt(selector: string | null): void;
};

function page(html: string, url = "aiden-design://grant/design/page.html"): Page {
  const window = new Window({ url });
  window.document.write(html);
  const sent: DesignBridgeMessage[] = [];
  const parent = {
    postMessage(data: unknown) {
      const message = parseDesignBridgeMessage(JSON.parse(JSON.stringify(data)));
      assert.ok(message, `the canvas can read ${JSON.stringify(data)}`);
      sent.push(message);
    },
  };
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  let pointed: unknown = null;
  window.document.elementFromPoint = () => pointed as never;
  new Function("window", DESIGN_BRIDGE_SOURCE)(window);
  return {
    window,
    sent,
    send(data, source = parent) {
      const event = new window.MessageEvent("message", { data });
      Object.defineProperty(event, "source", { value: source });
      window.dispatchEvent(event);
    },
    pointAt(selector) {
      pointed = selector ? window.document.querySelector(selector) : null;
    },
  };
}

const last = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];

const HERO = `<!doctype html><html><head><title>Hero</title></head><body>
  <main>
    <section data-aiden-src="design/hero.html:3"><h1>Ship   faster</h1><p>One</p><p>Two <b>bold</b></p></section>
    <section id="pricing" data-aiden-comment="c-old c-9"><h2>Pricing</h2><button aria-label="Buy now"></button></section>
  </main>
</body></html>`;

test("a pick describes the element under the point: selector, text, tag, nearest stamp and comment id", () => {
  const view = page(HERO);
  view.pointAt("section p:nth-of-type(2)");
  view.send({ type: "aiden-design:pick-at", requestId: "r1", x: 10, y: 20 });
  const picked = view.sent.find((message) => message.type === "picked");
  assert.ok(picked && picked.type === "picked");
  assert.equal(picked.requestId, "r1");
  assert.deepEqual(picked.point, [10, 20]);
  assert.equal(picked.element?.tag, "p");
  assert.equal(picked.element?.text, "Two bold");
  assert.equal(picked.element?.sourcePath, "design/hero.html:3");
  assert.equal(picked.element?.commentId, undefined);
  assert.equal(view.window.document.querySelectorAll(picked.element!.selector).length, 1, "the selector names one element");
  assert.equal(view.window.document.querySelector(picked.element!.selector)?.textContent, "Two bold");

  view.pointAt("#pricing button");
  view.send({ type: "aiden-design:pick-at", requestId: "r2", x: 1, y: 1 });
  const button = last(view.sent);
  assert.ok(button?.type === "picked");
  assert.equal(button.element?.selector, "#pricing > button");
  assert.equal(button.element?.text, "Buy now", "an element without text is named by its label");
  assert.equal(button.element?.commentId, "c-old");

  view.send({ type: "aiden-design:pick-at", requestId: "r3", x: 1, y: 1, wide: true });
  const wide = last(view.sent);
  assert.ok(wide?.type === "picked");
  assert.equal(wide.element?.selector, "#pricing", "Alt picks the parent");

  view.pointAt(null);
  view.send({ type: "aiden-design:pick-at", requestId: "r4", x: 1, y: 1 });
  const nothing = last(view.sent);
  assert.ok(nothing?.type === "picked");
  assert.equal(nothing.element, null);
});

test("locate finds an element by its comment id first, else lists candidates with the selector match marked", () => {
  const view = page(HERO);
  view.send({
    type: "aiden-design:locate",
    requestId: "l1",
    items: [
      { commentId: "c-9", selector: "nope", text: "", tag: "div" },
      { commentId: "c-new", selector: "main > section:nth-of-type(1) > h1", text: "Ship faster", tag: "h1" },
      { commentId: "c-bad", selector: "::not a selector((", text: "Pricing", tag: "h3" },
    ],
  });
  const anchors = view.sent.find((message) => message.type === "anchors");
  assert.ok(anchors && anchors.type === "anchors");
  assert.equal(anchors.requestId, "l1");
  assert.equal(anchors.results["c-9"]?.byId?.selector, "#pricing");
  const heading = anchors.results["c-new"]!;
  assert.equal(heading.byId, undefined);
  assert.deepEqual(heading.candidates.map((candidate) => [candidate.tag, candidate.selectorMatch]), [["h1", true]]);
  const bad = anchors.results["c-bad"]!;
  assert.ok(
    bad.candidates.some((candidate) => candidate.tag === "h2" && candidate.text === "Pricing" && !candidate.selectorMatch),
    "an element with the same text is a candidate",
  );
  assert.ok(bad.candidates.every((candidate) => candidate.text === "Pricing"));
});

test("the hover outline and highlight are drawn inside the page and never picked", () => {
  const view = page(HERO);
  const boxes = () => view.window.document.querySelectorAll("[data-aiden-bridge]").length;
  view.pointAt("h1");
  view.send({ type: "aiden-design:hover-at", x: 5, y: 5 });
  assert.equal(boxes(), 1);
  view.send({ type: "aiden-design:highlight", commentId: "c-9" });
  assert.equal(boxes(), 2);
  view.pointAt("[data-aiden-bridge]");
  view.send({ type: "aiden-design:pick-at", requestId: "r", x: 5, y: 5 });
  const picked = last(view.sent);
  assert.ok(picked?.type === "picked");
  assert.equal(picked.element, null, "the outline itself is not an element of the design");
  view.send({ type: "aiden-design:highlight", clear: true });
  assert.equal(boxes(), 0, "picking cleared the hover and clearing removed the highlight");
});

test("the bridge answers only its parent", () => {
  const view = page(HERO);
  view.pointAt("h1");
  const before = view.sent.length;
  view.send({ type: "aiden-design:pick-at", requestId: "x", x: 1, y: 1 }, {});
  view.send({ type: "aiden-design:locate", requestId: "y", items: [] }, null);
  assert.equal(view.sent.length, before);
});

test("the canvas refuses malformed bridge messages", () => {
  assert.equal(parseDesignBridgeMessage({ type: "aiden-design:ready", docHeight: -1 }), null);
  assert.equal(parseDesignBridgeMessage({ type: "ready", docHeight: 10 }), null);
  assert.equal(
    parseDesignBridgeMessage({ type: "aiden-design:picked", requestId: "r", point: [1, 2], element: { selector: "a", text: "", tag: "<script>", rect: { x: 0, y: 0, w: 1, h: 1 } } }),
    null,
  );
  const picked = parseDesignBridgeMessage({
    type: "aiden-design:picked",
    requestId: "r",
    point: [1, 2],
    element: { selector: "a", text: "x".repeat(500), tag: "a", rect: { x: 0, y: 0, w: 1, h: 1 }, sourcePath: "/etc/passwd:1" },
  });
  assert.ok(picked?.type === "picked");
  assert.equal(picked.element?.text.length, 200);
  assert.equal(picked.element?.sourcePath, undefined);
});

const THEMED = `<!doctype html><html data-theme="light" data-density="cozy" style="--accent: #111111"><head></head><body><p>Hi</p></body></html>`;

test("set-tweaks puts dark mode and the values on the root, and anything left out goes back to what the page had", () => {
  const view = page(THEMED);
  const root = view.window.document.documentElement;
  view.send({
    type: "aiden-design:set-tweaks",
    dark: true,
    vars: { "--accent": "#ff0055", "--radius": "12px" },
    attrs: { "data-density": "compact", "data-promo": "false" },
  });
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(root.style.getPropertyValue("--accent"), "#ff0055");
  assert.equal(root.style.getPropertyValue("--radius"), "12px");
  assert.equal(root.getAttribute("data-density"), "compact");
  assert.equal(root.getAttribute("data-promo"), "false");

  view.send({ type: "aiden-design:set-tweaks", dark: false, vars: { "--radius": "4px" }, attrs: {} });
  assert.equal(root.getAttribute("data-theme"), "light", "the page's own theme comes back");
  assert.equal(root.style.getPropertyValue("--accent"), "#111111");
  assert.equal(root.style.getPropertyValue("--radius"), "4px");
  assert.equal(root.getAttribute("data-density"), "cozy");
  assert.equal(root.hasAttribute("data-promo"), false);

  view.send({ type: "aiden-design:set-tweaks", dark: true, vars: {}, attrs: {} });
  view.send({ type: "aiden-design:set-tweaks", dark: false, vars: {}, attrs: {} });
  assert.equal(root.getAttribute("data-theme"), "light", "a second round trip still restores the page's theme");
  assert.equal(root.style.getPropertyValue("--radius"), "");
});

test("set-tweaks takes only safe names and values, and only from the canvas", () => {
  const view = page(THEMED);
  const root = view.window.document.documentElement;
  view.send({
    type: "aiden-design:set-tweaks",
    dark: false,
    vars: { "--ok": "1", color: "red", "--bad": "red; background: url(x)" },
    attrs: { onclick: "alert(1)", "data-x": "<b>", "data-y": "yes" },
  });
  assert.equal(root.style.getPropertyValue("--ok"), "1");
  assert.equal(root.style.getPropertyValue("--bad"), "");
  assert.equal(root.hasAttribute("onclick"), false);
  assert.equal(root.hasAttribute("data-x"), false);
  assert.equal(root.getAttribute("data-y"), "yes");

  view.send({ type: "aiden-design:set-tweaks", dark: true, vars: {}, attrs: {} }, { postMessage() {} });
  assert.equal(root.getAttribute("data-theme"), "light", "another window cannot change the page");
});

test("the page's address carries the same state, applied before the page draws", () => {
  const state = encodeURIComponent(JSON.stringify({ vars: { "--accent": "#00aa00" }, attrs: { "data-density": "compact" } }));
  const view = page(THEMED, `aiden-design://grant/design/page.html?v=2&aiden-dark=1&aiden-tweaks=${state}`);
  const root = view.window.document.documentElement;
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.equal(root.style.getPropertyValue("--accent"), "#00aa00");
  assert.equal(root.getAttribute("data-density"), "compact");
  view.send({ type: "aiden-design:set-tweaks", dark: false, vars: {}, attrs: {} });
  assert.equal(root.getAttribute("data-theme"), "light");
  assert.equal(root.style.getPropertyValue("--accent"), "#111111");
});

const EDITABLE_PAGE = `<!doctype html><html><head></head><body>
  <main data-aiden-src="design/page.html:1">
    <h1>Ship   faster</h1>
    <p>Two <b>bold</b> words</p>
  </main>
</body></html>`;

function dblclick(view: Page, selector: string): void {
  const target = view.window.document.querySelector(selector)!;
  target.dispatchEvent(new view.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
}

function key(view: Page, name: string): void {
  view.window.document.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

test("a double-click edits an element's words only while the canvas allows it, and Enter reports each changed text", () => {
  const view = page(EDITABLE_PAGE);
  const heading = view.window.document.querySelector("h1")!;
  dblclick(view, "h1");
  assert.equal(heading.hasAttribute("contenteditable"), false, "outside the page, a double-click edits nothing");

  view.send({ type: "aiden-design:edit-enable", on: true });
  dblclick(view, "h1");
  assert.equal(heading.getAttribute("contenteditable"), "true");
  const started = last(view.sent);
  assert.ok(started?.type === "edit-start");
  assert.equal(started.element.tag, "h1");
  assert.equal(started.element.sourcePath, "design/page.html:1");

  (heading.firstChild as unknown as { data: string }).data = "Ship sooner";
  // Chromium leaves an empty style attribute behind after select-all and typing.
  heading.setAttribute("style", "");
  key(view, "Enter");
  assert.equal(heading.hasAttribute("contenteditable"), false);
  const ended = last(view.sent);
  assert.ok(ended?.type === "edit-end");
  assert.equal(ended.cancelled, false);
  assert.equal(ended.plain, true);
  assert.deepEqual(ended.changes, [{ before: "Ship   faster", after: "Ship sooner" }], "a typed no-break space is a space");
  assert.equal(heading.hasAttribute("style"), false, "an empty style is no style");
});

test("a bold word is edited with its paragraph, Esc puts the words back, and a new tag is not a plain change", () => {
  const view = page(EDITABLE_PAGE);
  view.send({ type: "aiden-design:edit-enable", on: true });
  const paragraph = view.window.document.querySelector("p")!;
  dblclick(view, "p b");
  assert.equal(paragraph.getAttribute("contenteditable"), "true");
  paragraph.querySelector("b")!.textContent = "loud";
  key(view, "Escape");
  assert.equal(paragraph.innerHTML, "Two <b>bold</b> words");
  const cancelled = last(view.sent);
  assert.ok(cancelled?.type === "edit-end" && cancelled.cancelled);

  dblclick(view, "h1");
  view.send({ type: "aiden-design:edit-command", command: "block", value: "h2" });
  view.send({ type: "aiden-design:edit-finish", cancel: false });
  const ended = last(view.sent);
  assert.ok(ended?.type === "edit-end");
  assert.equal(ended.plain, false);
  assert.equal(ended.changes.length, 0);
  assert.match(ended.beforeHtml, /^<h1>/u);
  assert.match(ended.afterHtml, /^<h2>Ship {3}faster<\/h2>$/u);
  assert.equal(view.window.document.querySelector("h2")?.hasAttribute("contenteditable"), false);
});

test("leaving the page keeps an edit in progress", () => {
  const view = page(EDITABLE_PAGE);
  view.send({ type: "aiden-design:edit-enable", on: true });
  dblclick(view, "h1");
  view.window.document.querySelector("h1")!.textContent = "Ship today";
  view.send({ type: "aiden-design:edit-enable", on: false });
  const ended = last(view.sent);
  assert.ok(ended?.type === "edit-end");
  assert.deepEqual(ended.changes, [{ before: "Ship   faster", after: "Ship today" }]);
  dblclick(view, "h1");
  assert.equal(view.window.document.querySelector("h1")!.hasAttribute("contenteditable"), false);
});
