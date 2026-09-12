import assert from "node:assert/strict";
import test from "node:test";

import { desktopVersionRequested } from "./desktop-cli-core.js";

test("packaged desktop recognizes only an explicit user --version argument", () => {
  assert.equal(desktopVersionRequested(["/opt/Aiden Agent/aiden-agent"], false), false);
  assert.equal(
    desktopVersionRequested(
      ["/opt/Aiden Agent/aiden-agent", "--no-sandbox", "--version"],
      false,
    ),
    true,
  );
});

test("development desktop does not mistake the application path for an argument", () => {
  assert.equal(
    desktopVersionRequested(["/repo/node_modules/.bin/electron", "--version"], true),
    false,
  );
  assert.equal(
    desktopVersionRequested(
      ["/repo/node_modules/.bin/electron", "/repo", "--version"],
      true,
    ),
    true,
  );
});
