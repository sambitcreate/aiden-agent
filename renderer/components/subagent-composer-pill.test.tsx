import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { SubagentRunSnapshot, SubagentRunSnapshotV2 } from "../shared/subagent-runs";
import type { SubagentRunView, SubagentRunViewState } from "../lib/subagent-view-state";
import { prettyAccelerator } from "../shared/keybindings";
import { SubagentComposerPill, useSubagentComposerPill } from "./subagent-composer-pill";

afterEach(cleanup);

const ACTIVE = new Set<SubagentRunViewState>(["queued", "starting", "running", "needs_attention"]);

function runView(
  runId: string,
  state: SubagentRunViewState,
  extra: Partial<SubagentRunSnapshotV2> & { generationId?: string } = {},
): SubagentRunView {
  const terminal = !ACTIVE.has(state);
  const generationId = extra.generationId ?? "generation-2";
  const snapshot: SubagentRunSnapshotV2 = {
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
    state: state === "unknown" ? "unknown" : state,
    startedAt: Date.now() - 65_000,
    updatedAt: Date.now() - 1_000,
    ...(terminal ? { finishedAt: Date.now() - 5_000 } : {}),
    modelId: "test-model",
    turns: 1,
    tools: 3,
    tokens: 12_000,
    warnings: [],
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 1,
    ...extra,
  };
  return {
    runId,
    generationId,
    label: snapshot.label,
    role: snapshot.role,
    state,
    terminal,
    source: "live",
    sortKey: runId,
    snapshot,
  };
}

interface Calls {
  opened: string[];
  openedFrom: HTMLElement[];
  stopped: SubagentRunSnapshot[];
  /** The return target each panel open was given. */
  panelOpenedFrom: (HTMLElement | null)[];
  shownInChat: string[][];
  /** What the transcript reports when asked to reveal runs. */
  revealable: boolean;
  /** Opens or closes the tray the way the keyboard command does, without moving focus. */
  setOpen?: (open: boolean | ((open: boolean) => boolean)) => void;
  /** Where focus goes when the pill leaves while holding it. */
  returnFocus?: HTMLElement;
}

function Harness({
  views,
  calls,
  chatId = "chat-1",
  stopPendingRunIds = [],
  stopErrors,
}: {
  /** `null` stands for the panel still holding another chat's views. */
  views: SubagentRunView[] | null;
  calls: Calls;
  chatId?: string;
  stopPendingRunIds?: string[];
  stopErrors?: Record<string, string>;
}) {
  const { model, dismiss } = useSubagentComposerPill(chatId, views, true);
  const [open, setOpen] = React.useState(false);
  calls.setOpen = setOpen;
  return (
    <>
      {model ? (
    <SubagentComposerPill
      model={model}
      open={open}
      onOpenChange={setOpen}
      stopPendingRunIds={stopPendingRunIds}
      stopErrors={stopErrors}
      returnFocus={() => calls.returnFocus ?? null}
      onOpenRun={(runId, trigger) => {
        calls.opened.push(runId);
        calls.openedFrom.push(trigger);
      }}
      onOpenPanel={(returnTarget) => {
        calls.panelOpenedFrom.push(returnTarget);
      }}
      onStop={(run) => {
        calls.stopped.push(run);
      }}
      onShowInChat={(runIds) => {
        calls.shownInChat.push([...runIds]);
        return calls.revealable;
      }}
      onDismiss={dismiss}
      shortcut="Command+Shift+S"
    />
      ) : null}
    </>
  );
}

function mount(
  views: SubagentRunView[],
  options: { stopPendingRunIds?: string[]; stopErrors?: Record<string, string> } = {},
) {
  const calls: Calls = {
    opened: [],
    openedFrom: [],
    stopped: [],
    panelOpenedFrom: [],
    shownInChat: [],
    revealable: true,
  };
  const view = render(<Harness views={views} calls={calls} {...options} />);
  return {
    calls,
    rerender: (next: SubagentRunView[] | null, chatId = "chat-1") =>
      view.rerender(<Harness views={next} calls={calls} chatId={chatId} {...options} />),
  };
}

function pillTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /subagent details/u });
}

