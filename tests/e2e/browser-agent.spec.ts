import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserState } from "../../renderer/shared/browser";
import { E2E_WORKSPACE_ID, expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });

test("a real agent generation opens the closed Environment browser and edits the user's same page", async ({
  aiden,
}) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html><head><title>Agent browser fixture</title></head><body><h1>Shared browser agent test</h1><label>Name<input aria-label="Name" id="name"></label><button onclick="document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value">Save settings</button><p id="result">Ready</p></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const { page, lmStudio } = aiden;
    await finishLmStudioOnboarding(page);
    const browserPanel = page.getByRole("tabpanel", { name: "Browser", exact: true });
    await expect(browserPanel).toBeHidden();
    expect(lmStudio.enqueueToolScenario).toBeDefined();
    const prompt = "Browser integration scenario: enter Aiden agent and save my settings.";
    const calls = [
      { name: "browser", arguments: {} },
      { name: "browser_open", arguments: { open: true } },
      { name: "browser_navigate", arguments: { url, readiness: "load" } },
      { name: "browser_snapshot", arguments: { includeImage: false } },
      {
        name: "browser_type",
        arguments: { locator: "role=textbox[name='Name']", text: "Aiden agent", clear: true },
      },
      { name: "browser_click", arguments: { locator: "role=button[name='Save settings']" } },
      { name: "browser_wait_for", arguments: { text: "Saved Aiden agent" } },
      { name: "browser_snapshot", arguments: { includeImage: false } },
    ];
    const scenario = lmStudio.enqueueToolScenario!({
      prompt,
      calls,
      finalText: "Browser integration completed on your page.",
    });
    await page.locator("textarea").first().fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByText("Browser integration completed on your page.", { exact: true }).first(),
    ).toBeVisible({ timeout: 45_000 });
    expect(scenario.error).toBeUndefined();
    expect(scenario.completed).toBe(true);
    expect(scenario.issuedToolNames).toEqual(calls.map(({ name }) => name));
    const requests = lmStudio.requests.map(({ body }) => body as { tools?: { function?: { name?: string } }[] }).filter((body) => body?.tools?.some(({ function: tool }) => tool?.name === "browser"));
    expect(requests[0]?.tools?.filter(({ function: tool }) => tool?.name?.startsWith("browser")).map(({ function: tool }) => tool?.name)).toEqual(["browser"]);
    expect(requests[1]?.tools?.some(({ function: tool }) => tool?.name === "browser_snapshot")).toBe(true);
    expect(JSON.stringify(scenario.results[3]?.content)).toContain("Shared browser agent test");
    expect(JSON.stringify(scenario.results[7]?.content)).toContain("Saved Aiden agent");
    await expect(browserPanel).toBeVisible();

    // This read verifies the renderer shows the very tab driven through model
    // requests, not an independent standalone Playwright browser.
    const state = await page.evaluate(async (workspaceId) => {
      const api = (
        window as unknown as Window & {
          aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } };
        }
      ).aidenAPI;
      return api.ipc.invoke<BrowserState>("browser:get-state", workspaceId);
    }, E2E_WORKSPACE_ID);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.url).toBe(url);
    expect(state.tabs[0]?.title).toBe("Agent browser fixture");
    expect(state.activeTabId).toBe(state.tabs[0]?.id);

    await page.evaluate(async (workspaceId) => {
      await (window as unknown as { aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } } }).aidenAPI.ipc.invoke("browser:command", workspaceId, { action: "agent_access", access: "off" });
    }, E2E_WORKSPACE_ID);
    await page.getByRole("button", { name: "Close environment panel", exact: true }).click();
    const requestStart = lmStudio.requests.length;
    const disabledPrompt = "Confirm browser tools are disabled for this workspace.";
    const disabled = lmStudio.enqueueToolScenario!({ prompt: disabledPrompt, calls: [], finalText: "Browser tools are disabled." });
    await page.locator("textarea").first().fill(disabledPrompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Browser tools are disabled.", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    expect(disabled.completed).toBe(true);
    const disabledRequests = lmStudio.requests.slice(requestStart).map(({ body }) => body as { tools?: { function?: { name?: string } }[] }).filter((body) => body?.tools?.length);
    expect(disabledRequests.length).toBeGreaterThan(0);
    expect(disabledRequests.every((body) => body.tools!.every(({ function: tool }) => !tool?.name?.startsWith("browser")))).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Ask first holds a mutating browser tool until the user allows that action", async ({
  aiden,
}) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>Browser approval fixture</title><button onclick=\"window.approvalClicks=(window.approvalClicks||0)+1;document.querySelector('#result').textContent='Approved change'\">Apply change</button><p id=\"result\">Unchanged</p>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const { page, app, lmStudio } = aiden;
    await finishLmStudioOnboarding(page);
    await page.getByRole("button", { name: /^Workspace access: Full access/u }).click();
    await page
      .getByRole("radiogroup", { name: "Workspace access" })
      .getByRole("radio", { name: /^Workspace access: Ask first/u })
      .click();
    await expect(
      page.getByRole("button", { name: /^Workspace access: Ask first/u }),
    ).toHaveAttribute("aria-expanded", "false");

    const prompt = "Browser approval scenario: apply the change after I review it.";
    const calls = [
      { name: "browser", arguments: {} },
      { name: "browser_open", arguments: { open: true } },
      { name: "browser_navigate", arguments: { url, readiness: "load" } },
      { name: "browser_snapshot", arguments: { includeImage: false } },
      { name: "browser_click", arguments: { locator: "role=button[name='Apply change']" } },
      { name: "browser_wait_for", arguments: { text: "Approved change" } },
      { name: "browser_snapshot", arguments: { includeImage: false } },
    ];
    const scenario = lmStudio.enqueueToolScenario!({
      prompt,
      calls,
      finalText: "The approved browser change is complete.",
    });
    await page.locator("textarea").first().fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    const allowOnce = page.getByRole("button", { name: "Allow once", exact: true });
    await expect(allowOnce).toBeVisible({ timeout: 45_000 });
    await expect(
      page.getByText(/^Click an element in Aiden's browser/),
    ).toBeVisible();
    expect(scenario.issuedToolNames).toEqual(calls.slice(0, 5).map((call) => call.name));
    expect(scenario.completed).toBe(false);
    const readPageMutation = () =>
      app.evaluate(async ({ webContents }, targetUrl) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === targetUrl);
        if (!guest) throw new Error("Browser approval guest missing");
        return guest.executeJavaScript(
          "({text:document.querySelector('#result').textContent, clicks:window.approvalClicks||0})",
        );
      }, url);
    // Read the actual shared guest while the approval card is visible. A tool
    // execution before review would increment the page's own event counter.
    expect(await readPageMutation()).toEqual({ text: "Unchanged", clicks: 0 });
    // At the fixture's narrow window width, Environment floats over the right
    // side of chat. Dismiss it through its public control to review the card.
    await page.getByRole("button", { name: "Close environment panel", exact: true }).click();
    await allowOnce.click();
    await expect(
      page.getByText("The approved browser change is complete.", { exact: true }).first(),
    ).toBeVisible({ timeout: 45_000 });
    expect(scenario.error).toBeUndefined();
    expect(scenario.completed).toBe(true);
    expect(scenario.issuedToolNames).toEqual(calls.map((call) => call.name));
    expect(await readPageMutation(), JSON.stringify(scenario.results)).toEqual({ text: "Approved change", clicks: 1 });
    expect(JSON.stringify(scenario.results[6]?.content)).toContain("Approved change");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});


