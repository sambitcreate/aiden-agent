import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { mountWithBotRouter } from "../main/bots/test-providers";
import type { AppSettings, Workspace } from "../lib/types";
import { WorkspaceProvider } from "../lib/workspace-context";
import { openWorkspaceSettings, WorkspaceSettingsDialog } from "./workspace-settings-dialog";

afterEach(cleanup);

const WORKSPACE: Workspace = {
  id: "w1",
  name: "Project",
  folderPath: "/work/project",
  permission: "ask",
  createdAt: 1,
  updatedAt: 1,
};

async function openGeneral(settings: Partial<AppSettings>, workspace: Partial<Workspace> = {}) {
  installBotTestIpc({
    "workspaces:list": () => [{ ...WORKSPACE, ...workspace }],
    "settings:get": () => settings,
  });
  const { router } = await mountWithBotRouter(
    <WorkspaceProvider>
      <WorkspaceSettingsDialog />
    </WorkspaceProvider>,
    { initialPath: "/" },
  );
  await act(async () => openWorkspaceSettings("w1"));
  const dialog = await screen.findByRole("dialog");
  return { dialog, router };
}

test("with memory on in Settings, a workspace's Memory switch can be changed", async () => {
  const { dialog } = await openGeneral({});
  const toggle = await within(dialog).findByRole("switch", { name: "Use memory in this workspace" });
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(toggle.hasAttribute("disabled"), false);
  assert.equal(within(dialog).queryByText(/Memory is off in Settings/u), null);
});

test("with memory off in Settings, the workspace's choice is kept but locked, and Settings is one click away", async () => {
  const { dialog, router } = await openGeneral({ memoryEnabled: false }, { memoryEnabled: false });
  const toggle = await within(dialog).findByRole("switch", { name: "Use memory in this workspace" });
  await waitFor(() => assert.equal(toggle.hasAttribute("disabled"), true));
  assert.equal(toggle.getAttribute("aria-checked"), "false", "the workspace's own choice still shows");
  within(dialog).getByText(/Memory is off in Settings\. This choice applies when it's back on\./u);

  fireEvent.click(within(dialog).getByRole("button", { name: "Open Memory settings" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/settings"));
  assert.deepEqual({ ...router.state.location.search }, { section: "memory" });
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
});
