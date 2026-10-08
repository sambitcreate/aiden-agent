import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceControls } from "../lib/device-controls.js";
import type { DuoControlState } from "../lib/device-duo-control.js";
import type { DeviceScreenSize } from "../lib/device-stream.js";
import { DeviceDuoControls, duoFoldCommands, duoFoldLabel } from "./device-duo-controls.js";
import { DeviceToolsPanel, parseCoordinates } from "./device-tools-panel.js";

const noop = () => undefined;

function controls(extra: Partial<DeviceControls> = {}): DeviceControls {
  return {
    settings: { appearance: "dark", textSize: "large", reduceMotion: true, liquidGlass: "clear", colorFilter: "none" },
    pending: false,
    error: null,
    disabled: false,
    foregroundApp: { id: "com.example.app", pid: 42 },
    act: async () => true,
    ...extra,
  };
}

test("the drawer shows every section with labelled, stateful controls", () => {
  const html = renderToStaticMarkup(<DeviceToolsPanel controls={controls()} onClose={noop} />);
  for (const title of ["App", "Simulator", "Location", "Permissions", "Push notification"]) {
    assert.match(html, new RegExp(`>${title}<`, "u"), title);
  }
  for (const name of [
    "Close device tools",
    "Reduce Motion",
    "VoiceOver",
    "Latitude",
    "Longitude",
    "Bundle ID for permissions",
  ]) {
    assert.match(html, new RegExp(`aria-label="${name}"`, "u"), name);
  }
  assert.match(html, /com\.example\.app/u);
  assert.match(html, /aria-pressed="true"[^>]*>Dark</u);
  assert.match(html, /aria-labelledby="device-tools-title" aria-busy="false"/u);
  assert.doesNotMatch(html, /role="alert"/u);
});

test("the drawer reports errors inline and asks for an app before a push", () => {
  const html = renderToStaticMarkup(
    <DeviceToolsPanel
      controls={controls({ error: "Could not change the appearance: boom", foregroundApp: null, disabled: true })}
      onClose={noop}
    />,
  );
  assert.match(html, /role="alert"[^>]*>Could not change the appearance: boom/u);
  assert.match(html, /Open an app first/u);
});

test("coordinates must both be finite and within range", () => {
  assert.deepEqual(parseCoordinates("51.5", "-0.12"), { latitude: 51.5, longitude: -0.12 });
  assert.equal(parseCoordinates("", "1"), null);
  assert.equal(parseCoordinates("91", "0"), null);
  assert.equal(parseCoordinates("0", "-181"), null);
  assert.equal(parseCoordinates("north", "0"), null);
});

const idle = { pending: false, requested: null, error: null };
const duo = (screen: Partial<DeviceScreenSize>, state: DuoControlState = idle) =>
  renderToStaticMarkup(
    <DeviceDuoControls
      screen={{ width: 1, height: 1, orientation: "portrait", supportsHingeAngle: true, ...screen }}
      state={state}
      enabled
      onCommand={noop}
    />,
  );
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>.*?</button>`, "u"))?.[0] ?? "";

test("a half fold reads as a book when the phone is held upright and as a laptop when it is held sideways", () => {
  // The inner display is mounted a quarter turn, so landscape_left is an upright phone.
  const upright = duo({ screenId: 3, orientation: "landscape_left", hingeAngle: 90 });
  assert.match(button(upright, "Book"), /aria-pressed="true"/u);
  assert.doesNotMatch(upright, /aria-label="Laptop"/u);
  assert.doesNotMatch(button(upright, "Closed"), /data-rotated/u);
  const sideways = duo({ screenId: 3, orientation: "portrait_upside_down", hingeAngle: 90 });
  assert.match(button(sideways, "Laptop"), /aria-pressed="true"/u);
  // The fold glyphs turn with the phone; the stance glyphs do not.
  for (const label of ["Closed", "Laptop", "Open"]) assert.match(button(sideways, label), /data-rotated/u, label);
  for (const label of ["Laptop stand", "Tent stand"]) assert.doesNotMatch(button(sideways, label), /data-rotated/u, label);
  assert.equal(duoFoldLabel("half", true), "Book");
  assert.equal(duoFoldLabel("half", false), "Laptop");
});

test("a stand is pressed on its own, and folds wait while a stand is landing", () => {
  const laptop = duo({ screenId: 3, orientation: "portrait", hingeAngle: 90, hingePose: "laptop" });
  assert.match(button(laptop, "Laptop stand"), /aria-pressed="true"/u);
  // A sideways laptop stand's half fold is labelled Laptop; no fold shape claims the stand.
  for (const label of ["Closed", "Laptop", "Open"]) assert.match(button(laptop, label), /aria-pressed="false"/u, label);
  for (const label of ["Closed", "Open"]) assert.doesNotMatch(button(laptop, label), /\sdisabled=""/u);
  const landing = duo(
    { screenId: 3, orientation: "portrait", hingeAngle: 90, hingePose: "laptop" },
    { pending: true, requested: { control: "pose", value: "laptop" }, error: null },
  );
  for (const label of ["Closed", "Open"]) assert.match(button(landing, label), /\sdisabled=""/u, label);
  assert.doesNotMatch(button(landing, "Tent stand"), /\sdisabled=""/u);
});

test("leaving a stand turns the phone back to how it was held before the hinge moves", () => {
  assert.deepEqual(duoFoldCommands(180, { stand: false, standVertical: true, screenId: 3 }), [{ control: "angle", value: 180 }]);
  assert.deepEqual(duoFoldCommands(0, { stand: true, standVertical: true, screenId: 3 }), [
    { control: "orientation", value: "landscape_left" },
    { control: "angle", value: 0 },
  ]);
  assert.deepEqual(duoFoldCommands(90, { stand: true, standVertical: false, screenId: 1 }), [
    { control: "orientation", value: "landscape_left" },
    { control: "angle", value: 90 },
  ]);
});

test("Duo controls render both groups and surface a failed command", () => {
  const html = renderToStaticMarkup(
    <DeviceDuoControls
      screen={{ width: 1, height: 1, orientation: "portrait", supportsHingeAngle: true, hingeAngle: 0 }}
      state={{ pending: false, requested: null, error: "Device is disconnected." }}
      enabled={false}
      onCommand={noop}
    />,
  );
  assert.match(html, /role="group" aria-label="Fold shape"/u);
  assert.match(html, /role="group" aria-label="Device stance"/u);
  assert.match(button(html, "Closed"), /aria-pressed="true"/u);
  assert.match(button(html, "Closed"), /\sdisabled=""/u);
  assert.match(html, /role="alert"[^>]*>.*Device is disconnected\./u);
});
