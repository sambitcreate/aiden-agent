// The default session's permission handlers and session events have one
// owner (D8): Gemini Live fills the owner slot, deny layers win over it, and
// with nothing registered every handler is null and no listener exists.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  claimDefaultSessionPermissions,
  type PermissionTarget,
} from "./default-session-permissions.js";
import {
  installGeminiLiveDisplayMediaGuards,
  type GeminiLiveDisplayMediaBinding,
} from "./gemini-live/display-media-contract.js";

type Handler = ((...args: never[]) => unknown) | null;

function fakeTarget() {
  const emitter = new EventEmitter();
  const state = {
    check: null as Handler,
    request: null as Handler,
    display: null as Handler,
    displayOptions: undefined as unknown,
    device: null as Handler,
    calls: [] as string[],
  };
  const target = Object.assign(emitter, {
    setPermissionCheckHandler(handler: Handler) {
      state.calls.push(handler ? "check:set" : "check:null");
      state.check = handler;
    },
    setPermissionRequestHandler(handler: Handler) {
      state.calls.push(handler ? "request:set" : "request:null");
      state.request = handler;
    },
    setDisplayMediaRequestHandler(handler: Handler, options?: unknown) {
      state.calls.push(handler ? "display:set" : "display:null");
      state.display = handler;
      state.displayOptions = options;
    },
    setDevicePermissionHandler(handler: Handler) {
      state.calls.push(handler ? "device:set" : "device:null");
      state.device = handler;
    },
  });
  return { target: target as unknown as PermissionTarget, emitter, state };
}

const contents = (id: number) => ({ id }) as unknown as Electron.WebContents;
const checkDetails = (requestingUrl: string, isMainFrame = true) =>
  ({ requestingUrl, isMainFrame, embeddingOrigin: "file://", securityOrigin: requestingUrl }) as Electron.PermissionCheckHandlerHandlerDetails;
const requestDetails = (requestingUrl: string, isMainFrame = true, mediaTypes: string[] = ["audio"]) =>
  ({ requestingUrl, isMainFrame, mediaTypes }) as unknown as Electron.PermissionRequest;

function runCheck(state: ReturnType<typeof fakeTarget>["state"], webContents: Electron.WebContents | null, permission: string, details: Electron.PermissionCheckHandlerHandlerDetails) {
  return (state.check as (...args: unknown[]) => boolean)(webContents, permission, details.requestingUrl, details);
}

function runRequest(state: ReturnType<typeof fakeTarget>["state"], webContents: Electron.WebContents, permission: string, details: Electron.PermissionRequest) {
  let granted: boolean | undefined;
  (state.request as (...args: unknown[]) => void)(webContents, permission, (value: boolean) => (granted = value), details);
  return granted;
}

function runDisplay(state: ReturnType<typeof fakeTarget>["state"], request: Record<string, unknown> = {}) {
  let streams: unknown;
  (state.display as (...args: unknown[]) => void)(request, (value: unknown) => (streams = value));
  return streams;
}

test("a second claim of the same target throws", () => {
  const { target } = fakeTarget();
  claimDefaultSessionPermissions(target);
  assert.throws(() => claimDefaultSessionPermissions(target), /already owned by default-session-permissions\.ts/u);
});

test("no layer and no owner leaves every handler null and installs nothing", () => {
  const { target, state, emitter } = fakeTarget();
  claimDefaultSessionPermissions(target);
  assert.deepEqual(state.calls, []);
  assert.equal(state.check, null);
  assert.equal(emitter.listenerCount("will-download"), 0);
});

test("an owner alone is installed as given, display options included, and null clears it", () => {
  const { target, state } = fakeTarget();
  const dispatcher = claimDefaultSessionPermissions(target);
  const slot = dispatcher.ownerSlot("gemini-live");
  const check = () => true;
  const request = () => undefined;
  const display = () => undefined;
  slot.setPermissionCheckHandler(check);
  slot.setPermissionRequestHandler(request);
  slot.setDisplayMediaRequestHandler(display, { useSystemPicker: true });
  assert.equal(state.check, check, "the exact function");
  assert.equal(state.request, request);
  assert.equal(state.display, display);
  assert.deepEqual(state.displayOptions, { useSystemPicker: true });
  slot.setPermissionCheckHandler(null);
  slot.setPermissionRequestHandler(null);
  slot.setDisplayMediaRequestHandler(null);
  assert.equal(state.check, null);
  assert.equal(state.request, null);
  assert.equal(state.display, null);
});

