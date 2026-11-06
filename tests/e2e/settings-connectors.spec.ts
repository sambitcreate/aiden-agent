import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMcpPreset, serverFromPreset } from "../../main/services/mcp-presets";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const FAKE_SERVER = fileURLToPath(new URL("./mcp-stdio-fake.mjs", import.meta.url));

test.describe("Settings → Connectors", () => {
  test("adds a custom local connector and shows its live status and tools", async ({ aiden }) => {
    const { page } = aiden;
    await finishLmStudioOnboarding(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Connectors", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Connectors", exact: true })).toBeVisible();
    // Hosted Figma can't be set up; it points at Figma Desktop instead.
    await expect(page.getByRole("button", { name: "Use Figma Desktop instead of Figma" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Set Up Figma", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Add custom connector" }).click();
    const dialog = page.getByRole("dialog", { name: "Add custom connector" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("group", { name: "Name" }).getByRole("textbox").fill("E2E Tools");
    await dialog.getByRole("group", { name: "Command" }).getByRole("textbox").fill(process.execPath);
    await dialog.getByRole("textbox", { name: "Arguments" }).fill(FAKE_SERVER);
    // A new local launch asks in a native review box first. Playwright can't click native
    // boxes, so answer it in the main process and keep what it was asked to show.
    await aiden.app.evaluate(({ dialog: nativeDialog }) => {
      const asked: string[] = [];
      (globalThis as { __aidenLaunchReviews?: string[] }).__aidenLaunchReviews = asked;
      nativeDialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.find((arg) => arg !== null && typeof arg === "object" && "buttons" in (arg as object)) as { detail?: string };
        asked.push(options.detail ?? "");
        return { response: 1, checkboxChecked: false };
      }) as typeof nativeDialog.showMessageBox;
    });
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    const reviews = await aiden.app.evaluate(() => (globalThis as { __aidenLaunchReviews?: string[] }).__aidenLaunchReviews ?? []);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain(FAKE_SERVER);

    // Approving that review approves the command it showed, and Aiden connects in the background.
    const status = page.getByLabel("E2E Tools status");
    await expect(status).toContainText("Connected", { timeout: 20_000 });
    await expect(status).toContainText("Tools 2");
    await expect(page.getByRole("switch", { name: "Enable E2E Tools" })).toHaveAttribute("data-state", "checked");
  });

  test("an open launch review does not hold up changes to other connectors", async ({ aiden }) => {
    await finishLmStudioOnboarding(aiden.page);
    // A remote connector saved earlier, switched off.
    const page = await aiden.relaunch(async () => {
      const file = path.join(aiden.configDir, "config.json");
      const config = JSON.parse(await readFile(file, "utf8"));
      config.mcpServers = [{ id: "docs", name: "Docs", transport: "http", url: "http://127.0.0.1:9/mcp", enabled: false }];
      await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Connectors", exact: true })
      .click();
    const docs = page.getByRole("switch", { name: "Enable Docs" });
    await expect(docs).toHaveAttribute("data-state", "unchecked");

    await page.getByRole("button", { name: "Add custom connector" }).click();
    const dialog = page.getByRole("dialog", { name: "Add custom connector" });
    await dialog.getByRole("group", { name: "Name" }).getByRole("textbox").fill("E2E Tools");
    await dialog.getByRole("group", { name: "Command" }).getByRole("textbox").fill(process.execPath);
    await dialog.getByRole("textbox", { name: "Arguments" }).fill(FAKE_SERVER);
    // Keep the native review open until the test answers it.
    await aiden.app.evaluate(({ dialog: nativeDialog }) => {
      const state = globalThis as { __aidenReviewAnswers?: ((response: number) => void)[] };
      state.__aidenReviewAnswers = [];
      nativeDialog.showMessageBox = (() =>
        new Promise((resolve) => {
          state.__aidenReviewAnswers!.push((response) => resolve({ response, checkboxChecked: false }));
        })) as unknown as typeof nativeDialog.showMessageBox;
    });
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(() => aiden.app.evaluate(() => (globalThis as { __aidenReviewAnswers?: unknown[] }).__aidenReviewAnswers?.length ?? 0))
      .toBe(1);

    // While the person reads the review, saving another connector still finishes.
    const enabled = await page.evaluate(async () => {
      type Bridge = { aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } } };
      const { ipc } = (window as unknown as Bridge).aidenAPI;
      const docs = (await ipc.invoke<{ id: string; enabled: boolean }[]>("mcp:list")).find(({ id }) => id === "docs")!;
      return (await ipc.invoke<{ enabled: boolean }>("mcp:save", { ...docs, enabled: true })).enabled;
    });
    expect(enabled).toBe(true);

    await aiden.app.evaluate(() => (globalThis as { __aidenReviewAnswers?: ((response: number) => void)[] }).__aidenReviewAnswers![0](1));
    await expect(page.getByLabel("E2E Tools status")).toContainText("Connected", { timeout: 20_000 });
    await expect(docs).toHaveAttribute("data-state", "checked");
  });
});

