import assert from "node:assert/strict";
import test from "node:test";
import { applyLinuxWaylandChromiumFlags, linuxWaylandVulkanDisableFeatures } from "./linux-chromium-flags.js";

test("Vulkan is disabled only for Linux Wayland sessions", () => {
  assert.equal(
    linuxWaylandVulkanDisableFeatures({
      platform: "darwin",
      env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" },
    }),
    null,
  );
  assert.equal(
    linuxWaylandVulkanDisableFeatures({
      platform: "linux",
      env: { XDG_SESSION_TYPE: "x11" },
    }),
    null,
  );
  assert.equal(
    linuxWaylandVulkanDisableFeatures({
      platform: "linux",
      env: { XDG_SESSION_TYPE: "wayland" },
    }),
    "Vulkan",
  );
  assert.equal(
    linuxWaylandVulkanDisableFeatures({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      existingDisableFeatures: "UseChromeOSDirectVideoDecoder",
    }),
    "UseChromeOSDirectVideoDecoder,Vulkan",
  );
});

test("Wayland Chromium flags merge Vulkan into disable-features", () => {
  const switches: Array<{ name: string; value?: string }> = [];
  const applied = applyLinuxWaylandChromiumFlags(
    {
      appendSwitch: (name, value) => {
        switches.push({ name, value });
      },
      getSwitchValue: () => "",
    },
    { XDG_SESSION_TYPE: "wayland" },
    "linux",
  );
  assert.equal(applied, true);
  assert.deepEqual(switches, [{ name: "disable-features", value: "Vulkan" }]);
});
