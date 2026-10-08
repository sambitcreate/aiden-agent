import assert from "node:assert/strict";
import test from "node:test";
import {
  deviceActionSupported,
  parseDeviceActionInput,
  parseDeviceServiceState,
  parseDeviceSettings,
  parseDeviceStreamGrant,
} from "./devices.js";

const TOKEN = "A".repeat(43);

function state(overrides: Record<string, unknown> = {}) {
  return {
    hostStatus: "ready",
    hostStatuses: { local: { status: "ready" } },
    hosts: [{ id: "local", kind: "local", name: "This Mac", status: "ready" }],
    consent: { streaming: true, agentAccess: false, peerSharing: false },
    devices: [
      {
        hostId: "local",
        id: "5C1E4B7A-0000-4000-8000-000000000001",
        name: "iPhone 17 Pro",
        platform: "ios",
        version: "iOS 27.0",
        booted: true,
        kind: "iphone",
      },
    ],
    sessions: [
      {
        chatId: "chat-1",
        hostId: "local",
        deviceId: "5C1E4B7A-0000-4000-8000-000000000001",
        openedBy: "user",
      },
    ],
    toolVersions: { hub: "0.12.0", agent: "0.21.12" },
    ...overrides,
  };
}

test("device service state parses a complete snapshot", () => {
  const parsed = parseDeviceServiceState(state({ unavailableReason: "Install Xcode." }));
  assert.equal(parsed?.hostStatus, "ready");
  assert.equal(parsed?.devices[0]?.kind, "iphone");
  assert.equal(parsed?.sessions[0]?.openedBy, "user");
  assert.equal(parsed?.unavailableReason, "Install Xcode.");
});

test("device service state fails closed on unknown platforms, statuses, and shapes", () => {
  const device = state().devices[0];
  assert.equal(parseDeviceServiceState(state({ devices: [{ ...device, platform: "watchos" }] })), null);
  assert.equal(parseDeviceServiceState(state({ devices: [{ ...device, kind: "watch" }] })), null);
  assert.equal(parseDeviceServiceState(state({ hostStatus: "booting" })), null);
  assert.equal(parseDeviceServiceState(state({ hostStatuses: { local: { status: "?" } } })), null);
  assert.equal(parseDeviceServiceState(state({ consent: { streaming: "yes" } })), null);
  assert.equal(parseDeviceServiceState(state({ sessions: [{ chatId: "c", openedBy: "x" }] })), null);
  assert.equal(parseDeviceServiceState(state({ toolVersions: { hub: "" } })), null);
  assert.equal(parseDeviceServiceState(state({ unavailableReason: 4 })), null);
  assert.equal(parseDeviceServiceState(null), null);
  assert.equal(parseDeviceServiceState([]), null);
});

test("stream grants must be live loopback grants with a 256-bit token", () => {
  const now = 1_000;
  const grant = { origin: "http://127.0.0.1:52011", token: TOKEN, expiresAt: now + 60_000 };
  assert.deepEqual(parseDeviceStreamGrant(grant, now), grant);
  for (const origin of [
    "http://localhost:52011",
    "https://127.0.0.1:52011",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:99999",
    "http://127.0.0.1:52011/",
    "http://10.0.0.2:52011",
    "http://example.com",
  ]) {
    assert.equal(parseDeviceStreamGrant({ ...grant, origin }, now), null, origin);
  }
  assert.equal(parseDeviceStreamGrant({ ...grant, token: "A".repeat(42) }, now), null);
  assert.equal(parseDeviceStreamGrant({ ...grant, token: `${"A".repeat(42)}=` }, now), null);
  assert.equal(parseDeviceStreamGrant({ ...grant, expiresAt: now }, now), null);
  assert.equal(parseDeviceStreamGrant({ ...grant, expiresAt: Number.NaN }, now), null);
  assert.equal(parseDeviceStreamGrant(undefined, now), null);
});

const actionTarget = { hostId: "local", deviceId: "ABCD-1234" };

