import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const badge = () => screen.queryByRole("button", { name: /^(?:Show|Hide) Subagents\./u });

test("the toolbar counts the chat's working subagents and opens the Subagents tool", () => {
  const { calls, update } = renderToolbar({
    runs: [run("a", "running"), run("b", "queued"), run("c", "completed")],
  });
  const button = badge();
  assert.ok(button, "a badge appears while subagents work");
  assert.equal(button.getAttribute("aria-label"), "Show Subagents. 2 subagents running.");
  assert.equal(button.textContent, "2");
  fireEvent.click(button);
  assert.deepEqual(calls.shown, ["subagents"]);

  // With the Subagents tool on screen the badge reads as pressed and closes it.
  update({ runs: [run("a", "running")], tab: "subagents" });
  assert.equal(badge()?.getAttribute("aria-pressed"), "true");
  assert.equal(badge()?.getAttribute("aria-label"), "Hide Subagents. 1 subagent running.");
  fireEvent.click(badge()!);
  assert.equal(calls.closed, 1);
});

test("a subagent waiting on the person changes the badge's wording and tone", () => {
  renderToolbar({ runs: [run("a", "needs_attention"), run("b", "running")] });
  assert.equal(badge()?.getAttribute("aria-label"), "Show Subagents. 2 subagents running, 1 waiting on you.");
  assert.equal(badge()?.dataset.subagentsRunning, "attention");
});

test("the badge leaves once every subagent settles, and never shows when subagents are off", () => {
  const { update } = renderToolbar({ runs: [run("a", "running")] });
  assert.ok(badge());
  update({ runs: [run("a", "completed"), run("b", "failed")] });
  assert.equal(badge(), null, "settled runs live in the transcript and the panel, not the toolbar");

  update({ runs: [run("a", "running")], subagentsEnabled: false });
  assert.equal(badge(), null);
});

test("a chat without a workspace has no Subagents tool to open", () => {
  renderToolbar({ runs: [run("a", "running")] }, false);
  assert.equal(badge(), null);
});

test("runs the panel still holds for the previous chat are not counted on this chat's toolbar", () => {
  const { update } = renderToolbar({ runs: [run("a", "running")], viewsChatId: "chat-0" });
  assert.equal(badge(), null);
  update({ runs: [run("b", "running")] });
  assert.equal(badge()?.getAttribute("aria-label"), "Show Subagents. 1 subagent running.");
});

test("while a Git operation holds the panel the badge cannot switch it away", () => {
  const { calls } = renderToolbar({ runs: [run("a", "running")], gitOperationBusy: true });
  const button = badge();
  assert.equal(button?.hasAttribute("disabled"), true);
  fireEvent.click(button!);
  assert.deepEqual(calls.shown, []);
});

test("keyboard focus on the badge moves to the tools menu when the last subagent settles", async () => {
  const { update } = renderToolbar({ runs: [run("a", "running")] });
  badge()!.focus();
  update({ runs: [run("a", "completed")] });
  await Promise.resolve();
  const menu = screen.getByRole("button", { name: "More workspace tools" });
  assert.equal(document.activeElement === menu, true);
});
