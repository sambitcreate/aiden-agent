import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import { DEFAULT_BROWSER_SETTINGS, type BrowserCommand, type BrowserState } from "../shared/browser";
import { BrowserSettings } from "./browser-settings";

afterEach(cleanup);

const state: BrowserState = {
  workspaceId: "workspace",
  revision: 1,
  tabs: [],
  activeTabId: null,
  profiles: [{ id: "default", name: "Default", kind: "persistent" }],
  defaults: DEFAULT_BROWSER_SETTINGS,
  agentAccessOverride: "inherit",
  agentAccessAllowed: true,
  history: [],
  servers: [],
};

test("browser settings apply as they change, so the dialog offers one Done and no Cancel", async () => {
  const commands: BrowserCommand[] = [];
  const closes: boolean[] = [];
  render(
    <AppCapabilitiesProvider capabilities={DISABLED_APP_CAPABILITIES}>
      <BrowserSettings
        state={state}
        open
        onOpenChange={(open) => closes.push(open)}
        run={async (command) => {
          commands.push(command);
          return null;
        }}
      />
    </AppCapabilitiesProvider>,
  );
  const dialog = await screen.findByRole("dialog", { name: "Browser settings" });

  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Show the browser when Aiden uses it" }));
  assert.deepEqual(commands, [{ action: "defaults", defaults: { autoShow: false } }]);

  assert.equal(within(dialog).queryByRole("button", { name: "Cancel" }), null);
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => assert.deepEqual(closes, [false]));
  assert.equal(commands.length, 1, "closing sends nothing that would undo or repeat the change");
});
