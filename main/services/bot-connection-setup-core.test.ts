import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionSetupTarget,
  createFocusHistory,
  type ConnectionSetupWindow,
} from "./bot-connection-setup-core.js";

function windowsOf(specs: Array<{ id: number; focused?: boolean; destroyed?: boolean }>) {
  const sent: Array<{ id: number; channel: string; payload: unknown }> = [];
  const windows: ConnectionSetupWindow[] = specs.map((spec) => ({
    id: spec.id,
    isDestroyed: () => spec.destroyed === true,
    isFocused: () => spec.focused === true,
    send: (channel, payload) => sent.push({ id: spec.id, channel, payload }),
  }));
  return { windows, sent };
}

test("setup opens in the focused window only", () => {
  const { windows, sent } = windowsOf([{ id: 1 }, { id: 2, focused: true }, { id: 3 }]);
  const history = createFocusHistory();
  history.focused(3);
  connectionSetupTarget({ all: () => windows, focusHistory: history.list })?.send("bots:connections:setup", {
    pluginId: "x",
  });
  assert.deepEqual(sent, [{ id: 2, channel: "bots:connections:setup", payload: { pluginId: "x" } }]);
});

test("with nothing focused, the most recently focused open window gets setup", () => {
  const { windows } = windowsOf([{ id: 1 }, { id: 2 }, { id: 3, destroyed: true }]);
  const history = createFocusHistory();
  history.focused(2);
  history.focused(1);
  history.focused(2);
  history.focused(3);
  assert.equal(connectionSetupTarget({ all: () => windows, focusHistory: history.list })?.id, 2);
  history.closed(2);
  assert.equal(connectionSetupTarget({ all: () => windows, focusHistory: history.list })?.id, 1);
});

test("with no focus history the newest open window is used, and no window means none", () => {
  const { windows } = windowsOf([{ id: 4 }, { id: 7 }, { id: 9, destroyed: true }]);
  assert.equal(connectionSetupTarget({ all: () => windows, focusHistory: () => [] })?.id, 7);
  assert.equal(connectionSetupTarget({ all: () => [], focusHistory: () => [1] }), null);
});
