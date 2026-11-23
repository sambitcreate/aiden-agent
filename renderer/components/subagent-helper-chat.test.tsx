import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentStep } from "../shared/generation-timeline";
import type { SubagentRunSnapshotV2 } from "../shared/subagent-runs";
import type { SubagentTranscriptUpdateV1, SubagentTranscriptV1 } from "../shared/subagent-transcript";
import { loadComposerDraft } from "../lib/composer-draft-store";
import type { SubagentRunView } from "../lib/subagent-view-state";
import {
  askMainChatToRetrySubagent,
  createSubagentHelperChatStore,
  SubagentHelperChatStoreContext,
  type SubagentHelperChatStore,
} from "../lib/subagent-helper-chat-store";
import { EnvironmentPanelContext, type EnvironmentPanelContextValue } from "./environment-panel";
import { SubagentHelperChat } from "./subagent-helper-chat";
import { ExpandedSubagentHelperChat } from "./subagent-helper-chat-expanded";
import { SubagentsPanel } from "./subagents-panel";

afterEach(cleanup);

function helper(extra: Partial<SubagentRunSnapshotV2> = {}): SubagentRunSnapshotV2 {
  return {
    version: 2,
    runId: "run-1",
    groupId: "group-1",
    generationId: "generation-1",
    childId: "child-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    revision: 1,
    role: "scout",
    label: "Code scout",
    taskPreview: "Find the parser",
    state: "running",
    activity: "Reading files",
    startedAt: 1_000,
    updatedAt: 2_000,
    modelId: "test-model",
    turns: 2,
    tools: 1,
    tokens: 120,
    warnings: [],
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 1,
    ...extra,
  };
}

function readStep(status: "running" | "completed"): AgentStep {
  return {
    id: "step-1",
    order: 1,
    kind: "tool",
    toolCallId: "call-1",
    toolName: "read",
    label: "Read a file",
    target: "src/parser.ts",
    status,
    startedAt: 1_100,
    updatedAt: 1_200,
    ...(status === "completed" ? { finishedAt: 1_200 } : {}),
  };
}

function conversation(
  revision: number,
  messages: Array<{ text: string; steps?: AgentStep[]; finishedAt?: number }>,
): SubagentTranscriptV1 {
  return {
    version: 1,
    runId: "run-1",
    revision,
    trimmed: false,
    entries: [
      { kind: "task", text: "Find where the parser lives." },
      ...messages.map((message) => ({
        kind: "message" as const,
        text: message.text,
        steps: message.steps ?? [],
        startedAt: 1_000,
        ...(message.finishedAt === undefined ? {} : { finishedAt: message.finishedAt }),
      })),
    ],
  };
}

function view(snapshot: SubagentRunSnapshotV2): SubagentRunView {
  return {
    runId: snapshot.runId,
    generationId: snapshot.generationId,
    label: snapshot.label,
    role: snapshot.role,
    state: snapshot.state,
    terminal: snapshot.finishedAt !== undefined,
    source: "live",
    sortKey: `${snapshot.startedAt}:${snapshot.runId}`,
    snapshot,
  };
}

test("a running helper shows what it was asked, its steps, a working row, and a Stop that stops it", async () => {
  const stopped: string[] = [];
  render(
    <SubagentHelperChat
      run={helper()}
      transcript={conversation(2, [{ text: "Looking around.", steps: [readStep("running")] }])}
      onStop={(run) => {
        stopped.push(run.runId);
      }}
      now={4_000}
    />,
  );
  const chat = screen.getByRole("article", { name: "Code scout" });
  assert.match(chat.textContent ?? "", /Scout · Running · /u);
  assert.match(chat.textContent ?? "", /Find where the parser lives\./u);
  assert.match(chat.textContent ?? "", /Looking around\./u);
  assert.match(chat.textContent ?? "", /Read a file/u);
  assert.equal(chat.querySelector("[data-subagent-helper-problem]"), null);
  assert.match(chat.querySelector("[data-subagent-helper-working]")?.textContent ?? "", /Working/u);

  // A top-level helper stops with everything it started, and says so.
  const stop = screen.getByRole("button", { name: "Stop all Code scout" });
  assert.match(stop.textContent ?? "", /^Stop all$/u);
  await act(async () => {
    fireEvent.click(stop);
  });
  assert.deepEqual(stopped, ["run-1"]);
});

