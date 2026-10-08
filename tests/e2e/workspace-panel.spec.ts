import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  E2E_WORKSPACE_ID,
  expect,
  finishLmStudioOnboarding,
  test,
} from "./fixtures";

test.use({ workspaceSeed: true });

test("workspace launcher opens tools on demand and returns after closing the last tab", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  const panel = page.getByRole("complementary", {
    name: "Environment work surface",
  });
  await page.locator("[data-environment-toggle]").click();
  await expect(panel.getByRole("tabpanel", { name: "New tab" })).toBeVisible();
  await panel.getByRole("button", { name: "Files", exact: true }).click();
  await expect(
    panel.getByRole("tab", { name: "Files", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("button", { name: "New workspace tab" }).click();
  await panel.getByRole("button", { name: "Context", exact: true }).click();
  await expect(panel.getByRole("tabpanel", { name: "Context" })).toContainText(
    "Send a message",
  );
  await panel.getByRole("button", { name: "New workspace tab" }).click();
  await panel.getByRole("button", { name: "Files", exact: true }).click();
  await expect(
    panel.getByRole("tab", { name: "Files", exact: true }),
  ).toHaveCount(1);
  await panel.getByRole("button", { name: "Close environment panel" }).click();
  await page.locator("[data-environment-toggle]").click();
  await expect(panel.getByRole("tabpanel", { name: "New tab" })).toBeVisible();
  for (const width of [900, 1600]) {
    await aiden.app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(width, 900),
      width,
    );
    await expect(panel).toBeVisible();
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
  await expect(page.locator("[data-environment-surface-mode]")).toHaveAttribute(
    "data-environment-surface-mode",
    "tools-pinned",
  );
  await expect.poll(async () => {
    const composer = await page.locator("textarea").boundingBox();
    const tools = await panel.boundingBox();
    return Boolean(composer && tools && composer.x + composer.width <= tools.x);
  }).toBe(true);
  await page.screenshot({ path: "/tmp/aiden-workspace-launcher.png", animations: "disabled" });
  await panel.getByRole("button", { name: "Close Files tab" }).click();
  await panel.getByRole("button", { name: "Close Context tab" }).click();
  await expect(panel.getByRole("tab")).toHaveCount(1);
  await expect(panel.getByRole("tabpanel", { name: "New tab" })).toBeVisible();
});

test("terminal docking retains the same live surface, screen state and shell", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page
    .getByRole("button", { name: "Show terminal", exact: true })
    .click();
  const drawer = page.locator(".terminal-drawer");
  const output = drawer.getByRole("log", { name: "Terminal output" });
  await expect(output).toHaveText(/\S/u);
  await expect(drawer.locator(".ghostty-input")).toBeFocused();
  await page.keyboard.type(
    "export AIDEN_DOCK_CHECK=314159; echo ready-$AIDEN_DOCK_CHECK",
  );
  await page.keyboard.press("Enter");
  await expect(output).toContainText("ready-314159");
  const canvas = await drawer.locator("canvas").elementHandle();
  await drawer
    .getByRole("button", { name: "Move terminal to side panel" })
    .click();
  await expect(drawer).toHaveAttribute("data-placement", "side");
  const panel = page.getByRole("complementary", {
    name: "Environment work surface",
  });
  await expect(panel.locator(".terminal-drawer")).toBeVisible();
  expect(
    await drawer
      .locator("canvas")
      .evaluate((node, original) => node === original, canvas),
  ).toBe(true);
  await panel.getByRole("button", { name: "New workspace tab" }).click();
  await expect(drawer).toBeHidden();
  await panel.getByRole("button", { name: /^Terminal/ }).click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Move terminal to bottom" }).click();
  await expect(drawer).toHaveAttribute("data-placement", "bottom");
  expect(
    await drawer
      .locator("canvas")
      .evaluate((node, original) => node === original, canvas),
  ).toBe(true);
  await drawer.locator(".ghostty-input").focus();
  await page.keyboard.type("echo still-$AIDEN_DOCK_CHECK");
  await page.keyboard.press("Enter");
  await expect(output).toContainText("still-314159");
  await drawer
    .getByRole("button", { name: "Split terminal horizontally" })
    .click();
  await expect(drawer.locator("canvas")).toHaveCount(2);
  await drawer
    .getByRole("button", { name: "Move terminal to side panel" })
    .click();
  await expect(panel.locator(".terminal-drawer canvas")).toHaveCount(2);
  await panel.getByRole("button", { name: "Close Terminal tab" }).click();
  await expect(drawer).toBeHidden();
  await panel.getByRole("button", { name: "New workspace tab" }).click();
  await panel.getByRole("button", { name: /^Terminal/ }).click();
  await expect(drawer.locator("canvas")).toHaveCount(2);
});

test("context is available with the composer meter hidden and preference survives restart", async ({
  aiden,
}) => {
  let page = aiden.page;
  await finishLmStudioOnboarding(page);
  await page.locator("textarea").fill("Context inspector test");
  await page.locator("textarea").press("Enter");
  await expect(
    page.getByRole("button", { name: /^Context usage,/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  const preference = page.getByRole("switch", {
    name: "Show context usage in composer",
  });
  await expect(preference).toBeChecked();
  await preference.click();
  await expect(preference).not.toBeChecked();
  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(
    page.getByRole("button", { name: /^Context usage,/ }),
  ).toHaveCount(0);
  await page.locator("[data-environment-toggle]").click();
  await page.getByRole("button", { name: "Context", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Context" })).toContainText(
    "Recorded usage",
  );
  page = await aiden.relaunch();
  await expect(
    page.getByRole("button", { name: /^Context usage,/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await expect(
    page.getByRole("switch", { name: "Show context usage in composer" }),
  ).not.toBeChecked();
});

test("browser pages share the tool tab strip and the launcher hides the native page", async ({
  aiden,
}) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Panel fixture</title><h1>Local browser page</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { page } = aiden;
    await finishLmStudioOnboarding(page);
    await page.locator("[data-environment-toggle]").click();
    const panel = page.getByRole("complementary", {
      name: "Environment work surface",
    });
    await aiden.app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get("browser:command")!;
      let failNextCreate = true;
      ipcMain.removeHandler("browser:command");
      ipcMain.handle("browser:command", (event, ...args) => {
        if (failNextCreate && (args[1] as { action: string }).action === "create") {
          failNextCreate = false;
          throw new Error("Browser creation unavailable");
        }
        return original(event, ...args);
      });
    });
    await panel
      .getByRole("textbox", { name: "Open a URL" })
      .fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await panel.getByRole("textbox", { name: "Open a URL" }).press("Enter");
    await expect(panel.getByRole("alert")).toHaveText("Could not open this address. Try again.");
    await expect(panel.getByRole("textbox", { name: "Open a URL" })).toHaveValue(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await panel.getByRole("textbox", { name: "Open a URL" }).press("Enter");
    await expect(
      panel.getByRole("tab", { name: "Panel fixture", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("tablist", { name: "Browser tabs" }),
    ).toBeHidden();
    await panel.getByRole("button", { name: "New workspace tab" }).click();
    await expect(
      panel.getByRole("textbox", { name: "Open a URL" }),
    ).toBeVisible();
    await expect(panel.getByRole("textbox", { name: "Open a URL" })).toHaveValue("");
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(panel.locator("#environment-browser-panel")).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(async (workspaceId) => {
          const api = (
            window as unknown as {
              aidenAPI: {
                ipc: {
                  invoke: (
                    channel: string,
                    id: string,
                  ) => Promise<{ tabs: Array<{ visible?: boolean }> }>;
                };
              };
            }
          ).aidenAPI;
          return (
            await api.ipc.invoke("browser:get-state", workspaceId)
          ).tabs.some((tab) => tab.visible);
        }, E2E_WORKSPACE_ID),
      )
      .toBe(false);
    await panel.getByRole("button", { name: "Context", exact: true }).click();
    await panel
      .getByRole("tab", { name: "Panel fixture", exact: true })
      .click();
    await expect(panel.locator("#environment-browser-panel")).toBeVisible();
    await panel
      .getByRole("button", { name: "Close Panel fixture tab" })
      .click();
    await expect(
      panel.getByRole("tab", { name: "Panel fixture", exact: true }),
    ).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("browser creation and background selection preserve address focus while strip navigation moves it", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.locator("[data-environment-toggle]").click();
  const panel = page.getByRole("complementary", { name: "Environment work surface" });
  await panel.getByRole("button", { name: "Browser", exact: true }).click();
  const address = panel.getByRole("textbox", { name: "Search or enter URL" });
  const tabs = panel.getByRole("tablist", { name: "Environment views" }).getByRole("tab");
  await panel.getByRole("button", { name: "New browser tab" }).click();
  await expect(address).toBeFocused();
  await panel.getByRole("button", { name: "New browser tab" }).click();
  await expect(tabs).toHaveCount(2);
  await expect(address).toBeFocused();
  await tabs.first().click();
  await expect(tabs.first()).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tabs.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(tabs.last()).toBeFocused();
  await panel.getByRole("button", { name: "Open tabs", exact: true }).click();
  await page.getByRole("menuitem").first().click();
  await expect(tabs.first()).toBeFocused();
  await address.focus();
  await page.evaluate(async (workspaceId) => {
    const ipc = (window as unknown as { aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } } }).aidenAPI.ipc;
    const state = await ipc.invoke<{ tabs: { id: string }[] }>("browser:get-state", workspaceId);
    await ipc.invoke("browser:command", workspaceId, { action: "select", tabId: state.tabs[1].id });
  }, E2E_WORKSPACE_ID);
  await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
  await expect(address).toBeFocused();
});

test("the shared browser strip ignores a delayed command snapshot after a newer close event", async ({ aiden }) => {
  const { page, app } = aiden;
  await finishLmStudioOnboarding(page);
  await page.locator("[data-environment-toggle]").click();
  const panel = page.getByRole("complementary", { name: "Environment work surface" });
  await panel.getByRole("button", { name: "Browser", exact: true }).click();
  await panel.getByRole("button", { name: "New browser tab" }).click();
  await panel.getByRole("button", { name: "New browser tab" }).click();
  const tabs = panel.getByRole("tablist", { name: "Environment views" }).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  const closingId = await page.evaluate(async (workspaceId) => {
    const ipc = (window as unknown as { aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } } }).aidenAPI.ipc;
    const state = await ipc.invoke<{ tabs: { id: string }[] }>("browser:get-state", workspaceId);
    return state.tabs[0].id;
  }, E2E_WORKSPACE_ID);
  await app.evaluate(({ ipcMain }) => {
    const control = globalThis as unknown as { heldBrowserSelect?: boolean; releaseBrowserSelect?: () => void };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown> })._invokeHandlers;
    const original = handlers.get("browser:command")!;
    let holdNextSelect = true;
    ipcMain.removeHandler("browser:command");
    ipcMain.handle("browser:command", async (event, ...args) => {
      const hold = holdNextSelect && (args[1] as { action: string }).action === "select";
      if (hold) holdNextSelect = false;
      const result = await original(event, ...args);
      if (hold) await new Promise<void>((resolve) => { control.releaseBrowserSelect = resolve; control.heldBrowserSelect = true; });
      return result;
    });
  });
  await tabs.first().click();
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { heldBrowserSelect?: boolean }).heldBrowserSelect)).toBe(true);
  await page.evaluate(async ({ workspaceId, tabId }) => {
    const ipc = (window as unknown as { aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } } }).aidenAPI.ipc;
    await ipc.invoke("browser:command", workspaceId, { action: "close", tabId });
  }, { workspaceId: E2E_WORKSPACE_ID, tabId: closingId });
  await expect(tabs).toHaveCount(1);
  // Choose another tool before the stale select returns: it must not reveal Browser.
  await panel.getByRole("button", { name: "New workspace tab" }).click();
  await panel.getByRole("button", { name: "Context", exact: true }).click();
  await app.evaluate(() => (globalThis as unknown as { releaseBrowserSelect?: () => void }).releaseBrowserSelect?.());
  await page.evaluate(async (workspaceId) => {
    const ipc = (window as unknown as { aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } } }).aidenAPI.ipc;
    await ipc.invoke("browser:get-state", workspaceId);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, E2E_WORKSPACE_ID);
  await expect(tabs).toHaveCount(2); // One surviving browser page plus Context.
  await expect(panel.getByRole("tab", { name: "Context", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator("#environment-browser-panel")).toBeHidden();
});

