import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../../lib/app-capabilities";
import type { AidenMcpAppView, AidenMcpServerStatusView } from "../../shared/aiden-mcp";
import { Toaster, toast } from "../ui";
import { AidenMcpSettings } from "./aiden-mcp-settings";

// Never a legitimate piece of UI copy: any appearance after the sheet closes is a leak.
const TOKEN = "SENTINELtokenSENTINELtokenSENTINELtoken0000";

let clipboard: string[] = [];

beforeEach(() => {
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void clipboard.push(text) },
  });
});

afterEach(() => {
  toast.dismiss();
  cleanup();
});

type Handler = (...args: unknown[]) => unknown;

/** A fake main process: the switch and the app list behave like the real channels. */
function mcpServer(
  initial: { status?: Partial<AidenMcpServerStatusView>; apps?: AidenMcpAppView[] } = {},
  overrides: Record<string, Handler> = {},
) {
  let status: AidenMcpServerStatusView = { supported: true, enabled: false, running: false, ...initial.status };
  let apps = [...(initial.apps ?? [])];
  const calls = installBotTestIpc({
    "remote:mcpStatus": () => status,
    "remote:mcpSetEnabled": (enabled) => {
      status = enabled
        ? { supported: true, enabled: true, running: true, port: 49400, url: "http://127.0.0.1:49400/mcp" }
        : { supported: true, enabled: false, running: false, port: 49400, url: "http://127.0.0.1:49400/mcp" };
      return status;
    },
    "remote:mcpListApps": () => apps,
    "remote:mcpIssueApp": (input) => {
      const { name, access } = input as { name: string; access: "read" | "supervised" };
      const app: AidenMcpAppView = { id: `device_${apps.length + 1}`, name, access, createdAt: Date.UTC(2026, 10, 11), lastSeenAt: 0 };
      apps = [app, ...apps];
      return { credential: TOKEN, app };
    },
    "remote:mcpRevokeApp": (id) => {
      const before = apps.length;
      apps = apps.filter((app) => app.id !== id);
      return { revoked: apps.length < before };
    },
    ...overrides,
  });
  return { calls: (channel: string) => calls.filter((call) => call.channel === channel) };
}

function mount(mcpServerCapability = true) {
  return render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, platform: "darwin", mcpServer: mcpServerCapability }}>
        <AidenMcpSettings />
      </AppCapabilitiesProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

/** Every string the page exposes: rendered text plus every attribute value. */
function renderedSurface(): string {
  const parts = [document.body.textContent ?? ""];
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) parts.push(attribute.value);
  }
  return parts.join("\n");
}

/** A failed `assert.equal(node, null)` inspects the whole jsdom tree, which can take minutes. */
function absent(element: Element | null): boolean {
  return element === null;
}

const CODEX: AidenMcpAppView = {
  id: "device_codex",
  name: "Codex",
  access: "read",
  createdAt: Date.UTC(2026, 10, 1),
  lastSeenAt: Date.UTC(2026, 10, 10),
};

test("a computer without the MCP server shows nothing and asks main nothing", async () => {
  const server = mcpServer();
  mount(false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(absent(screen.queryByRole("switch", { name: "Let apps use Aiden" })));
  assert.ok(absent(screen.queryByRole("button", { name: "Add app" })));
  assert.equal(server.calls("remote:mcpStatus").length, 0);
  assert.equal(server.calls("remote:mcpListApps").length, 0);
});

test("turning the server on shows the port and the address apps connect to", async () => {
  const server = mcpServer();
  mount();
  const toggle = await screen.findByRole("switch", { name: "Let apps use Aiden" });
  assert.ok(screen.getByText("Off"));
  fireEvent.click(toggle);
  assert.ok(await screen.findByText("Listening on port 49400"));
  assert.deepEqual(server.calls("remote:mcpSetEnabled").map((call) => call.args), [[true]]);
  fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
  await waitFor(() => assert.deepEqual(clipboard, ["http://127.0.0.1:49400/mcp"]));
});

test("a failed switch puts it back and says why", async () => {
  mcpServer({}, { "remote:mcpSetEnabled": () => { throw new Error("This computer cannot run Aiden's MCP server."); } });
  mount();
  const toggle = await screen.findByRole("switch", { name: "Let apps use Aiden" });
  fireEvent.click(toggle);
  assert.ok(await screen.findByText("This computer cannot run Aiden's MCP server."));
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "false"));
  assert.ok(screen.getByText("Off"));
});

