import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_BOT_AVATAR, type BotDefinition } from "../../shared/bots";
import { BotList, formatBotRowTime, type BotListRow } from "./bot-list";

afterEach(cleanup);

function bot(id: string, name: string, description?: string): BotDefinition {
  return {
    id,
    revision: `${id}-r1`,
    name,
    ...(description ? { description } : {}),
    instructions: "Help.",
    avatar: { ...DEFAULT_BOT_AVATAR },
    createdAt: 1,
    updatedAt: 1,
  };
}

const NOW = new Date(2026, 9, 7, 18, 0).getTime();

function renderList(rows: BotListRow[], handlers: Partial<React.ComponentProps<typeof BotList>> = {}) {
  const calls: string[] = [];
  render(
    <BotList
      rows={rows}
      now={NOW}
      onOpen={(value) => calls.push(`open:${value.id}`)}
      onOpenProfile={(value) => calls.push(`profile:${value.id}`)}
      onDelete={(value) => calls.push(`delete:${value.id}`)}
      onCreate={() => calls.push("create")}
      {...handlers}
    />,
  );
  return calls;
}

test("a row shows the Bot's subtitle, last-message preview, and relative time", () => {
  const today = new Date(2026, 9, 7, 9, 41).getTime();
  renderList([
    { bot: bot("b1", "SLMob", "Meal prepping"), preview: "Told them: every Sunday 8:41", updatedAt: today },
  ]);
  const row = screen.getByRole("button", { name: /SLMob/u });
  assert.ok(within(row).getByText("Meal prepping"));
  assert.ok(within(row).getByText("Told them: every Sunday 8:41"));
  assert.equal(within(row).getByText(formatBotRowTime(today, NOW)).tagName, "TIME");
});

test("an interrupted Bot says it is paused instead of showing its preview", () => {
  renderList([
    {
      bot: bot("b1", "Chief of Staff"),
      preview: "Reading your calendar",
      updatedAt: NOW,
      state: { kind: "interrupted", submissionId: "s1" },
    },
  ]);
  const row = screen.getByRole("button", { name: /Chief of Staff/u });
  assert.ok(within(row).getByText("Paused — tap to resume"));
  assert.equal(within(row).queryByText("Reading your calendar"), null);
});

test("a Bot without a model says so in its row", () => {
  renderList([{ bot: bot("b1", "Researcher"), state: { kind: "needs_model" } }]);
  assert.ok(within(screen.getByRole("button", { name: /Researcher/u })).getByText("Needs an AI model"));
});

test("tapping a row opens that Bot, and its context menu offers Profile and Delete", async () => {
  const calls = renderList([{ bot: bot("b1", "Planner") }, { bot: bot("b2", "Inbox") }]);
  fireEvent.click(screen.getByRole("button", { name: /Inbox/u }));
  assert.deepEqual(calls, ["open:b2"]);

  fireEvent.contextMenu(screen.getByRole("button", { name: /Planner/u }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Profile" }));
  fireEvent.contextMenu(screen.getByRole("button", { name: /Planner/u }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  assert.deepEqual(calls, ["open:b2", "profile:b1", "delete:b1"]);
});

test("search narrows the list by name or subtitle and the + button starts a new Bot", () => {
  const calls = renderList([
    { bot: bot("b1", "Planner", "Trips") },
    { bot: bot("b2", "Inbox Helper", "Email") },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Search Bots" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Bots" }), {
    target: { value: "email" },
  });
  assert.ok(screen.getByRole("button", { name: /Inbox Helper/u }));
  assert.equal(screen.queryByRole("button", { name: /Planner/u }), null);

  fireEvent.click(screen.getByRole("button", { name: "New Bot" }));
  assert.deepEqual(calls, ["create"]);
});

test("the list uses plain language only", () => {
  renderList([{ bot: bot("b1", "Planner") }]);
  const text = document.body.textContent ?? "";
  for (const jargon of [/\bPi\b/u, /provider/iu, /workspace/iu, /capabilit/iu, /canonical/iu]) {
    assert.doesNotMatch(text, jargon);
  }
});

test("row times read as a clock time today, a day name this week, then a date", () => {
  assert.match(formatBotRowTime(new Date(2026, 9, 7, 8, 5).getTime(), NOW), /8:05/u);
  assert.equal(formatBotRowTime(new Date(2026, 9, 6, 23, 0).getTime(), NOW), "Yesterday");
  assert.equal(
    formatBotRowTime(new Date(2026, 9, 3, 12, 0).getTime(), NOW),
    new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2026, 9, 3, 12, 0)),
  );
  assert.equal(
    formatBotRowTime(new Date(2026, 8, 20, 12, 0).getTime(), NOW),
    new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
      new Date(2026, 8, 20, 12, 0),
    ),
  );
});
