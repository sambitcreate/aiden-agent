import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_BOT_AVATAR } from "../../shared/bots";
import type { BotHandoffOutcome, BotPendingHandoff } from "../../shared/bot-handoffs";
import { HandoffCard } from "./handoff-card";

afterEach(() => cleanup());

const HANDOFF: BotPendingHandoff = {
  botId: "bot:ada",
  waitId: "w-1",
  toolCallId: "call-1",
  kind: "action",
  action: "Enter the 2FA code for your bank",
  why: "Only you get the code on your phone.",
  open: { url: "https://bank.example/verify" },
  source: "tool",
};

function mount(handoff: BotPendingHandoff = HANDOFF, busy = false) {
  const answers: BotHandoffOutcome[] = [];
  let opens = 0;
  const view = render(
    <HandoffCard
      botId={handoff.botId}
      name="Ada"
      avatar={DEFAULT_BOT_AVATAR}
      handoff={handoff}
      busy={busy}
      onOpen={() => (opens += 1)}
      onAnswer={(outcome) => answers.push(outcome)}
    />,
  );
  return { view, answers, opens: () => opens };
}

const buttonNames = () => screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);

test("the card says whose turn it is, what to do and why, and names the page Open goes to", () => {
  mount();
  screen.getByText("Your turn: Enter the 2FA code for your bank");
  screen.getByRole("group", { name: "Ada needs you" });
  screen.getByText("Only you get the code on your phone.");
  screen.getByText("Opens bank.example");
  assert.deepEqual(buttonNames(), ["Open bank.example", "Skip", "Done"], "Open, then Skip, then Done in tab order");
});

test("Open appears only when the Bot gave a page, and a rule's card says which rule asked", () => {
  mount({ ...HANDOFF, open: undefined, why: undefined, source: "rule", rule: { id: "money", label: "Move money" } });
  assert.deepEqual(buttonNames(), ["Skip", "Done"]);
  assert.equal(screen.queryByText(/^Opens /u), null);
  screen.getByText("From your rule: Move money");
});

test("Open, Skip and Done each report once to the chat", () => {
  const { answers, opens } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Open bank.example" }));
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  assert.equal(opens(), 1);
  assert.deepEqual(answers, ["skipped", "done"]);
});

test("while an answer is on its way, no button can be pressed again", () => {
  const { answers, opens } = mount(HANDOFF, true);
  for (const button of screen.getAllByRole("button")) {
    assert.equal((button as HTMLButtonElement).disabled, true, button.textContent ?? "");
    fireEvent.click(button);
  }
  assert.deepEqual(answers, []);
  assert.equal(opens(), 0);
});
