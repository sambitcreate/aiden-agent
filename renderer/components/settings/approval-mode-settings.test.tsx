// Settings → Approvals and Workspace settings → Approvals, rendered (plan §3.1):
// one mode, Auto only with a usable model, a one-time note for upgraded
// installs, the legacy routines switch only for someone who had it on, Bot
// messaging for every Bot under Advanced, and a workspace that follows the
// global mode until the person customizes it.

import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import type { AppSettings, Provider, Workspace } from "../../lib/types";
import { TooltipProvider } from "../ui";
import { WorkspaceApprovalFields } from "../workspace-settings-dialog";
import * as React from "react";
import { ApprovalModeSettings, ApprovalsContentSettledContext } from "./approval-mode-settings";
import { SettingsAnchorContext } from "./settings-page";

afterEach(cleanup);

const MODEL: Provider = {
  id: "openai",
  kind: "openai",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  models: ["gpt-5"],
  needsKey: true,
  hasKey: true,
} as Provider;

function mount(
  settings: Partial<AppSettings>,
  providers: Provider[] = [MODEL],
  options: { failSave?: boolean; anchor?: "bots"; children?: React.ReactNode } = {},
) {
  let current: Partial<AppSettings> = { ...settings };
  const calls = installBotTestIpc({
    "settings:get": () => current,
    "settings:set": (patch: unknown) => {
      if (options.failSave) throw new Error("disk full");
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return current;
    },
    "providers:list": () => providers,
  });
  render(
    <TooltipProvider>
      <QueryClientProvider client={createBotTestQueryClient()}>
        <SettingsAnchorContext.Provider value={options.anchor ? { section: options.anchor, request: 1 } : null}>
          <ApprovalModeSettings>{options.children}</ApprovalModeSettings>
        </SettingsAnchorContext.Provider>
      </QueryClientProvider>
    </TooltipProvider>,
  );
  const saves = () => calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]);
  return { saves, current: () => current };
}

const modeGroup = () => screen.findByRole("radiogroup", { name: "Approval mode" });
const checked = (group: HTMLElement) =>
  within(group).getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true")?.getAttribute("aria-label");

