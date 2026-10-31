import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BotLearningOverview } from "../../shared/bot-learning-overview";
import { BotLearningSections, type BotLearningApi } from "./bot-learning-page";
import { LessonProposalCard } from "../../components/bots/lesson-cards";

afterEach(cleanup);

const BOT = { id: "bot-a", name: "Scout" };

function api(overview: BotLearningOverview, undoResult: { ok: true } | { ok: false; code: string } = { ok: true }) {
  const calls: string[] = [];
  const value: BotLearningApi = {
    get: async () => overview,
    undo: async (input) => { calls.push(`undo:${input.changeId}`); return undoResult; },
    removeLesson: async (input) => { calls.push(`remove:${input.lessonId}`); },
  };
  return { value, calls };
}

const OVERVIEW: BotLearningOverview = {
  lessons: [{ id: "l1", botId: "bot-a", scope: { kind: "bot" }, cue: "Summaries", lesson: "Put the totals first.", component: "output_format", evidence: [], verdict: "helped", source: "correction", status: "active", createdAt: 1 }],
  followUps: [{ id: "f1", text: "Check the invoice", dueDate: "2026-10-30", status: "proposed" }],
  changes: [{ id: "c1", botId: "bot-a", at: 1, kind: "memory_tidy", summary: "Tidied memory", target: { kind: "memory" }, before: "a", after: "b", fingerprintBefore: "x", fingerprintAfter: "y" }],
  budget: { requests: 1, outputTokens: 10 },
};

test("lists lessons, follow-ups and recent changes; Remove and Undo call the page's API", async () => {
  const h = api(OVERVIEW);
  render(<BotLearningSections bot={BOT} api={h.value} />);
  await waitFor(() => assert.ok(screen.getByText("Put the totals first.")));
  assert.ok(screen.getByText("Check the invoice"));
  fireEvent.click(screen.getByRole("button", { name: "Remove lesson: Put the totals first." }));
  fireEvent.click(screen.getByRole("button", { name: "Undo: Tidied memory" }));
  await waitFor(() => assert.deepEqual(h.calls.sort(), ["remove:l1", "undo:c1"]));
});

test("the empty state shows when nothing was learned", async () => {
  render(<BotLearningSections bot={BOT} api={api({ lessons: [], followUps: [], changes: [], budget: { requests: 0, outputTokens: 0 } }).value} />);
  await waitFor(() => assert.ok(screen.getByText("Nothing yet")));
});

test("a lesson card shows the routine and its evidence; Keep this responds keep", async () => {
  const answers: string[] = [];
  render(<LessonProposalCard lesson={{ lessonId: "l2", lesson: "Lead with the calendar.", routineName: "Briefing", runs: 3 }} status="pending" onRespond={async (decision) => { answers.push(decision); return "active"; }} />);
  assert.ok(screen.getByText("I learned something about Briefing"));
  assert.ok(screen.getByText("Based on 3 recent runs"));
  fireEvent.click(screen.getByRole("button", { name: "Keep this" }));
  await waitFor(() => assert.ok(screen.getByText("Kept ✓")));
  assert.deepEqual(answers, ["keep"]);
});