test("a running helper that asks to write says it is waiting on you, and the answer goes back", () => {
  const decisions: string[] = [];
  render(
    <SubagentHelperChat
      run={helper({ activity: "Preparing a workspace update" })}
      transcript={conversation(2, [{ text: "I'll write the plan." }])}
      approval={{
        prompt: {
          approvalId: "approval-1",
          toolCallId: "call-1",
          toolName: "subagent",
          summary: "Allow writes for Code scout",
          canAllow: true,
          details: {
            kind: "subagent-run-grant",
            lane: "write",
            runId: "run-1",
            childLabel: "Code scout",
            workspaceLabel: "Docs",
            worktreeLabel: null,
            isManagedWorktree: false,
            workspaceRevisionPrefix: "0123456789ab",
            fullHostAccess: false,
            noRollback: false,
          },
        },
        deciding: false,
        onDecide: (decision) => {
          decisions.push(decision);
        },
      }}
      now={4_000}
    />,
  );
  const chat = screen.getByRole("article", { name: "Code scout" });
  assert.match(chat.textContent ?? "", /Scout · Waiting on you · /u);
  const question = chat.querySelector<HTMLElement>("[data-subagent-helper-approval]");
  assert.ok(question, "the question is shown inside the helper chat");
  assert.match(question.textContent ?? "", /Allow writes for Code scout/u);
  fireEvent.click(within(question).getByRole("button", { name: /Deny|Don.t allow/u }));
  assert.deepEqual(decisions, ["deny"]);
});

test("a stopped helper explains what happened and offers no Stop", () => {
  render(
    <SubagentHelperChat
      run={helper({ state: "stopped", activity: undefined, finishedAt: 3_000 })}
      transcript={conversation(3, [{ text: "Looking around.", steps: [readStep("completed")] }])}
      onStop={() => undefined}
      onAskRetry={() => undefined}
    />,
  );
  const problem = screen.getByRole("note");
  assert.equal(
    problem.textContent?.replace("Ask main chat to retry", ""),
    "You stopped this helper after 1 step. It didn't change any files.",
  );
  within(problem).getByRole("button", { name: "Ask main chat to retry" });
  assert.match(screen.getByRole("article").textContent ?? "", /Scout · Stopped · /u);
  assert.equal(screen.queryByRole("button", { name: /^Stop / }), null);
  assert.equal(document.querySelector("[data-subagent-helper-working]"), null);
});

test("a helper without a saved conversation falls back to its summary", () => {
  const snapshot = helper({
    state: "completed",
    activity: undefined,
    finishedAt: 3_000,
    terminalMarkdown: "The parser lives in src/parser.ts.",
    projectionNotices: ["task_truncated"],
  });
  const asked: string[] = [];
  const fetched: string[] = [];
  render(
    <SubagentsPanel
      chatId="chat-1"
      workspaceId="workspace-1"
      runs={[view(snapshot)]}
      selectedRunId="run-1"
      active
      helperChat={{
        transcriptFor: (runId) => {
          asked.push(runId);
          return { transcript: null, complete: true };
        },
        onTranscriptIncomplete: (runId) => fetched.push(runId),
      }}
    />,
  );
  assert.ok(asked.includes("run-1"));
  assert.deepEqual(fetched, [], "a finished helper's summary is already saved; nothing is read again");
  assert.equal(screen.queryByRole("article", { name: "Code scout" }), null);
  assert.ok(screen.getAllByText("What it was asked").length > 0);
  assert.ok(screen.getAllByText(/The parser lives in src\/parser\.ts\./u).length > 0);
  assert.equal(screen.queryByText(/Saved view notice/u), null);
});

