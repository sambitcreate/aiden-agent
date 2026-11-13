import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_BOT_AVATAR } from "../../shared/bots";
import type { BotHandoffOutcome, BotPendingHandoff } from "../../shared/bot-handoffs";
import { HandoffActions, HandoffCard, handoffSignInComposerText } from "./handoff-card";

afterEach(() => cleanup());

type CardProps = Omit<React.ComponentProps<typeof HandoffCard>, "taken" | "onTake">;
type ActionsProps = Omit<React.ComponentProps<typeof HandoffActions>, "taken" | "onTake">;

/** The card as a chat holds it: Take control moves it to its second step. */
function Card(props: CardProps) {
  const [taken, setTaken] = React.useState(false);
  return <HandoffCard {...props} taken={taken} onTake={() => setTaken(true)} />;
}

function Actions(props: ActionsProps) {
  const [taken, setTaken] = React.useState(false);
  return <HandoffActions {...props} taken={taken} onTake={() => setTaken(true)} />;
}

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
    <Card
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
  screen.getByText("Needs you: Enter the 2FA code for your bank");
  screen.getByRole("group", { name: "Ada needs you" });
  screen.getByText("Only you get the code on your phone.");
  screen.getByText("Opens bank.example");
  assert.deepEqual(buttonNames(), ["Take control at bank.example"], "first, Take control alone");
});

test("Take control opens the page and only then offers I'm done and Skip, with the page one press away", () => {
  const { answers, opens } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Take control at bank.example" }));
  assert.equal(opens(), 1);
  assert.deepEqual(answers, [], "taking control answers nothing");
  assert.deepEqual(buttonNames(), ["Open again: Take control at bank.example", "Skip", "I’m done"]);
  assert.equal(document.activeElement, screen.getByRole("button", { name: "I’m done" }), "focus moves on to the answer, not to the page body");
  fireEvent.click(screen.getByRole("button", { name: "Open again: Take control at bank.example" }));
  assert.equal(opens(), 2);
});

test("with no page to open, Take control only moves the card on, and a rule's card says which rule asked", () => {
  const { opens } = mount({ ...HANDOFF, open: undefined, why: undefined, source: "rule", rule: { id: "money", label: "Move money" } });
  assert.deepEqual(buttonNames(), ["Take control"]);
  fireEvent.click(screen.getByRole("button", { name: "Take control" }));
  assert.equal(opens(), 0);
  assert.deepEqual(buttonNames(), ["Skip", "I’m done"]);
  assert.equal(screen.queryByText(/^Opens /u), null);
  screen.getByText("From your rule: Move money");
});