/** The run IDs the tray lists, opening and closing it around the read. */
async function trayRunIds(): Promise<(string | null)[]> {
  await act(async () => {
    fireEvent.click(pillTrigger());
  });
  const tray = await screen.findByRole("dialog", { name: "Subagents" });
  const runIds = within(tray)
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("data-subagent-pill-run-id"))
    .filter(Boolean);
  await act(async () => {
    fireEvent.click(pillTrigger());
  });
  return runIds;
}

test("a chat whose subagents all finished earlier shows no pill", () => {
  mount([
    runView("old-a", "completed", { generationId: "generation-1" }),
    runView("old-b", "failed", { generationId: "generation-1" }),
  ]);
  assert.equal(screen.queryByRole("button", { name: /subagent details/u }), null);
});

test("the pill counts the running batch and headlines the run that changed most recently", () => {
  mount([
    runView("old", "completed", { generationId: "generation-1" }),
    runView("a", "running", { activity: "Reading README.md", updatedAt: Date.now() - 9_000 }),
    runView("b", "running", { activity: "Searching workspace text", updatedAt: Date.now() - 500 }),
    runView("c", "completed"),
  ]);
  const trigger = pillTrigger();
  assert.match(trigger.textContent ?? "", /2 subagents/u);
  assert.match(trigger.textContent ?? "", /Run b · Searching workspace text/u);
  // Longest elapsed across the batch, ticking from each run's start.
  assert.match(trigger.textContent ?? "", /1m \d+s/u);
  // The label stays put while activity ticks, so a focused trigger is not re-read each step.
  assert.equal(trigger.getAttribute("aria-label"), "2 subagents running. Show subagent details.");
  assert.match(trigger.getAttribute("aria-keyshortcuts") ?? "", /^(?:Meta|Control)\+Shift\+S$/u);
  // A batch still working has nothing to dismiss.
  assert.equal(screen.queryByRole("button", { name: "Dismiss finished subagents" }), null);
});

test("a run waiting on the person outranks every other headline", () => {
  mount([
    runView("a", "running", { activity: "Reading README.md", updatedAt: Date.now() }),
    runView("b", "needs_attention", { updatedAt: Date.now() - 30_000 }),
  ]);
  assert.match(pillTrigger().textContent ?? "", /Run b needs your attention/u);
});

test("the tray lists the batch, opens the headline run's live feed, and closes with Escape", async () => {
  mount([
    runView("a", "running", {
      activity: "Searching workspace text",
      milestones: ["reading", "listing", "matching", "searching", "reading"],
      latestText: "The parser lives in renderer/lib.",
    }),
    runView("b", "completed", { milestones: ["reading"] }),
  ]);
  await act(async () => {
    fireEvent.click(pillTrigger());
  });
  const tray = await screen.findByRole("dialog", { name: "Subagents" });
  assert.match(tray.textContent ?? "", /1 working · 1 completed/u);
  const rows = within(tray).getAllByRole("listitem").filter((item) => item.hasAttribute("data-subagent-pill-run-id"));
  assert.deepEqual(
    rows.map((row) => row.getAttribute("data-subagent-pill-run-id")),
    ["a", "b"],
  );

  const runA = within(tray).getByRole("button", { name: /^Run a/u });
  assert.equal(runA.getAttribute("aria-expanded"), "true");
  const feed = within(tray).getByRole("list", { name: "Run a activity" });
  // The last four milestones, then the live step.
  assert.deepEqual(
    within(feed).getAllByRole("listitem").map((item) => item.textContent),
    [
      "Listed a workspace directory",
      "Matched workspace file names",
      "Searched workspace text",
      "Read a workspace file",
      "Searching workspace text",
    ],
  );
  assert.match(tray.textContent ?? "", /The parser lives in renderer\/lib\./u);

  // Expanding another run folds the first.
  const runB = within(tray).getByRole("button", { name: /^Run b/u });
  fireEvent.click(runB);
  assert.equal(runB.getAttribute("aria-expanded"), "true");
  assert.equal(runA.getAttribute("aria-expanded"), "false");
  assert.ok(within(tray).getByRole("button", { name: "View result of Run b in the side panel" }));

  await act(async () => {
    fireEvent.keyDown(tray, { key: "Escape" });
  });
  assert.equal(screen.queryByRole("dialog", { name: "Subagents" }), null);
});

