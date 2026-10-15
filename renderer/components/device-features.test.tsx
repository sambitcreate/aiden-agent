import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceRecordingInfo } from "../shared/device-features.js";
import { DeviceAxLabel } from "./device-ax-overlay.js";
import { DeviceEventLogSection } from "./device-event-log-panel.js";
import { DeviceFeatureSections, axStatusLabel } from "./device-feature-sections.js";
import { DeviceRecordControl, formatRecordingElapsed, spokenRecordingElapsed } from "./device-record-control.js";
import { DeviceScreenshotControl } from "./device-screenshot-control.js";
import { DeviceViewer } from "./device-viewer.js";

const noop = () => undefined;
const UDID = "5C1E4B7A-0000-4000-8000-000000000001";
const grants = {
  get: async () => ({ origin: "http://127.0.0.1:1", token: "t".repeat(43), expiresAt: Date.now() + 60_000 }),
  invalidate: noop,
};

function sections(hostId: string, extra: Partial<Parameters<typeof DeviceFeatureSections>[0]> = {}) {
  return renderToStaticMarkup(
    <DeviceFeatureSections
      chatId="chat-1"
      target={{ platform: "ios", hostId, deviceId: UDID }}
      deviceName="iPhone 17 Pro"
      grants={grants}
      axOverlay={false}
      axStatus={null}
      onAxOverlayChange={noop}
      onAxRefresh={noop}
      sendKey={noop}
      disabled={false}
      onReconnect={noop}
      onCloseSession={noop}
      {...extra}
    />,
  );
}

test("this Mac's simulator gets the overlay switch, clipboard, event log, and erase in the drawer", () => {
  const html = sections("local");
  for (const title of ["Accessibility", "Clipboard", "Device"]) {
    assert.match(html, new RegExp(`>${title}</h3>`, "u"), title);
  }
  assert.match(html, /role="switch"[^>]*aria-checked="false"[^>]*aria-label="Overlay element frames"|aria-label="Overlay element frames"[^>]*role="switch"/u);
  assert.match(html, />Paste to device</u);
  assert.match(html, />Copy from device</u);
  assert.match(html, /aria-expanded="false"[^>]*>.*Event log/u);
  assert.match(html, />Erase all content and settings…</u);
});

test("a paired Mac's simulator offers only what works through the relay", () => {
  const html = sections("peer-mac", { axOverlay: true, axStatus: { loading: false, count: 3, error: null } });
  assert.match(html, /aria-label="Overlay element frames"/u);
  assert.match(html, /aria-label="Read element frames again"/u);
  assert.match(html, /role="status"[^>]*>3 elements</u);
  assert.match(html, /Event log/u);
  assert.doesNotMatch(html, /Paste to device|Erase all content/u);
});

test("paste needs a connected input socket", () => {
  const pasteButton = (html: string) =>
    (html.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/gu) ?? []).find((button) => button.includes("Paste to device"));
  assert.match(pasteButton(sections("local", { sendKey: null })) ?? "", /^<button[^>]*disabled=""/u);
  assert.doesNotMatch(pasteButton(sections("local")) ?? "", /^<button[^>]*disabled=""/u);
});

test("overlay status reads as loading, a count, or the helper's error", () => {
  assert.equal(axStatusLabel(null), null);
  assert.equal(axStatusLabel({ loading: true, count: 0, error: null }), "Reading the accessibility tree…");
  assert.equal(axStatusLabel({ loading: false, count: 1, error: null }), "1 element");
  assert.equal(axStatusLabel({ loading: false, count: 0, error: "Accessibility is off" }), "Accessibility is off");
});

test("the hovered element shows its label and role, or says it is unlabeled", () => {
  const html = renderToStaticMarkup(
    <DeviceAxLabel element={{ id: "a", label: "General", role: "Button", x: 0.1, y: 0.5, width: 0.2, height: 0.05 }} />,
  );
  assert.match(html, />General</u);
  assert.match(html, />Button</u);
  assert.match(html, /data-placement="above"/u);
  const top = renderToStaticMarkup(
    <DeviceAxLabel element={{ id: "b", label: "", role: "", x: 0, y: 0, width: 1, height: 0.04 }} />,
  );
  assert.match(top, />Unlabeled</u);
  assert.match(top, /data-placement="below"/u);
});