test("Take control, Skip and Done each report once to the chat, with the same answers as before", () => {
  const { answers, opens } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Take control at bank.example" }));
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  fireEvent.click(screen.getByRole("button", { name: "I’m done" }));
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

test("on a Bot that lives on another Mac, a sign-in offers Finish there, then Skip, while other steps keep Take control and Done", () => {
  let finishes = 0;
  const answers: BotHandoffOutcome[] = [];
  const draw = (handoff: Pick<BotPendingHandoff, "kind" | "action" | "open">) =>
    render(
      <Card
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
  assert.deepEqual(buttonNames(), ["Finish on Studio"]);
  assert.equal(screen.queryByText(/^Opens /u), null, "the page opens over there, not here");
  fireEvent.click(screen.getByRole("button", { name: "Finish on Studio" }));
  assert.deepEqual(buttonNames(), ["Finish on Studio", "Skip"], "the sign-in is answered over there, so only Skip here");
  assert.equal(document.activeElement, screen.getByRole("button", { name: "Skip" }), "focus moves to the one answer left here");
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  assert.equal(finishes, 1);
  assert.deepEqual(answers, ["skipped"]);
  cleanup();
  draw({ kind: "action", action: HANDOFF.action, open: HANDOFF.open });
  assert.deepEqual(buttonNames(), ["Take control at bank.example"]);
  fireEvent.click(screen.getByRole("button", { name: "Take control at bank.example" }));
  assert.deepEqual(buttonNames(), ["Open again: Take control at bank.example", "Skip", "I’m done"]);
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

test("a sign-in asks to sign in to one site for the Bot, opens it in the Bot's browser, and is answered I'm done or Skip", () => {
  const { answers, opens } = mount(SIGN_IN);
  screen.getByText("Sign in to github.com for Ada");
  assert.equal(screen.queryByText(/^Needs you/u), null);
  screen.getByText("I need your GitHub account to read your issues.");
  screen.getByText("Opens in Ada’s own browser. Ada never sees your password.");
  assert.deepEqual(buttonNames(), ["Take control to sign in"]);
  fireEvent.click(screen.getByRole("button", { name: "Take control to sign in" }));
  assert.deepEqual(buttonNames(), ["Open again: Take control to sign in", "Skip", "I’m done"], "then Skip and I'm done in tab order");
  fireEvent.click(screen.getByRole("button", { name: "I’m done" }));
  assert.equal(opens(), 1);
  assert.deepEqual(answers, ["done"], "I'm done answers Done");
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
  assert.deepEqual(buttonNames(), ["Take control of Ada’s computer"]);
  fireEvent.click(screen.getByRole("button", { name: "Take control of Ada’s computer" }));
  fireEvent.click(screen.getByRole("button", { name: "I’m done" }));
  assert.equal(opens(), 1);
  assert.deepEqual(answers, ["done"]);
  assert.equal(handoffSignInComposerText("Ada"), "Sign in for Ada with Take control above, then choose I’m done.");
});

test("the panel's copy of the buttons names the Bot's computer too, and a Bot on another Mac still finishes there", () => {
  const onComputer: BotPendingHandoff = { ...SIGN_IN, target: "computer" };
  render(<Actions handoff={onComputer} name="Ada" onOpen={() => undefined} onAnswer={() => undefined} />);
  assert.deepEqual(buttonNames(), ["Take control of Ada’s computer"]);
  cleanup();
  render(<Actions handoff={onComputer} name="Ada" finishOn="Studio" onOpen={() => undefined} onAnswer={() => undefined} />);
  assert.deepEqual(buttonNames(), ["Finish on Studio"]);
  fireEvent.click(screen.getByRole("button", { name: "Finish on Studio" }));
  assert.deepEqual(buttonNames(), ["Finish on Studio", "Skip"]);
});

test("a step on the Bot's own browser opens there, never in the person's browser, and is answered Done or Skip", () => {
  const { answers, opens } = mount({ ...HANDOFF, action: "Choose the delivery slot", open: { url: "https://shop.example/checkout" }, target: "browser" });
  screen.getByText("Needs you: Choose the delivery slot");
  screen.getByText("Opens in Ada’s own browser at shop.example, not in yours.");
  assert.equal(screen.queryByText("Opens shop.example"), null);
  assert.deepEqual(buttonNames(), ["Take control of Ada’s browser"]);
  fireEvent.click(screen.getByRole("button", { name: "Take control of Ada’s browser" }));
  fireEvent.click(screen.getByRole("button", { name: "I’m done" }));
  assert.equal(opens(), 1);
  assert.deepEqual(answers, ["done"]);
  cleanup();
  mount({ ...HANDOFF, open: undefined, target: "computer" });
  screen.getByText("Opens on Ada’s own computer, with you in control. Ada waits until you answer.");
  assert.deepEqual(buttonNames(), ["Take control of Ada’s computer"]);
});

test("a step on the Bot's screen on another Mac offers Finish there beside Skip and Done", () => {
  let finishes = 0;
  const answers: BotHandoffOutcome[] = [];
  render(
    <Card
      name="Ada"
      avatar={DEFAULT_BOT_AVATAR}
      handoff={{ kind: "action", action: "Choose the delivery slot", onMac: true }}
      finishOn="Studio"
      onOpen={() => undefined}
      onFinish={() => (finishes += 1)}
      onAnswer={(outcome) => answers.push(outcome)}
    />,
  );
  screen.getByText("This step is on Ada’s own screen on Studio.");
  assert.deepEqual(buttonNames(), ["Finish on Studio"]);
  fireEvent.click(screen.getByRole("button", { name: "Finish on Studio" }));
  assert.deepEqual(buttonNames(), ["Finish on Studio", "Skip", "I’m done"]);
  fireEvent.click(screen.getByRole("button", { name: "I’m done" }));
  assert.equal(finishes, 1);
  assert.deepEqual(answers, ["done"]);
});
