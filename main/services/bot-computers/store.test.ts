import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBotComputersStore, parseBotComputersState } from "./store.js";

test("state round-trips through an owner-only file and concurrent updates all land", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p8-store-"));
  const file = path.join(dir, "bot-computers", "state.json");
  const store = createBotComputersStore(file);
  assert.deepEqual((await store.read()).settings, { maxRunning: 2, idleStopMinutes: 10 });
  await Promise.all(
    ["a", "b", "c"].map((botId, index) =>
      store.update((state) => {
        state.computers[botId] = { vmName: `aiden-bot-${String(index).repeat(16)}`, baseBuild: "25G83", createdAt: index };
      }),
    ),
  );
  const state = await store.read();
  assert.deepEqual(Object.keys(state.computers).sort(), ["a", "b", "c"]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});

test("a damaged file keeps what is valid and drops foreign VM names and bad settings", async () => {
  const parsed = parseBotComputersState({
    settings: { maxRunning: 5, idleStopMinutes: 15 },
    setup: { baseBuild: "25G83", ipswPath: "relative.ipsw" },
    computers: {
      good: { vmName: "aiden-bot-0123456789abcdef", baseBuild: "25G83", createdAt: 1, lastUsedAt: 2 },
      foreign: { vmName: "my-own-vm", baseBuild: "25G83", createdAt: 1 },
      broken: "nope",
    },
  });
  assert.deepEqual(parsed.settings, { maxRunning: 2, idleStopMinutes: 15 });
  assert.deepEqual(parsed.setup, { baseBuild: "25G83" });
  assert.deepEqual(Object.keys(parsed.computers), ["good"]);

  const dir = mkdtempSync(path.join(tmpdir(), "p8-store-bad-"));
  const file = path.join(dir, "state.json");
  writeFileSync(file, "{not json");
  assert.deepEqual((await createBotComputersStore(file).read()).computers, {});
});

test("the guest driver flag is kept for a base and its computers only when it is well formed", () => {
  const driver = { version: "0.36.0", home: "/Users/lume", uid: 501 };
  const parsed = parseBotComputersState({
    setup: { baseBuild: "25G83", guestDriver: driver },
    computers: {
      ada: { vmName: `aiden-bot-${"a".repeat(16)}`, baseBuild: "25G83", createdAt: 1, guestDriver: driver },
      bea: { vmName: `aiden-bot-${"b".repeat(16)}`, baseBuild: "25G83", createdAt: 2, guestDriver: { ...driver, home: "/var/root" } },
      cy: { vmName: `aiden-bot-${"c".repeat(16)}`, baseBuild: "25G83", createdAt: 3, guestDriver: { ...driver, version: "latest" } },
    },
  });
  assert.deepEqual(parsed.setup.guestDriver, driver);
  assert.deepEqual(parsed.computers.ada?.guestDriver, driver);
  assert.equal(parsed.computers.bea?.guestDriver, undefined, "a home outside /Users is dropped, the computer kept");
  assert.equal(parsed.computers.cy?.guestDriver, undefined);
  // Without a base there is nothing the flag could describe.
  assert.equal(parseBotComputersState({ setup: { guestDriver: driver } }).setup.guestDriver, undefined);
});