test("tray actions open runs and the panel, reveal the transcript, and stop foreground runs", async () => {
  const { calls } = mount([
    runView("a", "running", { activity: "Reading README.md", updatedAt: Date.now() }),
    runView("b", "running", { updatedAt: Date.now() - 2_000 }),
    runView("bg", "running", { execution: "background", updatedAt: Date.now() - 4_000 }),
  ]);
  const openTray = async () => {
    await act(async () => {
      fireEvent.click(pillTrigger());
    });
    return screen.findByRole("dialog", { name: "Subagents" });
  };

  let tray = await openTray();
  fireEvent.click(within(tray).getByRole("button", { name: "Stop all" }));
  // Background runs keep going: only the foreground runs the panel can stop.
  assert.deepEqual(
    calls.stopped.map((run) => run.runId),
    ["a", "b"],
  );

  fireEvent.click(within(tray).getByRole("button", { name: "Stop Run a" }));
  assert.deepEqual(
    calls.stopped.map((run) => run.runId),
    ["a", "b", "a"],
  );

  await act(async () => {
    fireEvent.click(within(tray).getByRole("button", { name: "Open Run a in the side panel" }));
  });
  assert.deepEqual(calls.opened, ["a"]);
  // The tray row is gone, so the panel hands focus back to the pill.
  assert.equal(calls.openedFrom[0] === pillTrigger(), true);
  assert.equal(screen.queryByRole("dialog", { name: "Subagents" }), null);

  tray = await openTray();
  await act(async () => {
    fireEvent.click(within(tray).getByRole("button", { name: "Show in chat" }));
  });
  assert.deepEqual(calls.shownInChat, [["a", "b", "bg"]]);
  assert.equal(screen.queryByRole("dialog", { name: "Subagents" }), null);

  tray = await openTray();
  assert.equal(within(tray).getByText(prettyAccelerator("Command+Shift+S")).tagName, "KBD");
  await act(async () => {
    fireEvent.click(within(tray).getByRole("button", { name: "Open Subagents panel" }));
  });
  assert.equal(calls.panelOpenedFrom.length, 1);
  assert.equal(calls.panelOpenedFrom[0] === pillTrigger(), true, "closing the panel returns to the pill");
});

test("a run whose Stop is in flight cannot be stopped again", async () => {
  const { calls } = mount(
    [runView("a", "running", { updatedAt: Date.now() }), runView("b", "running")],
    { stopPendingRunIds: ["a"] },
  );
  await act(async () => {
    fireEvent.click(pillTrigger());
  });
  const tray = await screen.findByRole("dialog", { name: "Subagents" });
  const stopping = within(tray).getByRole("button", { name: "Stopping Run a" });
  assert.equal((stopping as HTMLButtonElement).disabled, true);
  // One stoppable run left is not "all".
  assert.equal(within(tray).queryByRole("button", { name: "Stop all" }), null);
  assert.deepEqual(calls.stopped, []);
});

test("a settled batch stays as a finished summary until dismissed, and the next run replaces it", () => {
  const { rerender } = mount([runView("a", "running"), runView("b", "running")]);
  assert.match(pillTrigger().textContent ?? "", /2 subagents/u);

  rerender([runView("a", "completed"), runView("b", "failed", { error: "Provider refused" })]);
  const trigger = pillTrigger();
  assert.match(trigger.textContent ?? "", /2 subagents finished/u);
  assert.match(trigger.textContent ?? "", /1 failed · 1 completed/u);

  fireEvent.click(screen.getByRole("button", { name: "Dismiss finished subagents" }));
  assert.equal(screen.queryByRole("button", { name: /subagent details/u }), null);

  // Old settled runs do not return; a run started later in the same turn brings the pill back.
  rerender([runView("a", "completed"), runView("b", "failed"), runView("c", "running")]);
  assert.match(pillTrigger().textContent ?? "", /^1 subagent(?!s)/u);
  assert.doesNotMatch(pillTrigger().textContent ?? "", /Run a|Run b/u);
});

