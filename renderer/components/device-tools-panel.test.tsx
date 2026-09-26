import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceControls } from "../lib/device-controls.js";
import type { DeviceScreenSize } from "../lib/device-stream.js";
import { DeviceDuoControls, selectedDuoPose } from "./device-duo-controls.js";
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

test("Duo pose buttons follow the reported hinge angle and stance", () => {
  assert.equal(selectedDuoPose({ hingeAngle: 180, hingePose: "open" }, "open"), true);
  assert.equal(selectedDuoPose({ hingeAngle: 180, hingePose: "open" }, "book"), false);
  assert.equal(selectedDuoPose({ hingeAngle: 90, hingePose: "laptop" }, "laptop"), true);
  assert.equal(selectedDuoPose({ hingeAngle: 90, hingePose: "laptop" }, "book"), false);
  assert.equal(selectedDuoPose({ hingeAngle: 45 }, "book"), true);
  assert.equal(selectedDuoPose({}, "closed"), false);
});

test("Duo controls render both groups and surface a failed command", () => {
  const screen: DeviceScreenSize = { width: 1, height: 1, orientation: "portrait", supportsHingeAngle: true, hingeAngle: 0 };
  const html = renderToStaticMarkup(
    <DeviceDuoControls
      screen={screen}
      state={{ pending: false, requested: null, error: "Device is disconnected." }}
      enabled={false}
      onCommand={noop}
    />,
  );
  assert.match(html, /role="group" aria-label="Fold shape"/u);
  assert.match(html, /role="group" aria-label="Device stance"/u);
  assert.match(html, /aria-label="Closed pose" aria-pressed="true"/u);
  assert.match(html, /aria-label="Book \/ bookshelf pose"/u);
  assert.match(html, /role="alert"[^>]*>.*Device is disconnected\./u);
});
