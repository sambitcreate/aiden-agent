import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../main/bots/test-dom";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import {
  EnvironmentPanelContext,
  QuickViewCards,
  type EnvironmentPanelContextValue,
} from "./environment-panel";
import type { ChatContextDetails } from "./chat-context-panel";
import type { Workspace } from "../lib/types";
import { parseQuickViewLayout, QUICK_VIEW_LAYOUT_STORAGE_KEY } from "../lib/quick-view-layout";
import type { ChatContextPressureV1 } from "../shared/context-pressure";
import type { SubagentRunView } from "../lib/subagent-view-state";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const WORKSPACE: Workspace = {
  id: "ws-1",
  name: "aiden",
  folderPath: "/Users/test/aiden",
  permission: "full",
  createdAt: 0,
  updatedAt: 0,
};

const PRESSURE: ChatContextPressureV1 = {
  contextTokens: 90_000,
  contextWindow: 1_000_000,
  inputBudgetTokens: 967_000,
  reservedTokens: 33_000,
  percentOfWindow: 9,
  percentOfUsableInput: 9.3,
  shouldCompact: false,
  messageTokens: 80_000,
  staticTokens: 10_000,
  compressibleHistoryMessages: 4,
  source: "estimated",
  computedAt: 1_000,
};

const RUN: SubagentRunView = {
  runId: "run-1",
  generationId: "generation-1",
  label: "Scout the repo",
  role: "scout",
  state: "completed",
  terminal: true,
  source: "live",
  sortKey: "run-1",
};

/** Outside a Git repository, so the Changes card stays away and the tests isolate Context and Subagents. */
function installNonRepoIpc() {
  installBotTestIpc({
    "git:review": () => ({
      isRepo: false,
      files: [],
      summary: {
        fileCount: 0,
        additions: 0,
        deletions: 0,
        unavailableStats: 0,
        stagedFiles: 0,
        unstagedFiles: 0,
        conflictedFiles: 0,
      },
    }),
    "workspaces:gitInfo": () => ({ isRepo: false }),
    "git:pushCapability": () => ({ allowed: false, reason: "Not a Git repository", remotes: [] }),
    "workspaces:externalEditors": () => [],
  });
}

interface PanelState {
  pressure?: ChatContextPressureV1 | null;
  subagentsEnabled?: boolean;
  runs?: SubagentRunView[];
  gitOperationBusy?: boolean;
}

/** Only the fields Quick View's cards read; everything else would be a stub nobody calls. */
function stubPanel(state: PanelState, shownTools: string[]): EnvironmentPanelContextValue {
  const contextDetails = state.pressure
    ? ({ pressure: state.pressure, compacting: false } as ChatContextDetails)
    : null;
  const panel: Partial<EnvironmentPanelContextValue> = {
    activeChat: { chatId: "chat-1", workspaceId: WORKSPACE.id },
    contextDetails,
    subagentsEnabled: state.subagentsEnabled ?? true,
    subagentViews: state.runs ?? [],
    subagentStopPendingRunIds: [],
    subagentStopErrorsByRunId: {},
    gitOperationBusy: state.gitOperationBusy ?? false,
    gitMutationBlockedReason: null,
    setGitOperationBusy: () => {},
    showTools: (tab) => {
      shownTools.push(tab ?? "");
    },
    openReview: () => {},
    openSubagent: () => {},
    stopSubagent: async () => {},
  };
  return panel as EnvironmentPanelContextValue;
}

function renderCards(initial: PanelState) {
  installNonRepoIpc();
  const client = createBotTestQueryClient();
  const shownTools: string[] = [];
  const ui = (state: PanelState) => (
    <QueryClientProvider client={client}>
      <EnvironmentPanelContext.Provider value={stubPanel(state, shownTools)}>
        <QuickViewCards workspace={WORKSPACE} live />
      </EnvironmentPanelContext.Provider>
    </QueryClientProvider>
  );
  const view = render(ui(initial));
  return { shownTools, update: (state: PanelState) => view.rerender(ui(state)) };
}

/** Visible cards in order, named by their reorder grips ("Move Context"). */
const cardTitles = () =>
  screen
    .queryAllByRole("button", { name: /^Move / })
    .map((grip) => grip.getAttribute("aria-label")?.replace(/^Move /u, "") ?? "");

test("a new chat shows only the Environment card", () => {
  renderCards({});
  assert.deepEqual(cardTitles(), ["Environment"]);
});

test("Context appears once the chat has a context projection and opens the Context tool", () => {
  const { shownTools, update } = renderCards({});
  assert.equal(screen.queryAllByRole("button", { name: "Open Context in sidebar" }).length, 0);
  update({ pressure: PRESSURE });
  assert.deepEqual(cardTitles(), ["Environment", "Context"]);
  fireEvent.click(screen.getByRole("button", { name: "Open Context in sidebar" }));
  assert.deepEqual(shownTools, ["context"]);
});