test("Ask main chat to retry puts the request in the message box once, without sending it", () => {
  const chatId = `chat-retry-${Date.now()}`;
  const store = createSubagentHelperChatStore();
  store.reset(chatId);
  store.expand("run-1", null);
  render(
    <SubagentHelperChat
      run={helper({ chatId, state: "failed", activity: undefined, finishedAt: 3_000, error: "Disk full" })}
      transcript={conversation(3, [{ text: "Trying.", steps: [readStep("completed")] }])}
      onAskRetry={(text) => askMainChatToRetrySubagent(store, chatId, text)}
    />,
  );
  const problem = screen.getByRole("note");
  assert.equal(
    problem.textContent?.replace("Ask main chat to retry", ""),
    "This helper couldn't finish. Disk full. It didn't change any files.",
  );
  const retry = within(problem).getByRole("button", { name: "Ask main chat to retry" });
  fireEvent.click(retry);
  fireEvent.click(retry);

  const draft = loadComposerDraft(chatId);
  assert.equal(
    draft.text,
    "Please retry the helper \u201cCode scout\u201d. It failed after 1 step and didn't change any files.",
    "a second click does not add the request again",
  );
  assert.equal(draft.unresolvedText, undefined, "nothing was submitted");
  assert.equal(store.getState().expandedRunId, null, "the main chat is shown again");
});

