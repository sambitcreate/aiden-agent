import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RoutineProposalCard } from "./routine-proposal-card";

afterEach(cleanup);

const PROPOSAL = { name: "Morning brief", label: "Every day at 8:00 AM", prompt: "Brief me." };

test("Not now reveals four optional reasons; choosing Wrong time dismisses with that reason", async () => {
  const answers: Array<[string, string | undefined]> = [];
  render(
    <RoutineProposalCard
      proposal={PROPOSAL}
      status="pending"
      onRespond={async (decision, reason) => {
        answers.push([decision, reason]);
        return "dismissed";
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  for (const label of ["Not useful", "Wrong time", "Already have this", "Something else", "Skip"]) {
    assert.ok(screen.getByRole("button", { name: label }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Wrong time" }));
  await waitFor(() => assert.ok(screen.getByText("Not added")));
  assert.deepEqual(answers, [["dismiss", "wrong_time"]]);
});

test("Skip dismisses with no reason", async () => {
  const answers: Array<[string, string | undefined]> = [];
  render(
    <RoutineProposalCard
      proposal={PROPOSAL}
      status="pending"
      onRespond={async (decision, reason) => {
        answers.push([decision, reason]);
        return "dismissed";
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  await waitFor(() => assert.ok(screen.getByText("Not added")));
  assert.deepEqual(answers, [["dismiss", undefined]]);
});