test("device actions parse each supported iOS action", () => {
  const valid = [
    { type: "setAppearance", value: "dark" },
    { type: "setTextSize", value: "extra-large" },
    { type: "setToggle", setting: "increaseContrast", value: true },
    { type: "setToggle", setting: "voiceOver", value: false },
    { type: "setLiquidGlass", value: "tinted" },
    { type: "setColorFilter", value: "grayscale" },
    { type: "openUrl", url: "https://example.com/path?q=1" },
    { type: "launchApp", appId: "com.apple.Preferences" },
    { type: "terminateApp", appId: "com.example.App" },
    { type: "sendPush", appId: "com.example.App", payload: "Hello" },
    { type: "sendPush", appId: "com.example.App", payload: { aps: { alert: "Hi", badge: 1 } } },
    { type: "setPermission", permission: "notifications", decision: "grant", appId: "com.a.b" },
    { type: "openUrl", url: "myapp://route/1" },
    { type: "setPermission", permission: "camera", decision: "grant", appId: "com.example.App" },
    { type: "setLocation", latitude: 37.33, longitude: -122.03 },
    { type: "clearLocation" },
  ];
  for (const action of valid) {
    assert.deepEqual(parseDeviceActionInput({ ...actionTarget, ...action }), { ...actionTarget, ...action });
  }
});

test("device actions fail closed on bad targets, values, URLs, and app ids", () => {
  const invalid: unknown[] = [
    null,
    { ...actionTarget, type: "exec", command: "rm" },
    { hostId: "local", deviceId: "../x", type: "clearLocation" },
    { hostId: "", deviceId: "ABCD", type: "clearLocation" },
    { ...actionTarget, type: "setAppearance", value: "sepia" },
    { ...actionTarget, type: "setTextSize", value: "huge" },
    { ...actionTarget, type: "setIncreaseContrast", value: true },
    { ...actionTarget, type: "setToggle", setting: "wifi", value: true },
    { ...actionTarget, type: "setOrientation", value: "sideways" },
    { hostId: "local", deviceId: "-s", type: "clearLocation" },
    { hostId: "local", deviceId: ".hidden", type: "clearLocation" },
    { ...actionTarget, type: "launchApp", appId: "_x.y" },
    { ...actionTarget, type: "setToggle", setting: "reduceMotion", value: "yes" },
    { ...actionTarget, type: "setLiquidGlass", value: "frosted" },
    { ...actionTarget, type: "setColorFilter", value: "sepia" },
    { ...actionTarget, type: "launchApp", appId: "-all" },
    { ...actionTarget, type: "terminateApp", appId: "com.a.b; rm" },
    { ...actionTarget, type: "sendPush", appId: "com.a.b", payload: "   " },
    { ...actionTarget, type: "sendPush", appId: "com.a.b", payload: ["alert"] },
    { ...actionTarget, type: "sendPush", appId: "com.a.b", payload: { body: "x".repeat(5000) } },
    { ...actionTarget, type: "openUrl", url: "file:///etc/passwd" },
    { ...actionTarget, type: "openUrl", url: "javascript:alert(1)" },
    { ...actionTarget, type: "openUrl", url: "https://exa mple.com" },
    { ...actionTarget, type: "openUrl", url: "not a url" },
    { ...actionTarget, type: "setPermission", permission: "siri", decision: "grant", appId: "com.a.b" },
    { ...actionTarget, type: "setPermission", permission: "camera", decision: "allow", appId: "com.a.b" },
    { ...actionTarget, type: "setPermission", permission: "camera", decision: "grant", appId: "--all" },
    { ...actionTarget, type: "setLocation", latitude: 91, longitude: 0 },
    { ...actionTarget, type: "setLocation", latitude: 0, longitude: Number.NaN },
  ];
  for (const action of invalid) assert.equal(parseDeviceActionInput(action), null, JSON.stringify(action));
});

test("device settings keep known values and reject malformed ones", () => {
  assert.deepEqual(parseDeviceSettings({}), {});
  assert.deepEqual(parseDeviceSettings({ appearance: "light", textSize: "default", increaseContrast: false }), {
    appearance: "light",
    textSize: "default",
    increaseContrast: false,
  });
  assert.equal(parseDeviceSettings({ appearance: "auto" }), null);
  assert.equal(parseDeviceSettings({ textSize: 3 }), null);
  assert.deepEqual(
    parseDeviceSettings({ reduceMotion: true, voiceOver: false, liquidGlass: "clear", colorFilter: "none" }),
    { reduceMotion: true, voiceOver: false, liquidGlass: "clear", colorFilter: "none" },
  );
  assert.equal(parseDeviceSettings({ showBorders: "on" }), null);
  assert.equal(parseDeviceSettings({ liquidGlass: "frosted" }), null);
  assert.equal(parseDeviceSettings({ colorFilter: "sepia" }), null);
  assert.equal(parseDeviceSettings("dark"), null);
});

