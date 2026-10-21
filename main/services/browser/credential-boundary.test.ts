import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserImage, BrowserSnapshot, BrowserTab } from "../../../renderer/shared/browser.js";
import {
  BROWSER_IMAGE_OMITTED,
  maskBrowserSnapshotImage,
  scrubBrowserSnapshot,
  type BoundaryViewport,
  type CredentialBoundaryPort,
} from "./credential-boundary.js";
import type { CdpDomNode, CssRect } from "./credential-fields.js";
import { CREDENTIAL_MASK_GRAY, type RawBitmap } from "./credential-mask.js";

const PASSWORD = 11, NAME = 12, FRAME = 13;

/** A page with a password field and a name field, whose layout a test can move. */
function fakePage(options: { frame?: boolean } = {}) {
  const boxes = new Map<number, CssRect>([
    [PASSWORD, { x: 10, y: 10, width: 20, height: 10 }],
    [NAME, { x: 10, y: 40, width: 20, height: 10 }],
    [FRAME, { x: 0, y: 60, width: 50, height: 30 }],
  ]);
  const page = {
    revision: "1:1",
    viewport: { width: 100, height: 100, scale: 1, scrollX: 0, scrollY: 0 } as BoundaryViewport,
    boxes,
    captures: 0,
    encoded: [] as RawBitmap[],
    failCdp: false,
    afterCapture: undefined as (() => void) | undefined,
  };
  const tree = (): CdpDomNode => ({
    backendNodeId: 1, nodeType: 9, nodeName: "#document",
    children: [
      { backendNodeId: PASSWORD, nodeType: 1, nodeName: "INPUT", localName: "input", attributes: ["type", "password"] },
      { backendNodeId: NAME, nodeType: 1, nodeName: "INPUT", localName: "input", attributes: ["autocomplete", "name"] },
      ...(options.frame ? [{ backendNodeId: FRAME, nodeType: 1, nodeName: "IFRAME", localName: "iframe" }] : []),
    ],
  });
  const port: CredentialBoundaryPort = {
    cdp: {
      async send(method, params) {
        if (page.failCdp) throw new Error("Target closed");
        if (method === "DOM.getDocument") return { root: tree() };
        if (method === "DOM.getContentQuads") {
          const box = boxes.get((params as { backendNodeId: number }).backendNodeId);
          if (!box) throw new Error("Could not compute content quads.");
          const { x, y, width, height } = box;
          return { quads: [[x, y, x + width, y, x + width, y + height, x, y + height]] };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
    viewport: async () => ({ ...page.viewport }),
    documentRevision: () => page.revision,
    async capture(): Promise<BrowserImage> {
      page.captures += 1;
      page.afterCapture?.();
      return { data: "captured", mimeType: "image/png", width: 200, height: 200 };
    },
    // A 2x capture of the 100×100 viewport, every pixel white.
    decode: () => ({ width: 200, height: 200, data: new Uint8Array(200 * 200 * 4).fill(255) }),
    encode(bitmap) {
      page.encoded.push(bitmap);
      return { data: "masked", mimeType: "image/png", width: bitmap.width, height: bitmap.height };
    },
  };
  return { page, port };
}

function isGray(bitmap: RawBitmap, x: number, y: number): boolean {
  const at = (y * bitmap.width + x) * 4;
  return bitmap.data[at] === CREDENTIAL_MASK_GRAY && bitmap.data[at + 3] === 255;
}

test("the password field is painted over in the image and the name field is not", async () => {
  const { page, port } = fakePage();
  const result = await maskBrowserSnapshotImage(port);
  assert.ok("image" in result);
  assert.equal(result.image.data, "masked");
  assert.equal(result.masked, 1);
  assert.deepEqual([...result.sensitive], [PASSWORD]);
  const [bitmap] = page.encoded;
  assert.ok(bitmap);
  for (let y = 20; y < 40; y += 1) for (let x = 20; x < 60; x += 1) assert.ok(isGray(bitmap, x, y), `${x},${y}`);
  assert.equal(isGray(bitmap, 30, 90), false, "the name field stays visible");
});

test("a field that moved during capture is covered along its whole path", async () => {
  const { page, port } = fakePage();
  page.afterCapture = () => page.boxes.set(PASSWORD, { x: 60, y: 10, width: 20, height: 10 });
  const result = await maskBrowserSnapshotImage(port);
  assert.ok("image" in result);
  const [bitmap] = page.encoded;
  assert.ok(bitmap);
  // Before (10..30), after (60..80) and the stretch between them, at 2x.
  for (const x of [25, 90, 140]) assert.ok(isGray(bitmap, x, 30), `x ${x}`);
});

test("a visible frame that can't be inspected drops the image before anything is captured", async () => {
  const { page, port } = fakePage({ frame: true });
  const result = await maskBrowserSnapshotImage(port);
  assert.deepEqual(result, { omitted: BROWSER_IMAGE_OMITTED.frame, sensitive: new Set([PASSWORD]) });
  assert.equal(page.captures, 0);
});

test("a frame that scrolled out of view no longer blocks the image", async () => {
  const { page, port } = fakePage({ frame: true });
  page.boxes.set(FRAME, { x: 0, y: 120, width: 50, height: 30 });
  assert.ok("image" in (await maskBrowserSnapshotImage(port)));
});

test("navigation, scrolling or zoom during capture leaves the image out", async () => {
  const navigated = fakePage();
  navigated.page.afterCapture = () => { navigated.page.revision = "2:1"; };
  const navigatedResult = await maskBrowserSnapshotImage(navigated.port);
  assert.ok("omitted" in navigatedResult);
  assert.equal(navigatedResult.omitted, BROWSER_IMAGE_OMITTED.changed);

  const scrolled = fakePage();
  scrolled.page.afterCapture = () => { scrolled.page.viewport.scrollY = 30; };
  const scrolledResult = await maskBrowserSnapshotImage(scrolled.port);
  assert.ok("omitted" in scrolledResult);
  assert.equal(scrolledResult.omitted, BROWSER_IMAGE_OMITTED.changed);

  const zoomed = fakePage();
  zoomed.page.viewport.scale = 1.5;
  const zoomedResult = await maskBrowserSnapshotImage(zoomed.port);
  assert.ok("omitted" in zoomedResult);
  assert.equal(zoomedResult.omitted, BROWSER_IMAGE_OMITTED.zoom);
  assert.equal(zoomed.page.captures, 0);
});

test("a page whose fields can't be read gets no image", async () => {
  const { page, port } = fakePage();
  page.failCdp = true;
  const result = await maskBrowserSnapshotImage(port);
  assert.ok("omitted" in result);
  assert.equal(result.omitted, BROWSER_IMAGE_OMITTED.unreadable);
  assert.equal(page.captures, 0);
});

test("a page without sensitive fields keeps its capture untouched", async () => {
  const { page, port } = fakePage();
  page.boxes.delete(PASSWORD);
  const result = await maskBrowserSnapshotImage(port);
  assert.ok("image" in result);
  assert.equal(result.image.data, "captured");
  assert.equal(page.encoded.length, 0);
});

test("scrubbing drops a sensitive field's value, value text and rendered text, and nothing else", () => {
  const snapshot: BrowserSnapshot = {
    tab: {} as BrowserTab,
    text: "Sign in",
    diagnostics: [],
    elements: [
      { ref: "1-0", tag: "input", text: "Password", selector: "#pw", bounds: { x: 0, y: 0, width: 1, height: 1 }, attributes: { type: "password", placeholder: "Password" } },
      { ref: "1-1", tag: "div", text: "482913", selector: "#otp", bounds: { x: 0, y: 0, width: 1, height: 1 }, attributes: { autocomplete: "one-time-code" } },
      { ref: "1-2", tag: "input", text: "Email", selector: "#email", bounds: { x: 0, y: 0, width: 1, height: 1 }, attributes: { type: "email" } },
    ],
    accessibilityTree: {
      nodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "5", "7"] },
        { nodeId: "2", backendDOMNodeId: 40, role: { value: "textbox" }, name: { value: "Code" }, value: { type: "string", value: "482913" }, properties: [{ name: "valuetext", value: { value: "482913" } }, { name: "focused", value: { value: true } }], childIds: ["3"] },
        { nodeId: "3", role: { value: "generic" }, childIds: ["4"] },
        { nodeId: "4", role: { value: "StaticText" }, name: { value: "482913" } },
        { nodeId: "5", backendDOMNodeId: 41, role: { value: "textbox" }, name: { value: "Email" }, value: { type: "string", value: "ada@example.com" }, childIds: ["6"] },
        { nodeId: "6", role: { value: "StaticText" }, name: { value: "ada@example.com" } },
        { nodeId: "7", role: { value: "button" }, name: { value: "Continue" } },
      ],
    },
  };
  const scrubbed = scrubBrowserSnapshot(snapshot, new Set([40]));
  const serialized = JSON.stringify(scrubbed);
  assert.doesNotMatch(serialized, /482913/u);
  assert.match(serialized, /ada@example\.com/u, "ordinary fields keep their values");
  const nodes = (scrubbed.accessibilityTree as { nodes: Array<{ nodeId: string; name?: unknown; properties?: Array<{ name: string }> }> }).nodes;
  assert.deepEqual(nodes.map(({ nodeId }) => nodeId), ["1", "2", "5", "6", "7"]);
  const code = nodes.find(({ nodeId }) => nodeId === "2")!;
  assert.deepEqual(code.name, { value: "Code" }, "the field keeps its label");
  assert.deepEqual(code.properties?.map(({ name }) => name), ["focused"]);
  assert.deepEqual(scrubbed.elements.map(({ text }) => text), ["Password", "", "Email"]);
});
