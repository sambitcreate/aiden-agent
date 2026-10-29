import assert from "node:assert/strict";
import test from "node:test";

import {
  createBroadcastReceivers,
  parseMediaRequestType,
  parseMediaStatusType,
  parseOpenDialogOptions,
  type BroadcastReceiver,
} from "./native-ipc-core.js";

test("media status accepts the three macOS privacy types and nothing else", () => {
  assert.equal(parseMediaStatusType("microphone"), "microphone");
  assert.equal(parseMediaStatusType("camera"), "camera");
  assert.equal(parseMediaStatusType("screen"), "screen");
  for (const value of ["Microphone", "location", "", null, undefined, 1, { type: "camera" }]) {
    assert.throws(() => parseMediaStatusType(value), /Invalid media type/u);
  }
});

test("media requests cannot ask for screen recording, which has no prompt API", () => {
  assert.equal(parseMediaRequestType("microphone"), "microphone");
  assert.equal(parseMediaRequestType("camera"), "camera");
  assert.throws(() => parseMediaRequestType("screen"), /Invalid media type/u);
  assert.throws(() => parseMediaRequestType(undefined), /Invalid media type/u);
});

test("the folder picker request passes through unchanged", () => {
  assert.deepEqual(parseOpenDialogOptions({ properties: ["openDirectory", "createDirectory"] }), {
    properties: ["openDirectory", "createDirectory"],
  });
  assert.deepEqual(parseOpenDialogOptions(undefined), {});
  assert.deepEqual(parseOpenDialogOptions(null), {});
});

test("open dialog options keep only renderer-safe fields", () => {
  const options = parseOpenDialogOptions({
    title: "Choose images",
    buttonLabel: "Attach",
    message: "Pick up to five",
    defaultPath: "/Users/someone/.ssh",
    securityScopedBookmarks: true,
    filters: [{ name: "Images", extensions: ["png", "jpg", "*"] }],
    properties: ["openFile", "multiSelections", "openFile"],
  });
  assert.deepEqual(options, {
    title: "Choose images",
    buttonLabel: "Attach",
    message: "Pick up to five",
    filters: [{ name: "Images", extensions: ["png", "jpg", "*"] }],
    properties: ["openFile", "multiSelections"],
  });
});

test("open dialog options reject unknown properties, malformed filters and oversized text", () => {
  const invalid: unknown[] = [
    "openFile",
    ["openFile"],
    { properties: ["treatPackageAsDirectory"] },
    { properties: "openFile" },
    { filters: [{ name: "Any", extensions: ["../etc"] }] },
    { filters: [{ name: "Any", extensions: "png" }] },
    { filters: [null] },
    { filters: Array.from({ length: 21 }, () => ({ name: "x", extensions: ["png"] })) },
    { title: 42 },
    { message: "x".repeat(201) },
  ];
  for (const value of invalid) {
    assert.throws(() => parseOpenDialogOptions(value), /Invalid open dialog/u, JSON.stringify(value));
  }
});

class FakeReceiver implements BroadcastReceiver {
  destroyed = false;
  readonly received: [string, unknown][] = [];
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, payload: unknown): void {
    this.received.push([channel, payload]);
  }
}

test("broadcasts reach only windows that subscribed to the channel", () => {
  const receivers = createBroadcastReceivers<string>();
  const main = new FakeReceiver();
  const pill = new FakeReceiver();
  receivers.register("main", main);
  receivers.register("pill", pill, new Set(["dictation:state"]));

  assert.deepEqual(receivers.targets("chat:delta"), [main]);
  assert.deepEqual(receivers.targets("dictation:state"), [main, pill]);
  assert.deepEqual(receivers.targets("anything"), [main]);
});

test("closed and unregistered windows stop receiving broadcasts", () => {
  const receivers = createBroadcastReceivers<string>();
  const main = new FakeReceiver();
  const pill = new FakeReceiver();
  receivers.register("main", main);
  receivers.register("pill", pill, null);

  pill.destroyed = true;
  assert.deepEqual(receivers.targets("dictation:state"), [main]);
  // A destroyed receiver is dropped for good, even if the flag were to flip back.
  pill.destroyed = false;
  assert.deepEqual(receivers.targets("dictation:state"), [main]);

  receivers.unregister("main");
  assert.deepEqual(receivers.targets("dictation:state"), []);
});

test("a recreated window replaces its earlier registration", () => {
  const receivers = createBroadcastReceivers<string>();
  const first = new FakeReceiver();
  const second = new FakeReceiver();
  receivers.register("pill", first, new Set(["dictation:state"]));
  receivers.register("pill", second, new Set(["voice:stream-text"]));
  assert.deepEqual(receivers.targets("dictation:state"), []);
  assert.deepEqual(receivers.targets("voice:stream-text"), [second]);
});
