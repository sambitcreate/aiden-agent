import assert from "node:assert/strict";
import test from "node:test";

import { macDevRuntimeLayout } from "./prepare-macos-dev-runtime.mjs";

test("brands the macOS development app and every Electron helper as Aiden Agent", () => {
  assert.deepEqual(macDevRuntimeLayout(), {
    bundleIdentifier: "com.sambitcreate.aiden-agent.dev",
    executableName: "Aiden Agent",
    helpers: [
      {
        bundleIdentifier: "com.sambitcreate.aiden-agent.dev.helper",
        destinationName: "Aiden Agent Helper",
        sourceName: "Electron Helper",
      },
      {
        bundleIdentifier: "com.sambitcreate.aiden-agent.dev.helper.GPU",
        destinationName: "Aiden Agent Helper (GPU)",
        sourceName: "Electron Helper (GPU)",
      },
      {
        bundleIdentifier: "com.sambitcreate.aiden-agent.dev.helper.Plugin",
        destinationName: "Aiden Agent Helper (Plugin)",
        sourceName: "Electron Helper (Plugin)",
      },
      {
        bundleIdentifier: "com.sambitcreate.aiden-agent.dev.helper.Renderer",
        destinationName: "Aiden Agent Helper (Renderer)",
        sourceName: "Electron Helper (Renderer)",
      },
    ],
    productName: "Aiden Agent",
  });
});
