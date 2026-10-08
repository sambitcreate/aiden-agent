import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVICE_AX_ELEMENT_LIMIT,
  DeviceAxUnauthorizedError,
  axRectToDisplay,
  fetchDeviceAxTree,
  flattenIosAxTree,
  hitTestAxElements,
  type DeviceAxRect,
} from "./device-ax.js";

const GRANT = { origin: "http://127.0.0.1:4100", token: "tok", expiresAt: Date.now() + 60_000 };

const close = (actual: DeviceAxRect, expected: DeviceAxRect) => {
  for (const key of ["x", "y", "width", "height"] as const) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${actual[key]} ≈ ${expected[key]}`);
  }
};

const TREE = [
  {
    type: "Application",
    AXLabel: "Settings",
    frame: { x: 0, y: 0, width: 400, height: 800 },
    children: [
      { type: "Button", AXLabel: "General", AXUniqueId: "general", frame: { x: 40, y: 200, width: 320, height: 40 } },
      {
        type: "Other",
        frame: { x: 0, y: 0, width: 400, height: 800 },
        children: [{ type: "StaticText", AXLabel: "Wi-Fi", frame: { x: 60, y: 210, width: 80, height: 20 } }],
      },
      { type: "Image", frame: { x: 10, y: 10, width: 0, height: 10 } },
    ],
  },
];

test("the tree flattens to frames normalized to the root, skipping full-screen and empty nodes", () => {
  const { elements, root } = flattenIosAxTree(TREE);
  assert.deepEqual(root, { width: 400, height: 800 });
  assert.deepEqual(
    elements.map((element) => [element.id, element.role, element.label]),
    [
      ["general", "Button", "General"],
      ["0.1.0", "StaticText", "Wi-Fi"],
    ],
  );
  close(elements[0]!, { x: 0.1, y: 0.25, width: 0.8, height: 0.05 });
});

test("the tree is capped and repeated ids stay unique", () => {
  const children = Array.from({ length: DEVICE_AX_ELEMENT_LIMIT + 50 }, () => ({
    type: "Cell",
    AXUniqueId: "same",
    frame: { x: 1, y: 1, width: 10, height: 10 },
  }));
  const { elements } = flattenIosAxTree([{ frame: { x: 0, y: 0, width: 100, height: 100 }, children }]);
  assert.equal(elements.length, DEVICE_AX_ELEMENT_LIMIT);
  assert.equal(new Set(elements.map((element) => element.id)).size, elements.length);
});

test("frames stay put when the tree and the stream share the device's orientation", () => {
  const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
  close(axRectToDisplay(rect, { width: 400, height: 800 }, { width: 1179, height: 2556, orientation: "portrait" }), rect);
  // A rotated stream (landscape-shaped) with a landscape tree.
  close(axRectToDisplay(rect, { width: 800, height: 400 }, { width: 2556, height: 1179, orientation: "landscape_left" }), rect);
  close(axRectToDisplay(rect, null, null), rect);
});

test("interface frames turn into a raw portrait stream the same way touches do", () => {
  const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
  const raw = { width: 1179, height: 2556 };
  // landscape_left: raw = (y, 1 - x), so the rect's x span becomes the raw y span from the bottom.
  close(axRectToDisplay(rect, { width: 800, height: 400 }, { ...raw, orientation: "landscape_left" }), {
    x: 0.2,
    y: 0.6,
    width: 0.1,
    height: 0.3,
  });
  // landscape_right: raw = (1 - y, x).
  close(axRectToDisplay(rect, { width: 800, height: 400 }, { ...raw, orientation: "landscape_right" }), {
    x: 0.7,
    y: 0.1,
    width: 0.1,
    height: 0.3,
  });
  close(axRectToDisplay(rect, { width: 400, height: 800 }, { ...raw, orientation: "portrait_upside_down" }), {
    x: 0.6,
    y: 0.7,
    width: 0.3,
    height: 0.1,
  });
});

test("a portrait tree for a landscape device turns into a rotated stream", () => {
  const rect = { x: 0.2, y: 0.6, width: 0.1, height: 0.3 };
  // The inverse of the landscape_left case above: back to interface space.
  close(axRectToDisplay(rect, { width: 400, height: 800 }, { width: 2556, height: 1179, orientation: "landscape_left" }), {
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.1,
  });
});

test("hit testing picks the smallest element under the point", () => {
  const { elements } = flattenIosAxTree(TREE);
  assert.equal(hitTestAxElements(elements, { x: 0.2, y: 0.27 })?.label, "Wi-Fi");
  assert.equal(hitTestAxElements(elements, { x: 0.8, y: 0.27 })?.label, "General");
  assert.equal(hitTestAxElements(elements, { x: 0.5, y: 0.9 }), null);
});

test("the tree is fetched through the proxy, and helper errors are reported rather than thrown", async () => {
  const urls: string[] = [];
  const respond = (body: unknown, status = 200) => async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status });
  };
  const target = { hostId: "local", deviceId: "ABCD-1234", grant: GRANT };
  const signal = new AbortController().signal;
  const tree = await fetchDeviceAxTree(target, signal, { fetch: respond(TREE) });
  assert.equal(tree.elements.length, 2);
  assert.equal(urls[0], "http://127.0.0.1:4100/vendor/serve-sim/helper/ABCD-1234/ax?t=tok&host=local");

  const unavailable = await fetchDeviceAxTree(target, signal, {
    fetch: respond({ error: "ax_unavailable", message: "Accessibility is off" }, 503),
  });
  assert.deepEqual(unavailable, { elements: [], root: null, errors: ["Accessibility is off"] });
  await assert.rejects(fetchDeviceAxTree(target, signal, { fetch: respond({}, 401) }), DeviceAxUnauthorizedError);
});