test("a fresh install with a usable model is on Auto, and choosing Ask saves it", async () => {
  const { saves } = mount({ approvalModeOrigin: "fresh" });
  const group = await modeGroup();
  await waitFor(() => assert.equal(checked(group), "Auto"));
  assert.deepEqual(within(group).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label")), ["Auto", "Ask", "Never ask"]);
  screen.getByText("A model approves routine actions and asks you about the rest.");
  fireEvent.click(within(group).getByRole("radio", { name: "Ask" }));
  await waitFor(() => assert.deepEqual(saves(), [{ approvalMode: "ask" }]));
  await waitFor(() => assert.equal(checked(group), "Ask"));
});

test("the Approval model setting says the actions it reviews are sent to that model", async () => {
  mount({ approvalModeOrigin: "fresh" });
  await modeGroup();
  screen.getByText(/Each action it reviews is sent to this model, with typed text, passwords and card details left out\./u);
});

test("with no usable model Auto is hidden and the mode reads Ask", async () => {
  mount({ approvalMode: "auto" }, [{ ...MODEL, hasKey: false }]);
  const group = await modeGroup();
  await waitFor(() => assert.deepEqual(within(group).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label")), ["Ask", "Never ask"]));
  assert.equal(checked(group), "Ask");
  await screen.findByText("Auto appears once a model is connected in Providers.");
});

test("a failed save puts the mode back", async () => {
  mount({ approvalMode: "ask" }, [MODEL], { failSave: true });
  const group = await modeGroup();
  await waitFor(() => assert.equal(checked(group), "Ask"));
  fireEvent.click(within(group).getByRole("radio", { name: "Never ask" }));
  await waitFor(() => assert.equal(checked(group), "Ask"));
});

test("an upgraded install sees What changed once; Got it hides it for good", async () => {
  const { saves } = mount({ approvalMode: "ask", approvalModeOrigin: "upgrade" });
  const note = await screen.findByRole("note", { name: "What changed" });
  within(note).getByText(/You're on Ask, so Aiden asks as before/u);
  fireEvent.click(within(note).getByRole("button", { name: "Got it" }));
  await waitFor(() => assert.deepEqual(saves(), [{ approvalChangesSeen: true }]));
  await waitFor(() => assert.equal(screen.queryByRole("note", { name: "What changed" }), null));
  cleanup();
  mount({ approvalModeOrigin: "fresh" });
  await modeGroup();
  assert.equal(screen.queryByRole("note", { name: "What changed" }), null);
});

test("the routines switch appears only for someone who had it on, and only turns off", async () => {
  mount({ approvalMode: "ask" });
  await modeGroup();
  assert.equal(screen.queryByRole("switch", { name: "Let routines go ahead without asking" }), null);
  cleanup();
  const { saves } = mount({ approvalMode: "ask", botRoutinesGoAhead: true });
  const toggle = await screen.findByRole("switch", { name: "Let routines go ahead without asking" });
  fireEvent.click(toggle);
  await waitFor(() => assert.deepEqual(saves(), [{ botRoutinesGoAhead: false }]));
  await waitFor(() => assert.equal(screen.queryByRole("switch", { name: "Let routines go ahead without asking" }), null));
});

test("Bot messaging is one switch under Advanced: on unless turned off, and it saves botMessaging", async () => {
  const { saves } = mount({ approvalMode: "ask" });
  const toggle = await screen.findByRole("switch", { name: "Bot messaging" });
  await waitFor(() => assert.equal(toggle.hasAttribute("disabled"), false));
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  fireEvent.click(toggle);
  await waitFor(() => assert.deepEqual(saves(), [{ botMessaging: false }]));
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "false"));
  cleanup();
  mount({ approvalMode: "ask", botMessaging: false });
  const off = await screen.findByRole("switch", { name: "Bot messaging" });
  await waitFor(() => assert.equal(off.getAttribute("aria-checked"), "false"));
});

test("a failed Bot messaging save puts the switch back", async () => {
  const { saves } = mount({ approvalMode: "ask" }, [MODEL], { failSave: true });
  const toggle = await screen.findByRole("switch", { name: "Bot messaging" });
  await waitFor(() => assert.equal(toggle.hasAttribute("disabled"), false));
  fireEvent.click(toggle);
  await waitFor(() => assert.deepEqual(saves(), [{ botMessaging: false }]));
  await waitFor(() => assert.equal(toggle.hasAttribute("disabled"), false));
  assert.equal(toggle.getAttribute("aria-checked"), "true");
});

test("opening Settings at Bot messaging scrolls its switch into view", async () => {
  const scrolled: Element[] = [];
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this);
  };
  try {
    mount({ approvalMode: "ask" }, [MODEL], { anchor: "bots" });
    const toggle = await screen.findByRole("switch", { name: "Bot messaging" });
    await waitFor(() => assert.equal(scrolled.length, 1));
    assert.ok(scrolled[0]!.contains(toggle));
    cleanup();
    scrolled.length = 0;
    mount({ approvalMode: "ask" });
    await screen.findByRole("switch", { name: "Bot messaging" });
    assert.equal(scrolled.length, 0);
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});

test("a jump to Bot messaging waits for the rules list above it to load before scrolling", async () => {
  const scrolled: Element[] = [];
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this);
  };
  let finishLoading: () => void = () => undefined;
  function SlowRules() {
    const settled = React.useContext(ApprovalsContentSettledContext);
    const [rows, setRows] = React.useState<string[] | null>(null);
    finishLoading = () => setRows(["Always allow · web_fetch", "Blocked · send_email"]);
    React.useEffect(() => {
      if (rows) settled?.();
    }, [rows, settled]);
    return rows ? <ul>{rows.map((row) => <li key={row}>{row}</li>)}</ul> : <p>Loading rules</p>;
  }
  try {
    mount({ approvalMode: "ask" }, [MODEL], { anchor: "bots", children: <SlowRules /> });
    const toggle = await screen.findByRole("switch", { name: "Bot messaging" });
    await waitFor(() => assert.equal(toggle.hasAttribute("disabled"), false));
    assert.equal(scrolled.length, 0, "the row would move once the rules load");
    React.act(() => finishLoading());
    await screen.findByText("Blocked · send_email");
    await waitFor(() => assert.equal(scrolled.length, 1));
    assert.ok(scrolled[0]!.contains(toggle));
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});

function mountWorkspace(workspace: Workspace, settings: Partial<AppSettings>) {
  const patches: unknown[] = [];
  installBotTestIpc({ "settings:get": () => settings, "providers:list": () => [MODEL] });
  render(
    <TooltipProvider>
      <QueryClientProvider client={createBotTestQueryClient()}>
        <WorkspaceApprovalFields workspace={workspace} onPatch={(patch) => void patches.push(patch)} />
      </QueryClientProvider>
    </TooltipProvider>,
  );
  return patches;
}

const workspace = (fields: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  name: "Project",
  folderPath: "/work/project",
  permission: "ask",
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

test("a workspace follows the global mode until customized", async () => {
  mountWorkspace(workspace(), { approvalMode: "never" });
  await screen.findByText(/^Follows Settings → Approvals\. Asks only before purchases/u);
  assert.match(screen.getByRole("combobox", { name: "Approvals in this workspace" }).textContent ?? "", /Use Settings \(Never ask\)/u);
});

test("a Full workspace reads as Never ask with commands and file changes allowed, each removable", async () => {
  const patches = mountWorkspace(workspace({ permission: "full" }), { approvalMode: "ask" });
  await waitFor(() =>
    assert.match(screen.getByRole("combobox", { name: "Approvals in this workspace" }).textContent ?? "", /^Never ask$/u),
  );
  screen.getByText("Run commands");
  screen.getByText("Change files");
  fireEvent.click(screen.getByRole("button", { name: "Remove: Change files" }));
  assert.deepEqual(patches, [{ revokeMacGrant: "files" }]);
});
