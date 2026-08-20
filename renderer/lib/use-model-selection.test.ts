import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "./types.js";

const provider = (overrides: Partial<Provider> = {}): Provider => ({
  id: "google",
  kind: "openai",
  label: "Google",
  baseUrl: "",
  models: ["gemini-pro", "gemini-flash"],
  defaultModel: "gemini-pro",
  needsKey: true,
  hasKey: true,
  isBuiltin: true,
  ...overrides,
});

test("new work resolves away from a hidden active or default model", async () => {
  const { initialVisibleModelSelection, resolveVisibleModelSelection } = await import("./use-model-selection");
  assert.equal(
    initialVisibleModelSelection(
      { providerId: "", model: "" },
      [provider()],
      undefined,
      false,
    ),
    undefined,
  );
  assert.deepEqual(
    initialVisibleModelSelection(
      { providerId: "", model: "" },
      [provider()],
      { google: ["gemini-pro"] },
      true,
    ),
    { providerId: "google", model: "gemini-flash" },
  );
  assert.deepEqual(
    resolveVisibleModelSelection({ providerId: "google", model: "gemini-pro" }, [provider()], {
      google: ["gemini-pro"],
    }),
    { providerId: "google", model: "gemini-flash" },
  );
  assert.equal(
    resolveVisibleModelSelection({ providerId: "google", model: "gemini-pro" }, [provider()], {
      google: ["gemini-pro", "gemini-flash"],
    }),
    undefined,
  );
});

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

  const { persistModelSelection, readModelSelectionRevision, subscribeModelSelection } =
    await import("./use-model-selection");
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
