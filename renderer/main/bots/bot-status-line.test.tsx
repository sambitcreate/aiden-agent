import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotLiveActivity } from "../../shared/bot-live";
import { BotStatusLine } from "./bot-status-line";

afterEach(cleanup);

const reading: BotLiveActivity = {
  phase: "reading",
  startedAt: 1_000,
  step: { kind: "reading", label: "Reading", detail: "grocery-list.md" },
};

test("the line says the phase with its step on the Mac, and only Thinking with Always Thinking", () => {
  render(<BotStatusLine activity={reading} wording="follows" now={1_000} />);
  assert.ok(screen.getByRole("status", { name: "Reading, grocery-list.md" }));
  cleanup();
  render(<BotStatusLine activity={reading} wording="thinking" now={1_000} />);
  assert.ok(screen.getByRole("status", { name: "Thinking" }));
  assert.equal(screen.queryByText(/grocery-list\.md/u) === null, true, "Always Thinking never peeks at the step");
});

test("waiting keeps its word under Always Thinking, and an unknown phase reads as Working", () => {
  render(<BotStatusLine activity={{ phase: "waiting", startedAt: 0 }} wording="thinking" now={0} />);
  assert.ok(screen.getByRole("status", { name: "Waiting for you" }));
  cleanup();
  render(<BotStatusLine activity={{ phase: "browsing" as never, startedAt: 0 }} wording="follows" now={0} />);
  assert.ok(screen.getByRole("status", { name: "Working" }));
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
