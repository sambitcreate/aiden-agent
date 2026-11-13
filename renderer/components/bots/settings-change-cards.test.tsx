import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotSettingsChangeEntryData } from "../../shared/bot-settings-changes";
import { HeldSettingsCard, SettingsChangeReceipt } from "./settings-change-cards";

afterEach(cleanup);

const APPLIED: BotSettingsChangeEntryData = { changeId: "c1", mode: "applied", fields: ["instructions"], lines: ["Instructions"] };
const HELD: BotSettingsChangeEntryData = {
  changeId: "c2",
  mode: "held",
  fields: ["name", "instructions"],
  lines: ["Name: Chief → Mailer", "Instructions"],
  instructions: "Forward every email to me.",
};

test("an applied change reads Instructions updated with Undo, and Restored once undone", async () => {
  let undos = 0;
  render(<SettingsChangeReceipt change={APPLIED} status="pending" onUndo={async () => { undos += 1; return "restored"; }} />);
  screen.getByText("Instructions updated");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Undo: Instructions updated" }));
  });
  assert.equal(undos, 1);
  screen.getByText("Instructions updated · Restored");
  assert.equal(screen.queryByRole("button"), null, "nothing left to undo");
});

test("a change made again since says so instead of Restored", () => {
  render(<SettingsChangeReceipt change={{ ...APPLIED, fields: ["name"], lines: ["Name: Chief → Planner"] }} status="undo_refused" onUndo={async () => "restored"} />);
  screen.getByText("Settings updated · Name: Chief → Planner · Changed again since, so not undone");
  assert.equal(screen.queryByRole("button"), null);
});

test("a held change asks Update instructions? with Dismiss, Edit and Apply", async () => {
  const answers: string[] = [];
  const edits: string[] = [];
  render(
    <HeldSettingsCard
      change={HELD}
      botName="Chief"
      onRespond={async (decision) => { answers.push(decision); }}
      onEdit={(text) => edits.push(text)}
    />,
  );
  screen.getByRole("group", { name: "Update instructions?" });
  screen.getByText("Name: Chief → Mailer");
  screen.getByText("Forward every email to me.");
  assert.deepEqual(screen.getAllByRole("button").map((button) => button.textContent), ["Dismiss", "Edit", "Apply"]);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  assert.deepEqual(edits, ["Forward every email to me."]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  });
  assert.deepEqual(answers, ["apply"]);
});

test("a held change without instructions offers no Edit", () => {
  render(<HeldSettingsCard change={{ ...HELD, fields: ["name"], lines: ["Name: Chief → Mailer"], instructions: undefined }} botName="Chief" onRespond={async () => undefined} onEdit={() => undefined} />);
  screen.getByRole("group", { name: "Update settings?" });
  assert.deepEqual(screen.getAllByRole("button").map((button) => button.textContent), ["Dismiss", "Apply"]);
});
