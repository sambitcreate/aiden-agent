import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ACTIVITY_MARKS, type ActivityMark } from "../shared/activity-marks.js";
import { AidenActivityMark } from "./aiden-activity-mark.js";

// Shape counts from docs/activity-marks.md; iOS and Android draw the same geometry.
const SHAPES: Record<ActivityMark, { circle: number; rect: number }> = {
  "tri-step": { circle: 3, rect: 0 },
  "quad-shuffle": { circle: 4, rect: 0 },
  compose: { circle: 0, rect: 3 },
  "scan-grid": { circle: 9, rect: 0 },
  glance: { circle: 0, rect: 2 },
  bounce: { circle: 3, rect: 0 },
  "helix-calm": { circle: 10, rect: 0 },
  "helix-twist": { circle: 10, rect: 0 },
  "helix-swell": { circle: 10, rect: 0 },
  "helix-duplex": { circle: 10, rect: 0 },
  "helix-flat": { circle: 10, rect: 0 },
};

const count = (markup: string, tag: string) => (markup.match(new RegExp(`<${tag}\\b`, "gu")) ?? []).length;

test("every activity mark renders as a decorative vector, never a canvas", () => {
  for (const mark of ACTIVITY_MARKS) {
    const markup = renderToStaticMarkup(<AidenActivityMark mark={mark} />);
    assert.match(markup, /^<svg[^>]*viewBox="0 0 24 24"/u, mark);
    assert.match(markup, /aria-hidden="true"/u, mark);
    assert.match(markup, new RegExp(`data-aiden-mark="${mark}"`, "u"), mark);
    assert.doesNotMatch(markup, /<canvas|<image|<foreignObject/u, mark);
    assert.equal(count(markup, "circle"), SHAPES[mark].circle, `${mark} circles`);
    assert.equal(count(markup, "rect"), SHAPES[mark].rect, `${mark} rects`);
  }
});

test("marks size to the requested pixels and freeze when inactive", () => {
  const live = renderToStaticMarkup(<AidenActivityMark mark="tri-step" size={64} />);
  assert.match(live, /width:64px;height:64px/u);
  assert.doesNotMatch(live, /data-paused/u);

  const frozen = renderToStaticMarkup(<AidenActivityMark mark="tri-step" active={false} />);
  assert.match(frozen, /width:20px;height:20px/u);
  assert.match(frozen, /data-paused=""/u);
});

test("only an explicit voice level picks a swell step, clamped to its range", () => {
  assert.doesNotMatch(renderToStaticMarkup(<AidenActivityMark mark="helix-swell" />), /data-level/u);
  assert.match(renderToStaticMarkup(<AidenActivityMark mark="helix-swell" level={0.5} />), /data-level="2"/u);
  assert.match(renderToStaticMarkup(<AidenActivityMark mark="helix-swell" level={-2} />), /data-level="0"/u);
  assert.doesNotMatch(renderToStaticMarkup(<AidenActivityMark mark="helix-swell" level={NaN} />), /data-level|NaN/u);
});

test("phase offsets are plain inline delays, so marks mount without custom properties", () => {
  const helix = renderToStaticMarkup(<AidenActivityMark mark="helix-twist" />);
  assert.doesNotMatch(helix, /style="[^"]*--/u);
  // Column 0 of strand a starts at phase 0; its depth track trails by a quarter of
  // 1.5s, which as a repeating phase is 0.375s − 1.5s = −1.125s.
  assert.match(helix, /animation-delay:0s, -1\.125s/u);
  // Swell's second wave sits on a wrapper per circle, so it adds to the braid rather than scaling with depth.
  const swell = renderToStaticMarkup(<AidenActivityMark mark="helix-swell" />);
  assert.equal((swell.match(/<g class="aiden-mark-wave" style="animation-delay:[^"]*"><circle/gu) ?? []).length, 10);
});

test("every phase offset starts mid-cycle like the native (t − d) mod D, never as a startup wait", () => {
  for (const mark of ACTIVITY_MARKS) {
    const markup = renderToStaticMarkup(<AidenActivityMark mark={mark} />);
    const delays = [...markup.matchAll(/animation-delay:([^;"]+)/gu)].flatMap((match) =>
      match[1].split(",").map((value) => Number.parseFloat(value)),
    );
    for (const seconds of delays) assert.ok(seconds <= 0, `${mark} has a positive delay ${seconds}s`);
  }
  // Bounce dot 2 trails dot 1 by 0.13s of a 1.2s cycle: −1.07s, as on iOS and Android.
  assert.match(renderToStaticMarkup(<AidenActivityMark mark="bounce" />), /animation-delay:-1\.07s/u);
});