test("another chat's runs never drive this chat's pill", () => {
  const { rerender } = mount([runView("a", "running")]);
  assert.ok(pillTrigger());
  rerender(null, "chat-2");
  assert.equal(screen.queryByRole("button", { name: /subagent details/u }), null);
  rerender([], "chat-2");
  assert.equal(screen.queryByRole("button", { name: /subagent details/u }), null);
});

test("coming back to a chat mid-batch keeps the runs that finished earlier in the batch", async () => {
  const first = runView("a", "completed", { generationId: "generation-1" });
  const second = runView("b", "running", { generationId: "generation-2" });
  const { rerender } = mount([runView("a", "running", { generationId: "generation-1" })]);
  // A second turn's run starts before the first batch has been dismissed.
  rerender([first, second]);
  const before = await trayRunIds();
  assert.deepEqual(before, ["a", "b"]);

  // Away to a quiet chat, then back: the panel holds the other chat's views for a
  // render, and this chat's arrive in pieces, finished references before live runs.
  rerender(null, "chat-2");
  rerender([], "chat-2");
  rerender(null, "chat-1");
  rerender([first], "chat-1");
  rerender([first, second], "chat-1");
  assert.deepEqual(await trayRunIds(), before);
});

test("a batch whose runs vanish with a failed turn ends, so the next batch starts fresh", async () => {
  const { rerender } = mount([runView("a", "running", { generationId: "generation-1" })]);
  // The turn fails and clears its live runs before any saved record of them exists.
  rerender([]);
  assert.equal(screen.queryByRole("button", { name: /subagent details/u }), null);
  const next = runView("b", "running", { generationId: "generation-2" });
  rerender([next]);
  // The failed turn's record turns up later; it is not part of the new batch.
  rerender([runView("a", "interrupted", { generationId: "generation-1" }), next]);
  assert.deepEqual(await trayRunIds(), ["b"]);
});

test("closing a tray the shortcut opened puts focus back where the person was typing", async () => {
  const { calls } = mount([runView("a", "running")]);
  const composer = document.createElement("textarea");
  document.body.append(composer);
  try {
    composer.focus();
    await act(async () => {
      calls.setOpen?.((open) => !open);
    });
    const tray = await screen.findByRole("dialog", { name: "Subagents" });
    assert.equal(document.activeElement === within(tray).getByRole("button", { name: /^Run a/u }), true);
    await act(async () => {
      calls.setOpen?.((open) => !open);
    });
    // Radix returns focus on the next task after the tray unmounts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(screen.queryByRole("dialog", { name: "Subagents" }) === null, true);
    assert.equal(document.activeElement === composer, true, "focus returns to the composer");
  } finally {
    composer.remove();
  }
});

test("Show in chat falls back to the panel when no run is in the transcript", async () => {
  const { calls } = mount([runView("a", "running")]);
  calls.revealable = false;
  await act(async () => {
    fireEvent.click(pillTrigger());
  });
  const tray = await screen.findByRole("dialog", { name: "Subagents" });
  await act(async () => {
    fireEvent.click(within(tray).getByRole("button", { name: "Show in chat" }));
  });
  assert.deepEqual(calls.shownInChat, [["a"]]);
  assert.equal(calls.panelOpenedFrom.length, 1);
  assert.equal(calls.panelOpenedFrom[0] === pillTrigger(), true);
  assert.equal(screen.queryByRole("dialog", { name: "Subagents" }), null);
});

test("a batch left with only background runs can be hidden until another run starts", () => {
  const { rerender } = mount([
    runView("fg", "running"),
    runView("bg", "running", { execution: "background" }),
  ]);
  // A foreground run can still be stopped, so the pill stays.
  assert.equal(screen.queryByRole("button", { name: "Hide background subagents" }), null);

  const backgroundOnly = [runView("fg", "completed"), runView("bg", "running", { execution: "background" })];
  rerender(backgroundOnly);
  fireEvent.click(screen.getByRole("button", { name: "Hide background subagents" }));
  assert.equal(screen.queryByRole("button", { name: /subagent details/u }), null);
  // The background run keeps working without bringing the pill back.
  rerender([runView("fg", "completed"), runView("bg", "running", { execution: "background", activity: "Reading" })]);
  assert.equal(screen.queryByRole("button", { name: /subagent details/u }), null);

  rerender([...backgroundOnly, runView("next", "running")]);
  assert.match(pillTrigger().textContent ?? "", /^1 subagent(?!s)/u);
});

