import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_BOT_AVATAR } from "../../shared/bots";
import type { BotHandoffOutcome, BotPendingHandoff } from "../../shared/bot-handoffs";
import { HandoffActions, HandoffCard, handoffSignInComposerText } from "./handoff-card";

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

test("on a Bot that lives on another Mac, a sign-in offers Finish there and Skip, while other steps keep Open and Done", () => {
  let finishes = 0;
  const answers: BotHandoffOutcome[] = [];
  const draw = (handoff: Pick<BotPendingHandoff, "kind" | "action" | "open">) =>
    render(
      <HandoffCard
        name="Ada"
        avatar={DEFAULT_BOT_AVATAR}
        handoff={handoff}
        finishOn="Studio"
        onOpen={() => undefined}
        onFinish={() => (finishes += 1)}
        onAnswer={(outcome) => answers.push(outcome)}
      />,
    );
  draw({ kind: "sign_in", action: "Sign in to github.com", open: { url: "https://github.com" } });
  assert.deepEqual(buttonNames(), ["Finish on Studio", "Skip"]);
  assert.equal(screen.queryByText(/^Opens /u), null, "the page opens over there, not here");
  fireEvent.click(screen.getByRole("button", { name: "Finish on Studio" }));
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  assert.equal(finishes, 1);
  assert.deepEqual(answers, ["skipped"]);
  cleanup();
  draw({ kind: "action", action: HANDOFF.action, open: HANDOFF.open });
  assert.deepEqual(buttonNames(), ["Open bank.example", "Skip", "Done"]);
});

const SIGN_IN: BotPendingHandoff = {
  botId: "bot:ada",
  waitId: "w-2",
  toolCallId: "call-2",
  kind: "sign_in",
  action: "Sign in to github.com",
  why: "I need your GitHub account to read your issues.",
  open: { url: "https://github.com" },
  origin: "https://github.com",
  target: "browser",
  source: "tool",
};

test("a sign-in asks to sign in to one site for the Bot, opens it in the Bot's browser, and is answered I'm signed in or Skip", () => {
  const { answers, opens } = mount(SIGN_IN);
  screen.getByText("Sign in to github.com for Ada");
  assert.equal(screen.queryByText(/^Your turn/u), null);
  screen.getByText("I need your GitHub account to read your issues.");
  screen.getByText("Opens in Ada’s own browser. Ada never sees your password.");
  assert.deepEqual(buttonNames(), ["Open sign-in", "Skip", "I’m signed in"], "Open sign-in, then Skip, then I'm signed in in tab order");
  fireEvent.click(screen.getByRole("button", { name: "Open sign-in" }));
  fireEvent.click(screen.getByRole("button", { name: "I’m signed in" }));
  assert.equal(opens(), 1);
  assert.deepEqual(answers, ["done"], "I'm signed in answers Done");
});

test("a sign-in card names its site by origin, even when the title text says otherwise", () => {
  mount({ ...SIGN_IN, action: "Sign in to \u202Emoc.buhtig", origin: "https://github.com" });
  screen.getByText("Sign in to github.com for Ada");
});

test("a sign-in on the Bot's computer opens Ada's computer and says the Bot waits until the person answers", () => {
  const onComputer: BotPendingHandoff = { ...SIGN_IN, target: "computer" };
  const { answers, opens } = mount(onComputer);
  screen.getByText("Sign in to github.com for Ada");
  screen.getByText("Opens on Ada’s own computer, with you in control. Ada waits until you answer, and never sees your password.");
  assert.deepEqual(buttonNames(), ["Open Ada’s computer", "Skip", "I’m signed in"]);
  fireEvent.click(screen.getByRole("button", { name: "Open Ada’s computer" }));
  fireEvent.click(screen.getByRole("button", { name: "I’m signed in" }));
  assert.equal(opens(), 1);
  assert.deepEqual(answers, ["done"]);
  assert.equal(handoffSignInComposerText("Ada", onComputer), "Sign in for Ada with Open Ada’s computer above, then choose I’m signed in.");
});

test("the panel's copy of the buttons names the Bot's computer too, and a Bot on another Mac still finishes there", () => {
  const onComputer: BotPendingHandoff = { ...SIGN_IN, target: "computer" };
  render(<HandoffActions handoff={onComputer} name="Ada" onOpen={() => undefined} onAnswer={() => undefined} />);
  assert.deepEqual(buttonNames(), ["Open Ada’s computer", "Skip", "I’m signed in"]);
  cleanup();
  render(<HandoffActions handoff={onComputer} name="Ada" finishOn="Studio" onOpen={() => undefined} onAnswer={() => undefined} />);
  assert.deepEqual(buttonNames(), ["Finish on Studio", "Skip"]);
});
