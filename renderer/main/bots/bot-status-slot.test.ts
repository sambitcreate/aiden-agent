import assert from "node:assert/strict";
import test from "node:test";
import { pickBotStatus } from "./bot-status-slot";

test("nothing applies, nothing shows", () => {
  assert.equal(pickBotStatus({}), null);
  assert.equal(pickBotStatus({ paused: false, plan: false }), null);
});

test("the most important status wins, case by case", () => {
  const cases: Array<[Parameters<typeof pickBotStatus>[0], string]> = [
    // A model problem stops the Bot whatever else is true.
    [{ model_error: true, spending_reached: true, paused: true }, "model_error"],
    // A spent limit outranks the person's own pause.
    [{ paused: true, spending_reached: true }, "spending_reached"],
    // A paused Bot shows the pause, not an old interruption or a nearing line.
    [{ paused: true, interrupted: true, spending_nearing: true }, "paused"],
    // An interrupted turn comes before a wait that clears on its own.
    [{ interrupted: true, usage_limit: true }, "interrupted"],
    [{ usage_limit: true, saved_resume: true, spending_nearing: true }, "usage_limit"],
    [{ saved_resume: true, spending_nearing: true, plan: true }, "saved_resume"],
    // The nearing line is only a heads-up, above an approved or ended plan.
    [{ spending_nearing: true, plan: true }, "spending_nearing"],
    [{ plan: true }, "plan"],
  ];
  for (const [applies, expected] of cases) assert.equal(pickBotStatus(applies), expected, JSON.stringify(applies));
});
