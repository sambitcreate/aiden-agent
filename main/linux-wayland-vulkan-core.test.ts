import assert from "node:assert/strict";
import test from "node:test";
import {
  isWaylandSession,
  shouldSuppressOzoneWaylandVulkan,
} from "./linux-wayland-vulkan-core.js";

test("Wayland session detection mirrors Chromium ozone auto-selection", () => {
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: "wayland" }), true);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: "Wayland" }), true);
  assert.equal(isWaylandSession({ WAYLAND_DISPLAY: "wayland-0" }), true);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: "x11" }), false);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: "tty" }), false);
  assert.equal(isWaylandSession({ WAYLAND_DISPLAY: "  " }), false);
  assert.equal(isWaylandSession({}), false);
});

test("Vulkan suppression is Linux Wayland only and respects an explicit X11 ozone override", () => {
  const wayland = { XDG_SESSION_TYPE: "wayland" };
  assert.equal(shouldSuppressOzoneWaylandVulkan("linux", wayland), true);
  assert.equal(shouldSuppressOzoneWaylandVulkan("linux", { WAYLAND_DISPLAY: "wayland-1" }), true);
  assert.equal(shouldSuppressOzoneWaylandVulkan("linux", wayland, "x11"), false);
  assert.equal(shouldSuppressOzoneWaylandVulkan("linux", wayland, "X11"), false);
  assert.equal(shouldSuppressOzoneWaylandVulkan("linux", { XDG_SESSION_TYPE: "x11" }), false);
  assert.equal(shouldSuppressOzoneWaylandVulkan("darwin", wayland), false);
  assert.equal(shouldSuppressOzoneWaylandVulkan("win32", wayland), false);
  assert.equal(shouldSuppressOzoneWaylandVulkan("linux", {}), false);
});
