import assert from "node:assert/strict";
import test from "node:test";
import { latestWorkDetailsStart, workDetailsOpen } from "./work-details";

test("detail levels distinguish automatic trail visibility from manual disclosure", () => {
  assert.equal(workDetailsOpen("compact", true), false);
  assert.equal(workDetailsOpen("standard", true), false);
  assert.equal(workDetailsOpen("detailed", true), true);
  assert.equal(workDetailsOpen("detailed", false), false);
  assert.equal(workDetailsOpen("verbose", false), true);
});

test("latest exchange includes assistant continuations and refines a partial history", () => {
  const history = [
    { role: "user", content: "Old request" },
    { role: "assistant", content: "Old answer" },
    { role: "user", content: "New request" },
    { role: "assistant", content: "New answer" },
    { role: "assistant", content: "Continuation" },
  ];
  assert.equal(latestWorkDetailsStart(history), 2);
  assert.equal(latestWorkDetailsStart(history.slice(3)), 0);
  assert.equal(latestWorkDetailsStart([...history, { role: "user", content: "Next accepted request" }]), 5);
});
