import assert from "node:assert/strict";
import test from "node:test";

test("same-window model writes notify every mounted consumer", async () => {
  const values = new Map<string, string>();
  const events = new EventTarget();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });

  const {
    persistModelSelection,
    readModelSelectionRevision,
    subscribeModelSelection,
  } = await import("./use-model-selection");
  const first: Array<{ providerId: string; model: string }> = [];
  const second: Array<{ providerId: string; model: string }> = [];
  const unsubscribeFirst = subscribeModelSelection((selection) => first.push(selection));
  const unsubscribeSecond = subscribeModelSelection((selection) => second.push(selection));

  const previousRevision = readModelSelectionRevision();
  persistModelSelection("anthropic", "claude-sonnet");

  assert.deepEqual(first, [{ providerId: "anthropic", model: "claude-sonnet" }]);
  assert.deepEqual(second, first);
  assert.equal(readModelSelectionRevision(), previousRevision + 1);
  unsubscribeFirst();
  unsubscribeSecond();
});
