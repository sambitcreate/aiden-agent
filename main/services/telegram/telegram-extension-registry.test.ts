import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  clearTelegramExtensionsForTests,
  getTelegramExtensions,
  registerTelegramExtension,
  telegramExtensionCallbackData,
} from "./telegram-extension-registry.js";

afterEach(clearTelegramExtensionsForTests);

test("extension registry owns commands and namespaced callbacks", () => {
  const callbackData = telegramExtensionCallbackData("weather", "refresh");
  const unregister = registerTelegramExtension({
    id: "weather",
    commands: [{ name: "forecast", description: "Forecast", async handler() { return "sunny"; } }],
    sections: [{ id: "main", label: "Weather", callbackData }],
  });
  assert.equal(getTelegramExtensions()[0]?.id, "weather");
  assert.equal(callbackData, "ext:weather:refresh");
  unregister();
  assert.equal(getTelegramExtensions().length, 0);
});

test("extension registry rejects collisions and foreign callback namespaces", () => {
  registerTelegramExtension({
    id: "one",
    commands: [{ name: "shared", description: "One", async handler() {} }],
  });
  assert.throws(() => registerTelegramExtension({
    id: "two",
    commands: [{ name: "shared", description: "Two", async handler() {} }],
  }));
  assert.throws(() => registerTelegramExtension({
    id: "bad",
    sections: [{ id: "x", label: "Bad", callbackData: "ext:other:x" }],
  }));
});
