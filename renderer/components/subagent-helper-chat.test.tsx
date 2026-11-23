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

test("a running helper shows what it was asked, its steps, and a Stop that stops it", async () => {
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
  const chat = screen.getByRole("article", { name: "Helper chat: Code scout" });
  assert.match(chat.textContent ?? "", /Scout · Running · /u);
  assert.match(chat.textContent ?? "", /Find where the parser lives\./u);
  assert.match(chat.textContent ?? "", /Looking around\./u);
  assert.match(chat.textContent ?? "", /Read a file/u);
  assert.equal(chat.querySelector("[data-subagent-helper-problem]"), null);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Stop subtree Code scout" }));
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
  const chat = screen.getByRole("article", { name: "Helper chat: Code scout" });
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
  assert.match(problem.textContent ?? "", /You stopped this helper after 1 step\. It changed nothing\./u);
  within(problem).getByRole("button", { name: "Ask main chat to retry" });
  assert.match(screen.getByRole("article").textContent ?? "", /Scout · Stopped · /u);
  assert.equal(screen.queryByRole("button", { name: /^Stop / }), null);
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
  render(
    <SubagentsPanel
      chatId="chat-1"
      workspaceId="workspace-1"
      runs={[view(snapshot)]}
      selectedRunId="run-1"
      helperChat={{
        transcriptFor: (runId) => {
          asked.push(runId);
          return { transcript: null, complete: true };
        },
      }}
    />,
  );
  assert.ok(asked.includes("run-1"));
  assert.equal(screen.queryByRole("article", { name: /^Helper chat:/u }), null);
  assert.ok(screen.getAllByText("What it was asked").length > 0);
  assert.ok(screen.getAllByText(/The parser lives in src\/parser\.ts\./u).length > 0);
  assert.equal(screen.queryByText(/Saved view notice/u), null);
});

test("Ask main chat to retry puts the request in the message box without sending it", () => {
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
  fireEvent.click(screen.getByRole("button", { name: "Ask main chat to retry" }));

  const draft = loadComposerDraft(chatId);
  assert.match(draft.text, /Please retry the helper 'Code scout'\./u);
  assert.equal(draft.unresolvedText, undefined, "nothing was submitted");
  assert.equal(store.getState().expandedRunId, null, "the main chat is shown again");
});

function ExpandedHarness({
  store,
  snapshot,
}: {
  store: SubagentHelperChatStore;
  snapshot: SubagentRunSnapshotV2;
}) {
  const panel = {
    subagentViews: [view(snapshot)],
    subagentStopPendingRunIds: [],
    subagentStopErrorsByRunId: {},
    stopSubagent: () => undefined,
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
  assert.equal(screen.queryByRole("article", { name: "Helper chat: Code scout" }), null);
  assert.equal(document.activeElement, opener);

  act(() => {
    fireEvent.click(opener);
  });
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Back to main chat" }));
  });
  assert.equal(screen.queryByRole("article", { name: "Helper chat: Code scout" }), null);
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
  const text = screen.getByRole("article", { name: "Helper chat: Code scout" }).textContent ?? "";
  assert.match(text, /First look\./u);
  assert.match(text, /Found it in src\/parser\.ts\./u);
});

test("a status change is announced once the helper finishes", () => {
  const transcript = conversation(2, [{ text: "Looking around." }]);
  const { rerender } = render(
    <SubagentHelperChat run={helper()} transcript={transcript} announceStatus now={2_000} />,
  );
  const announcements = () => screen.getAllByRole("status").map((region) => region.textContent ?? "");
  assert.equal(announcements().some((text) => text.startsWith("Code scout:")), false);
  rerender(
    <SubagentHelperChat
      run={helper({ state: "completed", activity: undefined, finishedAt: 3_000, revision: 2 })}
      transcript={transcript}
      announceStatus
      now={3_000}
    />,
  );
  assert.ok(announcements().includes("Code scout: Done"));
});
