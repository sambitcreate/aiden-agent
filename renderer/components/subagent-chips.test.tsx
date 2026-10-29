import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { SubagentMessageReferenceV1, SubagentRunSnapshotV2 } from "../shared/subagent-runs";
import {
  SubagentChips,
  revealSubagentRunInTranscript,
  subagentGroupSummary,
  subagentRunTranscriptTarget,
} from "./subagent-chips";

afterEach(cleanup);

function run(
  runId: string,
  generationId: string,
  extra: Partial<SubagentRunSnapshotV2> = {},
): SubagentRunSnapshotV2 {
  return {
    version: 2,
    runId,
    groupId: "group-1",
    generationId,
    childId: `child-${runId}`,
    chatId: "chat-1",
    workspaceId: "workspace-1",
    revision: 1,
    role: "scout",
    label: `Run ${runId}`,
    taskPreview: "Look around",
    state: "completed",
    startedAt: 1_000,
    updatedAt: 2_000,
    finishedAt: 2_000,
    modelId: "test-model",
    turns: 1,
    tools: 1,
    tokens: 100,
    warnings: [],
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 1,
    ...extra,
  };
}

function savedReference(
  generationId: string,
  items: NonNullable<SubagentMessageReferenceV1["items"]>,
): SubagentMessageReferenceV1 {
  return {
    version: 1,
    generationId,
    runIds: items.map((item) => item.runId),
    items,
    total: items.length,
    completed: items.filter((item) => item.state === "completed").length,
    failed: items.filter((item) => item.state === "failed").length,
    timedOut: 0,
    interrupted: 0,
  };
}

function header(): HTMLElement {
  const group = screen.getByRole("group");
  return within(group).getAllByRole("button")[0]!;
}

test("the group summary counts states most urgent first", () => {
  assert.equal(
    subagentGroupSummary(["completed", "running", "needs_attention", "running", "failed"]),
    "1 needs attention · 2 working · 1 failed · 1 completed",
  );
  assert.equal(subagentGroupSummary([]), "");
});

