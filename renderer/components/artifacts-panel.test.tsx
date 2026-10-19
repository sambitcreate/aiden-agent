import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import { ArtifactsPanel } from "./artifacts-panel";
import { EnvironmentPanelProvider, useEnvironmentPanel } from "./environment-panel";
import { WorkspaceTerminalProvider } from "./terminal-drawer";
import { WorkspaceToolLauncher } from "./workspace-tool-launcher";
import { TooltipProvider } from "./ui";
import { WorkspaceProvider } from "../lib/workspace-context";
import { CommandSystemProvider } from "../lib/command-system";
import type { Workspace } from "../lib/types";
import type { WorkspaceArtifactsState } from "../lib/use-workspace-artifacts";
import { compileAum } from "../shared/aiden-ui/compile";
import { AIDEN_UI_CATALOG_VERSION } from "../shared/aiden-ui/types";
import type { WorkspaceArtifactSourceV1, WorkspaceArtifactView } from "../shared/workspace-artifacts";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const WORKSPACE: Workspace = { id: "ws-1", name: "aiden", folderPath: "/Users/test/aiden", permission: "ask", createdAt: 0, updatedAt: 0 };
const PULLS: WorkspaceArtifactSourceV1 = { name: "pulls", kind: "shell", command: "gh pr list --json number,title", parse: "json" };
const DIGEST = "a".repeat(64);

function view(id: string, title: string, options: { approved?: boolean; sources?: WorkspaceArtifactSourceV1[]; pulls?: unknown } = {}): WorkspaceArtifactView {
  const compiled = compileAum(
    `<Visual title="${title}"><Each in={$pulls} as="pr"><Text>#{$pr.number} {$pr.title}</Text></Each><If test={$pulls == null}><Text>Not loaded</Text></If></Visual>`,
    { artifactActions: true },
  );
  const sources = options.sources ?? [PULLS];
  return {
    digest: DIGEST,
    artifact: {
      version: 1,
      id,
      workspaceId: WORKSPACE.id,
      visual: { version: 1, kind: "ui", id, title, catalogVersion: AIDEN_UI_CATALOG_VERSION, tree: compiled.tree!, fallbackText: compiled.fallbackText },
      sources,
      actions: [],
      refresh: { onOpen: true },
      ...(options.approved ? { approvedDigest: DIGEST } : {}),
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    ...(options.pulls !== undefined
      ? { snapshot: { revision: 1, refreshedAt: Date.now(), sources: { pulls: { status: "ok" as const, at: 1, dataJson: JSON.stringify(options.pulls) } } } }
      : {}),
  };
}

function state(views: WorkspaceArtifactView[], overrides: Partial<WorkspaceArtifactsState> = {}): WorkspaceArtifactsState {
  return { workspaceId: WORKSPACE.id, views, loaded: true, error: null, reload: () => undefined, ...overrides };
}

function renderPanel(props: Partial<React.ComponentProps<typeof ArtifactsPanel>> & { artifacts: WorkspaceArtifactsState }) {
  return render(
    <TooltipProvider>
      <ArtifactsPanel workspace={WORKSPACE} selectedId={null} onSelect={() => undefined} onAskAiden={() => undefined} {...props} />
    </TooltipProvider>,
  );
}

test("the page draws its saved data from each source", () => {
  installBotTestIpc();
  renderPanel({ artifacts: state([view("art1", "Open PRs", { approved: true, pulls: [{ number: 12, title: "Fix login" }] })]) });
  screen.getByText((_content, element) => element?.tagName === "P" && /#\s*12\s*Fix login/u.test(element.textContent ?? ""));
  assert.equal(screen.queryByText("Not loaded"), null);
  screen.getByText(/Updated/u);
});

test("a source that never loaded binds as null", () => {
  installBotTestIpc();
  renderPanel({ artifacts: state([view("art1", "Open PRs", { approved: true })]) });
  screen.getByText("Not loaded");
});

test("under Ask, new commands wait for the person to allow exactly what they read", async () => {
  const calls = installBotTestIpc({ "workspaces:artifacts:approve": () => ({}) });
  renderPanel({ artifacts: state([view("art1", "Open PRs")]) });
  fireEvent.click(screen.getByRole("button", { name: /Review/u }));
  const dialog = await screen.findByRole("dialog");
  within(dialog).getByText(/gh pr list --json number,title/u);
  fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "workspaces:artifacts:approve")));
  assert.deepEqual(calls.find((call) => call.channel === "workspaces:artifacts:approve")!.args, [WORKSPACE.id, "art1", DIGEST]);
});

test("pages that only read workspace files, or were approved, ask nothing", () => {
  installBotTestIpc();
  const file: WorkspaceArtifactSourceV1 = { name: "pulls", kind: "file", file: "prs.json", parse: "json" };
  const { unmount } = renderPanel({ artifacts: state([view("art1", "Open PRs", { sources: [file] })]) });
  assert.equal(screen.queryByRole("button", { name: /Review/u }), null);
  unmount();
  renderPanel({ artifacts: state([view("art1", "Open PRs", { approved: true })]) });
  assert.equal(screen.queryByRole("button", { name: /Review/u }), null);
});

