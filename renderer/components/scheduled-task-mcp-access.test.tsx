import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../main/bots/test-dom";
import { createBotTestQueryClient, mountWithBotRouter } from "../main/bots/test-providers";
import { WorkspaceProvider } from "../lib/workspace-context";
import type {
  McpServer,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskSettings,
  Workspace,
} from "../lib/types";
import { ScheduledTaskEditor } from "./scheduled-task-editor";
import { ScheduledTasksView } from "./scheduled-tasks-view";
import { ScheduledTasksSettings } from "./settings/scheduled-tasks-settings";

afterEach(cleanup);

const server = (id: string, name: string, enabled = true): McpServer => ({
  id, name, enabled, transport: "http", url: `https://${id}.example/mcp`,
});

const mail = server("mail", "Mail");
const linear = server("linear", "Linear");
const archived = server("archived", "Archived CRM", false);
const workspace = { id: "ws-1", name: "Repo", path: "/tmp/repo" } as unknown as Workspace;

const baseTask: ScheduledTaskInput = {
  name: "Inbox brief",
  enabled: true,
  mode: "llm",
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  prompt: "Summarize unread mail.",
  permission: "read-only",
  mcpServerIds: [],
  webSearchEnabled: false,
  notify: true,
};

function mountEditor(
  initial: Partial<ScheduledTaskInput> = {},
  props: Partial<React.ComponentProps<typeof ScheduledTaskEditor>> = {},
) {
  installBotTestIpc({ "schedule:preview": () => [1_900_000_000_000] });
  const saved: ScheduledTaskInput[] = [];
  const onSave = props.onSave ?? (async (task: ScheduledTaskInput) => { saved.push(task); });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ScheduledTaskEditor
        open
        initial={{ ...baseTask, ...initial }}
        workspaces={[workspace]}
        mcpServers={[mail, linear, archived]}
        providers={[]}
        busy={false}
        onOpenChange={() => undefined}
        {...props}
        onSave={onSave}
      />
    </QueryClientProvider>,
  );
  return saved;
}