test("a batch that settles after coming back to the chat ends, even if an earlier turn's runs never return", async () => {
  const { rerender } = mount([runView("a", "running", { generationId: "generation-1" })]);
  // Away and back: the first turn's runs are gone (its turn failed while away).
  rerender(null, "chat-2");
  rerender([], "chat-2");
  rerender(null, "chat-1");
  rerender([], "chat-1");
  rerender([runView("b", "running", { generationId: "generation-2" })]);
  rerender([runView("b", "completed", { generationId: "generation-2" })]);
  assert.match(pillTrigger().textContent ?? "", /1 subagent finished/u);
  // The next turn starts a batch of its own instead of joining the finished one.
  rerender([
    runView("b", "completed", { generationId: "generation-2" }),
    runView("c", "running", { generationId: "generation-3" }),
  ]);
  assert.deepEqual(await trayRunIds(), ["c"]);
});

test("dismissing the pill from the keyboard hands focus to the composer", async () => {
  const { calls, rerender } = mount([runView("a", "running")]);
  const composer = document.createElement("textarea");
  document.body.append(composer);
  calls.returnFocus = composer;
  try {
    rerender([runView("a", "completed")]);
    const dismiss = screen.getByRole("button", { name: "Dismiss finished subagents" });
    dismiss.focus();
    await act(async () => {
      fireEvent.click(dismiss);
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(screen.queryByRole("button", { name: /subagent details/u }), null);
    assert.equal(document.activeElement === composer, true);
  } finally {
    composer.remove();
  }
});

test("a hidden background run that needs the person brings the pill back until it is answered", () => {
  const { rerender } = mount([runView("fg", "running"), runView("bg", "running", { execution: "background" })]);
  rerender([runView("fg", "completed"), runView("bg", "running", { execution: "background" })]);
  fireEvent.click(screen.getByRole("button", { name: "Hide background subagents" }));
  assert.equal(screen.queryByRole("button", { name: /subagent details/u }), null);

  rerender([runView("fg", "completed"), runView("bg", "needs_attention", { execution: "background" })]);
  assert.match(pillTrigger().textContent ?? "", /Run bg needs your attention/u);
  assert.equal(screen.queryByRole("button", { name: "Hide background subagents" }), null);
});

test("a running subagent from an older host counts as foreground, so the pill cannot be hidden", () => {
  const legacy = runView("legacy", "running");
  const { execution: _execution, context: _context, authorityRevision: _authority, ...rest } =
    legacy.snapshot as SubagentRunSnapshotV2;
  legacy.snapshot = { ...rest, version: 1 } as unknown as SubagentRunSnapshot;
  mount([legacy]);
  assert.ok(pillTrigger());
  assert.equal(screen.queryByRole("button", { name: "Hide background subagents" }), null);
});

test("a collapsed tray row still shows its failed Stop, and its name leaves out the ticking time", async () => {
  mount(
    [
      runView("a", "running", { updatedAt: Date.now() - 9_000 }),
      runView("b", "running", { updatedAt: Date.now() }),
    ],
    { stopErrors: { a: "The host refused to stop it." } },
  );
  await act(async () => {
    fireEvent.click(pillTrigger());
  });
  const tray = await screen.findByRole("dialog", { name: "Subagents" });
  const rowA = within(tray).getByRole("button", { name: /^Run a,/u });
  assert.equal(rowA.getAttribute("aria-expanded"), "false");
  assert.match(rowA.getAttribute("aria-label") ?? "", /The host refused to stop it\.$/u);
  assert.match(rowA.textContent ?? "", /The host refused to stop it\./u);
  // The row shows over a minute of work, but its name does not carry it.
  assert.match(rowA.textContent ?? "", /1m \d+s/u);
  assert.doesNotMatch(rowA.getAttribute("aria-label") ?? "", /\d+s/u);
});
