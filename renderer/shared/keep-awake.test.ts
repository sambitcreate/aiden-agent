import assert from "node:assert/strict";
import test from "node:test";
import { keepAwakeStatusLine, parseKeepAwakeStatus, type KeepAwakeStatus } from "./keep-awake.js";

const base: KeepAwakeStatus = {
  supported: true,
  enabled: true,
  holding: false,
  pausedWhileIdle: false,
  counts: {},
};

test("the live line says what keeps the computer awake", () => {
  assert.equal(keepAwakeStatusLine(base), "Not needed right now");
  assert.equal(
    keepAwakeStatusLine({ ...base, holding: true, counts: { chat: 1 } }),
    "Keeping awake: 1 chat working",
  );
  assert.equal(
    keepAwakeStatusLine({ ...base, holding: true, counts: { chat: 2, job: 1, check: 3 } }),
    "Keeping awake: 2 chats working, 1 background job running, 3 checks running",
  );
  assert.equal(
    keepAwakeStatusLine({ ...base, holding: true, counts: { "check-back": 1, "wake-up": 2 } }),
    "Keeping awake: 1 check-back due soon, 2 Bot wake-ups due soon",
  );
  assert.equal(
    keepAwakeStatusLine({ ...base, holding: true, counts: { goal: 1 } }),
    "Keeping awake: 1 goal being checked",
  );
  assert.equal(
    keepAwakeStatusLine({ ...base, holding: true, counts: { chat: 1, goal: 2 } }),
    "Keeping awake: 1 chat working, 2 goals being checked",
  );
  assert.equal(
    keepAwakeStatusLine({ ...base, holding: true }),
    "Keeping awake for one more minute",
  );
  assert.equal(
    keepAwakeStatusLine({ ...base, pausedWhileIdle: true }),
    "Paused: nobody has used this computer for 4 hours",
  );
  assert.equal(
    keepAwakeStatusLine({ ...base, enabled: false }),
    "Off: this computer sleeps as usual",
  );
  assert.equal(keepAwakeStatusLine({ ...base, supported: false }), null);
});

test("a malformed status from main reads as unsupported, and bad counts are dropped", () => {
  assert.equal(parseKeepAwakeStatus(null).supported, false);
  assert.deepEqual(
    parseKeepAwakeStatus({
      supported: true,
      enabled: true,
      holding: true,
      counts: { chat: 1, job: -2, check: 1.5, goal: 1, other: 4 },
    }),
    {
      supported: true,
      enabled: true,
      holding: true,
      pausedWhileIdle: false,
      counts: { chat: 1, goal: 1 },
    },
  );
});
