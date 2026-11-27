import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDesignLiveSwitches } from "./app-frame-switches";

/** A stand-in for `app.commandLine` that keeps the last value per switch, as Chromium does. */
function commandLine(initial: Record<string, string> = {}) {
  const switches = new Map(Object.entries(initial));
  return {
    switches,
    hasSwitch: (name: string) => switches.has(name),
    getSwitchValue: (name: string) => switches.get(name) ?? "",
    appendSwitch: (name: string, value?: string) => void switches.set(name, value ?? ""),
  };
}

test("with live apps on, Blink blocks focus() without user activation where a frame's policy says so", () => {
  const line = commandLine();
  applyDesignLiveSwitches(line, true);
  assert.deepEqual(line.getSwitchValue("enable-blink-features").split(","), ["BlockingFocusWithoutUserActivation"]);
});

test("with live apps off, no Blink feature is turned on", () => {
  const line = commandLine();
  applyDesignLiveSwitches(line, false);
  assert.equal(line.hasSwitch("enable-blink-features"), false);
});

test("Blink features already on the command line are kept, and the feature isn't added twice", () => {
  const line = commandLine({ "enable-blink-features": "Foo,Bar" });
  applyDesignLiveSwitches(line, true);
  applyDesignLiveSwitches(line, true);
  assert.deepEqual(line.getSwitchValue("enable-blink-features").split(","), ["Foo", "Bar", "BlockingFocusWithoutUserActivation"]);
});
