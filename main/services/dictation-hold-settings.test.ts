import assert from "node:assert/strict";
import test from "node:test";
import { DictationHoldSettingsTransaction } from "./dictation-hold-settings.js";

test("a newer toggle choice prevents delayed portal approval from persisting hold", async () => {
  let approve!: () => void;
  let saved = false;
  let active = false;
  let cancelled = false;
  const transaction = new DictationHoldSettingsTransaction({ active: () => active, bind: () => new Promise<void>(resolve => { approve = () => { if (!cancelled) active = true; resolve(); }; }), disable: async () => { cancelled = true; active = false; } });
  const hold = transaction.apply(true, async () => { saved = true; });
  const rejected = assert.rejects(hold, /changed during setup/u);
  await transaction.apply(false, async () => { saved = false; });
  approve();
  await rejected;
  assert.equal(saved, false);
  assert.equal(active, false);
});

test("failed persistence closes newly acquired portal authority", async () => {
  let active = false;
  const transaction = new DictationHoldSettingsTransaction({ active: () => active, bind: async () => { active = true; }, disable: async () => { active = false; } });
  await assert.rejects(transaction.apply(true, async () => { throw new Error("disk error"); }), /disk error/u);
  assert.equal(active, false);
});

test("an older toggle save cannot close a newer hold session", async () => {
  let finishSave!: () => void;
  let active = false;
  const transaction = new DictationHoldSettingsTransaction({ active: () => active, bind: async () => { active = true; }, disable: async () => { active = false; } });
  const toggle = transaction.apply(false, () => new Promise<void>(resolve => { finishSave = resolve; }));
  await transaction.apply(true, async () => {});
  finishSave();
  await toggle;
  assert.equal(active, true);
});


test("a stale request delayed inside persistence cannot overwrite the newer preference", async () => {
  let finishOld!: () => void;
  let saved = true;
  let active = true;
  const transaction = new DictationHoldSettingsTransaction({ active: () => active, bind: async () => { active = true; }, disable: async () => { active = false; } });
  const old = transaction.apply(false, (isCurrent) => new Promise<void>(resolve => {
    finishOld = () => { if (isCurrent()) saved = false; resolve(); };
  }));
  await transaction.apply(true, async (isCurrent) => { if (isCurrent()) saved = true; });
  finishOld();
  await old;
  assert.equal(saved, true);
  assert.equal(active, true);
});
