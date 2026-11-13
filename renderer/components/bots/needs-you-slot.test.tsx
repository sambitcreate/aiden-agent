import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NeedsYouHeader, useNeedsYouSlot, type NeedsYouItem } from "./needs-you-slot";

afterEach(cleanup);

type Item = NeedsYouItem & { text: string };

/** A chat footer in miniature: the header, then the one item on show. */
function Slot({ items }: { items: readonly Item[] }) {
  const slot = useNeedsYouSlot(items);
  return (
    <div>
      <NeedsYouHeader slot={slot} />
      {slot.current ? <p data-testid="shown">{slot.current.text}</p> : null}
    </div>
  );
}

const shown = () => screen.queryByTestId("shown")?.textContent ?? null;
const position = () => {
  const header = screen.queryByRole("navigation", { name: "Needs you" });
  return header ? within(header).getByText(/^\d+ of \d+$/u).textContent : null;
};
const next = () => fireEvent.click(within(screen.getByRole("navigation", { name: "Needs you" })).getByRole("button", { name: "Next" }));
const previous = () =>
  fireEvent.click(within(screen.getByRole("navigation", { name: "Needs you" })).getByRole("button", { name: "Previous" }));

test("whatever order they arrive in, take control shows first, then approvals, the folder request, the plan, and the question last", () => {
  render(
    <Slot
      items={[
        { key: "q", kind: "question", text: "Which colour?" },
        { key: "plan", kind: "plan", text: "Approve this plan?" },
        { key: "a2", kind: "approval", text: "Send email" },
        { key: "access", kind: "access", text: "Use ~/Documents" },
        { key: "h", kind: "take_control", text: "Sign in to github.com" },
        { key: "a1", kind: "approval", text: "Run on your Mac?" },
      ]}
    />,
  );
  const seen: Array<[string | null, string | null]> = [];
  for (let step = 0; step < 6; step += 1) {
    seen.push([position(), shown()]);
    next();
  }
  assert.deepEqual(seen, [
    ["1 of 6", "Sign in to github.com"],
    ["2 of 6", "Send email"],
    ["3 of 6", "Run on your Mac?"],
    ["4 of 6", "Use ~/Documents"],
    ["5 of 6", "Approve this plan?"],
    ["6 of 6", "Which colour?"],
  ], "two approvals keep the order they came in");
  assert.equal(shown(), "Sign in to github.com", "Next from the last wraps to the first");
  previous();
  assert.equal(shown(), "Which colour?", "Previous from the first wraps to the last");
});

test("one item shows alone with no counter and nothing to announce; none shows nothing", () => {
  const { rerender } = render(<Slot items={[{ key: "a", kind: "approval", text: "Send email" }]} />);
  assert.equal(shown(), "Send email");
  assert.equal(position(), null);
  assert.equal(screen.queryByRole("button", { name: "Next" }), null);
  assert.equal(screen.getByRole("status").textContent, "");
  rerender(<Slot items={[]} />);
  assert.equal(shown(), null);
});

test("the slot stays on the item the person moved to as others arrive, and returns to the first once it is answered", () => {
  const take: Item = { key: "h", kind: "take_control", text: "Enter the code" };
  const approval: Item = { key: "a", kind: "approval", text: "Send email" };
  const plan: Item = { key: "p", kind: "plan", text: "Approve this plan?" };
  const { rerender } = render(<Slot items={[take, approval]} />);
  next();
  assert.equal(shown(), "Send email");
  assert.equal(screen.getByRole("status").textContent, "Needs you, 2 of 2", "where it sits is announced");
  rerender(<Slot items={[take, approval, plan]} />);
  assert.equal(shown(), "Send email", "a new card does not pull the slot away");
  assert.equal(position(), "2 of 3");
  rerender(<Slot items={[take, plan]} />);
  assert.equal(shown(), "Enter the code", "the answered card's place goes back to the first item");
  assert.equal(position(), "1 of 2");
});

test("Previous and Next are named buttons a keyboard reaches", () => {
  render(
    <Slot
      items={[
        { key: "a", kind: "approval", text: "Send email" },
        { key: "b", kind: "approval", text: "Delete file" },
      ]}
    />,
  );
  const header = screen.getByRole("navigation", { name: "Needs you" });
  const buttons = within(header).getAllByRole("button");
  assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label")), ["Previous", "Next"]);
  for (const button of buttons) assert.notEqual(button.getAttribute("tabindex"), "-1");
});
