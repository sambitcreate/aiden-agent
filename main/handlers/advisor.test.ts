import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const handler = readFileSync(new URL("./advisor.ts", import.meta.url), "utf8");
const registry = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const channels = readFileSync(
  new URL("../../renderer/preload-channels.ts", import.meta.url),
  "utf8",
);

test("advisor settings IPC is allowlisted, registered, and bound to an active renderer document", () => {
  assert.match(channels, /"advisor:"/u);
  assert.match(registry, /registerAdvisorHandlers\(\)/u);
  assert.match(handler, /ipcMain\.handle\("advisor:get"/u);
  assert.match(handler, /ipcMain\.handle\("advisor:set"/u);
  assert.equal((handler.match(/activeAdvisorOwner\(event\)/gu) ?? []).length, 2);
  assert.match(handler, /owner\.isDestroyed\(\)/u);
  assert.match(handler, /advisorRuntime\.setSelection\(selection, \(\) =>/u);
});

test("advisor mutation errors remain closed at the renderer boundary", () => {
  assert.match(handler, /catch \{/u);
  assert.match(handler, /could not validate or save that advisor selection/u);
  assert.doesNotMatch(handler, /throw error/u);
});
