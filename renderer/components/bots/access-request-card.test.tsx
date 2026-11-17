import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotAccessChoice, BotPendingAccessRequest } from "../../shared/bot-access-requests";
import { AccessRequestCard } from "./access-request-card";

afterEach(cleanup);
const REQUEST: BotPendingAccessRequest = {
  botId: "bot:a", waitId: "attempt-1", toolCallId: "call-1", target: "folder",
  label: "Taxes", place: "~/Documents/Taxes", why: "Prepare your return.", choices: ["not_now", "always", "once"],
};
function mount(request = REQUEST, busy = false) {
  const answers: BotAccessChoice[] = [];
  render(<AccessRequestCard request={request} botName="Ada" busy={busy} onAnswer={(choice) => answers.push(choice)} />);
  return answers;
}
const buttonNames = () => screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);

/** Radix opens its menu on a pointer press, or Enter from the keyboard. */
function openMoreWays() {
  const trigger = screen.getByRole("button", { name: "More ways to allow" });
  act(() => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
}

test("a folder card asks like an approval: its title, place and why, then Deny, Allow once and the menu with Always", () => {
  mount();
  screen.getByRole("group", { name: "Ada wants to use Taxes" });
  screen.getByText("Ada wants to use Taxes");
  screen.getByText("~/Documents/Taxes");
  screen.getByText("Prepare your return.");
  assert.deepEqual(buttonNames(), ["Deny", "Allow once", "More ways to allow"]);
});
test("a whole-Mac card has no Always or folder place", () => {
  mount({ ...REQUEST, target: "whole_mac", label: "your whole Mac", choices: ["not_now", "once"] });
  screen.getByText("Ada wants to use your whole Mac");
  assert.equal(screen.queryByText("~/Documents/Taxes"), null);
  assert.deepEqual(buttonNames(), ["Deny", "Allow once"]);
});
test("each choice sends the answer it always did: Deny is not now, Allow once is once, Always for this folder is always", () => {
  const answers = mount();
  for (const button of screen.getAllByRole("button") as HTMLButtonElement[]) {
    assert.equal(button.disabled, false);
    assert.equal(button.tabIndex, 0);
  }
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  openMoreWays();
  fireEvent.click(screen.getByRole("menuitem", { name: /Always for this folder/u }));
  assert.deepEqual(answers, ["not_now", "once", "always"]);
});
test("every choice is disabled while busy", () => {
  const answers = mount(REQUEST, true);
  for (const button of screen.getAllByRole("button") as HTMLButtonElement[]) {
    assert.equal(button.disabled, true);
    fireEvent.click(button);
  }
  assert.deepEqual(answers, []);
});

test("a repeated folder request shows its safe approval count", () => {
  mount({ ...REQUEST, approvalCount: 3 });
  screen.getByText("You’ve allowed this folder 3 times in the last 2 weeks.");
});

test("Whole Mac and a folder without an eligible count show no repeat-approval line", () => {
  mount({ ...REQUEST, target: "whole_mac", approvalCount: 3, choices: ["not_now", "once"] });
  assert.ok(!screen.queryByText(/You’ve allowed this folder/u));
  cleanup();
  mount();
  assert.ok(!screen.queryByText(/You’ve allowed this folder/u));
});