test("a port held by another program says so and can try the same port again", async () => {
  const server = mcpServer({ status: { enabled: true, running: false, port: 49400, url: "http://127.0.0.1:49400/mcp", problem: "port_in_use" } });
  mount();
  assert.ok(await screen.findByText("Port 49400 is in use"));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  assert.ok(await screen.findByText("Listening on port 49400"));
  assert.deepEqual(server.calls("remote:mcpSetEnabled").map((call) => call.args), [[true]]);
});

test("adding an app shows its token once, with setup that reads it from the environment", async () => {
  const server = mcpServer({ status: { enabled: true, running: true, port: 49400, url: "http://127.0.0.1:49400/mcp" } });
  mount();
  assert.ok(await screen.findByText("No apps yet"));
  fireEvent.click(screen.getByRole("button", { name: "Add app" }));

  const addDialog = await screen.findByRole("dialog", { name: "Add an app" });
  const add = within(addDialog).getByRole("button", { name: "Add app" }) as HTMLButtonElement;
  assert.equal(add.disabled, true, "an app needs a name");
  fireEvent.change(within(addDialog).getByRole("textbox"), { target: { value: "Claude Code" } });
  assert.equal(within(addDialog).getByRole("radio", { name: "Read only" }).getAttribute("aria-checked"), "true");
  fireEvent.click(within(addDialog).getByRole("radio", { name: "Supervised" }));
  fireEvent.click(add);

  const sheet = await screen.findByRole("dialog", { name: "Connect Claude Code" });
  assert.deepEqual(server.calls("remote:mcpIssueApp").map((call) => call.args), [[{ name: "Claude Code", access: "supervised" }]]);
  const code = Array.from(sheet.querySelectorAll("code"), (element) => element.textContent ?? "");
  assert.ok(code.includes(TOKEN));
  const commands = code.filter((line) => line.startsWith("claude ") || line.startsWith("codex "));
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.ok(!command.includes(TOKEN), "a client command keeps the token out of its saved config");
    assert.match(command, /AIDEN_MCP_TOKEN/u);
    assert.match(command, /http:\/\/127\.0\.0\.1:49400\/mcp/u);
  }
  assert.ok(code.includes(`export AIDEN_MCP_TOKEN='${TOKEN}'`));

  fireEvent.click(within(sheet).getByRole("button", { name: "Copy token" }));
  await waitFor(() => assert.deepEqual(clipboard, [TOKEN]));

  fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
  await waitFor(() => assert.ok(absent(screen.queryByRole("dialog", { name: "Connect Claude Code" }))));
  assert.ok(!renderedSurface().includes(TOKEN), "closing the sheet forgets the token");
  assert.ok(await screen.findByText("Claude Code"));
  assert.ok(screen.getByText("Supervised"));
  assert.match(screen.getByText(/^Added /u).textContent ?? "", /Not used yet/u);
});

test("a failed add keeps the sheet open with the reason", async () => {
  mcpServer({}, { "remote:mcpIssueApp": () => { throw new Error("You can connect at most 16 apps."); } });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Add app" }));
  const addDialog = await screen.findByRole("dialog", { name: "Add an app" });
  fireEvent.change(within(addDialog).getByRole("textbox"), { target: { value: "Codex" } });
  fireEvent.click(within(addDialog).getByRole("button", { name: "Add app" }));
  assert.equal((await within(addDialog).findByRole("alert")).textContent, "You can connect at most 16 apps.");
  assert.ok(absent(screen.queryByRole("dialog", { name: /^Connect/u })));
});

test("revoking an app asks first, and Cancel leaves it connected", async () => {
  const server = mcpServer({ apps: [CODEX] });
  mount();
  assert.ok(await screen.findByText("Codex"));
  assert.match(screen.getByText(/^Added /u).textContent ?? "", /Last used/u);

  fireEvent.click(screen.getByRole("button", { name: "Revoke Codex" }));
  const confirm = await screen.findByRole("alertdialog", { name: "Revoke Codex?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(absent(screen.queryByRole("alertdialog"))));
  assert.equal(server.calls("remote:mcpRevokeApp").length, 0);
  assert.ok(screen.getByText("Codex"));

  fireEvent.click(screen.getByRole("button", { name: "Revoke Codex" }));
  fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Revoke Codex?" })).getByRole("button", { name: "Revoke" }));
  await waitFor(() => assert.ok(absent(screen.queryByText("Codex"))));
  assert.deepEqual(server.calls("remote:mcpRevokeApp").map((call) => call.args), [["device_codex"]]);
  assert.ok(screen.getByText("No apps yet"));
});