test("ownerSlot returns the same object for the same name, and a second owner name throws", () => {
  const { target } = fakeTarget();
  const dispatcher = claimDefaultSessionPermissions(target);
  assert.equal(dispatcher.ownerSlot("gemini-live"), dispatcher.ownerSlot("gemini-live"));
  assert.throws(() => dispatcher.ownerSlot("someone-else"), /gemini-live/u);
});

test("a deny layer wins over the owner, and with no owner the composed handlers answer Electron's defaults", () => {
  const { target, state } = fakeTarget();
  const dispatcher = claimDefaultSessionPermissions(target);
  const denied = "http://127.0.0.1:5173/";
  dispatcher.addDenyLayer("design", {
    denyCheck: (_wc, _permission, _origin, details) => details.requestingUrl === denied,
    denyRequest: (_wc, _permission, details) => details.requestingUrl === denied,
    denyDisplay: (request) => (request as unknown as { denied?: boolean }).denied === true,
    denyDevice: (details) => details.origin === "http://127.0.0.1:5173",
  });
  // No owner: Electron's defaults (checks and requests grant; display has no source; device denies).
  assert.equal(runCheck(state, contents(1), "media", checkDetails("file:///app/index.html")), true);
  assert.equal(runRequest(state, contents(1), "media", requestDetails("file:///app/index.html")), true);
  assert.deepEqual(runDisplay(state), {});
  assert.equal((state.device as (details: unknown) => boolean)({ origin: "file://", deviceType: "hid" }), false);
  // The layer denies its own.
  assert.equal(runCheck(state, contents(1), "media", checkDetails(denied, false)), false);
  assert.equal(runRequest(state, contents(1), "media", requestDetails(denied, false)), false);
  assert.deepEqual(runDisplay(state, { denied: true }), {});
  assert.equal((state.device as (details: unknown) => boolean)({ origin: "http://127.0.0.1:5173", deviceType: "hid" }), false);

  // With an owner that grants everything, the layer still wins.
  const slot = dispatcher.ownerSlot("gemini-live");
  slot.setPermissionCheckHandler(() => true);
  slot.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  assert.equal(runCheck(state, contents(1), "media", checkDetails(denied, false)), false);
  assert.equal(runRequest(state, contents(1), "media", requestDetails(denied, false)), false);
  assert.equal(runCheck(state, contents(1), "media", checkDetails("file:///app/index.html")), true, "the owner answers the rest");
});

test("a throwing deny layer denies", () => {
  const { target, state } = fakeTarget();
  const dispatcher = claimDefaultSessionPermissions(target);
  dispatcher.addDenyLayer("broken", {
    denyCheck: () => {
      throw new Error("boom");
    },
  });
  assert.equal(runCheck(state, contents(1), "media", checkDetails("file:///x")), false);
});

test("removing the last layer restores the owner's handlers, or null", () => {
  const { target, state } = fakeTarget();
  const dispatcher = claimDefaultSessionPermissions(target);
  const removeLayer = dispatcher.addDenyLayer("design", { denyCheck: () => true });
  assert.notEqual(state.check, null);
  removeLayer();
  assert.equal(state.check, null);
  assert.equal(state.device, null);
  const check = () => true;
  dispatcher.ownerSlot("gemini-live").setPermissionCheckHandler(check);
  const removeAgain = dispatcher.addDenyLayer("design", { denyCheck: () => true });
  assert.notEqual(state.check, check, "composed while a layer exists");
  removeAgain();
  assert.equal(state.check, check, "the owner's own function again");
});

test("session events: no subscriber means no listener; cancels prevent and cancel", () => {
  const { target, emitter } = fakeTarget();
  const dispatcher = claimDefaultSessionPermissions(target);
  for (const event of ["will-download", "select-hid-device", "select-serial-port", "select-usb-device"]) {
    assert.equal(emitter.listenerCount(event), 0, event);
  }
  const removeDownload = dispatcher.onWillDownload("design", (_item, webContents) => (webContents.id === 7 ? "cancel" : undefined));
  const removeDevice = dispatcher.onSelectDevice("design", (kind) => (kind === "hid" ? "cancel" : undefined));
  assert.equal(emitter.listenerCount("will-download"), 1);
  assert.equal(emitter.listenerCount("select-usb-device"), 1);

  const download = () => {
    const record = { prevented: false, cancelled: false };
    const item = { cancel: () => (record.cancelled = true) };
    return { record, item, event: { preventDefault: () => (record.prevented = true) } };
  };
  const cancelled = download();
  emitter.emit("will-download", cancelled.event, cancelled.item, contents(7), null);
  assert.deepEqual(cancelled.record, { prevented: true, cancelled: true });
  const kept = download();
  emitter.emit("will-download", kept.event, kept.item, contents(1), null);
  assert.deepEqual(kept.record, { prevented: false, cancelled: false });

  let chosen: unknown = "untouched";
  let prevented = false;
  emitter.emit("select-hid-device", { preventDefault: () => (prevented = true) }, { frame: null, deviceList: [] }, (id: unknown) => (chosen = id));
  assert.equal(prevented, true);
  assert.equal(chosen, "");
  chosen = "untouched";
  // Electron 43: select-serial-port is (event, portList, webContents, callback).
  emitter.emit("select-serial-port", { preventDefault: () => undefined }, [], contents(1), (id: unknown) => (chosen = id));
  assert.equal(chosen, "untouched", "a subscriber that doesn't cancel leaves the chooser alone");

  removeDownload();
  removeDevice();
  for (const event of ["will-download", "select-hid-device", "select-serial-port", "select-usb-device"]) {
    assert.equal(emitter.listenerCount(event), 0, event);
  }
});