const confirm = (name: RegExp | string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const mcpSwitch = (name: string) => screen.getByRole("switch", { name }) as HTMLButtonElement;

async function reviewAndSave() {
  await waitFor(() => assert.equal(confirm("Review task").disabled, false));
  fireEvent.click(confirm("Review task"));
  await screen.findByText("Review your task");
  fireEvent.click(confirm(/^(Save|Create) task$/u));
}

test("a removed MCP server stays visible by id and blocks saving until it is deselected", async () => {
  mountEditor({ permission: "full", mcpServerIds: ["mail", "gone-server"] });

  assert.ok(screen.getByText("Unavailable connector (gone-server)"));
  assert.ok(screen.getAllByText("Disabled or removed").length >= 1);
  assert.equal(confirm("Review task").disabled, true);

  // A selected unavailable server can still be removed, which unblocks the task.
  const remove = mcpSwitch("Remove Unavailable connector (gone-server) for this scheduled task");
  assert.equal(remove.disabled, false);
  fireEvent.click(remove);
  await waitFor(() => assert.equal(confirm("Review task").disabled, false));
  assert.equal(screen.queryByText("Unavailable connector (gone-server)"), null);
});

test("a disabled MCP server is listed only while selected and cannot be newly allowed", async () => {
  mountEditor({ permission: "full", mcpServerIds: ["archived"] });
  assert.ok(screen.getByText("Archived CRM"));
  assert.ok(screen.getByText("Disabled or removed"));
  assert.equal(confirm("Review task").disabled, true);

  fireEvent.click(mcpSwitch("Remove Archived CRM for this scheduled task"));
  await waitFor(() => assert.equal(confirm("Review task").disabled, false));
  // Unselected, a disabled server can only be re-enabled from Settings.
  const allow = screen.queryByRole("switch", { name: "Allow Archived CRM for this scheduled task" });
  assert.ok(allow === null || (allow as HTMLButtonElement).disabled);
  cleanup();

  mountEditor();
  assert.equal(screen.queryByText("Archived CRM"), null);
});

test("allowing an MCP server grants Full permission, drops the workspace and saves the exact ids", async () => {
  const saved = mountEditor({ permission: "read-only", workspaceId: undefined });
  fireEvent.click(mcpSwitch("Allow Mail for this scheduled task"));
  assert.ok(await screen.findByText(/may call 1 selected connector unattended\. Connector tools may read or change external data\./u));

  await reviewAndSave();
  await waitFor(() => assert.equal(saved.length, 1));
  assert.equal(saved[0]!.permission, "full");
  assert.deepEqual(saved[0]!.mcpServerIds, ["mail"]);
  assert.equal(saved[0]!.workspaceId, undefined);
});

test("a workspace and MCP servers together, or more than 16 servers, cannot be saved", async () => {
  mountEditor({ permission: "full", workspaceId: workspace.id, mcpServerIds: ["mail"] });
  assert.ok(screen.getByText(/Choose either a workspace or connectors/u));
  assert.equal(confirm("Review task").disabled, true);
  cleanup();

  const many = Array.from({ length: 17 }, (_, index) => server(`s${index}`, `Server ${index}`));
  mountEditor({ permission: "full", mcpServerIds: many.map((entry) => entry.id) }, { mcpServers: many });
  assert.ok(screen.getByText(/Choose at most 16 connectors/u));
  assert.equal(confirm("Review task").disabled, true);
});

test("selected servers cannot be saved while the MCP inventory failed to load", () => {
  mountEditor({ permission: "full", mcpServerIds: ["mail"] }, { mcpServersUnavailable: true });
  assert.ok(screen.getByText(/Connectors could not be loaded/u));
  assert.equal(confirm("Review task").disabled, true);
});

test("an Assistant-owned task locks its execution scope but can still be saved unchanged", async () => {
  const saved = mountEditor(
    { id: "task-1", permission: "full", mcpServerIds: ["mail"], webSearchEnabled: true },
    { assistantOwned: true },
  );
  assert.ok(screen.getByText("Ask Aiden · locked by the approved automation"));
  assert.equal(screen.queryByRole("button", { name: "Run script" }), null);
  assert.equal(mcpSwitch("Remove Mail for this scheduled task").disabled, true);
  assert.equal(mcpSwitch("Allow Linear for this scheduled task").disabled, true);
  assert.equal(mcpSwitch("Allow Web Search for this scheduled task").disabled, true);
  assert.ok(screen.getByText(/complete final scope can be confirmed again/u));

  await reviewAndSave();
  await waitFor(() => assert.equal(saved.length, 1));
  assert.deepEqual(saved[0]!.mcpServerIds, ["mail"]);
  assert.equal(saved[0]!.webSearchEnabled, true);
});

test("Web Search authority is explicit and saved with the task", async () => {
  const saved = mountEditor();
  const webSearch = mcpSwitch("Allow Web Search for this scheduled task");
  assert.equal(webSearch.getAttribute("aria-checked"), "false");
  fireEvent.click(webSearch);
  await reviewAndSave();
  await waitFor(() => assert.equal(saved.length, 1));
  assert.equal(saved[0]!.webSearchEnabled, true);
});

test("saving goes through a review step and keeps choices when the save fails", async () => {
  let attempts = 0;
  mountEditor({ permission: "full" }, {
    onSave: async () => { attempts++; throw new Error("The scheduler is busy."); },
  });
  assert.ok(screen.getByRole("combobox", { name: "Scheduled task frequency" }));
  assert.ok(screen.getByText("Advanced schedule"));

  await waitFor(() => assert.equal(confirm("Review task").disabled, false));
  fireEvent.click(confirm("Review task"));
  assert.ok(await screen.findByText("Review your task"));
  assert.ok(screen.getByText(/Runs without asking you each time/u));
  assert.equal(attempts, 0, "the first confirm only opens the review");

  fireEvent.click(confirm("Create task"));
  assert.equal((await screen.findByRole("alert")).textContent, "The scheduler is busy.");
  assert.equal(attempts, 1);

  fireEvent.click(screen.getByRole("button", { name: "Edit choices" }));
  assert.equal((screen.getByDisplayValue("Inbox brief") as HTMLInputElement).value, "Inbox brief");
});

// ---- Scheduled view and settings ----

const NOW = 1_800_000_000_000;
const storedTask = (patch: Partial<ScheduledTask>): ScheduledTask => ({
  id: "task-1", name: "Legacy brief", enabled: true, mode: "llm", cron: "0 9 * * 1-5",
  timezone: "UTC", prompt: "Brief me.", permission: "full", notify: true,
  createdAt: NOW, updatedAt: NOW, ...patch,
});
const scheduledSettings: ScheduledTaskSettings = {
  enabled: true, defaultMode: "llm", defaultPermission: "full", defaultMcpEnabled: true,
  defaultNotify: true, defaultTimezone: "UTC",
};

/** The detail panel's Edit button (the task row's menu has its own). */
function lastEditButton(): HTMLButtonElement {
  const buttons = screen.getAllByRole("button", { name: "Edit" });
  return buttons[buttons.length - 1] as HTMLButtonElement;
}

async function mountView(tasks: ScheduledTask[], mcpList: () => unknown) {
  const calls = installBotTestIpc({
    "schedule:list": () => tasks,
    "schedule:settings": () => scheduledSettings,
    "schedule:preview": () => [NOW + 60_000],
    "schedule:runs": () => [],
    "settings:get": () => ({}),
    "providers:list": () => [],
    "workspaces:list": () => [],
    "mcp:list": mcpList,
  });
  await mountWithBotRouter(<WorkspaceProvider><ScheduledTasksView /></WorkspaceProvider>, { initialPath: "/" });
  return calls;
}

test("a legacy task inherits every enabled server when edited, and says so in its details", async () => {
  const calls = await mountView([storedTask({ mcpServerIds: undefined })], () => [mail, archived]);
  fireEvent.click(await screen.findByRole("button", { name: /Legacy brief/u, pressed: false }));
  assert.ok(await screen.findByText(/All enabled connectors \(legacy\)/u));

  const edit = lastEditButton();
  await waitFor(() => assert.equal(edit.disabled, false));
  fireEvent.click(edit);
  // Only the enabled server is carried into the explicit selection.
  assert.equal(mcpSwitch("Remove Mail for this scheduled task").getAttribute("aria-checked"), "true");
  assert.equal(screen.queryByText("Archived CRM"), null);
  await reviewAndSave();
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "schedule:save")));
  const saved = calls.find((call) => call.channel === "schedule:save")!.args[0] as ScheduledTaskInput;
  assert.deepEqual(saved.mcpServerIds, ["mail"]);
});

