import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotHealthReport } from "../../shared/bot-health";
import { BotHealthGroup } from "./bot-health-section";

afterEach(cleanup);

const REPORT: BotHealthReport = {
  botId: "bot-1",
  checkedAt: Date.UTC(2026, 9, 27, 14, 5),
  trigger: "pre_fire",
  results: [
    { id: "bot_state", status: "ok", label: "Bot" },
    { id: "model", status: "repaired", label: "AI model" },
    { id: "provider_auth", status: "ok", label: "Sign-in" },
    { id: "connections", status: "needs_you", label: "Gmail needs reconnecting" },
    { id: "computer", status: "skipped", label: "Bot computer" },
  ],
};

test("lists the last check's results with plain labels", () => {
  render(<BotHealthGroup report={REPORT} checking={false} onCheck={() => undefined} />);
  assert.ok(screen.getByText("Gmail needs reconnecting"));
  assert.ok(screen.getByText("Needs you"));
  assert.ok(screen.getByText("Sign-in"));
  assert.equal(screen.queryByText("Bot computer"), null, "a Bot without a computer does not list one");
});

test("a repaired check reads as fixed, not as a problem", () => {
  render(<BotHealthGroup report={REPORT} checking={false} onCheck={() => undefined} />);
  assert.ok(screen.getByText("Fixed"));
  assert.equal(screen.getAllByText("Needs you").length, 1, "only the connection needs the person");
});

test("Check now calls back once and shows the checking state", () => {
  let calls = 0;
  const { rerender } = render(<BotHealthGroup report={null} checking={false} onCheck={() => (calls += 1)} />);
  assert.ok(screen.getByText("Not checked yet"));
  fireEvent.click(screen.getByRole("button", { name: /Check now/u }));
  assert.equal(calls, 1);
  rerender(<BotHealthGroup report={null} checking onCheck={() => (calls += 1)} />);
  const button = screen.getByRole("button", { name: /Checking/u }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
});
