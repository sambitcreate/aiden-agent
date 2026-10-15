import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatContextPressureV1 } from "../shared/context-pressure";
import { ContextBreakdown } from "./context-breakdown";

afterEach(cleanup);

function pressure(extra: Partial<ChatContextPressureV1> = {}): ChatContextPressureV1 {
  return {
    contextTokens: 299_800,
    contextWindow: 1_000_000,
    inputBudgetTokens: 967_000,
    reservedTokens: 33_000,
    percentOfWindow: 29.98,
    percentOfUsableInput: 31,
    shouldCompact: false,
    messageTokens: 273_400,
    staticTokens: 26_400,
    compressibleHistoryMessages: 43,
    source: "provider-anchored",
    computedAt: 1_000,
    breakdown: {
      categories: [
        { id: "system-prompt", tokens: 6_200 },
        { id: "builtin-tools", tokens: 11_800 },
        { id: "mcp-tools", tokens: 2_100 },
        { id: "skills", tokens: 2_400 },
        { id: "project-instructions", tokens: 1_900 },
        { id: "memory", tokens: 900 },
        { id: "mcp-instructions", tokens: 1_100 },
      ],
      deferred: [
        {
          id: "mcp-tools",
          tokens: 61_400,
          count: 142,
          servers: [
            { name: "Figma", count: 38, tokens: 21_800 },
            { name: "Notion", count: 47, tokens: 18_200 },
            { name: "Playwright", count: 23, tokens: 9_900 },
            { name: "Linear", count: 34, tokens: 11_500 },
          ],
        },
      ],
    },
    ...extra,
  };
}

function legendLabels(): string[] {
  const legend = screen.getByRole("list", { name: "Context by category" });
  return within(legend)
    .getAllByRole("listitem")
    .map((item) => item.querySelector("[data-legend-label]")?.textContent ?? "");
}

test("headline percentage matches the composer meter", () => {
  render(<ContextBreakdown pressure={pressure()} />);
  assert.ok(screen.getByText("31% used"));
});

test("legend lists messages, then categories largest first, then reserve, free space and deferred", () => {
  render(<ContextBreakdown pressure={pressure()} />);
  assert.deepEqual(legendLabels(), [
    "Messages",
    "Built-in tools",
    "System prompt",
    "Skills",
    "MCP tools",
    "Project instructions",
    "MCP server instructions",
    "Memory",
    "Reserved for response",
    "Free space",
    "MCP tools (deferred)",
  ]);
});

test("the deferred row shows its tokens and is not counted toward the window", () => {
  render(<ContextBreakdown pressure={pressure()} />);
  const legend = screen.getByRole("list", { name: "Context by category" });
  const deferred = within(legend)
    .getAllByRole("listitem")
    .find((item) => item.textContent?.startsWith("MCP tools (deferred)"));
  assert.ok(deferred);
  assert.ok(within(deferred).getByText("61.4K"));
  const notCounted = within(deferred).getByText("—");
  assert.equal(notCounted.getAttribute("aria-label"), "not counted");
  assert.match(screen.getByRole("note").textContent ?? "", /Deferred tools load through tool search and aren't counted until used\./u);
});

test("MCP tools by server starts folded and opens to list each server", () => {
  render(<ContextBreakdown pressure={pressure()} />);
  const fold = screen.getByRole("button", { name: /MCP tools by server/u });
  assert.equal(fold.getAttribute("aria-expanded"), "false");
  assert.match(fold.textContent ?? "", /142/u);
  assert.equal(screen.queryByText("Figma"), null);

  fireEvent.click(fold);

  assert.equal(fold.getAttribute("aria-expanded"), "true");
  const servers = screen.getByRole("list", { name: "MCP tools by server" });
  const rows = within(servers).getAllByRole("listitem");
  assert.equal(rows.length, 4);
  for (const name of ["Figma", "Notion", "Playwright", "Linear"]) assert.ok(within(servers).getByText(name));
  assert.ok(within(servers).getByText("47 tools"));
});

test("the bar's image label names every segment", () => {
  render(<ContextBreakdown pressure={pressure()} />);
  const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
  for (const name of [
    "Messages 273.4K",
    "Built-in tools 11.8K",
    "System prompt 6.2K",
    "Skills 2.4K",
    "MCP tools 2.1K",
    "Project instructions 1.9K",
    "MCP server instructions 1.1K",
    "Memory 900",
    "Free space 667.2K",
    "Reserved for response 33K",
  ]) {
    assert.ok(label.includes(name), `missing "${name}" in "${label}"`);
  }
});

test("without a breakdown the legend falls back to messages and system prompt & tools", () => {
  render(<ContextBreakdown pressure={pressure({ breakdown: undefined })} />);
  assert.deepEqual(legendLabels(), ["Messages", "System prompt & tools", "Reserved for response", "Free space"]);
  assert.equal(screen.queryByRole("button", { name: /MCP tools by server/u }), null);
  assert.doesNotMatch(screen.getByRole("note").textContent ?? "", /Deferred tools/u);
});

test("the note says Aiden will compact when the runtime rule trips", () => {
  render(<ContextBreakdown pressure={pressure({ shouldCompact: true, percentOfUsableInput: 101 })} />);
  assert.match(screen.getByRole("note").textContent ?? "", /^Aiden will compact context before the next request\./u);
});

test("the note reports how many earlier messages compaction could remove", () => {
  render(<ContextBreakdown pressure={pressure()} />);
  assert.match(screen.getByRole("note").textContent ?? "", /43 earlier messages could be compacted later\./u);
});
