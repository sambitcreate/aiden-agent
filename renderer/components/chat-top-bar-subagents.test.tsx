import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceToolButtons } from "./chat-top-bar";
import { EnvironmentPanelContext, type EnvironmentPanelContextValue } from "./environment-panel";
import { CommandSystemProvider } from "../lib/command-system";
import type { EnvironmentPanelTab } from "../lib/environment-panel-state";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import type { SubagentRunView, SubagentRunViewState } from "../lib/subagent-view-state";

afterEach(cleanup);

function run(runId: string, state: SubagentRunViewState): SubagentRunView {
  return {
    runId,
    generationId: "generation-1",
    label: `Run ${runId}`,
    role: "scout",
    state,
    terminal: state === "completed" || state === "failed",
    source: "live",
    sortKey: runId,
  };
}

interface PanelState {
  runs: SubagentRunView[];
  subagentsEnabled?: boolean;
  /** The tab the Environment panel is showing, if it is open. */
  tab?: EnvironmentPanelTab;
  gitOperationBusy?: boolean;
  /** The chat the panel's views were built for; the toolbar below belongs to `chat-1`. */
  viewsChatId?: string;
}

interface Calls {
  shown: (EnvironmentPanelTab | undefined)[];
  closed: number;
}

/** Only the fields the toolbar reads. */
function stubPanel(state: PanelState, calls: Calls): EnvironmentPanelContextValue {
  const panel: Partial<EnvironmentPanelContextValue> = {
    devicesEnabled: false,
    subagentsEnabled: state.subagentsEnabled ?? true,
    subagents: { chatId: state.viewsChatId ?? "chat-1" } as EnvironmentPanelContextValue["subagents"],
    subagentViews: state.runs,
    artifacts: { views: [] } as unknown as EnvironmentPanelContextValue["artifacts"],
    toolsPresented: state.tab !== undefined,
    tab: state.tab ?? "browser",
    gitOperationBusy: state.gitOperationBusy ?? false,
    showTools: (tab) => {
      calls.shown.push(tab);
    },
    closeTools: () => {
      calls.closed += 1;
    },
  };
  return panel as EnvironmentPanelContextValue;
}

function renderToolbar(initial: PanelState, hasWorkspace = true) {
  const calls: Calls = { shown: [], closed: 0 };
  const client = createBotTestQueryClient();
  const ui = (state: PanelState) => (
    <QueryClientProvider client={client}>
      <CommandSystemProvider>
        <EnvironmentPanelContext.Provider value={stubPanel(state, calls)}>
          <WorkspaceToolButtons
            chatId="chat-1"
            hasWorkspace={hasWorkspace}
            hasFolder={false}
            hasFolderAccess={false}
            isRepo={false}
            terminalButton={null}
          />
        </EnvironmentPanelContext.Provider>
      </CommandSystemProvider>
    </QueryClientProvider>
  );
  const view = render(ui(initial));
  return { calls, update: (state: PanelState) => view.rerender(ui(state)) };
}

/** Any toolbar control that announces running subagents. */
const runningCount = () => screen.queryByRole("button", { name: /subagents? running/u });

test("working subagents add no running count to the toolbar; the card and pill carry it", () => {
  const { update } = renderToolbar({
    runs: [run("a", "running"), run("b", "queued"), run("c", "needs_attention")],
  });
  assert.equal(runningCount(), null);
  assert.equal(screen.queryByText("3"), null);
  update({ runs: [run("a", "completed")] });
  assert.equal(runningCount(), null);
});

test("the Subagents tool stays one menu choice away while subagents work", async () => {
  const { calls } = renderToolbar({ runs: [run("a", "running")] });
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("button", { name: "More workspace tools" }), { key: "Enter" });
  });
  const item = await screen.findByRole("menuitem", { name: /Subagents/u });
  await act(async () => {
    fireEvent.click(item);
  });
  assert.deepEqual(calls.shown, ["subagents"]);
});

test("with subagents off, or no workspace, the menu offers no Subagents tool", async () => {
  renderToolbar({ runs: [run("a", "running")], subagentsEnabled: false });
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("button", { name: "More workspace tools" }), { key: "Enter" });
  });
  await screen.findAllByRole("menuitem");
  assert.equal(screen.queryByRole("menuitem", { name: /Subagents/u }), null);
  cleanup();

  renderToolbar({ runs: [run("a", "running")] }, false);
  assert.equal(screen.queryByRole("button", { name: "More workspace tools" }), null);
});