test("a legacy task cannot be edited while MCP access failed to load", async () => {
  await mountView([storedTask({ mcpServerIds: undefined })], () => { throw new Error("offline"); });
  fireEvent.click(await screen.findByRole("button", { name: /Legacy brief/u, pressed: false }));
  assert.ok(await screen.findByText(/editing is unavailable until access details load/u));
  const edit = lastEditButton();
  assert.equal(edit.disabled, true);
});

test("Scheduled settings turn on default MCP access together with Full permission", async () => {
  const calls = installBotTestIpc({
    "schedule:list": () => [],
    "schedule:settings": (patch?: unknown) =>
      patch ? { ...scheduledSettings, defaultPermission: "read-only", defaultMcpEnabled: false, ...(patch as object) }
        : { ...scheduledSettings, defaultPermission: "read-only", defaultMcpEnabled: false },
    "mcp:list": () => [mail],
  });
  await mountWithBotRouter(<ScheduledTasksSettings />, { initialPath: "/settings" });
  const toggle = await screen.findByRole("switch", { name: "Enable connector access for new scheduled tasks" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(toggle.disabled, false));
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  const patches = calls.filter((call) => call.channel === "schedule:settings" && call.args[0]);
  const patch = patches[patches.length - 1]!.args[0];
  assert.deepEqual(patch, { defaultMcpEnabled: true, defaultPermission: "full" });
});