test("without workspace access the page says why its data is not live", () => {
  installBotTestIpc();
  renderPanel({ workspace: { ...WORKSPACE, permission: "none" }, artifacts: state([view("art1", "Open PRs", { approved: true })]) });
  screen.getByText(/Workspace access is off/u);
  assert.equal(screen.queryByRole("button", { name: /Review/u }), null);
});

test("delete asks first, then removes the page", async () => {
  const calls = installBotTestIpc({ "workspaces:artifacts:delete": () => ({ removed: true }) });
  renderPanel({ artifacts: state([view("art1", "Open PRs", { approved: true })]) });
  fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Open PRs" }), { button: 0, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/u }));
  const dialog = await screen.findByRole("alertdialog");
  within(dialog).getByText(/Delete “Open PRs”\?/u);
  assert.equal(calls.some((call) => call.channel === "workspaces:artifacts:delete"), false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "workspaces:artifacts:delete")));
  assert.deepEqual(calls.find((call) => call.channel === "workspaces:artifacts:delete")!.args, [WORKSPACE.id, "art1"]);
});

test("Ask Aiden to change this hands the page to the chat", async () => {
  installBotTestIpc();
  const asked: string[] = [];
  renderPanel({ artifacts: state([view("art1", "Open PRs", { approved: true })]), onAskAiden: (entry) => asked.push(entry.artifact.id) });
  fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Open PRs" }), { button: 0, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: /Ask Aiden/u }));
  assert.deepEqual(asked, ["art1"]);
});

test("a list from another workspace is never shown for this one", () => {
  installBotTestIpc();
  renderPanel({ artifacts: state([view("art1", "Open PRs", { approved: true })], { workspaceId: "ws-other" }) });
  screen.getByLabelText("Loading artifacts");
  assert.equal(screen.queryByText("Open PRs"), null);
});

test("the launcher offers Artifacts only once the workspace has one", () => {
  installBotTestIpc({ "settings:get": () => null });
  const client = createBotTestQueryClient();
  const launcher = (artifacts: boolean) => (
    <QueryClientProvider client={client}>
      <CommandSystemProvider>
        <WorkspaceToolLauncher hasWorkspace hasFolderAccess canOpenTerminal subagents={false} devices={false} artifacts={artifacts} busy={false} onOpen={() => undefined} onUrl={async () => undefined} onQuickView={() => undefined} />
      </CommandSystemProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(launcher(false));
  assert.equal(screen.queryByRole("button", { name: /Artifacts/u }), null);
  rerender(launcher(true));
  screen.getByRole("button", { name: /Artifacts/u });
});

function PanelProbe({ chatId }: { chatId: string }) {
  const panel = useEnvironmentPanel();
  React.useEffect(() => panel.setActiveChat(chatId, WORKSPACE.id), [chatId, panel.setActiveChat]);
  return (
    <output data-testid="probe">
      {JSON.stringify({ open: panel.toolsOpen, tab: panel.tab, tabs: panel.openTabs, selected: panel.selectedArtifactId })}
    </output>
  );
}

function probe() {
  return JSON.parse(screen.getByTestId("probe").textContent ?? "{}") as { open: boolean; tab: string; tabs: string[]; selected: string | null };
}

test("a page made in this chat opens beside it, and the tab goes away with the last page", async () => {
  let listed: WorkspaceArtifactView[] = [];
  installBotTestIpc({
    "workspaces:list": () => [WORKSPACE],
    "workspaces:artifacts:list": () => listed,
  });
  await act(async () => {
    render(
      <QueryClientProvider client={createBotTestQueryClient()}>
        <WorkspaceProvider>
          <WorkspaceTerminalProvider>
            <EnvironmentPanelProvider>
              <PanelProbe chatId="chat-1" />
            </EnvironmentPanelProvider>
          </WorkspaceTerminalProvider>
        </WorkspaceProvider>
      </QueryClientProvider>,
    );
  });
  await waitFor(() => assert.equal(probe().open, false));

  // Another chat's page only updates the list.
  listed = [view("art0", "Release", { approved: true })];
  await act(async () => emitBotTestNotification("workspaces:artifacts-changed", { workspaceId: WORKSPACE.id, artifactId: "art0", reason: "created", chatId: "chat-2" }));
  assert.equal(probe().open, false);

  listed = [...listed, view("art1", "Open PRs", { approved: true })];
  await act(async () => emitBotTestNotification("workspaces:artifacts-changed", { workspaceId: WORKSPACE.id, artifactId: "art1", reason: "created", chatId: "chat-1" }));
  await waitFor(() => assert.deepEqual({ open: probe().open, tab: probe().tab, selected: probe().selected }, { open: true, tab: "artifacts", selected: "art1" }));

  listed = [];
  await act(async () => emitBotTestNotification("workspaces:artifacts-changed", { workspaceId: WORKSPACE.id, artifactId: "art1", reason: "deleted" }));
  await waitFor(() => assert.equal(probe().tabs.includes("artifacts"), false));
  assert.notEqual(probe().tab, "artifacts");
});
