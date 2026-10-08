import assert from "node:assert/strict";
import test from "node:test";
import { deviceDisplayRotation, displayedAspect, rotatedMediaStyle } from "./device-display-rotation";

const PORTRAIT_FRAME = { width: 1206, height: 2622 };

test("a portrait-sized iOS frame reporting landscape or upside down is turned upright", () => {
  assert.equal(deviceDisplayRotation("ios", { ...PORTRAIT_FRAME, orientation: "portrait" }), 0);
  assert.equal(deviceDisplayRotation("ios", { ...PORTRAIT_FRAME, orientation: "landscape_left" }), 90);
  assert.equal(deviceDisplayRotation("ios", { ...PORTRAIT_FRAME, orientation: "landscape_right" }), -90);
  assert.equal(deviceDisplayRotation("ios", { ...PORTRAIT_FRAME, orientation: "portrait_upside_down" }), 180);
});

test("frames that are already landscape, Android frames, and unknown screens are drawn as they come", () => {
  assert.equal(deviceDisplayRotation("ios", { width: 2622, height: 1206, orientation: "landscape_left" }), 0);
  assert.equal(deviceDisplayRotation("android", { ...PORTRAIT_FRAME, orientation: "landscape_left" }), 0);
  assert.equal(deviceDisplayRotation("ios", null), 0);
});

test("a sideways turn shows the device landscape and draws the raw frame at the screen box's transposed size", () => {
  const screen = { ...PORTRAIT_FRAME, orientation: "landscape_left" as const };
  const rotation = deviceDisplayRotation("ios", screen);
  const aspect = displayedAspect(screen, rotation);
  assert.ok(aspect > 1, "the box is landscape");
  assert.equal(displayedAspect(screen, 0), PORTRAIT_FRAME.width / PORTRAIT_FRAME.height);

  // The turned media is the screen box's height wide and its width tall, so it covers the box exactly.
  const style = rotatedMediaStyle(rotation)!;
  assert.equal(style.width, "100cqh");
  assert.equal(style.height, "100cqw");
  assert.match(String(style.transform), /translate\(-50%, -50%\) rotate\(90deg\)/u);
  assert.match(String(rotatedMediaStyle(-90)!.transform), /rotate\(-90deg\)/u);

  assert.deepEqual(rotatedMediaStyle(180), { transform: "rotate(180deg)" });
  assert.equal(rotatedMediaStyle(0), undefined);
});
