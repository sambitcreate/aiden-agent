import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { PLUGIN_CATALOG, isConnectablePlugin } from "../../shared/plugin-catalog";
import type { McpPresetState, McpServer } from "../../lib/types";
import { Toaster } from "../ui";
import { useMcpPresets, useMcpServers } from "../../lib/queries";
import { McpSettings } from "./mcp-settings";
import { PresetSetupDialog } from "./mcp-preset-setup";
import { McpOAuthMetadataField, mcpOAuthMetadataFieldError } from "./mcp-oauth-metadata-field";
import { McpProviderAuthFields } from "./mcp-provider-auth-fields";

afterEach(cleanup);

/** Preset states derived from the shared catalog, the way main builds them. */
function catalogPresetStates(patch: Record<string, Partial<McpPresetState>> = {}): McpPresetState[] {
  return PLUGIN_CATALOG.filter(isConnectablePlugin).map((plugin) => ({
    preset: {
      id: plugin.id,
      name: plugin.name,
      tagline: plugin.tagline,
      vendor: plugin.vendor,
      category: plugin.category,
      transport: "http",
      url: plugin.url!,
      auth: plugin.auth!,
      docsUrl: plugin.docsUrl,
    },
    serverId: `preset-${plugin.id}`,
    configured: false,
    enabled: true,
    ready: false,
    ...patch[plugin.id],
  }));
}

const localServer: McpServer = {
  id: "mcp-files",
  name: "Files",
  transport: "stdio",
  enabled: true,
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/My Docs"],
};

