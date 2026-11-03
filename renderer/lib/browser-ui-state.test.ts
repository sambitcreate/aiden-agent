import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { acceptBrowserState, BROWSER_DEVICE_PRESETS, BROWSER_NATIVE_OCCLUDER_SELECTOR, browserAnnotationRegion, browserOcclusionMutated, browserOcclusionScrolled, browserBoundsFromRect, browserElementAtPoint, browserNativeViewObstructed, enqueueBrowserPresentation, resizeBrowserViewport, savedBrowserScreenshotPath, validBrowserViewport, visibleBrowserNativeOccluders } from "./browser-ui-state.js";
import type { BrowserElement, BrowserState } from "../shared/browser.js";
import { browserAnnotationCropBounds } from "./browser-annotation-capture.js";

test("browser updates reject another workspace and an older revision", () => {
  const current = { workspaceId: "a", revision: 5 } as BrowserState;
  assert.equal(acceptBrowserState(current, { workspaceId: "b", revision: 8 } as BrowserState, "a"), current);
  assert.equal(acceptBrowserState(current, { workspaceId: "a", revision: 4 } as BrowserState, "a"), current);
  const next = { workspaceId: "a", revision: 6 } as BrowserState;
  assert.equal(acceptBrowserState(current, next, "a"), next);
});

test("device dimensions have bounded area and lock ratio without accepting invalid edits", () => {
  assert.equal(BROWSER_DEVICE_PRESETS.length, 17);
  for (const [, width, height] of BROWSER_DEVICE_PRESETS) assert.ok(validBrowserViewport(width, height));
  assert.equal(validBrowserViewport(3840, 3840), false);
  assert.equal(validBrowserViewport(239, 240), false);
  assert.equal(validBrowserViewport(Infinity, 720), false);
  const viewport = { mode: "responsive" as const, width: 800, height: 600, ratioLocked: true };
  assert.deepEqual(resizeBrowserViewport(viewport, 1200, 600), { ...viewport, width: 1200, height: 900 });
  assert.deepEqual(resizeBrowserViewport(viewport, 800, 900, "height"), { ...viewport, width: 1200, height: 900 });
  assert.equal(resizeBrowserViewport(viewport, 200, 600), null);
});

test("annotations normalize reverse drags and pick the smallest enclosing element", () => {
  assert.deepEqual(browserAnnotationRegion({ x: 50, y: 80 }, { x: 10, y: 20 }), { x: 10, y: 20, width: 40, height: 60 });
  const outer = { ref: "outer", bounds: { x: 0, y: 0, width: 100, height: 100 } } as BrowserElement;
  const inner = { ref: "inner", bounds: { x: 5, y: 5, width: 20, height: 20 } } as BrowserElement;
  assert.equal(browserElementAtPoint([outer, inner], { x: 10, y: 10 }), inner);
  assert.equal(browserElementAtPoint([outer, inner], { x: 110, y: 110 }), null);
});

test("native browser stays visible unless an overlay actually covers its slot", () => {
  const host = { x: 800, y: 40, width: 400, height: 600 };
  assert.equal(browserNativeViewObstructed(host, [{ x: 80, y: 420, width: 320, height: 220 }]), false);
  assert.equal(browserNativeViewObstructed(host, [{ x: 790, y: 100, width: 40, height: 40 }]), true);
  assert.equal(browserNativeViewObstructed(host, [{ x: 0, y: 0, width: 1920, height: 1080 }]), true);
  assert.equal(browserNativeViewObstructed(host, [{ x: 800, y: 40, width: 0, height: 600 }]), false);
  assert.match(BROWSER_NATIVE_OCCLUDER_SELECTOR, /data-slot="popover-content"/u);
  assert.match(BROWSER_NATIVE_OCCLUDER_SELECTOR, /data-slot="dialog-overlay"/u);
  assert.match(BROWSER_NATIVE_OCCLUDER_SELECTOR, /data-browser-occluder/u);
  assert.match(BROWSER_NATIVE_OCCLUDER_SELECTOR, /\[role="listbox"\]/u);
});