test("Technical details open in view with focus, and show what the run used", () => {
  render(
    <SubagentHelperChat
      run={helper({ context: "fork" })}
      transcript={conversation(2, [{ text: "Looking around." }])}
      contextUsage={{ tokens: 9_000, window: 10_000 }}
      now={4_000}
    />,
  );
  const toggle = screen.getByRole("button", { name: "Technical details" });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const details = screen.getByRole("region", { name: "Technical details" });
  assert.equal(document.activeElement, details, "opening the details moves focus to them");
  const text = details.textContent ?? "";
  assert.match(text, /Started with this chat's context/u);
  assert.match(text, /Turns2/u);
  assert.match(text, /Tokens120/u);
  assert.match(text, /test-model/u);
  assert.match(text, /run-1/u);
  assert.match(
    details.querySelector("[data-subagent-helper-context-usage]")?.textContent ?? "",
    /90%/u,
    "the context reading is listed",
  );
  within(details).getByRole("button", { name: "Copy run ID" });

  fireEvent.click(toggle);
  assert.equal(screen.queryByRole("region", { name: "Technical details" }), null);
});

test("the side panel's chat closes the panel, shows a refresh problem with a retry, and announces nothing itself", () => {
  const closed: string[] = [];
  const retried: string[] = [];
  const { rerender } = render(
    <SubagentHelperChat
      run={helper()}
      transcript={conversation(2, [{ text: "Looking around." }])}
      onClose={() => closed.push("close")}
      onBack={() => closed.push("back")}
      refreshError="Network down"
      onRetryRefresh={() => retried.push("retry")}
      now={4_000}
    />,
  );
  assert.equal(screen.queryByRole("button", { name: "Back to main chat" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  assert.deepEqual(closed, ["close"]);

  const refresh = document.querySelector<HTMLElement>("[data-subagent-helper-refresh-error]");
  assert.ok(refresh);
  assert.match(refresh.textContent ?? "", /Couldn't load the latest steps/u);
  fireEvent.click(within(refresh).getByRole("button", { name: "Try again" }));
  assert.deepEqual(retried, ["retry"]);

  // The shared live announcer speaks for helpers; a second region would repeat it.
  rerender(
    <SubagentHelperChat
      run={helper({ state: "completed", activity: undefined, finishedAt: 3_000, revision: 2 })}
      transcript={conversation(2, [{ text: "Looking around." }])}
      onClose={() => undefined}
      now={4_000}
    />,
  );
  const spoken = [...document.querySelectorAll("[aria-live]")].map((region) => region.textContent ?? "");
  assert.equal(spoken.some((text) => /Code scout|Done/u.test(text)), false);
});

function ExpandedHarness({
  store,
  snapshot,
  refetch,
}: {
  store: SubagentHelperChatStore;
  snapshot: SubagentRunSnapshotV2;
  refetch?: (runId: string, savedRevision: number) => void;
}) {
  const panel = {
    subagentViews: [view(snapshot)],
    subagentStopPendingRunIds: [],
    subagentStopErrorsByRunId: {},
    stopSubagent: () => undefined,
    refetchSubagentTranscript: refetch,
  } as unknown as EnvironmentPanelContextValue;
  return (
    <SubagentHelperChatStoreContext.Provider value={store}>
      <EnvironmentPanelContext.Provider value={panel}>
        <button type="button" onClick={(event) => store.expand(snapshot.runId, event.currentTarget)}>
          Open Code scout
        </button>
        <ExpandedSubagentHelperChat chatId="chat-1" />
      </EnvironmentPanelContext.Provider>
    </SubagentHelperChatStoreContext.Provider>
  );
}

function expandedStore(): SubagentHelperChatStore {
  const store = createSubagentHelperChatStore();
  store.reset("chat-1");
  store.rememberSaved("chat-1", conversation(3, [{ text: "First look." }]));
  return store;
}

test("Expand fills the pane, and Esc or Back returns focus to what opened it", () => {
  const store = expandedStore();
  render(<ExpandedHarness store={store} snapshot={helper()} />);
  const opener = screen.getByRole("button", { name: "Open Code scout" });

  act(() => {
    opener.focus();
    fireEvent.click(opener);
  });
  const heading = screen.getByRole("heading", { name: "Code scout" });
  assert.equal(document.activeElement, heading, "the helper chat takes focus");
  assert.equal(screen.queryByRole("button", { name: "Expand" }), null);

  act(() => {
    fireEvent.keyDown(heading, { key: "Escape" });
  });
  assert.equal(screen.queryByRole("article", { name: "Code scout" }), null);
  assert.equal(document.activeElement, opener);

  act(() => {
    fireEvent.click(opener);
  });
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Back to main chat" }));
  });
  assert.equal(screen.queryByRole("article", { name: "Code scout" }), null);
  assert.equal(document.activeElement, opener);
});

test("a window that joins late shows the saved conversation plus what streamed since", () => {
  const store = expandedStore();
  render(<ExpandedHarness store={store} snapshot={helper()} />);
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Open Code scout" }));
  });
  const update: SubagentTranscriptUpdateV1 = {
    version: 1,
    runId: "run-1",
    baseRevision: 3,
    revision: 4,
    trimmed: false,
    entryCount: 3,
    changes: [{ index: 2, entry: { kind: "message", text: "Found it in src/parser.ts.", steps: [], startedAt: 2_000 } }],
  };
  act(() => {
    store.syncLive("chat-1", new Map([["run-1", update]]));
  });
  const text = screen.getByRole("article", { name: "Code scout" }).textContent ?? "";
  assert.match(text, /First look\./u);
  assert.match(text, /Found it in src\/parser\.ts\./u);
});

test("a gap in the streamed updates makes the expanded chat read the saved copy again", () => {
  const store = expandedStore();
  const refetched: Array<[string, number]> = [];
  render(
    <ExpandedHarness
      store={store}
      snapshot={helper()}
      refetch={(runId, revision) => refetched.push([runId, revision])}
    />,
  );
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Open Code scout" }));
  });
  assert.deepEqual(refetched, [], "a complete conversation is not read again");
  const update: SubagentTranscriptUpdateV1 = {
    version: 1,
    runId: "run-1",
    baseRevision: 5,
    revision: 6,
    trimmed: false,
    entryCount: 4,
    changes: [{ index: 3, entry: { kind: "message", text: "Later.", steps: [], startedAt: 3_000 } }],
  };
  act(() => {
    store.syncLive("chat-1", new Map([["run-1", update]]));
  });
  assert.deepEqual(refetched, [["run-1", 3]]);
  const text = screen.getByRole("article", { name: "Code scout" }).textContent ?? "";
  assert.match(text, /First look\./u, "the saved copy stays on screen meanwhile");
});

