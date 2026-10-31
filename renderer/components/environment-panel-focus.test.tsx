import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import { EnvironmentPanelProvider, useEnvironmentPanel, type EnvironmentPanelContextValue } from "./environment-panel";
import { WorkspaceTerminalProvider } from "./terminal-drawer";
import { WorkspaceProvider } from "../lib/workspace-context";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const CAPABILITIES = { ...DISABLED_APP_CAPABILITIES, subagents: true };

function Probe({ onPanel }: { onPanel: (panel: EnvironmentPanelContextValue) => void }) {
  const panel = useEnvironmentPanel();
  onPanel(panel);
  return (
    <>
      <textarea aria-label="Composer" />
      <button type="button">Run chip</button>
      {/* Stands in for the open Subagents tool, so a close starts from focus inside it. */}
      {panel.toolsOpen ? (
        <div data-environment-surface="tools">
          <button type="button">Close Subagents</button>
        </div>
      ) : null}
    </>
  );
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

test("closing a subagent opened from a run chip puts focus back on that chip", async () => {
  installBotTestIpc({ "workspaces:list": () => [], "browser:link-preference": () => "ask" });
  let panel!: EnvironmentPanelContextValue;
  await act(async () => {
    render(
      <QueryClientProvider client={createBotTestQueryClient()}>
        <AppCapabilitiesProvider capabilities={CAPABILITIES}>
          <WorkspaceProvider>
            <WorkspaceTerminalProvider>
              <EnvironmentPanelProvider>
                <Probe onPanel={(value) => (panel = value)} />
              </EnvironmentPanelProvider>
            </WorkspaceTerminalProvider>
          </WorkspaceProvider>
        </AppCapabilitiesProvider>
      </QueryClientProvider>,
    );
  });
  const chip = screen.getByRole("button", { name: "Run chip" });
  // The person was typing; the chip handed itself over as the place to come back to.
  screen.getByRole("textbox", { name: "Composer" }).focus();
  await act(async () => panel.openSubagent("run-1", chip));
  await waitFor(() => assert.equal(panel.toolsOpen, true));
  assert.equal(panel.tab, "subagents");

  screen.getByRole("button", { name: "Close Subagents" }).focus();
  await act(async () => {
    panel.closeTools();
    await nextFrame();
  });
  assert.equal(document.activeElement === chip, true);
});