type FakeRect = { x: number; y: number; width: number; height: number };
class FakeElement {
  readonly children: FakeElement[] = [];
  constructor(readonly attrs: Record<string, string>, readonly rect: FakeRect, readonly parent: FakeElement | null = null) {
    parent?.children.push(this);
  }
  hasAttribute(name: string) { return name in this.attrs; }
  getBoundingClientRect() { return this.rect; }
  // Attribute-only CSS subset used by the occluder filter: lists, `[a]`, `[a="v"]`, `:not(...)`.
  matches(selector: string): boolean {
    if (selector === ":popover-open") return false;
    return selector.split(/,\s*(?![^()]*\))/u).some((compound) => {
      const parts = compound.trim().match(/:not\((\[[^\]]+\])\)|\[[^\]]+\]/gu) ?? [];
      return parts.length > 0 && parts.every((part) => part.startsWith(":not(")
        ? !this.matches(part.slice(5, -1))
        : (([, name, value]) => name in this.attrs && (value === undefined || this.attrs[name] === value))(
          part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/u) ?? [],
        ));
    });
  }
  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}

test("a modal's aria-hidden full-window overlay still occludes a browser outside the dialog", () => {
  const viewport = { x: 0, y: 0, width: 1600, height: 900 };
  const body = new FakeElement({}, viewport);
  // Radix `hideOthers(content)` marks the overlay's portal and the app root.
  const overlayPortal = new FakeElement({ "aria-hidden": "true", "data-aria-hidden": "true" }, viewport, body);
  new FakeElement({ "data-slot": "dialog-overlay", "data-state": "open" }, viewport, overlayPortal);
  const contentPortal = new FakeElement({}, viewport, body);
  const content = new FakeElement({ role: "dialog", "data-slot": "dialog-content", "data-state": "open" }, { x: 560, y: 300, width: 480, height: 300 }, contentPortal);
  const app = new FakeElement({ "aria-hidden": "true", "data-aria-hidden": "true" }, viewport, body);
  // A genuinely aria-hidden surface (e.g. an exiting slash palette) never occludes.
  new FakeElement({ "data-browser-occluder": "", "aria-hidden": "true" }, { x: 1200, y: 600, width: 300, height: 200 }, app);
  new FakeElement({ role: "menu", "data-state": "closed" }, { x: 1200, y: 100, width: 200, height: 200 }, body);

  const browserSlot = { x: 1100, y: 40, width: 480, height: 820 };
  assert.equal(browserNativeViewObstructed(browserSlot, [content.getBoundingClientRect()]), false);
  const occluders = visibleBrowserNativeOccluders(body as unknown as ParentNode) as unknown as FakeElement[];
  assert.deepEqual(occluders.map((element) => element.attrs["data-slot"]), ["dialog-overlay", "dialog-content"]);
  assert.equal(browserNativeViewObstructed(browserSlot, occluders.map((element) => element.getBoundingClientRect())), true);
});

test("only mutations near the browser slot or its occluders ask for a new presentation", async () => {
  const window = new Window();
  const { document } = window;
  document.body.innerHTML = `
    <main id="split">
      <section id="chat"><div id="transcript"><p id="reply">Hello</p></div></section>
      <aside id="panel"><div id="host"></div></aside>
    </main>
    <div id="portal"><div role="menu" data-state="open" id="menu"><div id="item">One</div></div></div>`;
  const byId = (id: string) => document.getElementById(id)!;
  const host = byId("host") as unknown as Node;
  const menu = byId("menu") as unknown as Node;
  const records: MutationRecord[] = [];
  const observer = new window.MutationObserver((batch) => { records.push(...(batch as unknown as MutationRecord[])); });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "aria-hidden", "inert", "style"] });
  const mutated = async (change: () => void, occluders: Node[] = [menu]) => {
    records.length = 0;
    change();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(records.length > 0, "the change should be observed");
    return browserOcclusionMutated(records, host, occluders);
  };

  // A streaming reply grows and its reveal styles change: no occlusion can follow.
  assert.equal(await mutated(() => { byId("reply").appendChild(document.createElement("span")).textContent = "token"; }), false);
  assert.equal(await mutated(() => { byId("reply").setAttribute("style", "opacity: .5"); }), false);
  // Things that move the slot or change what covers it still do.
  assert.equal(await mutated(() => { byId("panel").setAttribute("style", "width: 300px"); }), true);
  assert.equal(await mutated(() => { byId("chat").setAttribute("style", "width: 300px"); }), true);
  assert.equal(await mutated(() => { byId("menu").setAttribute("data-state", "closed"); }), true);
  assert.equal(await mutated(() => { byId("item").setAttribute("style", "height: 400px"); }), true);
  assert.equal(await mutated(() => { byId("portal").setAttribute("aria-hidden", "true"); }), true);
  assert.equal(await mutated(() => { byId("portal").remove(); }), true);
  const dialog = document.createElement("div");
  dialog.innerHTML = `<div role="dialog"></div>`;
  assert.equal(await mutated(() => { document.body.appendChild(dialog); }), true);
  // A previously visible occluder without a matching selector any more (popover removed).
  const popover = document.createElement("div");
  byId("transcript").appendChild(popover);
  assert.equal(await mutated(() => { popover.setAttribute("style", "top: 10px"); }, [menu, popover as unknown as Node]), true);
  observer.disconnect();

  // Scrolling the transcript beside the browser cannot move either; the page or the panel can.
  assert.equal(browserOcclusionScrolled(byId("transcript") as unknown as EventTarget, host, [menu]), false);
  assert.equal(browserOcclusionScrolled(byId("panel") as unknown as EventTarget, host, [menu]), true);
  assert.equal(browserOcclusionScrolled(document as unknown as EventTarget, host, [menu]), true);
  await window.happyDOM.close();
});

