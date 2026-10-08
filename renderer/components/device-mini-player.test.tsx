import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceSummary } from "../shared/devices.js";
import { DeviceMiniPlayer } from "./device-mini-player.js";
import { AUTO_FLOAT_DEVICE_LABEL, DeviceWorkspaceSettingsView } from "./settings/device-workspace-settings.js";

const IPHONE: DeviceSummary = {
  hostId: "local",
  id: "UDID-1",
  name: "iPhone 17 Pro",
  platform: "ios",
  version: "iOS 27.0",
  booted: true,
  kind: "iphone",
};
const noop = () => undefined;

test("the floating player is a labelled, keyboard-reachable surface with Home, Rotate, Dock and Close", () => {
  const html = renderToStaticMarkup(
    <DeviceMiniPlayer device={IPHONE} title="Checkout flow" active={false} onDock={noop} onClose={noop} />,
  );
  assert.match(html, /aria-roledescription="floating device"/u);
  assert.match(html, /aria-labelledby="[^"]+"/u);
  assert.match(html, />Checkout flow</u);
  for (const name of ["Home", "Rotate", "Dock device in its tab", "Close floating device"]) {
    assert.match(html, new RegExp(`aria-label="${name}"`, "u"), name);
  }
  // The move handle and the screen both take focus; the screen takes touches and keys.
  assert.match(html, /role="group" aria-label="Move Checkout flow" tabindex="0"/u);
  assert.match(html, /tabindex="0" role="application" aria-roledescription="simulator screen"/u);
  // The screen is a reserved typing surface, so the composer's type-to-focus never takes its keys.
  assert.match(html, /data-typing-surface="device"[^>]*role="application" aria-roledescription="simulator screen"/u);
  assert.match(html, /Escape to put it back in its tab/u);
  // Home and Rotate wait for a live stream.
  assert.match(html, /disabled=""[^>]*aria-label="Home"|aria-label="Home"[^>]*disabled=""/u);
  // Eight resize grips, no decorative colored borders.
  assert.equal(html.match(/data-device-mini-player-resize=/gu)?.length, 8);
  assert.doesNotMatch(html, /border-(red|green|blue|accent)/u);
});

test("a floating Android emulator offers Back, Home and Recents instead of the iOS Rotate", () => {
  const pixel: DeviceSummary = {
    hostId: "local",
    id: "emulator-5554",
    name: "Pixel 9",
    platform: "android",
    version: "Android 16",
    booted: true,
    kind: "other",
  };
  const html = renderToStaticMarkup(
    <DeviceMiniPlayer device={pixel} title="Pixel 9" active={false} onDock={noop} onClose={noop} />,
  );
  const labels = [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(labels, ["Back", "Home", "Recents", "Dock device in its tab", "Close floating device"]);
  const ios = renderToStaticMarkup(
    <DeviceMiniPlayer device={IPHONE} title="iPhone" active={false} onDock={noop} onClose={noop} />,
  );
  assert.deepEqual(
    [...ios.matchAll(/<button[^>]*aria-label="([^"]+)"/gu)].map((match) => match[1]),
    ["Home", "Rotate", "Dock device in its tab", "Close floating device"],
  );
});

test("Settings offers the auto-show floating device switch", () => {
  const on = renderToStaticMarkup(<DeviceWorkspaceSettingsView autoFloat onAutoFloatChange={noop} />);
  assert.match(on, new RegExp(`role="switch"[^>]*aria-checked="true"[^>]*aria-label="${AUTO_FLOAT_DEVICE_LABEL}"`, "u"));
  assert.match(on, /Environment tab instead/u);
  const off = renderToStaticMarkup(<DeviceWorkspaceSettingsView autoFloat={false} onAutoFloatChange={noop} />);
  assert.match(off, /role="switch"[^>]*aria-checked="false"/u);
});
