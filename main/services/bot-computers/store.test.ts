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
