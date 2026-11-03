import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { BOT_CONNECTOR_WATCH_TEMPLATES } from "../../renderer/shared/bot-connector-watches";
import { defaultBotRulesView } from "../../renderer/shared/bot-rules";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// Exercise the shipped Electron bridge, controls and layout with deterministic
// connector metadata. Host authority and crash handoff have separate real-store suites.
test("connector watches require explicit source discovery and keep the editor usable at narrow widths", async ({ aiden }) => {
  const { page } = aiden;
  const bot = botFixture({ id: "bot-mail", name: "Inbox Helper" });
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }, data) => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {
      "bots:list": () => [data.bot],
      "bots:get": () => data.bot,
      "bots:getCanonicalPhoto": () => null,
      "bots:pendingApprovals": () => [],
      "bots:live:summary": () => ({ botId: data.bot.id, preview: null, updatedAt: null, state: { kind: "idle" } }),
      "bots:live:subscribe": () => ({ botId: data.bot.id, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [], state: { kind: "idle" } }),
      "bots:rules:get": () => data.rules,
      "bots:routines:list": () => [],
      "bots:eventRoutines:list": () => [],
      "bots:health:report": () => null,
      "bots:memory:get": () => ({ botId: data.bot.id, available: true, entries: [], usedTokens: 0, tokenLimit: 2000 }),
      "bots:connectorWatches:list": () => ({ supported: true, templates: data.templates, watches: [] }),
      "bots:connectorWatches:discoverSources": () => {
        (globalThis as { watchDiscoveries?: number }).watchDiscoveries = ((globalThis as { watchDiscoveries?: number }).watchDiscoveries ?? 0) + 1;
        return { choices: [{ id: "opaque-work-inbox", templateId: "mail_messages", providerLabel: "Mail", accountLabel: "Work", resourceLabel: "Inbox", available: true }], unavailableReasons: [] };
      },
      "bots:connectorWatches:testCheck": () => ({ checkedAt: 1, result: "baseline", itemCount: 2, changeCount: 0, preview: ["Invoice update", "Meeting notes"] }),
    };
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, ...args) => handler(...args));
    }
  }, { bot, templates: BOT_CONNECTOR_WATCH_TEMPLATES, rules: defaultBotRulesView(bot.id) });
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await page.getByRole("button", { name: "Inbox Helper profile" }).click();
  const group = page.getByRole("heading", { name: "Connected-app watches", exact: true }).locator("..");
  await expect(group.getByText("No connected-app watches", { exact: true })).toBeVisible();
  expect(await aiden.app.evaluate(() => (globalThis as { watchDiscoveries?: number }).watchDiscoveries ?? 0)).toBe(0);
  await group.getByRole("button", { name: "Add watch", exact: true }).click();
  await group.getByLabel("Watch name").fill("Work invoices");
  await group.getByLabel("What the Bot should do").fill("Summarize important invoice changes.");
  await expect(group.getByRole("button", { name: "Add watch", exact: true })).toBeDisabled();
  await group.getByRole("button", { name: "Find sources" }).click();
  await group.getByRole("combobox", { name: "Connected source" }).click();
  await page.getByRole("option", { name: "Mail · Work · Inbox" }).click();
  await expect(group.getByRole("button", { name: "Add watch", exact: true })).toBeEnabled();
  await group.getByRole("button", { name: "Test check", exact: true }).click();
  await expect(group.getByText("Invoice update", { exact: true })).toBeVisible();
  for (const width of [1280, 600, 390]) {
    await aiden.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]!.setSize(w, 900), width);
    const save = group.getByRole("button", { name: "Add watch", exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    expect(await group.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await group.getByLabel("Watch name").focus();
    await expect(group.getByLabel("Watch name")).toBeFocused();
  }
  await page.screenshot({ path: test.info().outputPath("connector-watch-editor.png"), fullPage: true });
  expect(await aiden.app.evaluate(() => (globalThis as { watchDiscoveries?: number }).watchDiscoveries)).toBe(1);
});