test("Subagents appears only when enabled and the chat has a run, and opens the Subagents tool", () => {
  const { shownTools, update } = renderCards({ subagentsEnabled: false, runs: [RUN] });
  assert.deepEqual(cardTitles(), ["Environment"]);
  update({ subagentsEnabled: true, runs: [] });
  assert.deepEqual(cardTitles(), ["Environment"]);
  update({ subagentsEnabled: true, runs: [RUN] });
  assert.deepEqual(cardTitles(), ["Environment", "Subagents"]);
  fireEvent.click(screen.getByRole("button", { name: "Open Subagents in sidebar" }));
  assert.deepEqual(shownTools, ["subagents"]);
});

test("a running Git operation disables Open in sidebar but not Show in Finder", () => {
  renderCards({ pressure: PRESSURE, runs: [RUN], gitOperationBusy: true });
  const disabled = (name: string | RegExp) =>
    (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
  assert.equal(disabled("Open Context in sidebar"), true);
  assert.equal(disabled("Open Subagents in sidebar"), true);
  assert.equal(disabled(/^Show aiden in (Finder|Files)$/u), false);
});

test("when the focused card goes away, focus moves to the first remaining card", async () => {
  const { update } = renderCards({ pressure: PRESSURE });
  const contextHeader = screen.getByRole("button", { name: /^Context/u, expanded: false });
  act(() => contextHeader.focus());
  assert.equal(document.activeElement === contextHeader, true);
  update({ pressure: null });
  assert.deepEqual(cardTitles(), ["Environment"]);
  await waitFor(() => {
    const environmentHeader = screen.getByRole("button", { name: /^Environment/u, expanded: false });
    assert.equal(document.activeElement === environmentHeader, true);
  });
});

test("the grip picks a card up with Space, moves it with the arrows and Home, and drops it", () => {
  renderCards({ pressure: PRESSURE, runs: [RUN] });
  assert.deepEqual(cardTitles(), ["Environment", "Context", "Subagents"]);
  const grip = () => screen.getByRole("button", { name: "Move Subagents" });
  const status = () => screen.getByRole("status").textContent;
  act(() => grip().focus());
  fireEvent.keyDown(grip(), { key: "ArrowUp" });
  assert.deepEqual(cardTitles(), ["Environment", "Context", "Subagents"], "arrows do nothing until the card is picked up");

  fireEvent.keyDown(grip(), { key: " " });
  assert.equal(status(), "Picked up Subagents, position 3 of 3.");
  fireEvent.keyDown(grip(), { key: "ArrowUp" });
  assert.deepEqual(cardTitles(), ["Environment", "Subagents", "Context"]);
  assert.equal(status(), "Subagents, position 2 of 3.");
  assert.equal(document.activeElement, grip(), "focus stays on the moved card's grip");
  fireEvent.keyDown(grip(), { key: "Home" });
  assert.deepEqual(cardTitles(), ["Subagents", "Environment", "Context"]);
  // Nothing is saved while the card is held.
  const saved = () => parseQuickViewLayout(window.localStorage.getItem(QUICK_VIEW_LAYOUT_STORAGE_KEY)).order.filter((id) => id !== "changes");
  assert.deepEqual(saved(), ["environment", "context", "subagents"]);

  fireEvent.keyDown(grip(), { key: "Enter" });
  assert.equal(status(), "Dropped Subagents at position 1 of 3.");
  assert.deepEqual(cardTitles(), ["Subagents", "Environment", "Context"]);
  assert.equal(document.activeElement, grip());
  assert.deepEqual(saved(), ["subagents", "environment", "context"]);
});

test("Escape puts a held card back where it was and keeps focus on its grip", () => {
  renderCards({ pressure: PRESSURE, runs: [RUN] });
  const grip = () => screen.getByRole("button", { name: "Move Environment" });
  act(() => grip().focus());
  fireEvent.keyDown(grip(), { key: "Enter" });
  fireEvent.keyDown(grip(), { key: "End" });
  assert.deepEqual(cardTitles(), ["Context", "Subagents", "Environment"]);
  fireEvent.keyDown(grip(), { key: "Escape" });
  assert.deepEqual(cardTitles(), ["Environment", "Context", "Subagents"]);
  assert.equal(screen.getByRole("status").textContent, "Moved Environment back to position 1 of 3.");
  assert.equal(document.activeElement, grip());
  // Released: the arrows no longer move it.
  fireEvent.keyDown(grip(), { key: "ArrowDown" });
  assert.deepEqual(cardTitles(), ["Environment", "Context", "Subagents"]);
});

test("pressing a held card's grip puts the card back before a pointer drag starts", () => {
  renderCards({ pressure: PRESSURE, runs: [RUN] });
  const grip = () => screen.getByRole("button", { name: "Move Subagents" });
  act(() => grip().focus());
  fireEvent.keyDown(grip(), { key: " " });
  fireEvent.keyDown(grip(), { key: "ArrowUp" });
  assert.deepEqual(cardTitles(), ["Environment", "Subagents", "Context"]);
  fireEvent.pointerDown(grip(), { button: 0, pointerId: 1, clientY: 0 });
  assert.deepEqual(cardTitles(), ["Environment", "Context", "Subagents"]);
  fireEvent.pointerUp(grip(), { pointerId: 1, clientY: 0 });
  // Released: the arrows no longer move it.
  fireEvent.keyDown(grip(), { key: "ArrowUp" });
  assert.deepEqual(cardTitles(), ["Environment", "Context", "Subagents"]);
});
