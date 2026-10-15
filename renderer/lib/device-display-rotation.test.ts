import assert from "node:assert/strict";
import test from "node:test";
import {
  deviceDisplayRotation,
  displayedAspect,
  displayedAxScreen,
  fittedScreenStyle,
  rotatedMediaStyle,
} from "./device-display-rotation";

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

test("the screen box keeps the displayed aspect whether its parent is width- or height-bound", () => {
  const style = fittedScreenStyle(2.174);
  // Resolve `min(100cq?, calc(100cq? <op> aspect))` for a parent of the given size.
  const resolve = (expression: string, cqw: number, cqh: number) => {
    const match = /^min\(100(cq[wh]), calc\(100(cq[wh]) ([*/]) ([\d.]+)\)\)$/u.exec(expression);
    assert.ok(match, expression);
    const unit = (name: string) => (name === "cqw" ? cqw : cqh);
    const scaled = match[3] === "*" ? unit(match[2]!) * Number(match[4]) : unit(match[2]!) / Number(match[4]);
    return Math.min(unit(match[1]!), scaled);
  };
  for (const [cqw, cqh] of [
    [400, 600],
    [1200, 300],
    [800, 368],
  ] as const) {
    const width = resolve(String(style.width), cqw, cqh);
    const height = resolve(String(style.height), cqw, cqh);
    assert.ok(width <= cqw + 1e-6 && height <= cqh + 1e-6, "fits the parent");
    assert.ok(Math.abs(width / height - 2.174) < 1e-6, "keeps the aspect");
  }
});

test("the overlay maps its tree into the displayed screen once a raw frame is turned", () => {
  const raw = { ...PORTRAIT_FRAME, orientation: "landscape_left" as const };
  assert.deepEqual(displayedAxScreen(raw, 90), { width: 2622, height: 1206, orientation: "landscape_left" });
  assert.deepEqual(displayedAxScreen({ ...PORTRAIT_FRAME, orientation: "portrait_upside_down" }, 180), {
    ...PORTRAIT_FRAME,
    orientation: "portrait",
  });
  assert.equal(displayedAxScreen(raw, 0), raw);
  assert.equal(displayedAxScreen(null, 90), null);
});
