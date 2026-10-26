import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import type { McpPresetState, McpServer, Provider } from "../../lib/types";
import { Toaster } from "../ui";
import { useMcpPresets, useMcpServers } from "../../lib/queries";
import { McpSettings } from "./mcp-settings";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../../lib/app-capabilities";
import { PresetSetupDialog } from "./mcp-preset-setup";
import { McpOAuthMetadataField, mcpOAuthMetadataFieldError } from "./mcp-oauth-metadata-field";
import { ProviderConnectorKeySharing } from "./provider-connector-key-sharing";
import { McpProviderAuthFields, mcpShareableProviders } from "./mcp-provider-auth-fields";
import { buildMcpPresetStates } from "../../../main/handlers/mcp-preset-states";
import { parseMcpServer } from "../../../main/handlers/phase2-parse";
import { mcpToolsOfferedToModel } from "../../shared/mcp-exposure";
import {
  MCP_PRESETS,
  assertMcpPresetServer,
  presetServerId,
  serverFromPreset,
} from "../../../main/services/mcp-presets";

afterEach(cleanup);

/** Preset states for the whole catalog, the way main builds them. */
function catalogPresetStates(patch: Record<string, Partial<McpPresetState>> = {}): McpPresetState[] {
  return MCP_PRESETS.map((preset) => ({
    preset,
    serverId: presetServerId(preset.id),
    configured: false,
    enabled: true,
    ready: false,
    ...patch[preset.id],
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

function mount(handlers: Record<string, (...args: unknown[]) => unknown> = {}, { onMac = false } = {}) {
  const calls = installBotTestIpc({
    "mcp:list": () => [localServer],
    "mcp:presets": () => catalogPresetStates(),
    "mcp:liveStatus": () => [],
    "mcp:dependents": () => ({ schedules: [], bots: [] }),
    "mcp:launchApprovals": () => [],
    "providers:list": () => [],
    ...handlers,
  });
  const capabilities = onMac
    ? { ...DISABLED_APP_CAPABILITIES, platform: "darwin" as const, macAppConnectors: true }
    : DISABLED_APP_CAPABILITIES;
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <AppCapabilitiesProvider capabilities={capabilities}>
        <McpSettings />
        <Toaster />
      </AppCapabilitiesProvider>
    </QueryClientProvider>,
  );
  return calls;
}

const savedServers = (calls: { channel: string; args: unknown[] }[]) =>
  calls.filter((call) => call.channel === "mcp:save").map((call) => call.args[0] as McpServer);

test("searching the directory narrows the cards", async () => {
  mount();
  await screen.findByRole("button", { name: "Set Up Linear" });
  assert.ok(screen.getByRole("button", { name: "Set Up Notion" }));

  fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), {
    target: { value: "linear" },
  });

  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Set Up Notion" }), null));
  assert.ok(screen.getByRole("button", { name: "Set Up Linear" }));
  assert.ok(screen.getByText(/^\d+ connectors?$/u).textContent!.startsWith("1 "));
});

test("searching for an app Composio reaches shows the Composio card with its hint", async () => {
  mount();
  await screen.findByRole("button", { name: "Set Up Linear" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), { target: { value: "gmail" } });
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Set Up Linear" }), null));
  assert.ok(screen.getByRole("button", { name: "Set Up Composio" }));
  assert.ok(screen.getByText("Gmail, Slack and 500+ apps through Composio"));
});

test("hosted Figma explains why it can't be set up and leads to Figma Desktop", async () => {
  mount();
  await screen.findByRole("button", { name: "Set Up Linear" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), { target: { value: "hosted server" } });
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Set Up Linear" }), null));
  assert.equal(screen.queryByRole("button", { name: "Set Up Figma" }), null);
  assert.ok(screen.getByText(/Figma only lets approved apps connect to its hosted server/u));

  fireEvent.click(screen.getByRole("button", { name: "Use Figma Desktop instead of Figma" }));
  // The search clears so the Figma Desktop card is shown, and its action takes focus.
  await screen.findByRole("button", { name: "Set Up Figma Desktop" });
  assert.equal((screen.getByRole("searchbox", { name: "Search connectors" }) as HTMLInputElement).value, "");
  // Focus lands on the Figma Desktop card itself, which can take focus even before its button is enabled.
  await waitFor(() => assert.equal(document.activeElement, screen.getByRole("group", { name: "Figma Desktop" })));
});

test("a connector card turns green only once its live connection succeeds", async () => {
  const notion = serverFromPreset(MCP_PRESETS.find((preset) => preset.id === "notion")!);
  mount({
    "mcp:list": () => [notion],
    "mcp:presets": () => catalogPresetStates({ notion: { configured: true, ready: true } }),
    "mcp:liveStatus": () => [{ serverId: notion.id, state: "failed", error: "HTTP 500" }],
  });
  const card = () => document.getElementById("connector-card-notion")!;
  await waitFor(() => assert.match(card().textContent ?? "", /Couldn’t connect/u));
  assert.doesNotMatch(card().textContent ?? "", /Connected/u);
  act(() => emitBotTestNotification("mcp:statusChanged", { serverId: notion.id, state: "connected", toolCount: 4 }));
  await waitFor(() => assert.match(card().textContent ?? "", /Connected/u));
});

test("Reset connections lives in the page's overflow menu", async () => {
  const calls = mount({ "mcp:reconnect": () => undefined });
  await screen.findByRole("button", { name: "Set Up Linear" });
  assert.equal(screen.queryByRole("button", { name: "Reset connections" }), null);
  const more = screen.getByRole("button", { name: "More connector actions" });
  fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Reset connections" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "mcp:reconnect").length, 1));
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
  const retry = await screen.findByRole("button", { name: "Retry loading connector details" });
  assert.match(screen.getByRole("alert").textContent ?? "", /bad preset record/u);
  assert.equal((screen.getByRole("button", { name: "Set Up Linear" }) as HTMLButtonElement).disabled, true);

  failing = false;
  fireEvent.click(retry);
  await waitFor(() =>
    assert.equal((screen.getByRole("button", { name: "Set Up Linear" }) as HTMLButtonElement).disabled, false),
  );
  assert.equal(screen.queryByRole("button", { name: /Retry loading/u }), null);
});

test("a tampered saved preset opens Needs repair and Authorize saves the official address", async () => {
  const linear = MCP_PRESETS.find((preset) => preset.id === "linear")!;
  const tampered: McpServer = { ...serverFromPreset(linear), url: "https://attacker.test/mcp" };
  // Main's real state builder and validator, so the repair is judged by the same rules.
  const validate = (server: unknown) => assertMcpPresetServer(server as McpServer);
  const calls = mount({
    "mcp:list": () => [tampered],
    "mcp:presets": () =>
      buildMcpPresetStates({
        presets: MCP_PRESETS,
        servers: [tampered],
        serverIdFor: (preset) => presetServerId(preset.id),
        validate: (server) => { validate(server); },
        isReady: async () => false,
      }),
    "mcp:save": (server: unknown) => { validate(server); return server; },
    "mcp:authorize": (server: unknown) => { validate(server); },
  });
  assert.ok((await screen.findAllByText("Needs repair")).length > 0);
  // The saved-server row and the directory card both open the same preset dialog.
  const [manage] = screen.getAllByRole("button", { name: "Manage Linear" });
  await waitFor(() => assert.equal((manage as HTMLButtonElement).disabled, false));
  fireEvent.click(manage);
  const dialog = await screen.findByRole("dialog");
  assert.match(within(dialog).getByRole("alert").textContent ?? "", /official secure server/u);
  const addressField = within(dialog).getByRole("group", { name: "Server address", hidden: true });
  const address = within(addressField).getByRole("textbox", { hidden: true }) as HTMLInputElement;
  assert.equal(address.value, linear.url);

  fireEvent.click(within(dialog).getByRole("button", { name: "Authorize" }));
  await waitFor(() =>
    assert.equal(calls.filter((call) => call.channel === "mcp:authorize").length, 1),
  );
  assert.equal(savedServers(calls)[0]?.url, linear.url);
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

test("provider key consent identifies the exact endpoint and separates saving from approval", () => {
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
  assert.match(html, /Allow the key/u);
  assert.match(html, /Saving the server does not grant access/u);
  assert.match(html, /each device needs your approval/u);
  assert.match(html, /Only attended desktop workspace chats/u);
  const approved = renderToStaticMarkup(<McpProviderAuthFields {...props} approved />);
  assert.match(approved, /Stop sharing the key/u);
  assert.match(approved, /Approved on this device/u);
});

test("the provider key picker offers only opted-in API keys, never sign-in or subscription credentials", () => {
  const provider = (id: string, patch: Partial<Provider>): Provider => ({
    id, label: id, kind: "openai", baseUrl: "", models: [], needsKey: true, isBuiltin: true, hasKey: true, ...patch,
  });
  const providers = [
    provider("openai", { credentialType: "api_key", connectorKeySharing: true }),
    provider("anthropic", { credentialType: "oauth", connectorKeySharing: true }),
    provider("github-copilot", { credentialType: "oauth" }),
    provider("groq", { credentialType: "api_key" }),
    provider("mistral", { credentialType: "api_key", connectorKeySharing: true, hasKey: false }),
    provider("custom-local", { credentialType: "api_key", connectorKeySharing: true, isBuiltin: false }),
  ];
  assert.deepEqual(mcpShareableProviders(providers, "").map((entry) => entry.id), ["openai"]);
  // A provider already selected stays listed so its sharing can be stopped.
  assert.deepEqual(mcpShareableProviders(providers, "groq").map((entry) => entry.id), ["openai", "groq"]);
  const empty = renderToStaticMarkup(
    <McpProviderAuthFields providerId="" endpoint="" approved={false} busy={false} disabled providers={[]} onProviderChange={() => {}} onConsent={() => {}} />,
  );
  assert.match(empty, /No provider keys are shared with connectors/u);
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
  await waitFor(() => assert.match(within(dialog).getByRole("note").textContent ?? "", /“Morning digest”.*“Planner”.*use this connector/su));
});

test("disabling a server with dependents asks first and only then saves it disabled", async () => {
  const calls = mount({
    "mcp:save": (server: unknown) => server,
    "mcp:dependents": () => ({ schedules: [{ id: "t1", name: "Morning digest" }], bots: [] }),
  });
  fireEvent.click(await screen.findByRole("switch", { name: "Enable Files" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.match(within(dialog).getByRole("note").textContent ?? "", /Scheduled task “Morning digest” uses this connector/u);
  assert.equal(savedServers(calls).length, 0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
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
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Connector description" }), { target: { value: "notes" } });
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

test("signing in after adding a header saves the header first, so sign-in uses the stored record", async () => {
  const calls = mount({
    "mcp:list": () => [remoteServer],
    "mcp:oauthStatus": () => ({ authorized: false }),
    "mcp:save": (server: unknown) => ({ ...(server as McpServer), headers: { "X-Team": savedMarker } }),
    "mcp:authorize": () => ({ authorized: true }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Remote" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Add header" }));
  const names = within(dialog).getAllByRole("textbox", { name: "Header name" });
  fireEvent.change(names[names.length - 1]!, { target: { value: "X-Team" } });
  fireEvent.change(within(dialog).getByLabelText("Value of X-Team"), { target: { value: "blue" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Authorize" }));
  await waitFor(() => assert.equal(channelCalls(calls, "mcp:authorize").length, 1));
  assert.deepEqual(savedServers(calls)[0]?.headers, { "X-Team": "blue" });
  assert.deepEqual((channelCalls(calls, "mcp:authorize")[0]!.args[0] as McpServer).headers, { "X-Team": savedMarker });
});

test("signing in after changing the address of a server with a stored header saves it as an editor change", async () => {
  const calls = mount({
    "mcp:list": () => [{ ...remoteServer, headers: { Authorization: savedMarker } }],
    "mcp:oauthStatus": () => ({ authorized: false }),
    "mcp:save": (server: unknown) => server,
    "mcp:authorize": () => ({ authorized: true }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Remote" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Server URL" }), { target: { value: "https://moved.example.com/mcp" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Authorize" }));
  await waitFor(() => assert.equal(channelCalls(calls, "mcp:authorize").length, 1));
  const save = channelCalls(calls, "mcp:save")[0]!;
  assert.equal((save.args[0] as McpServer).url, "https://moved.example.com/mcp");
  assert.deepEqual((save.args[0] as McpServer).headers, { Authorization: savedMarker }, "the kept value travels as its marker");
  assert.deepEqual(save.args[1], { fromEditor: true }, "kept values may follow an address changed in the editor");
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

test("a connector on this device sets up with Test and Connect, without a key or sign-in", async () => {
  const state = catalogPresetStates().find((entry) => entry.preset.id === "figma-desktop")!;
  const { calls, openChanges } = renderPreset(state, undefined, {
    "mcp:testDraft": () => ({ connected: true, toolCount: 6, tools: [], serverCapabilities: {} }),
    "mcp:save": (server: unknown) => { assertMcpPresetServer(server as McpServer); return server; },
    "mcp:status": () => ({ connected: true, toolCount: 6 }),
  });
  const dialog = await screen.findByRole("dialog");
  assert.equal(within(dialog).queryByRole("button", { name: "Authorize" }), null);
  assert.equal(within(dialog).queryByPlaceholderText(/API key/u), null);
  assert.equal(within(dialog).queryByText("Credentials saved"), null);

  fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));
  await waitFor(() => assert.equal(channelCalls(calls, "mcp:testDraft").length, 1));
  assert.equal(channelCalls(calls, "mcp:testDraft")[0]!.args[1], undefined, "no key is sent");
  assert.equal(savedServers(calls).length, 0, "testing saves nothing");

  const connect = within(dialog).getByRole("button", { name: "Connect" }) as HTMLButtonElement;
  assert.equal(connect.disabled, false);
  fireEvent.click(connect);
  await waitFor(() => assert.deepEqual(openChanges, [false]));
  assert.deepEqual(savedServers(calls).map((server) => [server.url, server.oauth]), [["http://127.0.0.1:3845/mcp", undefined]]);
});

test("the iMCP card appears only where Aiden runs on a Mac", async () => {
  mount();
  await screen.findByRole("button", { name: "Set Up Linear" });
  assert.equal(screen.queryByRole("button", { name: "Set Up iMCP" }), null);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), { target: { value: "imessage" } });
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Set Up Linear" }), null));
  assert.equal(screen.queryByRole("button", { name: "Set Up iMCP" }), null);
  cleanup();

  mount({}, { onMac: true });
  await screen.findByRole("button", { name: "Set Up iMCP" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), { target: { value: "imessage" } });
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Set Up Linear" }), null));
  assert.ok(screen.getByRole("button", { name: "Set Up iMCP" }));
  assert.ok(screen.getByText("Calendar, Messages and more from this Mac through iMCP"));
});

const IMCP_SERVER = "/Applications/iMCP.app/Contents/MacOS/imcp-server";

test("iMCP setup leads from download to Open, then saves a connection that runs only the installed app's server", async () => {
  const state = catalogPresetStates().find((entry) => entry.preset.id === "imcp")!;
  let app = { supported: true, installed: false, open: false } as { supported: boolean; installed: boolean; open: boolean; command?: string };
  const { calls, openChanges } = renderPreset(state, undefined, {
    "mcp:macAppStatus": () => app,
    "mcp:openMacApp": () => {
      app = { ...app, open: true };
      return { opened: true };
    },
    "mcp:save": (server: unknown) => server,
    "mcp:status": () => ({ connected: true, toolCount: 12 }),
  });
  const dialog = await screen.findByRole("dialog", { name: /Set up iMCP/u });
  const download = await within(dialog).findByRole("link", { name: "Download iMCP" });
  assert.equal(download.getAttribute("href"), "https://imcp.app/download");
  const connect = within(dialog).getByRole("button", { name: "Connect" }) as HTMLButtonElement;
  assert.equal(connect.disabled, true, "nothing to run until iMCP is installed");
  assert.equal((within(dialog).getByRole("button", { name: "Open iMCP" }) as HTMLButtonElement).disabled, true);

  // The person installs iMCP outside Aiden, then checks again.
  app = { supported: true, installed: true, open: false, command: IMCP_SERVER };
  fireEvent.click(within(dialog).getByRole("button", { name: "Check again" }));
  await within(dialog).findByText("Installed");
  assert.ok(within(dialog).getByText(IMCP_SERVER), "Connection details show exactly what runs");
  fireEvent.click(within(dialog).getByRole("button", { name: "Open iMCP" }));
  await within(dialog).findByText("Open");
  assert.equal(channelCalls(calls, "mcp:openMacApp").length, 1);
  assert.deepEqual(channelCalls(calls, "mcp:openMacApp")[0]!.args, ["imcp"]);

  await waitFor(() => assert.equal(connect.disabled, false));
  fireEvent.click(connect);
  await waitFor(() => assert.deepEqual(openChanges, [false]));
  const save = channelCalls(calls, "mcp:save")[0]!;
  const saved = save.args[0] as McpServer;
  assert.deepEqual(save.args[1], { approveLaunch: true }, "saving from the dialog that shows the command approves it");
  assert.deepEqual(
    [saved.transport, saved.command, saved.args, saved.url],
    ["stdio", IMCP_SERVER, [], undefined],
  );
  // Main accepts exactly this record on a Mac.
  assert.equal(assertMcpPresetServer(saved, { platform: "darwin", homedir: "/Users/me" })?.id, "imcp");
});

test("a failed iMCP connection test adds the checks that usually fix it", async () => {
  const state = catalogPresetStates().find((entry) => entry.preset.id === "imcp")!;
  const { calls } = renderPreset(state, undefined, {
    "mcp:macAppStatus": () => ({ supported: true, installed: true, open: true, command: IMCP_SERVER }),
    "mcp:testDraft": () => ({ connected: false, toolCount: 0, tools: [], serverCapabilities: null, error: "The MCP connection timed out after 10s." }),
  });
  const dialog = await screen.findByRole("dialog", { name: /Set up iMCP/u });
  await within(dialog).findByText("Installed");
  assert.equal(within(dialog).queryByText(/Still not connecting/u), null);
  fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));
  await within(dialog).findByText(/Still not connecting\? In iMCP, check that Enable MCP Server is on/u);
  assert.equal(channelCalls(calls, "mcp:save").length, 0, "testing saves nothing");
  assert.equal((channelCalls(calls, "mcp:testDraft")[0]!.args[0] as McpServer).command, IMCP_SERVER);
});

test("managing a saved iMCP connection keeps the model access chosen for it", async () => {
  const state = catalogPresetStates({ imcp: { configured: true, ready: true } }).find((entry) => entry.preset.id === "imcp")!;
  const saved: McpServer = {
    id: state.serverId, name: "iMCP", transport: "stdio", command: IMCP_SERVER, args: [], presetId: "imcp", enabled: true,
    exposure: "direct", hiddenTools: ["messages_fetch"],
  };
  const { calls } = renderPreset(state, saved, {
    "mcp:macAppStatus": () => ({ supported: true, installed: true, open: true, command: IMCP_SERVER }),
    "mcp:save": (server: unknown) => server,
  });
  const dialog = await screen.findByRole("dialog", { name: /Manage iMCP/u });
  await within(dialog).findByText("Installed");
  fireEvent.click(within(dialog).getByRole("switch", { name: "Enable iMCP" }));
  await waitFor(() => assert.equal(channelCalls(calls, "mcp:save").length, 1));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(channelCalls(calls, "mcp:save").length, 2));

  // What main stores from each save: the switch and Save change only what they show.
  const tools = [{ name: "calendar_events" }, { name: "messages_fetch" }];
  for (const call of channelCalls(calls, "mcp:save")) {
    const stored = parseMcpServer(call.args[0]);
    assert.equal(stored.exposure, "direct");
    assert.deepEqual(mcpToolsOfferedToModel(stored, tools).map((tool) => tool.name), ["calendar_events"]);
  }
});

test("a saved hosted Figma connection shows why it can't connect and offers no way to save or sign in", async () => {
  const figma = MCP_PRESETS.find((preset) => preset.id === "figma")!;
  const state: McpPresetState = {
    preset: figma, serverId: "preset-figma", configured: true, enabled: true, ready: false,
    error: figma.availability!.reason, invalidRecord: true,
  };
  const server: McpServer = { id: "preset-figma", name: "Figma", transport: "http", url: figma.url, oauth: true, presetId: "figma", enabled: true };
  const { calls } = renderPreset(state, server, {});
  const dialog = await screen.findByRole("dialog");
  assert.match(within(dialog).getByRole("note").textContent ?? "", /isn’t approved yet/u);
  assert.equal((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);
  assert.equal((within(dialog).getByRole("button", { name: "Authorize" }) as HTMLButtonElement).disabled, true);
  assert.equal((within(dialog).getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled, true);
  assert.equal(savedServers(calls).length, 0);
});

test("model access saves the chosen exposure through the ordinary save path", async () => {
  const calls = mount({ "mcp:save": (server: unknown) => server });
  const access = await screen.findByRole("radiogroup", { name: "Model access for Files" });
  assert.equal(within(access).getByRole("radio", { name: "On demand" }).getAttribute("aria-checked"), "true");
  assert.match(document.getElementById(access.getAttribute("aria-describedby")!)?.textContent ?? "", /looks these tools up/u);
  fireEvent.click(within(access).getByRole("radio", { name: "Always visible" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  assert.equal(savedServers(calls)[0]?.exposure, "direct");
  assert.equal(savedServers(calls)[0]?.id, "mcp-files");
  assert.deepEqual(savedServers(calls)[0]?.args, localServer.args);
});

test("a server switched off for the model offers no tool list, and choosing On demand clears the setting", async () => {
  const calls = mount({
    "mcp:list": () => [{ ...localServer, exposure: "hidden" }],
    "mcp:save": (server: unknown) => server,
  });
  const access = await screen.findByRole("radiogroup", { name: "Model access for Files" });
  assert.match(document.getElementById(access.getAttribute("aria-describedby")!)?.textContent ?? "", /can’t use this server/u);
  assert.equal(screen.queryByRole("button", { name: /^Tools/u }), null);
  fireEvent.click(within(access).getByRole("radio", { name: "On demand" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  assert.equal(savedServers(calls)[0]?.exposure, undefined);
});

test("the Tools list shows every discovered tool and hiding one saves it in hiddenTools", async () => {
  const calls = mount({
    "mcp:list": () => [{ ...localServer, hiddenTools: ["write_file"] }],
    "mcp:liveStatus": () => [{ serverId: "mcp-files", state: "connected", toolCount: 2 }],
    "mcp:toolList": () => [{ name: "read_file", title: "Read file" }, { name: "write_file" }],
    "mcp:save": (server: unknown) => server,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Tools · 1 hidden" }));
  const read = await screen.findByRole("switch", { name: "Let the model use Read file" });
  const write = screen.getByRole("switch", { name: "Let the model use write_file" });
  assert.equal(read.getAttribute("aria-checked"), "true");
  assert.equal(write.getAttribute("aria-checked"), "false");
  assert.deepEqual(channelCalls(calls, "mcp:toolList").map((call) => call.args[0]), ["mcp-files"]);
  fireEvent.click(read);
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  assert.deepEqual(savedServers(calls)[0]?.hiddenTools, ["write_file", "read_file"]);
});

test("a same-count rediscovery refreshes the Tools list while open and after reopening", async () => {
  let inventory = [{ name: "old_tool" }];
  const calls = mount({
    "mcp:liveStatus": () => [{ serverId: "mcp-files", state: "connected", toolCount: 1, toolsRevision: "rev-old" }],
    "mcp:toolList": () => inventory,
  });
  const toggle = await screen.findByRole("button", { name: "Tools" });
  fireEvent.click(toggle);
  assert.ok(await screen.findByRole("switch", { name: "Let the model use old_tool" }));

  inventory = [{ name: "new_tool" }];
  act(() =>
    emitBotTestNotification("mcp:statusChanged", { serverId: "mcp-files", state: "connected", toolCount: 1, toolsRevision: "rev-new" }),
  );
  assert.ok(await screen.findByRole("switch", { name: "Let the model use new_tool" }));
  assert.equal(screen.queryByRole("switch", { name: "Let the model use old_tool" }), null);

  fireEvent.click(toggle);
  fireEvent.click(toggle);
  assert.ok(await screen.findByRole("switch", { name: "Let the model use new_tool" }));
  assert.equal(screen.queryByRole("switch", { name: "Let the model use old_tool" }), null);
  assert.equal(channelCalls(calls, "mcp:toolList").length, 2);
});

test("before any discovery the Tools list can load tools with a connection test that saves nothing", async () => {
  const calls = mount({
    "mcp:toolList": () => null,
    "mcp:testDraft": () => ({ connected: true, toolCount: 1, tools: ["search"], serverCapabilities: {} }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Tools" }));
  fireEvent.click(await screen.findByRole("button", { name: "Load tools" }));
  assert.ok(await screen.findByRole("switch", { name: "Let the model use search" }));
  assert.equal(channelCalls(calls, "mcp:testDraft").length, 1);
  assert.equal(savedServers(calls).length, 0);
});

const savedMarker = `aiden-secret:v1:${"c".repeat(32)}`;

test("saved header values stay masked; Save sends back their marker and only replaced values as text", async () => {
  const calls = mount({
    "mcp:list": () => [{ ...remoteServer, oauth: undefined, headers: { Authorization: savedMarker } }],
    "mcp:save": (server: unknown) => server,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Remote" }));
  const dialog = await screen.findByRole("dialog");
  assert.equal(within(dialog).queryByDisplayValue(savedMarker), null);
  assert.doesNotMatch(dialog.textContent ?? "", /aiden-secret/u);
  assert.ok(within(dialog).getByText("Saved value of Authorization"));
  // Unchanged: the marker goes back, so the stored value is kept.
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  assert.deepEqual(savedServers(calls)[0]?.headers, { Authorization: savedMarker });
  assert.deepEqual(channelCalls(calls, "mcp:save")[0]!.args[1], { approveLaunch: true });
});

test("replacing a saved value and adding a header send the typed values once", async () => {
  const calls = mount({
    "mcp:list": () => [{ ...remoteServer, oauth: undefined, headers: { Authorization: savedMarker } }],
    "mcp:save": (server: unknown) => server,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Remote" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Replace value of Authorization" }));
  fireEvent.change(within(dialog).getByLabelText("Value of Authorization"), { target: { value: "Bearer rotated" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add header" }));
  const names = within(dialog).getAllByRole("textbox", { name: "Header name" });
  fireEvent.change(names[names.length - 1]!, { target: { value: "X-Team" } });
  fireEvent.change(within(dialog).getByLabelText("Value of X-Team"), { target: { value: "blue" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  assert.deepEqual(savedServers(calls)[0]?.headers, { Authorization: "Bearer rotated", "X-Team": "blue" });
});

test("a pre-registered OAuth client is entered in the editor; its saved secret stays masked and goes back as its marker", async () => {
  const calls = mount({
    "mcp:list": () => [remoteServer],
    "mcp:oauthStatus": () => ({ authorized: false }),
    "mcp:save": (server: unknown) => server,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Remote" }));
  const dialog = await screen.findByRole("dialog");
  assert.equal(within(dialog).queryByRole("textbox", { name: "OAuth client name" }), null, "there is no client name override");
  assert.equal(within(dialog).queryByLabelText("OAuth client secret"), null, "the secret field appears with a client ID");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "OAuth client ID" }), { target: { value: " slack-app " } });
  const secret = within(dialog).getByLabelText("OAuth client secret", { selector: "input" }) as HTMLInputElement;
  assert.equal(secret.type, "password");
  fireEvent.change(secret, { target: { value: "typed-secret" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  assert.equal(savedServers(calls)[0]?.oauthClientId, "slack-app");
  assert.equal(savedServers(calls)[0]?.oauthClientSecret, "typed-secret");
});

test("a saved OAuth client secret is shown as dots and kept unless replaced", async () => {
  const calls = mount({
    "mcp:list": () => [{ ...remoteServer, oauthClientId: "slack-app", oauthClientSecret: savedMarker }],
    "mcp:oauthStatus": () => ({ authorized: false }),
    "mcp:save": (server: unknown) => server,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Remote" }));
  const dialog = await screen.findByRole("dialog");
  assert.doesNotMatch(dialog.textContent ?? "", /aiden-secret/u);
  assert.equal(within(dialog).queryByDisplayValue(savedMarker), null);
  assert.ok(within(dialog).getByText("Saved OAuth client secret"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  assert.equal(savedServers(calls)[0]?.oauthClientSecret, savedMarker);
  // Clearing the client ID drops the secret with it.
  fireEvent.click(await screen.findByRole("button", { name: "Edit Remote" }));
  const again = await screen.findByRole("dialog");
  fireEvent.change(within(again).getByRole("textbox", { name: "OAuth client ID" }), { target: { value: "" } });
  fireEvent.click(within(again).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 2));
  assert.equal(savedServers(calls)[1]?.oauthClientId, undefined);
  assert.equal(savedServers(calls)[1]?.oauthClientSecret, undefined);
});

test("changing the OAuth client ID asks for its secret again instead of sending the previous client's", async () => {
  const calls = mount({
    "mcp:list": () => [{ ...remoteServer, oauthClientId: "old-app", oauthClientSecret: savedMarker }],
    "mcp:oauthStatus": () => ({ authorized: false }),
    "mcp:save": (server: unknown) => server,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Remote" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "OAuth client ID" }), { target: { value: "new-app" } });
  assert.equal(within(dialog).queryByText("Saved OAuth client secret"), null);
  assert.equal((within(dialog).getByLabelText("OAuth client secret", { selector: "input" }) as HTMLInputElement).value, "");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  assert.equal(savedServers(calls)[0]?.oauthClientId, "new-app");
  assert.equal(savedServers(calls)[0]?.oauthClientSecret, undefined);
});

test("a stored sign-in that no longer matches the server can still be signed out", async () => {
  const calls = mount({
    "mcp:list": () => [remoteServer],
    "mcp:oauthStatus": () => ({ authorized: false, needsSignIn: false, hasSession: true }),
    "mcp:signOut": () => ({ authorized: false }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Remote" }));
  const dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByRole("button", { name: "Authorize" }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "Sign out" }));
  await waitFor(() => assert.deepEqual(channelCalls(calls, "mcp:signOut").map((call) => call.args[0]), [remoteServer.id]));
  await waitFor(() => assert.equal(within(dialog).queryByRole("button", { name: "Sign out" }), null));
});

test("a sign-in kept despite a failed connection check says so instead of claiming success", async () => {
  mount({
    "mcp:list": () => [remoteServer],
    "mcp:oauthStatus": () => ({ authorized: false }),
    "mcp:authorize": () => ({ authorized: true, connectionError: "MCP HTTP request failed with status 503" }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Remote" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Authorize" }));
  assert.ok(await screen.findByText(/Signed in, but connecting failed: MCP HTTP request failed with status 503/u));
  assert.equal(screen.queryByText(/you're signed in/u), null);
  assert.ok(await within(dialog).findByText("Authorized"));
});

test("a preset with a stored sign-in offers Sign out even when it is not flagged", async () => {
  const state = linearState({ configured: true, ready: false, hasSession: true });
  const server: McpServer = { id: state.serverId, name: "Linear", transport: "http", url: state.preset.url, oauth: true, presetId: "linear", enabled: true };
  renderPreset(state, server, { "mcp:signOut": () => ({ authorized: false }) });
  const dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByRole("button", { name: "Authorize" }));
  assert.ok(within(dialog).getByRole("button", { name: "Sign out" }));
});

test("a local server added outside Aiden shows exactly what it runs and is approved only from Settings", async () => {
  const pending = { serverId: localServer.id, fingerprint: "d".repeat(64), command: "npx", args: localServer.args!, env: [{ name: "NODE_OPTIONS", value: "--require /tmp/p.js" }, { name: "TOKEN" }, { name: "EXTRA", unavailable: true as const }] };
  let approvals = [pending];
  const calls = mount({
    "mcp:launchApprovals": () => approvals,
    "mcp:approveLaunch": () => { approvals = []; return { approved: true }; },
    "mcp:save": (server: unknown) => server,
  });
  const group = await screen.findByRole("group", { name: "Files needs approval" });
  assert.match(group.textContent ?? "", /Added outside Aiden — Approve to run/u);
  assert.match(group.textContent ?? "", /npx\s*-y\s*@modelcontextprotocol\/server-filesystem\s*\/Users\/me\/My Docs/u);
  // The environment is shown with its values: they change what the command does.
  const env = within(group).getByLabelText("Files environment");
  assert.match(env.textContent ?? "", /NODE_OPTIONS=--require \/tmp\/p\.js/u);
  assert.match(env.textContent ?? "", /TOKEN=\(saved value, not shown\)/u);
  // A stored value moved under another name outside Aiden is not presented as saved.
  assert.match(env.textContent ?? "", /EXTRA=\(not available — enter it again in Edit\)/u);
  // No tool list or model-access control while it may not run.
  assert.equal(screen.queryByRole("radiogroup", { name: "Model access for Files" }), null);
  // Switching it on is not an approval.
  fireEvent.click(screen.getByRole("switch", { name: "Enable Files" }));
  await waitFor(() => assert.equal(savedServers(calls).length, 1));
  assert.equal(channelCalls(calls, "mcp:save")[0]!.args[1], undefined);

  fireEvent.click(within(group).getByRole("button", { name: "Approve Files to run" }));
  await waitFor(() => assert.deepEqual(channelCalls(calls, "mcp:approveLaunch").map((call) => call.args), [["mcp-files", "d".repeat(64)]]));
  assert.ok(await screen.findByRole("radiogroup", { name: "Model access for Files" }));
});

test("the editor shows env values still written in config.json, so saving it is an informed approval", async () => {
  mount({
    "mcp:list": () => [{ ...localServer, env: { NODE_OPTIONS: "--require /tmp/p.js", TOKEN: savedMarker } }],
  });
  fireEvent.click(await screen.findByRole("button", { name: "Edit Files" }));
  const dialog = await screen.findByRole("dialog");
  const visible = within(dialog).getByLabelText("Value of NODE_OPTIONS") as HTMLInputElement;
  assert.equal(visible.value, "--require /tmp/p.js");
  assert.equal(visible.type, "text");
  // A keychain value stays masked.
  assert.ok(within(dialog).getByText("Saved value of TOKEN"));
  assert.equal(within(dialog).queryByDisplayValue(savedMarker), null);
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
  fireEvent.click(await screen.findByRole("button", { name: /Add custom connector/u }));
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
  fireEvent.change(within(dialog).getByLabelText("Value of X-Tenant"), { target: { value: "new" } });
  assert.ok(await within(dialog).findByText(/Bot “Planner” uses this server. Changing how Aiden connects/u));

  fireEvent.click(within(dialog).getByRole("button", { name: "Authorize" }));
  await waitFor(() => assert.equal(channelCalls(calls, "mcp:authorize").length, 1));
  assert.deepEqual(savedServers(calls).map((server) => server.headers), [{ "X-Tenant": "new" }]);
  const order = calls.map((call) => call.channel).filter((channel) => channel === "mcp:save" || channel === "mcp:authorize");
  assert.deepEqual(order, ["mcp:save", "mcp:authorize"]);
});

test("returning to Connectors shows status that changed while it was closed", async () => {
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

  // Main's status changes while Connectors is closed; its push reaches no one.
  snapshot = [{ serverId: "mcp-files", state: "failed", error: "token revoked" }];
  act(() => emitBotTestNotification("mcp:statusChanged", snapshot[0]));

  render(view());
  await waitFor(() => assert.match(screen.getByLabelText("Files status").textContent ?? "", /Couldn’t connect/u));
  assert.equal(channelCalls(calls, "mcp:liveStatus").length, 2);
});

test("Settings → Providers offers connector key sharing only for a saved API key, and turning it on asks main", async () => {
  const base: Provider = { id: "openai", label: "OpenAI", kind: "openai", baseUrl: "", models: [], needsKey: true, isBuiltin: true, hasKey: true };
  const calls = installBotTestIpc({
    "providers:list": () => [],
    "providers:setConnectorKeySharing": (_id: unknown, allowed: unknown) => ({ connectorKeySharing: allowed }),
  });
  const { rerender } = render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ProviderConnectorKeySharing provider={{ ...base, credentialType: "oauth" }} />
    </QueryClientProvider>,
  );
  assert.equal(screen.queryByRole("switch"), null, "a sign-in credential is never offered");
  rerender(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ProviderConnectorKeySharing provider={{ ...base, credentialType: "api_key" }} />
    </QueryClientProvider>,
  );
  const toggle = screen.getByRole("switch", { name: "Let custom connectors use the OpenAI key" });
  assert.equal(toggle.getAttribute("aria-checked"), "false", "off by default");
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  assert.deepEqual(calls.filter((call) => call.channel === "providers:setConnectorKeySharing").map((call) => call.args), [["openai", true]]);
});