function mount(handlers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls = installBotTestIpc({
    "mcp:list": () => [localServer],
    "mcp:presets": () => catalogPresetStates(),
    "mcp:liveStatus": () => [],
    "mcp:dependents": () => ({ schedules: [], bots: [] }),
    "providers:list": () => [],
    ...handlers,
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <McpSettings />
      <Toaster />
    </QueryClientProvider>,
  );
  return calls;
}

const savedServers = (calls: { channel: string; args: unknown[] }[]) =>
  calls.filter((call) => call.channel === "mcp:save").map((call) => call.args[0] as McpServer);

test("searching the plugin directory narrows the cards", async () => {
  mount();
  await screen.findByRole("button", { name: "Set Up Linear" });
  assert.ok(screen.getByRole("button", { name: "Set Up Notion" }));

  fireEvent.change(screen.getByRole("searchbox", { name: "Search plugins" }), {
    target: { value: "linear" },
  });

  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Set Up Notion" }), null));
  assert.ok(screen.getByRole("button", { name: "Set Up Linear" }));
  assert.ok(screen.getByText(/^\d+ plugins?$/u).textContent!.startsWith("1 "));
});

test("connectable cards offer setup while skills and apps only offer details", async () => {
  mount();
  const setUp = await screen.findByRole("button", { name: "Set Up Linear" });
  await waitFor(() => assert.equal((setUp as HTMLButtonElement).disabled, false));
  assert.equal(screen.queryByRole("button", { name: "Set Up Superpowers" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Details for Superpowers" }));
  const dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByText("Superpowers"));
});

test("configured rows name the server they act on", async () => {
  mount();
  assert.ok(await screen.findByRole("button", { name: "Edit Files" }));
  assert.ok(screen.getByRole("button", { name: "Remove Files" }));
  assert.ok(screen.getByRole("switch", { name: "Enable Files" }));
});

test("a failed toggle reports the error and blocks a second toggle while pending", async () => {
  let reject: (error: Error) => void = () => undefined;
  const calls = mount({
    "mcp:save": () => new Promise((_, fail) => { reject = fail; }),
  });
  const toggle = await screen.findByRole("switch", { name: "Enable Files" });
  fireEvent.click(toggle);
  await waitFor(() => assert.equal((toggle as HTMLButtonElement).disabled, true));
  fireEvent.click(toggle);
  assert.equal(savedServers(calls).length, 1);
  assert.equal(savedServers(calls)[0]?.enabled, false);

  reject(new Error("config is read-only"));
  assert.ok(await screen.findByText(/Couldn’t disable Files: config is read-only/u));
  await waitFor(() => assert.equal((toggle as HTMLButtonElement).disabled, false));
});

test("a failed save keeps the editor open with the error", async () => {
  mount({ "mcp:save": () => { throw new Error("disk full"); } });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Files" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  assert.ok(await within(dialog).findByRole("alert"));
  assert.match(within(dialog).getByRole("alert").textContent ?? "", /disk full/u);
  assert.ok(screen.getByRole("dialog"));
});

test("a failed removal keeps the confirmation open and lets the user retry", async () => {
  let attempts = 0;
  const calls = mount({
    "mcp:remove": () => {
      attempts += 1;
      if (attempts === 1) throw new Error("server busy");
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Remove Files" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  assert.match((await within(dialog).findByRole("alert")).textContent ?? "", /server busy/u);
  assert.ok(screen.getByRole("alertdialog"));

  fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() => assert.equal(dialog.isConnected, false));
  assert.deepEqual(
    calls.filter((call) => call.channel === "mcp:remove").map((call) => call.args[0]),
    ["mcp-files", "mcp-files"],
  );
});

test("a failed preset load shows Retry, and retrying restores the directory", async () => {
  let failing = true;
  mount({
    "mcp:presets": () => {
      if (failing) throw new Error("bad preset record");
      return catalogPresetStates();
    },
  });
  const retry = await screen.findByRole("button", { name: "Retry loading plugin connection details" });
  assert.match(screen.getByRole("alert").textContent ?? "", /bad preset record/u);
  assert.equal((screen.getByRole("button", { name: "Set Up Linear" }) as HTMLButtonElement).disabled, true);

  failing = false;
  fireEvent.click(retry);
  await waitFor(() =>
    assert.equal((screen.getByRole("button", { name: "Set Up Linear" }) as HTMLButtonElement).disabled, false),
  );
  assert.equal(screen.queryByRole("button", { name: /Retry loading/u }), null);
});

test("a preset whose saved record is invalid stays usable and explains the repair", async () => {
  mount({
    "mcp:list": () => [],
    "mcp:presets": () =>
      catalogPresetStates({ linear: { configured: true, error: "Linear has an invalid identity." } }),
  });
  assert.ok(await screen.findByText("Needs repair"));
  const manage = screen.getByRole("button", { name: "Manage Linear" });
  await waitFor(() => assert.equal((manage as HTMLButtonElement).disabled, false));
  fireEvent.click(manage);
  const dialog = await screen.findByRole("dialog");
  assert.match(within(dialog).getByRole("alert").textContent ?? "", /invalid identity/u);
});

test("preset setup refreshes server and preset lists for callers outside Settings", async () => {
  const composio = catalogPresetStates({ composio: { configured: true, ready: true } }).find(
    (state) => state.preset.id === "composio",
  )!;
  const server: McpServer = {
    id: composio.serverId,
    name: "Composio",
    transport: "http",
    url: composio.preset.url,
    presetId: "composio",
    enabled: true,
  };
  const calls = installBotTestIpc({
    "mcp:list": () => [server],
    "mcp:presets": () => [composio],
    "mcp:save": (saved: unknown) => saved,
    "mcp:status": () => ({ connected: true, toolCount: 3 }),
  });
  function ListReader() {
    useMcpServers();
    useMcpPresets();
    return null;
  }
  let open = true;
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ListReader />
      <PresetSetupDialog state={composio} server={server} open onOpenChange={(next) => { open = next; }} />
    </QueryClientProvider>,
  );
  const count = (channel: string) => calls.filter((call) => call.channel === channel).length;
  await waitFor(() => assert.equal(count("mcp:presets"), 1));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(open, false));
  assert.equal(count("mcp:list"), 2);
  assert.equal(count("mcp:presets"), 2);
});

test("arguments are edited one per line and keep embedded spaces", async () => {
  const calls = mount({ "mcp:save": (server: unknown) => server });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Files" }));
  const dialog = await screen.findByRole("dialog");
  const args = within(dialog).getByRole("textbox", { name: "Arguments" }) as HTMLTextAreaElement;
  assert.equal(args.value, "-y\n@modelcontextprotocol/server-filesystem\n/Users/me/My Docs");

  fireEvent.change(args, { target: { value: `${args.value}\n\n/Volumes/Shared Drive\n` } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  assert.deepEqual(savedServers(calls)[0]?.args, [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "/Users/me/My Docs",
    "/Volumes/Shared Drive",
  ]);
});

test("OAuth metadata field labels optional setup and exposes invalid addresses accessibly", () => {
  const renderField = (value: string) =>
    renderToStaticMarkup(<McpOAuthMetadataField value={value} onChange={() => undefined} />);
  const defaults = renderField("");
  assert.match(defaults, /aria-label="Authorization metadata URL"/u);
  assert.match(defaults, /placeholder="Automatic discovery"/u);
  assert.doesNotMatch(defaults, /role="alert"/u);
  assert.match(defaults, /requires signing in again/u);
  const invalid = renderField("http://remote.test/metadata");
  assert.match(invalid, /aria-invalid="true"/u);
  assert.match(invalid, /role="alert"/u);
  assert.equal(mcpOAuthMetadataFieldError("https://identity.test/.well-known/openid-configuration"), undefined);
  assert.equal(mcpOAuthMetadataFieldError(""), undefined);
  assert.ok(mcpOAuthMetadataFieldError("file:///tmp/metadata"));
});

test("provider credential consent identifies the exact endpoint and separates saving from approval", () => {
  const props = {
    providerId: "openai",
    endpoint: "https://tools.test/mcp?tenant=one",
    approved: false,
    busy: false,
    disabled: false,
    providers: [{ id: "openai", label: "OpenAI" }],
    onProviderChange() {},
    onConsent() {},
  };
  const html = renderToStaticMarkup(<McpProviderAuthFields {...props} />);
  assert.match(html, /https:\/\/tools.test\/mcp\?tenant=one/u);
  assert.match(html, /Allow provider credential/u);
  assert.match(html, /Saving the server does not grant access/u);
  assert.match(html, /each device needs your approval/u);
  assert.match(html, /Only attended desktop workspace chats/u);
  const approved = renderToStaticMarkup(<McpProviderAuthFields {...props} approved />);
  assert.match(approved, /Stop sharing credential/u);
  assert.match(approved, /Approved on this device/u);
});

const remoteServer: McpServer = {
  id: "mcp-remote",
  name: "Remote",
  transport: "http",
  url: "https://tools.test/mcp",
  oauth: true,
  enabled: true,
};

function linearState(patch: Partial<McpPresetState> = {}): McpPresetState {
  return catalogPresetStates({ linear: patch }).find((state) => state.preset.id === "linear")!;
}

function renderPreset(state: McpPresetState, server: McpServer | undefined, handlers: Record<string, (...args: unknown[]) => unknown>) {
  const calls = installBotTestIpc({
    "mcp:list": () => (server ? [server] : []),
    "mcp:presets": () => [state],
    ...handlers,
  });
  const openChanges: boolean[] = [];
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return (
      <PresetSetupDialog
        state={state}
        server={server}
        open={open}
        onOpenChange={(next) => {
          openChanges.push(next);
          setOpen(next);
        }}
      />
    );
  }
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <Harness />
      <Toaster />
    </QueryClientProvider>,
  );
  return { calls, openChanges };
}

const channelCalls = (calls: { channel: string; args: unknown[] }[], channel: string) =>
  calls.filter((call) => call.channel === channel);

test("configured rows show live status pushed from main, with tool and resource badges", async () => {
  mount({
    "mcp:liveStatus": () => [{ serverId: "mcp-files", state: "connected", toolCount: 5, resources: true }],
  });
  const status = await screen.findByLabelText("Files status");
  await waitFor(() => assert.match(status.textContent ?? "", /Connected/u));
  assert.match(status.textContent ?? "", /Tools 5/u);
  assert.match(status.textContent ?? "", /Resources/u);

  act(() => emitBotTestNotification("mcp:statusChanged", { serverId: "mcp-files", state: "failed", error: "spawn npx ENOENT" }));
  await waitFor(() => assert.match(status.textContent ?? "", /Couldn’t connect/u));
  assert.ok(screen.getByText("spawn npx ENOENT"));

  act(() => emitBotTestNotification("mcp:statusChanged", { serverId: "mcp-files", state: "closed", needsSignIn: true }));
  await waitFor(() => assert.match(status.textContent ?? "", /Needs sign-in/u));
});

test("removing a server names the schedules and Bots that rely on it", async () => {
  mount({
    "mcp:dependents": () => ({ schedules: [{ id: "t1", name: "Morning digest" }], bots: [{ id: "b1", name: "Planner" }] }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Remove Files" }));
  const dialog = await screen.findByRole("alertdialog");
  await waitFor(() => assert.match(within(dialog).getByRole("note").textContent ?? "", /“Morning digest”.*“Planner”.*use this server/su));
});

test("disabling a server with dependents asks first and only then saves it disabled", async () => {
  const calls = mount({
    "mcp:save": (server: unknown) => server,
    "mcp:dependents": () => ({ schedules: [{ id: "t1", name: "Morning digest" }], bots: [] }),
  });
  fireEvent.click(await screen.findByRole("switch", { name: "Enable Files" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.match(within(dialog).getByRole("note").textContent ?? "", /Scheduled task “Morning digest” uses this server/u);
  assert.equal(savedServers(calls).length, 0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  assert.equal(savedServers(calls)[0]?.enabled, false);
});

test("testing an edited server connects to the draft without saving it", async () => {
  const calls = mount({
    "mcp:testDraft": () => ({ connected: true, toolCount: 2, tools: ["a", "b"], serverCapabilities: {} }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Files" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Arguments" }), { target: { value: "--draft" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));
  await waitFor(() => assert.equal(channelCalls(calls, "mcp:testDraft").length, 1));
  assert.deepEqual((channelCalls(calls, "mcp:testDraft")[0]!.args[0] as McpServer).args, ["--draft"]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.equal(savedServers(calls).length, 0);
});

test("editing an existing server's connection warns that dependents need approval again", async () => {
  mount({ "mcp:dependents": () => ({ schedules: [], bots: [{ id: "b1", name: "Planner" }] }) });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Files" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "MCP server description" }), { target: { value: "notes" } });
  assert.equal(within(dialog).queryByText(/asks for their approval again/u), null);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Arguments" }), { target: { value: "--other" } });
  assert.ok(await within(dialog).findByText(/Bot “Planner” uses this server. Changing how Aiden connects/u));
});

test("signing in to an existing server never saves its other unsaved edits", async () => {
  const calls = mount({
    "mcp:list": () => [remoteServer],
    "mcp:oauthStatus": () => ({ authorized: false }),
    "mcp:authorize": () => ({ authorized: true }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Remote" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getAllByRole("textbox")[0]!, { target: { value: "Renamed but not saved" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Authorize" }));
  await waitFor(() => assert.equal(channelCalls(calls, "mcp:authorize").length, 1));
  assert.equal((channelCalls(calls, "mcp:authorize")[0]!.args[0] as McpServer).name, "Remote");
  assert.equal(savedServers(calls).length, 0);
  assert.ok(await within(dialog).findByRole("button", { name: "Sign out" }));
});

test("a waiting sign-in can be cancelled, and cancelling a new preset's setup removes it again", async () => {
  let rejectAuthorize: (error: Error) => void = () => undefined;
  const { calls, openChanges } = renderPreset(linearState(), undefined, {
    "mcp:save": (server: unknown) => server,
    "mcp:authorize": () => new Promise((_, reject) => { rejectAuthorize = reject; }),
    "mcp:cancelAuthorize": () => {
      rejectAuthorize(new Error("Sign-in was cancelled."));
      return { cancelled: true };
    },
    "mcp:remove": () => undefined,
  });
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Authorize" }));
  const cancel = await within(dialog).findByRole("button", { name: "Cancel sign-in" });
  assert.equal(savedServers(calls).length, 1);
  fireEvent.click(cancel);
  assert.ok(await within(dialog).findByRole("button", { name: "Authorize" }));
  assert.deepEqual(channelCalls(calls, "mcp:cancelAuthorize").map((call) => call.args[0]), ["preset-linear"]);
  assert.equal(screen.queryByText(/Sign-in was cancelled/u), null);

  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.deepEqual(channelCalls(calls, "mcp:remove").map((call) => call.args[0]), ["preset-linear"]));
  assert.deepEqual(openChanges, [false]);
});

test("a preset whose sign-in stopped working offers Sign in again and Sign out", async () => {
  const state = linearState({ configured: true, ready: false, needsSignIn: true });
  const server: McpServer = { id: state.serverId, name: "Linear", transport: "http", url: state.preset.url, oauth: true, presetId: "linear", enabled: true };
  const { calls } = renderPreset(state, server, { "mcp:signOut": () => ({ authorized: false }) });
  const dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByRole("button", { name: "Sign in again" }));
  assert.ok(within(dialog).getByText("Needs sign-in"));
  assert.equal(within(dialog).queryByText("Authorized"), null);
  fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
  await waitFor(() => assert.deepEqual(channelCalls(calls, "mcp:signOut").map((call) => call.args[0]), [state.serverId]));
  assert.ok(await within(dialog).findByRole("button", { name: "Authorize" }));
  assert.equal(savedServers(calls).length, 0);
});

test("closing a new preset's setup while its sign-in save is pending never authorizes and removes the record", async () => {
  let resolveSave: () => void = () => undefined;
  const { calls, openChanges } = renderPreset(linearState(), undefined, {
    "mcp:save": (server: unknown) => new Promise((resolve) => { resolveSave = () => resolve(server); }),
    "mcp:authorize": () => ({ authorized: true }),
    "mcp:cancelAuthorize": () => ({ cancelled: true }),
    "mcp:remove": () => undefined,
  });
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Authorize" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  assert.deepEqual(openChanges, [false]);

  await act(async () => resolveSave());
  await waitFor(() => assert.deepEqual(channelCalls(calls, "mcp:remove").map((call) => call.args[0]), ["preset-linear"]));
  assert.equal(channelCalls(calls, "mcp:authorize").length, 0);
});

test("closing a new custom server while its sign-in save is pending never authorizes and removes it", async () => {
  let resolveSave: () => void = () => undefined;
  const calls = mount({
    "mcp:save": (server: unknown) => new Promise((resolve) => { resolveSave = () => resolve(server); }),
    "mcp:authorize": () => ({ authorized: true }),
    "mcp:cancelAuthorize": () => ({ cancelled: true }),
    "mcp:remove": () => undefined,
  });
  fireEvent.click(await screen.findByRole("button", { name: /Add custom MCP/u }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: "Remote URL (Streamable HTTP)" }));
  fireEvent.change(await within(dialog).findByRole("textbox", { name: "Server URL" }), { target: { value: "https://tools.test/mcp" } });
  fireEvent.click(within(within(dialog).getByRole("group", { name: "OAuth sign-in" })).getByRole("switch"));
  fireEvent.click(await within(dialog).findByRole("button", { name: "Authorize" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  const id = savedServers(calls)[0]!.id;
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));

  await act(async () => resolveSave());
  await waitFor(() => assert.deepEqual(channelCalls(calls, "mcp:remove").map((call) => call.args[0]), [id]));
  assert.equal(channelCalls(calls, "mcp:authorize").length, 0);
});

test("a header-only edit is saved before sign-in and warns dependents", async () => {
  const saved: McpServer = { ...remoteServer, headers: { "X-Tenant": "old" } };
  const calls = mount({
    "mcp:list": () => [saved],
    "mcp:oauthStatus": () => ({ authorized: false }),
    "mcp:save": (server: unknown) => server,
    "mcp:authorize": () => ({ authorized: true }),
    "mcp:dependents": () => ({ schedules: [], bots: [{ id: "b1", name: "Planner" }] }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Remote" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByDisplayValue("X-Tenant=old"), { target: { value: "X-Tenant=new" } });
  assert.ok(await within(dialog).findByText(/Bot “Planner” uses this server. Changing how Aiden connects/u));

  fireEvent.click(within(dialog).getByRole("button", { name: "Authorize" }));
  await waitFor(() => assert.equal(channelCalls(calls, "mcp:authorize").length, 1));
  assert.deepEqual(savedServers(calls).map((server) => server.headers), [{ "X-Tenant": "new" }]);
  const order = calls.map((call) => call.channel).filter((channel) => channel === "mcp:save" || channel === "mcp:authorize");
  assert.deepEqual(order, ["mcp:save", "mcp:authorize"]);
});

test("returning to Plugins shows status that changed while it was closed", async () => {
  let snapshot: unknown[] = [{ serverId: "mcp-files", state: "connected", toolCount: 5 }];
  const calls = installBotTestIpc({
    "mcp:list": () => [localServer],
    "mcp:presets": () => catalogPresetStates(),
    "mcp:liveStatus": () => snapshot,
    "mcp:dependents": () => ({ schedules: [], bots: [] }),
    "providers:list": () => [],
  });
  const client = createBotTestQueryClient();
  const view = () => (
    <QueryClientProvider client={client}>
      <McpSettings />
    </QueryClientProvider>
  );
  const first = render(view());
  await waitFor(() => assert.match(screen.getByLabelText("Files status").textContent ?? "", /Connected/u));
  first.unmount();

  // Main's status changes while Plugins is closed; its push reaches no one.
  snapshot = [{ serverId: "mcp-files", state: "failed", error: "token revoked" }];
  act(() => emitBotTestNotification("mcp:statusChanged", snapshot[0]));

  render(view());
  await waitFor(() => assert.match(screen.getByLabelText("Files status").textContent ?? "", /Couldn’t connect/u));
  assert.equal(channelCalls(calls, "mcp:liveStatus").length, 2);
});
