import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_BOT_AVATAR } from "../../shared/bots";
import type { BotPlanDecision, BotPlanView } from "../../shared/bot-plans";
import { PlanCard } from "./plan-card";

afterEach(cleanup);

const PLAN: BotPlanView = {
  botId: "bot-1", planId: "plan-1", revision: 1, status: "pending",
  title: "Prepare the calendar", why: "Keep the team ready for next week.",
  steps: [
    { text: "Read the brief", status: "done" },
    { text: "Skip the cancelled meeting", status: "skipped" },
    { text: "Create the team event", status: "pending" },
  ],
  items: [
    { id: "i1", line: "Google Calendar · create events (up to 5)", details: ["Create a calendar event", "Update a calendar event"], used: 2, max: 5 },
    { id: "i2", line: "Files · read ~/Documents/Team for this plan", details: ["~/Documents/Team", "Read only · allowed once, for this plan only"] },
    { id: "i3", line: "Commands · in its own folder", details: [] },
  ],
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function card(plan = PLAN, onRespond: (decision: BotPlanDecision) => Promise<void> = async () => {}) {
  return <PlanCard plan={plan} botName="Ada" avatar={DEFAULT_BOT_AVATAR} onRespond={onRespond} />;
}

test("a pending plan shows its title, why, numbered steps and every coverage line", () => {
  render(card());
  const notice = screen.getByRole("group", { name: "Ada has a plan" });
  within(notice).getByText("Prepare the calendar");
  within(notice).getByText("Keep the team ready for next week.");
  const steps = within(notice).getByRole("list", { name: "Plan steps" });
  assert.equal(steps.tagName, "OL");
  assert.deepEqual(within(steps).getAllByRole("listitem").map((item) => item.textContent), [
    "Read the brief", "Skip the cancelled meeting", "Create the team event",
  ]);
  const coverage = within(notice).getByRole("list", { name: "Plan coverage" });
  assert.deepEqual(within(coverage).getAllByRole("listitem").map((item) => item.textContent), [
    "Google Calendar · create events (up to 5)", "Files · read ~/Documents/Team for this plan", "Commands · in its own folder",
  ]);
  assert.equal(screen.queryByText("2 of 5 used"), null);
});

test("an asking Bot supplies the pending eyebrow", () => {
  render(card({ ...PLAN, from: "Jester" }));
  screen.getByRole("group", { name: "Jester asked Ada to do this" });
});

test("Show details reveals exact item details and controls the disclosure region", () => {
  render(card());
  const toggle = screen.getByRole("button", { name: "Show details" });
  const id = toggle.getAttribute("aria-controls");
  assert.ok(id);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByText("Create a calendar event"), null);
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const details = document.getElementById(id)!;
  assert.deepEqual(within(details).getAllByRole("listitem").map((item) => item.textContent), [
    "Create a calendar event", "Update a calendar event", "~/Documents/Team", "Read only · allowed once, for this plan only",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByText("Create a calendar event"), null);
});

for (const [label, decision, status] of [
  ["Approve plan", "approve", "pending"], ["Not now", "not_now", "pending"], ["Stop plan", "stop", "active"],
] as const) {
  test(`${label} forwards exactly one decision and shares the busy guard with every answer`, async () => {
    const pending = deferred();
    const decisions: BotPlanDecision[] = [];
    render(card({ ...PLAN, status }, async (answer) => { decisions.push(answer); await pending.promise; }));
    const button = screen.getByRole("button", { name: label });
    // One React batch: a state-only guard would still admit the second click.
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      if (status === "pending") screen.getByRole("button", { name: label === "Approve plan" ? "Not now" : "Approve plan" }).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.deepEqual(decisions, [decision]);
    for (const answer of screen.getAllByRole("button").filter((node) => node.textContent !== "Show details")) {
      assert.equal((answer as HTMLButtonElement).disabled, true);
    }
    await act(async () => pending.resolve());
    assert.equal((button as HTMLButtonElement).disabled, false);
    screen.getByText("Prepare the calendar");
    assert.equal(screen.queryByText(/Plan ended/u), null, "a response alone never settles the host-owned card");
  });
}

test("a failed answer exposes an inline error and permits a retry", async () => {
  let calls = 0;
  render(card(PLAN, async () => { if (++calls === 1) throw new Error("The plan changed. Try again."); }));
  fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
  assert.equal((await screen.findByRole("alert")).textContent, "The plan changed. Try again.");
  const approve = screen.getByRole("button", { name: "Approve plan" }) as HTMLButtonElement;
  assert.equal(approve.disabled, false);
  await act(async () => fireEvent.click(approve));
  assert.equal(calls, 2);
  assert.equal(screen.queryByRole("alert"), null);
});

test("replacing a plan isolates its busy state, details and late failure", async () => {
  const old = deferred();
  const current = deferred();
  const decisions: string[] = [];
  const view = render(card(PLAN, async () => { await old.promise; }));
  fireEvent.click(screen.getByRole("button", { name: "Show details" }));
  fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
  view.rerender(card({ ...PLAN, planId: "plan-2", title: "A new plan" }, async (answer) => { decisions.push(answer); await current.promise; }));
  assert.equal(screen.getByRole("button", { name: "Show details" }).getAttribute("aria-expanded"), "false");
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  await act(async () => old.reject(new Error("Old failure")));
  assert.equal(screen.queryByRole("alert"), null);
  assert.equal((screen.getByRole("button", { name: "Approve plan" }) as HTMLButtonElement).disabled, true);
  assert.deepEqual(decisions, ["not_now"]);
  await act(async () => current.resolve());
});

test("an active plan labels every step status, shows counted usage and the remaining minutes", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  render(card({ ...PLAN, status: "active", expiresAt: 1_000_000 + 150_000 }));
  screen.getByText("Approved · ends in 3 min");
  const steps = screen.getByRole("list", { name: "Plan steps" });
  const entries = within(steps).getAllByRole("listitem");
  within(entries[0]!).getByRole("img", { name: "Done" });
  within(entries[1]!).getByRole("img", { name: "Skipped" });
  within(entries[2]!).getByRole("img", { name: "Pending" });
  const coverage = within(screen.getByRole("list", { name: "Plan coverage" })).getAllByRole("listitem");
  within(coverage[0]!).getByText("2 of 5 used");
  assert.equal(within(coverage[1]!).queryByText(/used/u), null);
  screen.getByRole("button", { name: "Stop plan" });
  act(() => t.mock.timers.tick(30_000));
  screen.getByText("Approved · ends in 2 min");
  act(() => t.mock.timers.tick(120_000));
  screen.getByText("Approved · ends in 0 min");
  screen.getByRole("button", { name: "Stop plan" });
  assert.equal(screen.queryByText(/Plan ended/u), null, "local time does not invent host settlement");
});