function runGrant(runId: string, approvalId: string) {
  return {
    approvalId,
    toolCallId: `call-${approvalId}`,
    toolName: "subagent",
    summary: `Allow writes for ${runId}`,
    canAllow: true,
    details: {
      kind: "subagent-run-grant" as const,
      lane: "write" as const,
      runId,
      childLabel: runId,
      workspaceLabel: "Docs",
      worktreeLabel: null,
      isManagedWorktree: false,
      workspaceRevisionPrefix: "0123456789ab",
      fullHostAccess: false,
      noRollback: false,
    },
  };
}

test("while expanded, the main chat's own approval shows a bar that returns to it", async () => {
  const store = expandedStore();
  const focused: string[] = [];
  store.syncMainWaiting("chat-1", false, () => focused.push("main approval"));
  render(<ExpandedHarness store={store} snapshot={helper()} />);
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Open Code scout" }));
  });
  const bar = () => document.querySelector<HTMLElement>("[data-subagent-helper-main-waiting]");

  // This helper's own question is answered inside its chat: no bar.
  act(() => {
    store.syncApprovals("chat-1", [runGrant("run-1", "own")], null, () => undefined);
  });
  assert.equal(bar(), null);
  assert.ok(document.querySelector("[data-subagent-helper-approval]"));

  act(() => {
    store.syncApprovals("chat-1", [runGrant("run-1", "own"), runGrant("run-other", "main")], null, () => undefined);
  });
  const waiting = bar();
  assert.ok(waiting, "an approval that is not this helper's shows the bar");
  assert.match(waiting.textContent ?? "", /Main chat is waiting on you/u);
  assert.ok(document.querySelector("[data-subagent-helper-approval]"), "the helper's own question still works");

  await act(async () => {
    fireEvent.click(within(waiting).getByRole("button", { name: "Back to main chat" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(store.getState().expandedRunId, null, "the main chat is shown again");
  assert.deepEqual(focused, ["main approval"], "focus goes to what waits in the main chat");
});

test("a question waiting in the main chat also shows the bar", () => {
  const store = expandedStore();
  store.syncMainWaiting("chat-1", true, () => undefined);
  render(<ExpandedHarness store={store} snapshot={helper()} />);
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Open Code scout" }));
  });
  assert.ok(document.querySelector("[data-subagent-helper-main-waiting]"));
});

test("the side panel shows a placeholder for the helper that fills the main chat", async () => {
  const snapshot = helper();
  const collapsed: string[] = [];
  render(
    <SubagentsPanel
      chatId="chat-1"
      workspaceId="workspace-1"
      runs={[view(snapshot)]}
      selectedRunId="run-1"
      active
      helperChat={{
        transcriptFor: () => ({ transcript: conversation(2, [{ text: "Looking around." }]), complete: true }),
        expandedRunId: "run-1",
        onCollapse: () => collapsed.push("collapse"),
      }}
    />,
  );
  assert.equal(screen.queryByRole("article", { name: "Code scout" }), null, "the chat is shown once, not twice");
  const heading = screen.getByRole("heading", { name: "Showing in the main chat" });
  // The helper list stays next to it.
  assert.ok(document.querySelector("[data-subagent-run-id='run-1']"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Back to main chat" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.deepEqual(collapsed, ["collapse"]);
  assert.ok(heading);
});

test("a running helper opened before anything streamed to this window reads its conversation once", () => {
  const snapshot = helper();
  const fetched: Array<[string, number]> = [];
  const props = {
    chatId: "chat-1",
    workspaceId: "workspace-1",
    runs: [view(snapshot)],
    selectedRunId: "run-1",
    active: true,
    helperChat: {
      transcriptFor: () => ({ transcript: null, complete: true }),
      onTranscriptIncomplete: (runId: string, revision: number) => fetched.push([runId, revision]),
    },
  };
  const { rerender } = render(<SubagentsPanel {...props} />);
  rerender(<SubagentsPanel {...props} runs={[view(helper({ revision: 2, activity: "Still reading" }))]} />);
  assert.deepEqual(fetched, [["run-1", 0]]);
});
