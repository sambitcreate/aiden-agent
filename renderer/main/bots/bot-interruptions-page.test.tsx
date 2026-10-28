import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_BOT_INTERRUPTIONS, type BotInterruptions } from "../../shared/bots";
import { BotInterruptionsFields, botInterruptionsSummary } from "./bot-interruptions-page";

afterEach(cleanup);

function Harness({ initial, saved }: { initial: BotInterruptions; saved: BotInterruptions[] }) {
  const [value, setValue] = React.useState(initial);
  return (
    <BotInterruptionsFields
      value={value}
      onChange={(next) => {
        setValue(next);
        saved.push(next);
      }}
    />
  );
}

test("shows quiet hours on, 10 PM to 7 AM, and 5 a day by default", () => {
  render(<Harness initial={DEFAULT_BOT_INTERRUPTIONS} saved={[]} />);
  assert.equal(screen.getByRole("switch", { name: "Quiet hours" }).getAttribute("aria-checked"), "true");
  assert.equal((screen.getByLabelText("Quiet from") as HTMLInputElement).value, "22:00");
  assert.equal((screen.getByLabelText("Quiet until") as HTMLInputElement).value, "07:00");
  assert.equal(screen.getByRole("status", { name: "Notifications a day" }).textContent, "5");
  assert.match(botInterruptionsSummary(undefined), /^Quiet .+–.+ · 5 a day$/u);
});

test("turning quiet hours off saves enabled false and hides the times", () => {
  const saved: BotInterruptions[] = [];
  render(<Harness initial={DEFAULT_BOT_INTERRUPTIONS} saved={saved} />);
  fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
  assert.equal(saved.at(-1)?.quietHours.enabled, false);
  assert.equal(screen.queryByLabelText("Quiet from"), null);
  assert.equal(botInterruptionsSummary(saved.at(-1)), "5 a day");
});

test("the limit stepper stays within 0 and 20", () => {
  const saved: BotInterruptions[] = [];
  render(<Harness initial={{ ...DEFAULT_BOT_INTERRUPTIONS, dailyLimit: 1 }} saved={saved} />);
  fireEvent.click(screen.getByRole("button", { name: "Fewer notifications" }));
  assert.equal(saved.at(-1)?.dailyLimit, 0);
  assert.equal((screen.getByRole("button", { name: "Fewer notifications" }) as HTMLButtonElement).disabled, true);
  cleanup();
  const top: BotInterruptions[] = [];
  render(<Harness initial={{ ...DEFAULT_BOT_INTERRUPTIONS, dailyLimit: 20 }} saved={top} />);
  assert.equal((screen.getByRole("button", { name: "More notifications" }) as HTMLButtonElement).disabled, true);
});

test("changing a time saves the new window", () => {
  const saved: BotInterruptions[] = [];
  render(<Harness initial={DEFAULT_BOT_INTERRUPTIONS} saved={saved} />);
  fireEvent.change(screen.getByLabelText("Quiet from"), { target: { value: "21:30" } });
  assert.deepEqual(saved.at(-1)?.quietHours, { enabled: true, start: "21:30", end: "07:00" });
});
