import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotLiveActivity } from "../../shared/bot-live";
import { BotStatusLine } from "./bot-status-line";

afterEach(() => {
  mock.timers.reset();
  cleanup();
});

const reading: BotLiveActivity = {
  phase: "reading",
  startedAt: 1_000,
  step: { kind: "reading", label: "Reading", detail: "grocery-list.md" },
};

/** What a screen reader is told: the status region's announcement text. */
function announced(): string | null {
  return screen.getByRole("status").querySelector("[data-bot-status-announcement]")?.textContent ?? null;
}

test("the line says the phase with its step on the Mac, and only Thinking with Always Thinking", () => {
  render(<BotStatusLine activity={reading} wording="follows" now={1_000} />);
  assert.equal(announced(), "Reading, grocery-list.md");
  cleanup();
  render(<BotStatusLine activity={reading} wording="thinking" now={1_000} />);
  assert.equal(announced(), "Thinking");
  assert.equal(screen.queryByText(/grocery-list\.md/u) === null, true, "Always Thinking never peeks at the step");
});

test("waiting keeps its word under Always Thinking, and an unknown phase reads as Working", () => {
  render(<BotStatusLine activity={{ phase: "waiting", startedAt: 0 }} wording="thinking" now={0} />);
  assert.equal(announced(), "Waiting for you");
  cleanup();
  render(<BotStatusLine activity={{ phase: "browsing" as never, startedAt: 0 }} wording="follows" now={0} />);
  assert.equal(announced(), "Working");
});

test("after 20 seconds the line shows elapsed time and Stop; after 2 minutes, a still-going note", () => {
  const calls: string[] = [];
  render(<BotStatusLine activity={reading} wording="follows" now={1_000 + 19_000} onStop={() => calls.push("stop")} />);
  assert.equal(screen.queryByRole("button", { name: "Stop" }) === null, true);
  assert.equal(screen.queryByText(/19s/u) === null, true);
  cleanup();
  render(<BotStatusLine activity={reading} wording="follows" now={1_000 + 72_000} onStop={() => calls.push("stop")} />);
  assert.ok(screen.getByText("· 1m 12s"));
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  assert.deepEqual(calls, ["stop"]);
  assert.equal(screen.queryByRole("note") === null, true);
  cleanup();
  render(<BotStatusLine activity={reading} wording="follows" now={1_000 + 121_000} />);
  assert.ok(screen.getByRole("note"));
  assert.ok(screen.getByText("Still going. I'll message you when it's done."));
});

test("Stop needs a handler, and goes away while the Bot is already stopping", () => {
  render(<BotStatusLine activity={reading} wording="follows" now={1_000 + 72_000} />);
  assert.equal(screen.queryByRole("button", { name: "Stop" }) === null, true, "no handler, no Stop");
  cleanup();
  render(
    <BotStatusLine activity={{ phase: "stopping", startedAt: 1_000 }} wording="follows" now={1_000 + 72_000} onStop={() => {}} />,
  );
  assert.equal(announced(), "Stopping");
  assert.equal(screen.queryByRole("button", { name: "Stop" }) === null, true, "already stopping");
});

test("the announcement changes at most once every 2 seconds, and ends on the newest wording", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const searching: BotLiveActivity = { phase: "searching", startedAt: 0 };
  const writing: BotLiveActivity = { phase: "writing", startedAt: 0 };
  const view = render(<BotStatusLine activity={reading} wording="follows" now={0} />);
  assert.equal(announced(), "Reading, grocery-list.md");

  mock.timers.tick(500);
  view.rerender(<BotStatusLine activity={searching} wording="follows" now={0} />);
  assert.equal(announced(), "Reading, grocery-list.md", "a change inside the gap waits");

  mock.timers.tick(500);
  view.rerender(<BotStatusLine activity={writing} wording="follows" now={0} />);
  assert.equal(announced(), "Reading, grocery-list.md", "still inside the gap");

  act(() => mock.timers.tick(1_000));
  assert.equal(announced(), "Writing", "the gap passed: the newest wording wins, not the skipped one");
});

test("a change after a quiet spell is announced at once", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const view = render(<BotStatusLine activity={reading} wording="follows" now={0} />);
  mock.timers.tick(3_000);
  view.rerender(<BotStatusLine activity={{ phase: "writing", startedAt: 0 }} wording="follows" now={0} />);
  assert.equal(announced(), "Writing");
});