test("agent local-file preview requests exact approval and releases its listener after the final tab", async ({ aiden }) => {
  const root = await mkdtemp(join(tmpdir(), "aiden-browser-agent-preview-"));
  const path = join(root, "index.html");
  const asset = join(root, "style.css");
  await writeFile(path, '<!doctype html><title>Approved local preview</title><link rel="stylesheet" href="style.css"><h1>Exact local document</h1>');
  await writeFile(asset, "h1{color:rgb(12,34,56)}");
  try {
    const { page, app, lmStudio } = aiden;
    await finishLmStudioOnboarding(page);
    const prompt = "Preview this exact temporary document with its stylesheet.";
    const scenario = lmStudio.enqueueToolScenario!({ prompt, calls: [
      { name: "browser", arguments: {} },
      { name: "browser_open", arguments: { path, assetPaths: [asset], open: true } },
      { name: "browser_snapshot", arguments: { includeImage: false } },
    ], finalText: "The managed preview is ready." });
    await page.locator("textarea").first().fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    const allow = page.getByRole("button", { name: "Allow once", exact: true });
    await expect(allow).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(/Open this exact local document and its listed assets/)).toBeVisible();
    expect(scenario.issuedToolNames).toEqual(["browser", "browser_open"]);
    await allow.click();
    await expect(page.getByText("The managed preview is ready.", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    expect(scenario.error).toBeUndefined();
    expect(JSON.stringify(scenario.results[2]?.content)).toContain("Exact local document");
    expect(JSON.stringify(scenario.results)).not.toContain("aiden_preview_token");
    const rawUrl = await app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((item) => item.getTitle() === "Approved local preview");
      if (!guest) throw new Error("Preview guest missing");
      const color = await guest.executeJavaScript("getComputedStyle(document.querySelector('h1')).color");
      if (color !== "rgb(12, 34, 56)") throw new Error("Approved asset did not load");
      return guest.getURL();
    });
    expect(new URL(rawUrl).hostname).toBe("127.0.0.1");
    const tabs = await page.evaluate(async ({ workspaceId, rawUrl }) => {
      const ipc = (window as unknown as { aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } } }).aidenAPI.ipc;
      const state = await ipc.invoke<BrowserState>("browser:get-state", workspaceId);
      const first = state.tabs[0]!.id;
      const second = await ipc.invoke<{ tabId: string }>("browser:command", workspaceId, { action: "create", url: rawUrl });
      return { first, second: second.tabId };
    }, { workspaceId: E2E_WORKSPACE_ID, rawUrl });
    const close = (tabId: string) => page.evaluate(async ({ tabId, workspaceId }) => {
      await (window as unknown as { aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } } }).aidenAPI.ipc.invoke("browser:command", workspaceId, { action: "close", tabId });
    }, { tabId, workspaceId: E2E_WORKSPACE_ID });
    await expect.poll(async () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((item) => item.getTitle() === "Approved local preview").length)).toBe(2);
    await close(tabs.first);
    expect((await fetch(rawUrl)).ok).toBe(true);
    await close(tabs.second);
    await expect.poll(async () => { try { await fetch(rawUrl); return true; } catch { return false; } }, { timeout: 6000 }).toBe(false);
    expect(await readFile(path, "utf8")).toContain("Exact local document");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("browser approval expires when the same tab reloads before Allow once", async ({ aiden }) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><title>Stale browser approval</title><button onclick="window.clicks=(window.clicks||0)+1">Save</button>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const { page, app, lmStudio } = aiden;
    await finishLmStudioOnboarding(page);
    await page.getByRole("button", { name: /^Workspace access: Full access/u }).click();
    await page.getByRole("radio", { name: /^Workspace access: Ask first/u }).click();
    const prompt = "Test stale approval on a reloaded browser page.";
    const scenario = lmStudio.enqueueToolScenario!({ prompt, calls: [
      { name: "browser", arguments: {} },
      { name: "browser_open", arguments: { url } },
      { name: "browser_wait_for", arguments: { text: "Save" } },
      { name: "browser_click", arguments: { locator: "role=button[name='Save']" } },
    ], finalText: "Stale approval check finished." });
    await page.locator("textarea").first().fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    const allow = page.getByRole("button", { name: "Allow once", exact: true });
    await expect(allow).toBeVisible({ timeout: 45_000 });
    await app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((item) => item.getURL() === url);
      if (!guest) throw new Error("Browser guest missing");
      await guest.loadURL(url);
    }, url);
    await page.getByRole("button", { name: "Close environment panel", exact: true }).click();
    await allow.click();
    await expect(page.getByText("Stale approval check finished.", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    expect(scenario.error).toBeUndefined();
    expect(JSON.stringify(scenario.results[3]?.content)).toContain("changed while approval was pending");
    expect(await app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((item) => item.getURL() === url);
      return guest?.executeJavaScript("window.clicks||0");
    }, url)).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