test("the Aiden On The Go sharing consent reads as off when absent and fails closed when malformed", () => {
  assert.equal(parseDeviceServiceState(state())?.consent.mobileSharing, false);
  const shared = parseDeviceServiceState(
    state({ consent: { streaming: true, agentAccess: false, peerSharing: false, mobileSharing: true } }),
  );
  assert.equal(shared?.consent.mobileSharing, true);
  assert.equal(shared?.consent.peerSharing, false);
  assert.equal(
    parseDeviceServiceState(state({ consent: { streaming: true, agentAccess: false, peerSharing: false, mobileSharing: "yes" } })),
    null,
  );
});

test("Android emulators and per-platform availability cross the boundary", () => {
  const emulator = {
    hostId: "local",
    id: "emulator-5554",
    name: "Pixel_9_API_35",
    platform: "android",
    version: "Android 15.0",
    booted: true,
    kind: "other",
  };
  const avd = { ...emulator, id: "Pixel_Fold_API_35", name: "Pixel_Fold_API_35", booted: false };
  const platforms = [
    { platform: "ios", available: true },
    { platform: "android", available: false, reason: "Android SDK not found." },
  ];
  const parsed = parseDeviceServiceState(
    state({
      devices: [emulator, avd],
      hosts: [{ id: "local", kind: "local", name: "This Mac", status: "ready", platforms }],
    }),
  );
  assert.deepEqual(parsed?.devices.map((device) => [device.id, device.platform]), [
    ["emulator-5554", "android"],
    ["Pixel_Fold_API_35", "android"],
  ]);
  assert.deepEqual(parsed?.hosts[0]?.platforms, platforms);
  const host = { id: "local", kind: "local", name: "This Mac", status: "ready" };
  assert.equal(parseDeviceServiceState(state({ hosts: [{ ...host, platforms: [{ platform: "web", available: true }] }] })), null);
  assert.equal(parseDeviceServiceState(state({ hosts: [{ ...host, platforms: [{ platform: "ios", available: "yes" }] }] })), null);
  assert.equal(parseDeviceServiceState(state({ hosts: [{ ...host, platforms: {} }] })), null);
});

test("Android actions parse with AVD names, serials, and package names", () => {
  const serial = { hostId: "local", deviceId: "emulator-5554" };
  for (const action of [
    { type: "setOrientation", value: "landscape_left" },
    { type: "setToggle", setting: "networkEnabled", value: false },
    { type: "launchApp", appId: "com.example.my_app" },
  ]) {
    assert.deepEqual(parseDeviceActionInput({ ...serial, ...action }), { ...serial, ...action });
  }
  assert.deepEqual(parseDeviceActionInput({ hostId: "local", deviceId: "Pixel_9_API_35.1", type: "clearLocation" }), {
    hostId: "local",
    deviceId: "Pixel_9_API_35.1",
    type: "clearLocation",
  });
});

test("each platform offers only the actions it can run", () => {
  assert.equal(deviceActionSupported("android", { type: "setOrientation" }), true);
  assert.equal(deviceActionSupported("ios", { type: "setOrientation" }), false);
  assert.equal(deviceActionSupported("android", { type: "sendPush" }), false);
  assert.equal(deviceActionSupported("android", { type: "setLiquidGlass" }), false);
  assert.equal(deviceActionSupported("android", { type: "setToggle", setting: "networkEnabled" }), true);
  assert.equal(deviceActionSupported("android", { type: "setToggle", setting: "voiceOver" }), false);
  assert.equal(deviceActionSupported("ios", { type: "setToggle", setting: "networkEnabled" }), false);
  assert.equal(deviceActionSupported("android", { type: "setPermission", permission: "camera" }), true);
  assert.equal(deviceActionSupported("android", { type: "setPermission", permission: "faceid" }), false);
  assert.equal(deviceActionSupported("ios", { type: "setPermission", permission: "faceid" }), true);
});

test("Android settings carry the network switch and the focused package", () => {
  assert.deepEqual(parseDeviceSettings({ networkEnabled: false, foregroundApp: "com.android.settings" }), {
    networkEnabled: false,
    foregroundApp: "com.android.settings",
  });
  assert.equal(parseDeviceSettings({ networkEnabled: "off" }), null);
  assert.equal(parseDeviceSettings({ foregroundApp: "rm -rf /" }), null);
});
