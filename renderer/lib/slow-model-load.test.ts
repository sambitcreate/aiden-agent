import { test } from "node:test";
import assert from "node:assert/strict";
import { SlowModelLoadNotice } from "./slow-model-load.js";

function clock() {
  let now = 0;
  const timers: Array<{ at: number; cb: () => void; dead?: boolean }> = [];
  return {
    deps: (onShow: () => void) => ({
      setTimer: (cb: () => void, ms: number) => {
        const t = { at: now + ms, cb };
        timers.push(t);
        return t;
      },
      clearTimer: (t: unknown) => {
        (t as { dead: boolean }).dead = true;
      },
      onShow,
    }),
    advance(ms: number) {
      now += ms;
      for (const t of timers)
        if (!t.dead && t.at <= now) {
          t.dead = true;
          t.cb();
        }
    },
  };
}

test("a warm load never shows the notice", () => {
  const c = clock();
  let shown = 0;
  const n = new SlowModelLoadNotice(c.deps(() => { shown += 1; }));
  n.observe("loading");
  c.advance(1500);
  n.observe("ready");
  c.advance(5000);
  assert.equal(shown, 0);
});

test("a slow load shows once after 2 s and an idle 'unloaded' does not end it", () => {
  const c = clock();
  let shown = 0;
  const n = new SlowModelLoadNotice(c.deps(() => { shown += 1; }));
  n.observe("loading");
  c.advance(1000);
  n.observe("unloaded");
  c.advance(1500);
  assert.equal(shown, 1);
  assert.equal(n.shown, true);
  n.observe("loading");
  c.advance(3000);
  assert.equal(shown, 1);
});

test("failure ends the wait without showing", () => {
  const c = clock();
  let shown = 0;
  const n = new SlowModelLoadNotice(c.deps(() => { shown += 1; }));
  n.observe("loading");
  n.observe("failed");
  c.advance(5000);
  assert.equal(shown, 0);
});

test("disposing mid-load cancels the pending notice", () => {
  const c = clock();
  let shown = 0;
  const n = new SlowModelLoadNotice(c.deps(() => { shown += 1; }));
  n.observe("loading");
  c.advance(1000);
  n.dispose();
  c.advance(5000);
  assert.equal(shown, 0);
  assert.equal(n.shown, false);
});
