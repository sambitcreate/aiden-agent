import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { projectChatContextPressure } from "../../main/services/generation-context.js";
import { formatContextTokenCount, type ChatContextPressureV1 } from "../shared/context-pressure";
import { ContextBreakdown } from "./context-breakdown";
import { ContextMeter } from "./context-meter";
import { CONTEXT_TILE_COUNT, ContextPips, contextTiles } from "./context-tiles";

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
  assert.ok(screen.getByText((_, element) => element?.tagName === "SPAN" && element.textContent === "31% used"));
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
  assert.ok(within(deferred).getByText("not counted"));
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

test("the tile grid's image label names every segment", () => {
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

test("a running compaction leads the note, even when the runtime rule has tripped", () => {
  render(<ContextBreakdown pressure={pressure({ shouldCompact: true, percentOfUsableInput: 101 })} compacting />);
  const note = screen.getByRole("note").textContent ?? "";
  assert.match(note, /^Compacting context…/u);
  assert.doesNotMatch(note, /will compact|Healthy/u);
  cleanup();

  render(<ContextBreakdown pressure={pressure()} compacting />);
  assert.match(screen.getByRole("note").textContent ?? "", /^Compacting context…/u);
});

test("the note reports how many earlier messages compaction could remove", () => {
  render(<ContextBreakdown pressure={pressure()} />);
  assert.match(screen.getByRole("note").textContent ?? "", /43 earlier messages could be compacted later\./u);
});

// A real provider-anchored projection: the provider reported far more input than
// the tiny transcript estimates, so contextTokens exceeds messages + static.
function anchoredPressure(): ChatContextPressureV1 {
  const options = {
    contextWindow: 128_000,
    systemPrompt: "You are a coding agent.",
    tools: [],
    providerId: "openai-codex",
    modelId: "gpt-5.3-codex-spark",
  };
  const user = (content: string): UserMessage => ({ role: "user", content, timestamp: 1 });
  const reply: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-codex-responses",
    provider: options.providerId,
    model: options.modelId,
    usage: {
      input: 50_000,
      output: 1_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 51_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
  return projectChatContextPressure([user("hi"), reply, user("next")], options, 1_000);
}

function tileKinds(): string[] {
  return Array.from(screen.getByRole("img").querySelectorAll("[data-tile]")).map(
    (tile) => (tile as HTMLElement).dataset.tile ?? "",
  );
}

test("provider-counted tokens beyond the local itemization get their own segment on the whole-window scale", () => {
  const anchored = anchoredPressure();
  const excess = anchored.contextTokens - anchored.messageTokens - anchored.staticTokens;
  assert.equal(anchored.source, "provider-anchored");
  assert.ok(excess > 40_000, `expected a large unitemized excess, got ${excess}`);

  for (const variant of [anchored, { ...anchored, breakdown: undefined }]) {
    render(<ContextBreakdown pressure={variant} />);
    const legend = screen.getByRole("list", { name: "Context by category" });
    const row = within(legend)
      .getAllByRole("listitem")
      .find((item) => item.querySelector("[data-legend-label]")?.textContent === "Not itemized");
    assert.ok(row, "missing the provider-counted row");
    assert.ok(within(row).getByText(formatContextTokenCount(excess)));
    assert.equal(legendLabels()[0], "Not itemized");
    assert.ok(within(legend).getByText("Messages"));
    const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
    assert.ok(label.includes(`Not itemized ${formatContextTokenCount(excess)}`), label);
    const tiles = Array.from(screen.getByRole("img").querySelectorAll("[data-tile]"));
    assert.equal(tiles.length, CONTEXT_TILE_COUNT);
    assert.ok(tiles.some((tile) => tile.getAttribute("title") === "Not itemized"));
    cleanup();
  }
});

test("no provider-counted row when the itemization covers the whole projection", () => {
  render(<ContextBreakdown pressure={pressure()} />);
  assert.ok(!legendLabels().includes("Not itemized"));
});

test("the grid lays the window out as 100 tiles: used first, then free, then the reserve", () => {
  render(<ContextBreakdown pressure={pressure()} />);
  const kinds = tileKinds();
  assert.equal(kinds.length, 100);
  // 299.8K used and 33K reserved in a 1M window.
  assert.equal(kinds.filter((kind) => kind === "used").length, 30);
  assert.equal(kinds.filter((kind) => kind === "reserved").length, 3);
  assert.equal(kinds.lastIndexOf("used") < kinds.indexOf("free"), true);
  assert.equal(kinds.lastIndexOf("free") < kinds.indexOf("reserved"), true);
  assert.ok(screen.getByText("Each tile is 10K tokens, 1% of the 1M window"));
});

test("used tiles split by category always add up to the used share", () => {
  const tiles = contextTiles(pressure());
  const perCategory = new Map<string, number>();
  for (const tile of tiles) {
    if (tile.kind === "used") perCategory.set(tile.segment.label, (perCategory.get(tile.segment.label) ?? 0) + 1);
  }
  assert.equal([...perCategory.values()].reduce((sum, count) => sum + count, 0), 30);
  // Each category gets its exact share of the 30 used tiles, rounded down or up.
  for (const [label, tokens] of [["Messages", 273_400], ["Built-in tools", 11_800], ["System prompt", 6_200]] as const) {
    const exact = (tokens / 299_800) * 30;
    const got = perCategory.get(label) ?? 0;
    assert.ok(got === Math.floor(exact) || got === Math.ceil(exact), `${label}: ${got} tiles for ${exact.toFixed(2)}`);
  }
});

test("a tiny context still lights one tile, and an over-budget one eats into the reserve", () => {
  const tiny = contextTiles(pressure({ contextTokens: 1_200, messageTokens: 1_000, staticTokens: 200, breakdown: undefined }));
  assert.equal(tiny.filter((tile) => tile.kind === "used").length, 1);

  const over = contextTiles(
    pressure({ contextTokens: 990_000, messageTokens: 963_600, staticTokens: 26_400, shouldCompact: true }),
  );
  assert.equal(over.length, 100);
  assert.equal(over.filter((tile) => tile.kind === "used").length, 99);
  assert.equal(over.filter((tile) => tile.kind === "reserved").length, 1);
  assert.equal(over.filter((tile) => tile.kind === "free").length, 0);
});

test("pips light one per 10% of usable context, and at least one once anything is used", () => {
  const lit = (percent: number) => {
    const { container } = render(<ContextPips percent={percent} warning={false} />);
    const value = (container.firstElementChild as HTMLElement).dataset.lit;
    cleanup();
    return Number(value);
  };
  assert.deepEqual([0, 2, 12, 84, 131].map(lit), [0, 1, 1, 8, 10]);
});

test("the composer popover warns as soon as its meter does, before compaction is due", () => {
  render(<ContextMeter pressure={pressure({ percentOfUsableInput: 84 })} />);
  fireEvent.click(screen.getByRole("button", { name: /^Context usage, 84 percent$/u }));
  const popover = screen.getByRole("dialog", { name: "Context usage" });
  assert.match(popover.textContent ?? "", /Approaching the limit/u);
  assert.doesNotMatch(popover.textContent ?? "", /Context healthy/u);
});

test("a reserve under half a tile still gets one tile", () => {
  const kinds = contextTiles(pressure({ reservedTokens: 4_000, inputBudgetTokens: 996_000 })).map((tile) => tile.kind);
  assert.equal(kinds.filter((kind) => kind === "reserved").length, 1);
});

test("a window too small for Aiden's own prompt says so instead of promising compaction", () => {
  // A 2K local model: 2,047 tokens are reserved, leaving a 1-token budget.
  render(
    <ContextBreakdown
      pressure={pressure({
        contextWindow: 2_048,
        reservedTokens: 2_047,
        inputBudgetTokens: 1,
        contextTokens: 9_000,
        messageTokens: 400,
        staticTokens: 8_600,
        percentOfUsableInput: 900_000,
        shouldCompact: true,
        breakdown: undefined,
      })}
    />,
  );
  assert.ok(screen.getByText((_, element) => element?.tagName === "SPAN" && element.textContent === ">999% used"));
  const note = screen.getByRole("note").textContent ?? "";
  assert.match(note, /context window is too small/u);
  assert.doesNotMatch(note, /will compact/u);
  assert.equal(tileKinds().every((kind) => kind === "used"), true);
});

test("a category that rounds to nothing in a huge window still reads as present", () => {
  render(<ContextBreakdown pressure={pressure({ contextWindow: 2_000_000 })} />);
  const legend = screen.getByRole("list", { name: "Context by category" });
  const memory = within(legend)
    .getAllByRole("listitem")
    .find((item) => item.querySelector("[data-legend-label]")?.textContent === "Memory");
  assert.ok(memory);
  assert.ok(within(memory).getByText("<0.1%"));
});

test("a little context in a huge window reads as under 1%, not 0%", () => {
  render(
    <ContextBreakdown
      pressure={pressure({ contextWindow: 2_000_000, inputBudgetTokens: 1_883_600, contextTokens: 8_600, percentOfUsableInput: 0.4 })}
    />,
  );
  assert.ok(screen.getByText((_, element) => element?.tagName === "SPAN" && element.textContent === "<1% used"));
});
