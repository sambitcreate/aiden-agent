import assert from "node:assert/strict";
import test from "node:test";
import { localComputerNoun, runtimeComputerPlatform, thisComputerLabel } from "./computer-noun.js";

test("names the local computer a Mac only on macOS", () => {
  assert.equal(localComputerNoun("darwin"), "Mac");
  assert.equal(localComputerNoun("linux"), "computer");
  assert.equal(localComputerNoun("other"), "computer");
  assert.equal(localComputerNoun(undefined), "computer");
  assert.equal(thisComputerLabel("darwin"), "This Mac");
  assert.equal(thisComputerLabel("linux"), "This computer");
});

function withGlobals(
  stubs: { process?: unknown; navigator?: unknown },
  run: () => void,
): void {
  const previousProcess = Object.getOwnPropertyDescriptor(globalThis, "process");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  if ("process" in stubs) {
    if (stubs.process === undefined) {
      Reflect.deleteProperty(globalThis, "process");
    } else {
      Object.defineProperty(globalThis, "process", {
        configurable: true,
        writable: true,
        value: stubs.process,
      });
    }
  }
  if ("navigator" in stubs) {
    if (stubs.navigator === undefined) {
      Reflect.deleteProperty(globalThis, "navigator");
    } else {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        writable: true,
        value: stubs.navigator,
      });
    }
  }
  try {
    run();
  } finally {
    if (previousProcess) {
      Object.defineProperty(globalThis, "process", previousProcess);
    } else {
      Reflect.deleteProperty(globalThis, "process");
    }
    if (previousNavigator) {
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  }
}

test("runtimeComputerPlatform prefers process.platform and otherwise reads navigator.userAgentData.platform with userAgent fallback", () => {
  withGlobals(
    {
      process: { platform: "darwin" },
      navigator: { userAgentData: { platform: "Linux" } },
    },
    () => {
      assert.equal(runtimeComputerPlatform(), "darwin");
    },
  );

  withGlobals(
    {
      process: {},
      navigator: {
        userAgentData: { platform: "macOS" },
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      },
    },
    () => {
      assert.equal(runtimeComputerPlatform(), "darwin");
    },
  );

  withGlobals(
    {
      process: undefined,
      navigator: {
        userAgentData: { platform: "Linux" },
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      },
    },
    () => {
      assert.equal(runtimeComputerPlatform(), "linux");
    },
  );

  withGlobals(
    {
      process: undefined,
      navigator: { userAgentData: { platform: "Windows" }, userAgent: "" },
    },
    () => {
      assert.equal(runtimeComputerPlatform(), undefined);
    },
  );

  withGlobals(
    {
      process: undefined,
      navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    },
    () => {
      assert.equal(runtimeComputerPlatform(), "darwin");
    },
  );

  withGlobals(
    {
      process: undefined,
      navigator: {
        userAgentData: { platform: "" },
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      },
    },
    () => {
      assert.equal(runtimeComputerPlatform(), "linux");
    },
  );

  withGlobals({ process: undefined, navigator: undefined }, () => {
    assert.equal(runtimeComputerPlatform(), undefined);
  });
});
