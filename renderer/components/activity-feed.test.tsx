import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityFeed } from "./activity-feed.js";
import type {
  AgentStep,
  AgentToolStep,
  GenerationTimeline,
} from "../shared/generation-timeline.js";

function step(
  order: number,
  toolName: string,
  status: AgentToolStep["status"] = "completed",
  extra: Partial<AgentToolStep> = {},
): AgentToolStep {
  return {
    id: `tool-${order + 1}`,
    order,
    kind: "tool",
    toolCallId: `call-${order + 1}`,
    toolName,
    label: toolName,
    status,
    startedAt: order,
    updatedAt: order,
    ...extra,
  };
}

function timeline(
  status: GenerationTimeline["status"],
  steps: AgentStep[],
  extra: Partial<GenerationTimeline> = {},
): GenerationTimeline {
  return {
    version: 3,
    generationId: "generation-1",
    status,
    startedAt: 1,
    ...(status === "running" ? {} : { finishedAt: 2 }),
    steps,
    ...extra,
  };
}

function repeat(toolName: string, count: number, from: number): AgentToolStep[] {
  return Array.from({ length: count }, (_, index) => step(from + index, toolName));
}

function styles(): string {
  return readFileSync(new URL("../styles.css", import.meta.url), "utf8");
}

test("a live turn shows a three-row ticker with the newest line last", () => {
  const markup = renderToStaticMarkup(
    <ActivityFeed
      timeline={timeline("running", [
        step(0, "read_file", "completed", { target: "package.json" }),
        step(1, "grep", "completed", { detail: "export", target: "services" }),
        step(2, "list_dir", "completed", { target: "renderer" }),
        step(3, "run_command", "running", { detail: "Count tests in the workspace" }),
      ])}
    />,
  );

  const ticker = markup.slice(markup.indexOf("activity-feed-window"), markup.indexOf("</summary>"));
  assert.equal((ticker.match(/activity-feed-row/gu) ?? []).length, 3);
  assert.doesNotMatch(ticker, /package\.json/u);
  assert.match(ticker, /data-masked="true"/u);
  assert.match(ticker, /aria-live="polite"/u);
  assert.match(ticker, /aria-label="Running Count tests in the workspace"/u);
  // The active row is the last one, so older lines drift up out of the mask.
  const stack = ticker.slice(ticker.indexOf("activity-feed-stack"));
  assert.ok(stack.indexOf("Grepped") < stack.indexOf("Listed"));
  assert.ok(stack.indexOf("Listed") < stack.indexOf("Running"));
  assert.match(ticker, /agent-thinking-shimmer/u);
});

test("a short run leaves the mask off so the first line is fully legible", () => {
  const markup = renderToStaticMarkup(
    <ActivityFeed timeline={timeline("running", [step(0, "read_file", "running")])} />,
  );
  assert.match(markup, /data-masked="false"/u);
});

test("a settled turn collapses to one deterministic summary", () => {
  const markup = renderToStaticMarkup(
    <ActivityFeed
      timeline={timeline("completed", [
        ...repeat("read_file", 8, 0),
        ...repeat("grep", 3, 8),
        ...repeat("glob", 1, 11),
        ...repeat("run_command", 1, 12),
      ])}
    />,
  );
  assert.doesNotMatch(markup, /activity-feed-window/u);
  assert.match(markup, /Explored 8 files, 4 searches, ran 1 command/u);
  assert.equal((markup.match(/role="listitem"/gu) ?? []).length, 13);
});

test("the trail is a flat list, never a nested disclosure", () => {
  const markup = renderToStaticMarkup(
    <ActivityFeed
      timeline={timeline("completed", [
        step(0, "read_file", "completed", { target: "package.json" }),
        {
          id: "think-1",
          order: 1,
          kind: "thinking",
          startedAt: 1,
          updatedAt: 2,
          finishedAt: 2,
          durationMs: 4_000,
        },
        step(2, "grep", "completed", { detail: "export", target: "services" }),
      ])}
    />,
  );
  assert.equal((markup.match(/<details/gu) ?? []).length, 1);
  assert.match(markup, /Read<\/span><span[^>]*> package\.json/u);
  assert.match(markup, /Thought<\/span><span[^>]*> for 4s/u);
  assert.match(markup, /Grepped<\/span><span[^>]*> export in services/u);
});

test("activity typography keeps summaries above compact details", () => {
  const markup = renderToStaticMarkup(
    <ActivityFeed
      timeline={timeline("completed", [
        step(0, "read_file", "completed", { target: "package.json" }),
        step(1, "run_command", "failed", { detail: "Run the test suite" }),
      ])}
    />,
  );

  assert.match(
    markup,
    /text-small-strong font-medium text-secondary activity-feed-summary-label/u,
  );
  assert.match(markup, /activity-feed-detail-label[^"]*text-mini text-secondary/u);
  assert.match(markup, /text-secondary font-medium">Read/u);
  assert.match(markup, /font-normal text-tertiary"> package\.json/u);
  assert.match(markup, /text-red font-medium">run_command failed/u);
});

test("the feed carries no outline of its own", () => {
  const markup = renderToStaticMarkup(
    <ActivityFeed timeline={timeline("completed", [step(0, "read_file")])} />,
  );
  const summary = markup.slice(0, markup.indexOf("</summary>"));
  assert.doesNotMatch(summary, /\bborder(?:-|\s|")/u);
  assert.doesNotMatch(summary, /\bbg-surface/u);
});

test("failed work is counted for review and states why", () => {
  const markup = renderToStaticMarkup(
    <ActivityFeed
      timeline={timeline("completed", [step(0, "read_file"), step(1, "run_command", "cancelled")], {
        claimCheck: { kind: "unverified_success", stepIds: ["tool-2"] },
      })}
    />,
  );
  assert.match(markup, />1 issue</u);
  assert.match(markup, /run_command cancelled/u);
  assert.match(markup, /Success not verified/u);
});

test("an empty timeline renders nothing at all", () => {
  assert.equal(renderToStaticMarkup(<ActivityFeed timeline={timeline("running", [])} />), "");
  assert.equal(renderToStaticMarkup(<ActivityFeed timeline={null} />), "");
});

test("the ticker rises by exactly one row and dissolves under a fade", () => {
  const css = styles();
  assert.match(css, /@keyframes aiden-activity-stack-shift\s*\{[^}]*translateY\(1\.5rem\)/u);
  assert.match(css, /@keyframes aiden-activity-row-in\s*\{[^}]*blur\(2px\)/u);
  assert.match(
    css,
    /\.activity-feed-window\[data-masked="true"\]\s*\{[^}]*mask-image:\s*linear-gradient/u,
  );
  // Motion is opt-in, so a reduced-motion window still shows the same rows.
  assert.match(css, /:root\[data-reduce-motion="false"\] \.activity-feed-stack/u);
  assert.doesNotMatch(css, /aiden-agent-step-label-(?:in|out)/u);
});