test("a working batch reads as kicked off and a settled one as ran, with the longest elapsed time", () => {
  const opened: string[] = [];
  const { rerender } = render(
    <SubagentChips
      runs={[
        run("a", "gen-header", { state: "running", finishedAt: undefined, startedAt: Date.now() - 125_000 }),
        run("b", "gen-header", { startedAt: 1_000, finishedAt: 6_000 }),
      ]}
      onOpen={(runId) => opened.push(runId)}
    />,
  );
  const group = screen.getByRole("group", { name: "2 subagents" });
  // The name leaves out the elapsed time, so a focused header is not re-read every second.
  const toggle = screen.getByRole("button", { name: "Kicked off 2 subagents. 1 working · 1 completed." });
  assert.equal(toggle === header(), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.match(toggle.textContent ?? "", /Kicked off 2 subagents/u);
  assert.match(toggle.textContent ?? "", /1 working · 1 completed/u);
  // The running run has worked for over two minutes; the finished one for five seconds.
  assert.match(toggle.textContent ?? "", /2m \d+s/u);

  fireEvent.click(within(group).getByRole("button", { name: /^Open Run b\. Status: Finished\./u }));
  assert.deepEqual(opened, ["b"]);

  rerender(
    <SubagentChips
      runs={[
        run("a", "gen-header", { startedAt: 1_000, finishedAt: 66_000 }),
        run("b", "gen-header", { state: "failed", startedAt: 1_000, finishedAt: 6_000 }),
      ]}
      onOpen={() => undefined}
    />,
  );
  assert.match(header().textContent ?? "", /Ran 2 subagents/u);
  assert.match(header().textContent ?? "", /1 failed · 1 completed/u);
  assert.match(header().textContent ?? "", /1m 5s/u);
});

test("collapsing hides the rows, and the choice survives the saved message replacing the live group", async () => {
  const live = (
    <SubagentChips
      runs={[run("a", "gen-collapse", { state: "running", finishedAt: undefined }), run("b", "gen-collapse")]}
      onOpen={() => undefined}
    />
  );
  const { unmount } = render(live);
  assert.equal(screen.getAllByRole("button", { name: /^Open Run/u }).length, 2);

  await act(async () => {
    fireEvent.click(header());
  });
  assert.equal(header().getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryAllByRole("button", { name: /^Open Run/u }).length, 0);
  unmount();

  // The finished generation renders from its saved reference, without live snapshots.
  render(
    <SubagentChips
      reference={savedReference("gen-collapse", [
        { runId: "a", label: "Run a", role: "scout", state: "completed" },
        { runId: "b", label: "Run b", role: "scout", state: "completed" },
      ])}
      onOpen={() => undefined}
    />,
  );
  assert.equal(header().getAttribute("aria-expanded"), "false");
  assert.match(header().textContent ?? "", /Ran 2 subagents/u);
  assert.equal(screen.queryAllByRole("button", { name: /^Open Run/u }).length, 0);

  await act(async () => {
    fireEvent.click(header());
  });
  assert.equal(header().getAttribute("aria-expanded"), "true");
  assert.equal(screen.getAllByRole("button", { name: /^Open Run/u }).length, 2);
});

test("another generation does not inherit a collapsed group", async () => {
  const { rerender } = render(
    <SubagentChips runs={[run("a", "gen-first")]} onOpen={() => undefined} />,
  );
  await act(async () => {
    fireEvent.click(header());
  });
  // The live group stays mounted while the next turn's subagents replace its runs.
  rerender(<SubagentChips runs={[run("c", "gen-second")]} onOpen={() => undefined} />);
  assert.equal(header().getAttribute("aria-expanded"), "true");
  assert.equal(screen.getAllByRole("button", { name: /^Open Run/u }).length, 1);
  rerender(<SubagentChips runs={[run("a", "gen-first")]} onOpen={() => undefined} />);
  assert.equal(header().getAttribute("aria-expanded"), "false");
});

test("the transcript target is the run's row, or its group's header while collapsed", async () => {
  render(
    <SubagentChips
      runs={[run("target-a", "gen-target"), run("target-b", "gen-target")]}
      onOpen={() => undefined}
    />,
  );
  const rowB = screen.getByRole("button", { name: /^Open Run target-b/u });
  assert.equal(subagentRunTranscriptTarget("target-b"), rowB);
  assert.equal(subagentRunTranscriptTarget("missing"), null);

  await act(async () => {
    fireEvent.click(header());
  });
  // A collapsed row cannot take focus, so the header that reopens it stands in.
  assert.equal(subagentRunTranscriptTarget("target-b"), header());
});

test("revealing a run in a collapsed group opens the group and focuses the run's row", async () => {
  const scrolled: Element[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  try {
    render(
      <SubagentChips
        runs={[run("reveal-a", "gen-reveal"), run("reveal-b", "gen-reveal")]}
        onOpen={() => undefined}
      />,
    );
    await act(async () => {
      fireEvent.click(header());
    });
    assert.equal(header().getAttribute("aria-expanded"), "false");

    let revealed = false;
    await act(async () => {
      revealed = revealSubagentRunInTranscript("reveal-b", { instant: true });
    });
    assert.equal(revealed, true);
    assert.equal(header().getAttribute("aria-expanded"), "true");
    const rowB = screen.getByRole("button", { name: /^Open Run reveal-b/u });
    assert.equal(document.activeElement === rowB, true);
    assert.deepEqual(scrolled, [rowB]);
    assert.equal(revealSubagentRunInTranscript("missing"), false);
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test("a group with no runs renders nothing", () => {
  const { container } = render(<SubagentChips runs={[]} onOpen={() => undefined} />);
  assert.equal(container.innerHTML, "");
});