test("a hovered label near the right edge stays inside the screen however wide it grows", () => {
  // On a real simulator, Settings' label in the last icon column was cut off by the screen edge.
  for (const x of [0, 0.3, 0.55, 0.77, 0.95]) {
    const html = renderToStaticMarkup(
      <DeviceAxLabel element={{ id: "s", label: "Settings", role: "Button", x, y: 0.4, width: 0.04, height: 0.05 }} />,
    );
    const left = Number(/left:([\d.]+)%/u.exec(html)?.[1]);
    const maxWidth = Number(/max-width:([\d.]+)%/u.exec(html)?.[1]);
    assert.ok(maxWidth > 0, `x=${x} has a bounded width`);
    assert.ok(left + maxWidth <= 100, `x=${x}: ${left}% + ${maxWidth}% overflows`);
    assert.ok(left <= x * 100, `x=${x}: the label starts at or before its element`);
  }
});

test("an open event log offers filter, pause, clear, and copy around a labelled log", () => {
  const html = renderToStaticMarkup(
    <DeviceEventLogSection hostId="local" deviceId={UDID} platform="ios" grants={grants} defaultOpen />,
  );
  for (const name of ["Filter events", "Pause event log", "Clear event log", "Copy events"]) {
    assert.match(html, new RegExp(`aria-label="${name}"`, "u"), name);
  }
  assert.match(html, /role="log" aria-label="Simulator events"/u);
  assert.match(html, />No events yet\.</u);
  assert.match(html, /aria-expanded="true"/u);
});

test("the screenshot control joins the chat action with a menu of both options", () => {
  const html = renderToStaticMarkup(
    <DeviceScreenshotControl disabled={false} onScreenshotToChat={noop} onSaveScreenshot={noop} />,
  );
  assert.match(html, /role="group" aria-label="Screenshot"/u);
  assert.match(html, /aria-label="Screenshot to chat"/u);
  assert.match(html, /aria-label="Screenshot options"[^>]*aria-haspopup="menu"|aria-haspopup="menu"[^>]*aria-label="Screenshot options"/u);
});

test("the record control shows elapsed time while recording and a plain action otherwise", () => {
  const recording: DeviceRecordingInfo = {
    id: "recording-0001",
    chatId: "chat-1",
    platform: "ios",
    hostId: "local",
    deviceId: UDID,
    status: "recording",
    startedAt: 10_000,
    endsBy: 610_000,
  };
  const target = { platform: "ios" as const, hostId: "local", deviceId: UDID };
  const live = renderToStaticMarkup(
    <DeviceRecordControl chatId="chat-1" target={target} disabled={false} initial={[recording]} now={() => 75_000} />,
  );
  assert.match(live, /aria-label="Stop recording, 1 minute 5 seconds recorded"/u);
  assert.match(live, />1:05</u);
  const otherChat = renderToStaticMarkup(
    <DeviceRecordControl chatId="chat-2" target={target} disabled={false} initial={[recording]} />,
  );
  assert.match(otherChat, /aria-label="Record screen"/u);
  const stopping = renderToStaticMarkup(
    <DeviceRecordControl
      chatId="chat-1"
      target={target}
      disabled={false}
      initial={[{ ...recording, status: "stopping", stoppedAt: 20_000 }]}
    />,
  );
  assert.match(stopping, /aria-label="Finishing the recording"/u);
  assert.match(stopping, />0:10</u);

  assert.equal(formatRecordingElapsed(599_999), "9:59");
  assert.equal(spokenRecordingElapsed(1_000), "1 second");
  assert.equal(spokenRecordingElapsed(120_000), "2 minutes 0 seconds");
});

