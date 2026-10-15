import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { PLUGIN_CATALOG, isConnectablePlugin } from "../../shared/plugin-catalog";
import type { McpPresetState, McpServer } from "../../lib/types";
import { Toaster } from "../ui";
import { useMcpPresets, useMcpServers } from "../../lib/queries";
import { McpSettings } from "./mcp-settings";
import { PresetSetupDialog } from "./mcp-preset-setup";
import { McpOAuthMetadataField, mcpOAuthMetadataFieldError } from "./mcp-oauth-metadata-field";
import { McpProviderAuthFields } from "./mcp-provider-auth-fields";
import { buildMcpPresetStates } from "../../../main/handlers/mcp-preset-states";
import {
  MCP_PRESETS,
  assertMcpPresetServer,
  presetServerId,
  serverFromPreset,
} from "../../../main/services/mcp-presets";

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
