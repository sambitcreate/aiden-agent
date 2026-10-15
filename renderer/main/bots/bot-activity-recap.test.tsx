import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BotActivityRecap } from "./bot-activity-recap";
import type { BotRecapStep } from "./bot-activity-steps";

afterEach(cleanup);

const ok = (id: string, kind: BotRecapStep["kind"], label: string, extra: Partial<BotRecapStep> = {}): BotRecapStep => ({
  id,
  kind,
  label,
  status: "ok",
  ...extra,
});

const TURN: BotRecapStep[] = [
  ok("1", "reading", "Read 1 file", { detail: "a.md" }),
  ok("2", "reading", "Read 1 file", { detail: "b.md" }),
  ok("3", "searching", "Searched the web", { detail: "lisbon trains" }),
  ok("4", "app", "Used Notion", { app: "Notion" }),
];

const itemTexts = () =>
  within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem").map((item) => item.textContent);

test("a finished recap is one closed line that opens to its merged steps", () => {
  render(<BotActivityRecap steps={TURN} durationMs={18_000} live={false} level="summary" />);
  const header = screen.getByRole("button", { name: "Worked for 18s · read 2 files, searched the web, used Notion" });
  assert.equal(header.getAttribute("aria-expanded"), "false");
  fireEvent.click(header);
  assert.deepEqual(itemTexts(), ["Read 2 files", "Searched the web · lisbon trains", "Used Notion"]);
});

test("Detailed opens while live with the last three steps, and folds itself when the reply lands", () => {
  const live = [...TURN, { id: "5", kind: "editing" as const, label: "Edited 1 file", detail: "plan.md", status: "running" as const }];
  const { rerender } = render(<BotActivityRecap steps={live} durationMs={0} live level="detailed" />);
  assert.deepEqual(itemTexts(), ["Searched the web · lisbon trains", "Used Notion", "Editing files · plan.md"]);
  rerender(<BotActivityRecap steps={live.map((step) => ({ ...step, status: "ok" }))} durationMs={9_000} live={false} level="detailed" />);
  assert.equal(screen.queryByRole("list", { name: "Steps" }), null);
});

test("a manual close or open during the run sticks after the reply lands", () => {
  const { rerender } = render(<BotActivityRecap steps={TURN} durationMs={0} live level="detailed" />);
  fireEvent.click(screen.getByRole("button", { name: /^Working/u }));
  rerender(<BotActivityRecap steps={TURN} durationMs={0} live level="detailed" />);
  assert.equal(screen.queryByRole("list", { name: "Steps" }), null, "closed by hand stays closed while live");
  fireEvent.click(screen.getByRole("button", { name: /^Working/u }));
  rerender(<BotActivityRecap steps={TURN} durationMs={4_000} live={false} level="detailed" />);
  assert.ok(screen.getByRole("list", { name: "Steps" }), "opened by hand stays open after the reply");
});

test("a failed step is a red issue and a refused one is amber Blocked, never alike", () => {
  render(
    <BotActivityRecap
      steps={[
        ok("1", "reading", "Read 1 file"),
        { id: "2", kind: "command", label: "Ran a command", status: "failed" },
        { id: "3", kind: "searching", label: "Searched the web", status: "blocked" },
      ]}
      durationMs={5_000}
      live={false}
      level="summary"
    />,
  );
  const header = screen.getByRole("button", { name: "Worked for 5s · read 1 file · 1 issue · 1 blocked" });
  fireEvent.click(header);
  assert.ok(screen.getByText("Couldn’t run a command"));
  assert.ok(screen.getByText("Blocked: search the web"));
});

test("a step the person stopped is a neutral line, never an issue or a block, and reads fine without a detail", () => {
  render(
    <BotActivityRecap
      steps={[
        ok("1", "reading", "Read 1 file"),
        { id: "2", kind: "command", label: "Ran a command", status: "stopped" },
      ]}
      durationMs={7_000}
      live={false}
      level="summary"
    />,
  );
  const header = screen.getByRole("button", { name: "Worked for 7s · read 1 file" });
  fireEvent.click(header);
  assert.deepEqual(itemTexts(), ["Read 1 file", "Stopped: run a command"]);
  assert.equal(screen.queryByText(/issue/u), null);
  assert.equal(screen.queryByText(/Couldn’t/u), null);
  assert.equal(screen.queryByText(/blocked/iu), null);
});
