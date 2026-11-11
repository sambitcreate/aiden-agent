import type { Page } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ appEnvironment: { AIDEN_ANALYTICS: "0" } });

/** One JSON-RPC call to Aiden's MCP endpoint, the way Claude Code or Codex sends it. */
async function mcpCall(url: string, token: string, method: string, id: number): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } }
        : {},
    }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // A 401 may carry no JSON body; the status is the claim.
  }
  return { status: response.status, body };
}

async function openAppsUsingAiden(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Connections", exact: true })
    .click();
  await page.getByRole("tab", { name: "Apps using Aiden", exact: true }).click();
}

test("an app added in Settings connects with its copied token and is refused once revoked", async ({ aiden }) => {
  const { app, page } = aiden;
  await finishLmStudioOnboarding(page);
  await openAppsUsingAiden(page);

  const toggle = page.getByRole("switch", { name: "Let apps use Aiden" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Off", { exact: true })).toBeVisible();
  await toggle.click();
  await expect(page.getByText(/^Listening on port \d+$/u)).toBeVisible();

  const address = (await page.getByText(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u).textContent()) ?? "";
  expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);

  await page.getByRole("button", { name: "Add app", exact: true }).click();
  const addDialog = page.getByRole("dialog", { name: "Add an app" });
  await addDialog.getByRole("textbox").fill("E2E Client");
  await expect(addDialog.getByRole("radio", { name: "Read only" })).toHaveAttribute("aria-checked", "true");
  await addDialog.getByRole("button", { name: "Add app", exact: true }).click();

  const sheet = page.getByRole("dialog", { name: "Connect E2E Client" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Copy token", exact: true }).click();
  const readClipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  await expect.poll(readClipboard).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const token = await readClipboard();
  await expect(sheet.getByText(`export AIDEN_MCP_TOKEN='${token}'`).first()).toBeVisible();
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(sheet).toBeHidden();

  await expect(page.getByText("E2E Client", { exact: true })).toBeVisible();
  await expect(page.getByText(/Not used yet/u)).toBeVisible();
  await expect(page.getByText(token)).toHaveCount(0);

  // The copied token works against the address Settings showed, with Read only access.
  const initialize = await mcpCall(address, token, "initialize", 1);
  expect(initialize.status).toBe(200);
  const tools = await mcpCall(address, token, "tools/list", 2);
  expect(tools.status).toBe(200);
  const names = ((tools.body as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((tool) => tool.name);
  expect(names).toContain("aiden_chat_list");
  expect(names).not.toContain("aiden_chat_start");

  await page.getByRole("button", { name: "Revoke E2E Client", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Revoke E2E Client?" });
  await confirm.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText("No apps yet", { exact: true })).toBeVisible();

  expect((await mcpCall(address, token, "tools/list", 3)).status).toBe(401);

  await toggle.click();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    try {
      return (await mcpCall(address, token, "initialize", 4)).status;
    } catch {
      return "closed";
    }
  }).toBe("closed");
});
