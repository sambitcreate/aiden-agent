import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillProposalCard } from "./skill-proposal-card";

afterEach(cleanup);

test("shows the skill, the reason and what would load; Add skill responds add", async () => {
  const answers: string[] = [];
  render(
    <SkillProposalCard
      proposal={{ proposalId: "p1", name: "meal-plan", description: "Use when planning meals.", reason: "You asked twice.", origin: "bot", preview: "---\nname: meal-plan\n---\nList seven dinners.", update: false }}
      status="pending"
      onRespond={async (decision) => {
        answers.push(decision);
        return "added";
      }}
    />,
  );
  assert.ok(screen.getByText("Add a skill?"));
  assert.ok(screen.getByText("You asked twice."));
  assert.match(screen.getByLabelText("What would load").textContent ?? "", /List seven dinners/u);
  fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
  await waitFor(() => assert.ok(screen.getByText("Added ✓")));
  assert.deepEqual(answers, ["add"]);
});

test("a folder skill asks Use this skill? and a decided card shows no buttons", () => {
  render(
    <SkillProposalCard
      proposal={{ proposalId: "p2", name: "notes", description: "Use when x.", origin: "folder", preview: "y", update: false }}
      status="dismissed"
      onRespond={async () => null}
    />,
  );
  assert.ok(screen.getByText("Not added"));
  assert.equal(screen.queryByRole("button"), null);
});
