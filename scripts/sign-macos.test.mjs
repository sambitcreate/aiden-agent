import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { COMPUTER_USE_ENTITLEMENTS, createAidenMacSignOptions } from "./sign-macos.mjs";
import { packagedComputerUsePaths } from "./computer-use-signing-pins.mjs";

test("mac signing hook ignores only the exact pinned driver and retains prior ignores", () => {
  const app = path.resolve("/tmp/Aiden Agent.app");
  const paths = packagedComputerUsePaths(app);
  const options = createAidenMacSignOptions({
    app,
    ignore: (file) => file.endsWith("already-ignored"),
    optionsForFile: () => ({ entitlements: "/tmp/electron.plist", hardenedRuntime: true }),
  });

  assert.equal(options.ignore(paths.driver), true);
  assert.equal(options.ignore(path.join(app, "Contents", "MacOS", "cua-driver")), false);
  assert.equal(options.ignore(path.join(app, "already-ignored")), true);
});

test("mac signing hook assigns minimal entitlements to privileged and standalone native helpers", () => {
  const app = path.resolve("/tmp/Aiden Agent.app");
  const paths = packagedComputerUsePaths(app);
  const electronEntitlements = "/tmp/electron.plist";
  const options = createAidenMacSignOptions({
    app,
    optionsForFile: () => ({
      entitlements: electronEntitlements,
      hardenedRuntime: true,
      timestamp: true,
    }),
  });

  assert.equal(options.optionsForFile(paths.helperApp).entitlements, COMPUTER_USE_ENTITLEMENTS);
  assert.equal(options.optionsForFile(paths.broker).entitlements, COMPUTER_USE_ENTITLEMENTS);
  assert.equal(options.optionsForFile(paths.broker).timestamp, true);
  assert.equal(
    options.optionsForFile(path.join(app, "Contents", "Helpers", "aiden-subagent-run-store"))
      .entitlements,
    COMPUTER_USE_ENTITLEMENTS,
  );
  assert.equal(
    options.optionsForFile(path.join(app, "Contents", "Helpers", "aiden-subagent-file-mutator"))
      .entitlements,
    COMPUTER_USE_ENTITLEMENTS,
  );
  assert.equal(
    options.optionsForFile(path.join(app, "Contents", "Helpers", "aiden-subagent-shell-runner"))
      .entitlements,
    COMPUTER_USE_ENTITLEMENTS,
  );
  assert.equal(
    options.optionsForFile(path.join(app, "Contents", "Helpers", "aiden-worktree-remover"))
      .entitlements,
    COMPUTER_USE_ENTITLEMENTS,
  );
  assert.equal(
    options.optionsForFile(path.join(app, "Contents", "MacOS", "Aiden Agent")).entitlements,
    electronEntitlements,
  );
});
