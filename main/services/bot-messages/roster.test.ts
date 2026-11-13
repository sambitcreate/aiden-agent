import assert from "node:assert/strict";
import { test } from "node:test";
import { botFixture } from "../../../renderer/main/bots/test-fixtures.js";
import { SpendingDispatchError } from "../spending-dispatch-ledger.js";
import { projectBotMessageRoster } from "./roster.js";

test("roster reports local model, budget and pause availability independently for each Bot", async () => {
  const bots = ["ready", "paused", "no-model", "over-budget", "unreadable"].map((id) => botFixture({ id, name: id }));
  const reports: string[] = [];
  const rows = await projectBotMessageRoster(bots, {
    paused: async (id) => {
      if (id === "unreadable") throw new Error("pause file damaged");
      return id === "paused";
    },
    hasModel: async (id) => id !== "no-model",
    spendingRefusal: async (id) => (id === "over-budget" ? "Monthly limit reached" : undefined),
    report: (id) => {
      reports.push(id);
    },
  });
  assert.deepEqual(
    rows.map((row) => [row.id, row.unavailable]),
    [
      ["ready", undefined],
      ["paused", "bot_paused"],
      ["no-model", "needs_model"],
      ["over-budget", "spending_limit"],
      ["unreadable", "unavailable"],
    ],
  );
  assert.deepEqual(reports, ["unreadable"]);
});

test("a Bot whose last request has an unknown cost stays reachable and is not reported as unreadable", async () => {
  const reports: unknown[] = [];
  const rows = await projectBotMessageRoster([botFixture({ id: "unsure", name: "Unsure" }), botFixture({ id: "broken", name: "Broken" })], {
    paused: async () => false,
    hasModel: async () => true,
    spendingRefusal: async (id) => {
      if (id === "unsure") throw new SpendingDispatchError("uncertain", "A previous request may have been billed.");
      throw new Error("spending file damaged");
    },
    report: (id) => {
      reports.push(id);
    },
  });
  assert.deepEqual(
    rows.map((row) => [row.id, row.unavailable]),
    [
      ["unsure", undefined],
      ["broken", "unavailable"],
    ],
  );
  assert.deepEqual(reports, ["broken"]);
});