test("Composio metadata and Calendar read checks are separate explicit Settings actions with one allowance", async ({ aiden }) => {
  await finishLmStudioOnboarding(aiden.page);
  const server = serverFromPreset(getMcpPreset("composio")!);
  await aiden.app.evaluate(({ ipcMain }, saved) => {
    const state = globalThis as { composioChecks?: number; composioReads?: number; composioSaves?: number };
    state.composioChecks = 0; state.composioReads = 0; state.composioSaves = 0;
    const handlers: Record<string, (...args: unknown[]) => unknown> = {
      "mcp:list": () => [saved],
      "mcp:toolList": () => [{ name: "COMPOSIO_SEARCH_TOOLS" }, { name: "COMPOSIO_MULTI_EXECUTE_TOOL" }],
      "mcp:liveStatus": () => [{ serverId: saved.id, state: "connected", toolCount: 1 }],
      "mcp:save": () => { state.composioSaves!++; return saved; },
      "mcp:composioWatch:inspect": (_event, input) => {
        if (input && typeof input === "object" && (input as { calendarRead?: unknown }).calendarRead === true) { state.composioReads!++; return { message: "Calendar's exact-account read check passed." }; }
        state.composioChecks!++; return { available: false, checkedAt: 1, status: "inspected", code: "account_routing_unverified", message: "Composio’s watch schemas were inspected. This metadata check does not verify account routing." };
      },
    };
    for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
  }, server);
  const { page } = aiden;
  // Onboarding caches the original empty connector list. Reload after installing
  // the deterministic fixture so Settings reads that fixture on its first mount.
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Connectors", exact: true }).click();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const tools = page.getByRole("list", { name: "Composio tools" });
  await expect(tools.getByRole("switch")).toHaveCount(1);
  expect(await aiden.app.evaluate(() => (globalThis as { composioChecks?: number }).composioChecks)).toBe(0);
  await page.getByRole("button", { name: "Check watch support", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "This metadata check does not verify account routing" })).toBeVisible();
  expect(await aiden.app.evaluate(() => (globalThis as { composioChecks?: number }).composioChecks)).toBe(1);
  expect(await aiden.app.evaluate(() => (globalThis as { composioReads?: number }).composioReads)).toBe(0);
  await expect(page.getByText(/read your Calendar list and preview up to one day of events/u)).toBeVisible();
  await page.getByRole("button", { name: "Check Calendar reads", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Calendar's exact-account read check passed." })).toBeVisible();
  expect(await aiden.app.evaluate(() => (globalThis as { composioReads?: number }).composioReads)).toBe(1);
  expect(await aiden.app.evaluate(() => (globalThis as { composioSaves?: number }).composioSaves)).toBe(0);
  await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(600, 900));
  await page.getByRole("button", { name: "Check Calendar reads", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Check Calendar reads", exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("composio-watch-support.png"), fullPage: true });
});