test("the viewer rail offers screenshot options and recording, and a paired Mac's has no recording", () => {
  const render = (hostId: string) =>
    renderToStaticMarkup(
      <DeviceViewer
        chatId="chat-1"
        session={{ chatId: "chat-1", hostId, deviceId: UDID, openedBy: "user" }}
        device={{ hostId, id: UDID, name: "iPhone 17 Pro", platform: "ios", version: "iOS 27.0", booted: true, kind: "iphone" }}
        active={false}
        compact={false}
        onClose={noop}
      />,
    );
  const local = render("local");
  assert.match(local, /aria-label="Screenshot options"/u);
  assert.match(local, /aria-label="Record screen"/u);
  assert.doesNotMatch(render("peer-mac"), /aria-label="Record screen"/u);
});

const SERIAL = "emulator-5554";

function androidSections(hostId: string, extra: Partial<Parameters<typeof DeviceFeatureSections>[0]> = {}) {
  return sections(hostId, { target: { platform: "android", hostId, deviceId: SERIAL }, deviceName: "Pixel 9", ...extra });
}

test("this Mac's emulator gets the overlay, paste, logcat, and erase, with Copy from device disabled and explained", () => {
  const html = androidSections("local");
  for (const title of ["Accessibility", "Clipboard", "Device"]) {
    assert.match(html, new RegExp(`>${title}</h3>`, "u"), title);
  }
  assert.match(html, /aria-label="Overlay element frames"/u);
  assert.match(html, /Event log/u);
  assert.match(html, />Erase all content and settings…</u);
  const copy = (html.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/gu) ?? []).find((button) =>
    button.includes("Copy from device"),
  );
  assert.match(copy ?? "", /^<button[^>]*disabled=""/u);
  const describedBy = /aria-describedby="([^"]+)"/u.exec(copy ?? "")?.[1];
  assert.ok(describedBy, "the disabled button points at its reason");
  assert.ok(html.includes(`id="${describedBy}"`));
  assert.match(html, />Android Emulators do not let adb read their clipboard\.</u);
  assert.match(html, /typed into the focused field/u);
});

test("a paired Mac's emulator offers only the overlay and logcat", () => {
  const html = androidSections("peer-mac");
  assert.match(html, /aria-label="Overlay element frames"/u);
  assert.match(html, /Event log/u);
  assert.doesNotMatch(html, /Paste to device|Copy from device|Erase all content/u);
});

test("an emulator's open log is labelled as logcat and can follow only the frontmost app", () => {
  const html = renderToStaticMarkup(
    <DeviceEventLogSection
      hostId="local"
      deviceId={SERIAL}
      platform="android"
      grants={grants}
      foregroundApp="com.example.shop"
      defaultOpen
    />,
  );
  assert.match(html, /role="log" aria-label="Emulator logcat"/u);
  assert.match(html, />Only com\.example\.shop</u);
  assert.match(html, /aria-label="Only the frontmost app"/u);
  const unknownApp = renderToStaticMarkup(
    <DeviceEventLogSection hostId="local" deviceId={SERIAL} platform="android" grants={grants} defaultOpen />,
  );
  assert.doesNotMatch(unknownApp, /Only the frontmost app/u);
});

test("an emulator's rail offers recording capped at three minutes; a paired Mac's has none", () => {
  const render = (hostId: string) =>
    renderToStaticMarkup(
      <DeviceViewer
        chatId="chat-1"
        session={{ chatId: "chat-1", hostId, deviceId: SERIAL, openedBy: "user" }}
        device={{ hostId, id: SERIAL, name: "Pixel 9", platform: "android", version: "Android 16", booted: true, kind: "other" }}
        active={false}
        compact={false}
        onClose={noop}
      />,
    );
  const local = render("local");
  assert.match(local, /aria-label="Screenshot options"/u);
  assert.match(local, /title="Record screen \(up to 3 minutes\)"/u);
  assert.doesNotMatch(render("peer-mac"), /aria-label="Record screen"/u);
});
