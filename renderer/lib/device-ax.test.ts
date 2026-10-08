import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVICE_AX_ELEMENT_LIMIT,
  DeviceAxUnauthorizedError,
  axRectToDisplay,
  fetchDeviceAxTree,
  flattenAndroidAxSnapshot,
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

/** serve-emu's `/api/accessibility` snapshot: a flattened `uiautomator dump`, bounds in pixels. */
const ANDROID_SNAPSHOT = {
  ok: true,
  capturedAt: "2026-10-08T09:41:00.000Z",
  screen: { width: 1080, height: 2400 },
  nodes: [
    { id: "0", text: "", contentDescription: "", resourceId: "", className: "android.widget.FrameLayout", bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } },
    { id: "1", text: "Sign in", contentDescription: "", resourceId: "com.example.shop:id/sign_in", className: "android.widget.Button", bounds: { left: 100, top: 2000, right: 980, bottom: 2160 } },
    { id: "2", text: "", contentDescription: "Profile", resourceId: "", className: "android.widget.ImageView", bounds: { left: 900, top: 120, right: 1020, bottom: 240 } },
    { id: "3", text: "", contentDescription: "", resourceId: "com.example.shop:id/title", className: "android.widget.TextView", bounds: { left: 60, top: 300, right: 1020, bottom: 400 } },
    { id: "4", text: "Broken", className: "android.view.View", bounds: { left: 10, top: 10, right: 5, bottom: 20 } },
  ],
};

test("an emulator's uiautomator nodes become normalized frames, labelled by text, description, or resource id", () => {
  const tree = flattenAndroidAxSnapshot(ANDROID_SNAPSHOT);
  assert.deepEqual(tree.root, { width: 1080, height: 2400 });
  // The full-screen root is skipped like iOS's application frame; an inverted box is dropped.
  assert.deepEqual(
    tree.elements.map((element) => [element.label, element.role]),
    [
      ["Sign in", "Button"],
      ["Profile", "ImageView"],
      ["title", "TextView"],
    ],
  );
  close(tree.elements[0]!, { x: 100 / 1080, y: 2000 / 2400, width: 880 / 1080, height: 160 / 2400 });
  // A point inside the button's pixels hits the button.
  assert.equal(hitTestAxElements(tree.elements, { x: 540 / 1080, y: 2080 / 2400 })?.label, "Sign in");

  // Without a screen size the furthest bound stands in, so frames still land in 0..1.
  const { screen: _screen, ...unsized } = ANDROID_SNAPSHOT;
  const fallback = flattenAndroidAxSnapshot(unsized);
  assert.deepEqual(fallback.root, { width: 1080, height: 2400 });
  assert.deepEqual(flattenAndroidAxSnapshot({ ok: true, nodes: [] }), { elements: [], root: null });
  assert.deepEqual(flattenAndroidAxSnapshot("nonsense"), { elements: [], root: null });
});

test("a landscape emulator's dump lines up with a landscape stream without remapping", () => {
  // uiautomator reports rotated bounds, and serve-emu swaps the screen to match.
  const landscape = flattenAndroidAxSnapshot({
    ok: true,
    screen: { width: 2400, height: 1080 },
    nodes: [{ id: "0", text: "Play", className: "android.widget.Button", bounds: { left: 2000, top: 100, right: 2300, bottom: 300 } }],
  });
  const [play] = landscape.elements;
  const shown = axRectToDisplay(play!, landscape.root, { width: 2400, height: 1080, orientation: "landscape_left" });
  close(shown, { x: 2000 / 2400, y: 100 / 1080, width: 300 / 2400, height: 200 / 1080 });
});

test("an emulator's tree is read from serve-emu for that serial, and dump failures are reported", async () => {
  const urls: string[] = [];
  const respond = (body: unknown, status = 200) => async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status });
  };
  const target = { hostId: "local", deviceId: "emulator-5554", grant: GRANT, platform: "android" as const };
  const signal = new AbortController().signal;
  const tree = await fetchDeviceAxTree(target, signal, { fetch: respond(ANDROID_SNAPSHOT) });
  assert.equal(tree.elements.length, 3);
  assert.equal(urls[0], "http://127.0.0.1:4100/vendor/serve-emu/api/accessibility?device=emulator-5554&t=tok&host=local");
  const failed = await fetchDeviceAxTree(target, signal, {
    fetch: respond({ ok: false, error: "ERROR: could not get idle state." }, 400),
  });
  assert.deepEqual(failed, { elements: [], root: null, errors: ["ERROR: could not get idle state."] });
  await assert.rejects(fetchDeviceAxTree(target, signal, { fetch: respond({}, 401) }), DeviceAxUnauthorizedError);
});
