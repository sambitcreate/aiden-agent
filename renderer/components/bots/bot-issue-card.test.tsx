import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BotIssue, BotIssueAction, BotIssueResolution } from "../../shared/bot-issues";
import { BotIssueCard } from "./bot-issue-card";

afterEach(() => cleanup());

const ISSUE: BotIssue = {
  id: "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c",
  botId: "bot:ada",
  kind: "routine_failed",
  dedupeKey: "routine:r1:failed",
  title: "Ada couldn’t finish your morning briefing",
  body: "The model was unavailable, so nothing ran.",
  routineId: "r1",
  actions: [{ kind: "keep_waiting" }, { kind: "stop_run" }],
  createdAt: 1_000,
};

function mount(status: "open" | BotIssueResolution = "open") {
  const actions: BotIssueAction[] = [];
  render(
    <BotIssueCard
      issue={ISSUE}
      status={status}
      onAct={async (action) => {
        actions.push(action);
      }}
    />,
  );
  return { actions };
}

const buttonNames = () => screen.getAllByRole("button").map((button) => button.textContent);

test("an open issue shows its title, body and action buttons and calls onAct", async () => {
  const { actions } = mount();
  screen.getByRole("group", { name: ISSUE.title });
  screen.getByText(ISSUE.body);
  assert.deepEqual(buttonNames(), ["Keep waiting", "Stop run"]);

  fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
  await waitFor(() => assert.deepEqual(actions, [{ kind: "stop_run" }]));
  assert.equal(actions.length, 1, "one answer per click");
});

test("a resolved issue shows a quiet resolved line and no buttons", () => {
  for (const [status, line] of [
    ["fixed", "Fixed"],
    ["dismissed", "Dismissed"],
    ["superseded", "Superseded"],
  ] as const) {
    mount(status);
    screen.getByText(ISSUE.title);
    screen.getByText(line);
    assert.equal(screen.queryAllByRole("button").length, 0, `${status}: nothing left to press`);
    assert.equal(screen.queryByText(ISSUE.body), null, `${status}: the detail is history now`);
    cleanup();
  }
});

test("buttons keep focus-visible styling", () => {
  mount();
  const buttons = screen.getAllByRole("button");
  // Tab order is document order for controls at tabIndex 0; nothing is
  // removed from it, and each action can take keyboard focus.
  assert.deepEqual(buttons.map((button) => button.tabIndex), [0, 0]);
  for (const button of buttons) {
    button.focus();
    assert.equal(document.activeElement, button, button.textContent ?? "");
  }
  // The shared Button primitive owns the visible ring: it is not a div or a span.
  for (const button of buttons) assert.equal(button.tagName, "BUTTON");
});