test("active countdown timers are cleared on replacement, settlement and unmount", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const clear = t.mock.method(globalThis, "clearTimeout");
  const view = render(card({ ...PLAN, status: "active", expiresAt: 1_060_000 }));
  view.rerender(card({ ...PLAN, planId: "plan-2", status: "active", expiresAt: 1_120_000 }));
  assert.equal(clear.mock.callCount(), 1);
  view.rerender(card({ ...PLAN, planId: "plan-2", status: "finished" }));
  assert.equal(clear.mock.callCount(), 2);
  view.rerender(card({ ...PLAN, planId: "plan-3", status: "active", expiresAt: 1_180_000 }));
  view.unmount();
  assert.equal(clear.mock.callCount(), 3);
});

for (const status of ["finished", "stopped", "expired"] as const) {
  test(`a ${status} plan is a compact line counting done and skipped steps`, () => {
    render(card({ ...PLAN, status }));
    assert.equal(document.body.textContent, "Plan ended · 2 of 3 steps");
    assert.equal(screen.queryByRole("button"), null);
    assert.equal(screen.queryByRole("list"), null);
  });
}

test("keyboard: Approve plan is the first native Tab stop and retains native Enter activation", () => {
  render(card());
  const buttons = screen.getAllByRole("button") as HTMLButtonElement[];
  assert.equal(buttons[0]!.textContent, "Approve plan");
  assert.deepEqual(buttons.map((button) => button.tabIndex), [0, 0, 0]);
  assert.equal(buttons[0]!.tagName, "BUTTON");
  assert.equal(buttons[0]!.type, "button");
  buttons[0]!.focus();
  assert.equal(document.activeElement, buttons[0]);
  assert.equal(fireEvent.keyDown(buttons[0]!, { key: "Enter" }), true, "native Enter is not intercepted");
});