for (const scenario of ["create", "select", "superseded select", "superseded create"] as const) {
  test(`browser ${scenario} distinguishes newer metadata from superseding navigation`, async ({ aiden }) => {
    const { page, app } = aiden;
    const creating = scenario.endsWith("create");
    const superseded = scenario.startsWith("superseded");
    await finishLmStudioOnboarding(page);
    await page.locator("[data-environment-toggle]").click();
    const panel = page.getByRole("complementary", { name: "Environment work surface" });
    if (!creating) {
      await panel.getByRole("button", { name: "Browser", exact: true }).click();
      await panel.getByRole("button", { name: "New browser tab" }).click();
      await expect(panel.getByRole("textbox", { name: "Search or enter URL" })).toBeFocused();
      await panel.getByRole("button", { name: "New workspace tab" }).click();
      await panel.getByRole("button", { name: "Context", exact: true }).click();
    }
    await app.evaluate(({ ipcMain }, action) => {
      const control = globalThis as unknown as { heldMetadataTab?: string; releaseMetadataResponse?: () => void };
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get("browser:command")!;
      let holdNext = true;
      ipcMain.removeHandler("browser:command");
      ipcMain.handle("browser:command", async (event, ...args) => {
        const command = args[1] as { action: string; tabId?: string };
        const hold = holdNext && command.action === action;
        if (hold) holdNext = false;
        const result = await original(event, ...args) as { tabId?: string };
        if (hold) await new Promise<void>((resolve) => {
          control.heldMetadataTab = result.tabId ?? command.tabId;
          control.releaseMetadataResponse = resolve;
        });
        return result;
      });
    }, creating ? "create" : "select");
    if (creating) {
      await panel.getByRole("textbox", { name: "Open a URL" }).fill("about:blank");
      await panel.getByRole("textbox", { name: "Open a URL" }).press("Enter");
    } else {
      await panel.getByRole("tablist", { name: "Environment views" }).getByRole("tab").first().click();
    }
    await expect.poll(() => app.evaluate(() => Boolean((globalThis as unknown as { heldMetadataTab?: string }).heldMetadataTab))).toBe(true);
    const tabId = await app.evaluate(() => (globalThis as unknown as { heldMetadataTab: string }).heldMetadataTab);
    await page.evaluate(async ({ workspaceId, tabId }) => {
      const ipc = (window as unknown as { aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } } }).aidenAPI.ipc;
      await ipc.invoke("browser:command", workspaceId, { action: "mute", tabId, muted: true });
    }, { workspaceId: E2E_WORKSPACE_ID, tabId });
    // Metadata does not reveal the presenter. Hidden creates intentionally leave
    // the active page unchanged until their navigation intent is revalidated.
    if (!creating) await expect(panel.locator('#environment-browser-panel .browser-chrome button[aria-label="Unmute tab"]')).toHaveCount(1);
    await expect(panel.locator("#environment-browser-panel")).toBeHidden();
    if (superseded) {
      await panel.getByRole("button", { name: "New workspace tab" }).click();
      await panel.getByRole("button", { name: "Files", exact: true }).click();
    }
    await app.evaluate(() => (globalThis as unknown as { releaseMetadataResponse?: () => void }).releaseMetadataResponse?.());
    await page.evaluate(async (workspaceId) => {
      const ipc = (window as unknown as { aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } } }).aidenAPI.ipc;
      await ipc.invoke("browser:get-state", workspaceId);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, E2E_WORKSPACE_ID);
    if (superseded) {
      await expect(panel.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(panel.locator("#environment-browser-panel")).toBeHidden();
    } else {
      await expect(panel.locator("#environment-browser-panel")).toBeVisible();
      await expect(panel.getByRole("button", { name: "Unmute tab", exact: true })).toBeVisible();
    }
  });
}