test("native presentation never receives empty or nonfinite geometry", () => {
  assert.equal(browserBoundsFromRect({ x: 0, y: 0, width: 0, height: 10 }), null);
  assert.equal(browserBoundsFromRect({ x: NaN, y: 0, width: 10, height: 10 }), null);
  assert.deepEqual(browserBoundsFromRect({ x: 12.4, y: 40.6, width: 345.7, height: 299.2 }), { x: 12, y: 41, width: 346, height: 299 });
});

test("an old view's delayed hide cannot overtake its replacement's show", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const old = enqueueBrowserPresentation("owner:tab", async () => { calls.push("old-show"); await blocked; });
  const hide = enqueueBrowserPresentation("owner:tab", async () => { calls.push("old-hide"); });
  const next = enqueueBrowserPresentation("owner:tab", async () => { calls.push("new-show"); });
  await Promise.resolve(); release(); await Promise.all([old, hide, next]);
  assert.deepEqual(calls, ["old-show", "old-hide", "new-show"]);
  await assert.rejects(enqueueBrowserPresentation("owner:tab", async () => { throw new Error("gone"); }));
  await enqueueBrowserPresentation("owner:tab", async () => { calls.push("retry"); });
  assert.equal(calls[calls.length - 1], "retry");
});

test("annotation crops combine scaled DOM bounds with drawn regions and clamp to captured frame", () => {
  const snapshot = { tab: { viewport: { width: 500, height: 400 } } } as import("../shared/browser.js").BrowserSnapshot;
  const annotation = { url: "http://localhost", comment: "", image: { data: "", mimeType: "image/png" as const, width: 1000, height: 800 }, elements: [{ bounds: { x: 10, y: 20, width: 30, height: 40 } } as BrowserElement], regions: [{ x: 200, y: 300, width: 40, height: 30 }], strokes: [] };
  assert.deepEqual(browserAnnotationCropBounds(annotation, snapshot), { x: 12, y: 32, width: 236, height: 306 });
  assert.deepEqual(browserAnnotationCropBounds({ ...annotation, elements: [], regions: [{ x: -10, y: -20, width: 1040, height: 850 }] }, snapshot), { x: 0, y: 0, width: 1000, height: 800 });
  assert.equal(browserAnnotationCropBounds({ ...annotation, image: undefined }, snapshot), null);
});

test("canceling a screenshot Save dialog is not reported as a saved file", () => {
  const state = { workspaceId: "workspace", revision: 1 } as BrowserState;
  assert.equal(savedBrowserScreenshotPath(null), null);
  assert.equal(savedBrowserScreenshotPath({ state }), null);
  assert.equal(savedBrowserScreenshotPath({ state, value: { path: "" } }), null);
  assert.equal(savedBrowserScreenshotPath({ state, value: { path: "   " } }), null);
  assert.equal(savedBrowserScreenshotPath({ state, value: { path: 42 } }), null);
  assert.equal(savedBrowserScreenshotPath({ state, value: { path: "/tmp/browser-screenshot.png" } }), "/tmp/browser-screenshot.png");
});