test("the serial chooser's subscriber gets its web contents, and a cancel or a throw answers its real callback", () => {
  const { target, emitter } = fakeTarget();
  const dispatcher = claimDefaultSessionPermissions(target);
  const seen: Array<{ kind: string; frame: unknown; contents: number | undefined }> = [];
  const remove = dispatcher.onSelectDevice("design", (kind, details) => {
    seen.push({ kind, frame: details.frame, contents: details.webContents?.id });
    if (details.webContents?.id === 9) throw new Error("subscriber failed");
    return details.webContents?.id === 7 ? "cancel" : undefined;
  });
  const choose = (webContents: Electron.WebContents) => {
    const record = { prevented: false, chosen: "unanswered" as unknown };
    emitter.emit("select-serial-port", { preventDefault: () => (record.prevented = true) }, [{ portId: "p1" }], webContents, (id: unknown) => (record.chosen = id));
    return record;
  };
  assert.deepEqual(choose(contents(7)), { prevented: true, chosen: "" });
  assert.deepEqual(choose(contents(9)), { prevented: true, chosen: "" }, "a throwing subscriber cancels, through the 4th argument");
  assert.deepEqual(choose(contents(1)), { prevented: false, chosen: "unanswered" });
  assert.deepEqual(seen.map((entry) => [entry.kind, entry.frame, entry.contents]), [
    ["serial", null, 7],
    ["serial", null, 9],
    ["serial", null, 1],
  ]);
  remove();
});

test("with guardSetters a direct setPermissionRequestHandler call throws", () => {
  const { target, state } = fakeTarget();
  const dispatcher = claimDefaultSessionPermissions(target, { guardSetters: true });
  assert.throws(() => target.setPermissionRequestHandler(null), /default-session-permissions\.ts/u);
  assert.throws(() => target.setPermissionCheckHandler(null), /default-session-permissions\.ts/u);
  dispatcher.ownerSlot("gemini-live").setPermissionCheckHandler(() => true);
  assert.notEqual(state.check, null, "the dispatcher still installs through its own copy");
});

function binding(sender: Electron.WebContents, requestingUrl: string): GeminiLiveDisplayMediaBinding {
  return {
    sourceId: "screen:1",
    allowsPermissionRequest: (webContents: Electron.WebContents, permission: string, details: { isMainFrame: boolean; requestingUrl: string }) =>
      webContents === sender && permission === "media" && details.isMainFrame && details.requestingUrl === requestingUrl,
    allowsDisplayRequest: () => false,
  } as unknown as GeminiLiveDisplayMediaBinding;
}

test("Gemini Live through the slot grants its document, denies another, and dispose empties the slot", () => {
  const { target, state } = fakeTarget();
  const dispatcher = claimDefaultSessionPermissions(target);
  const live = contents(3);
  const bindings = [binding(live, "file:///app/index.html")];
  const dispose = installGeminiLiveDisplayMediaGuards(dispatcher.ownerSlot("gemini-live"), () => bindings);
  assert.equal(
    installGeminiLiveDisplayMediaGuards(dispatcher.ownerSlot("gemini-live"), () => bindings),
    dispose,
    "the same slot object, so Live's guard sees one session",
  );
  assert.equal(runRequest(state, live, "media", requestDetails("file:///app/index.html")), true);
  assert.equal(runRequest(state, contents(4), "media", requestDetails("file:///app/index.html")), false);
  dispose();
  assert.equal(state.check, null);
  assert.equal(state.request, null);
  assert.equal(state.display, null);
});
