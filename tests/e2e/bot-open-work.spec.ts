import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { defaultBotRulesView } from "../../renderer/shared/bot-rules";
import type { BotOpenWorkSnapshot } from "../../renderer/shared/bot-open-work";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// Real Electron bridge and routed UI; store/replay/cancellation use real SQLite
// and durable-file fixtures in test:bot-open-work.
test("Open work keeps source evidence readable and its editor usable at narrow widths", async ({ aiden }) => {
  const { page } = aiden;
  const bot = botFixture({ id: "bot-work", name: "Work Helper" });
  const snapshot: BotOpenWorkSnapshot = { botId: bot.id, revision: "view-1", undo: [], items: [{
    id: "invoice", revision: "item-1", title: "Review invoice", note: "Reconcile the total with the purchase order.", state: "waiting", waitingReason: "Waiting for the receipt", createdAt: 10, updatedAt: 10,
    source: { kind: "person", submissionId: "1", entryId: "2" }, links: [{ kind: "source", submissionId: "1", entryId: "2" }], execution: { state: "idle", canStop: false },
  }] };
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }, data) => {
    const handlers: Record<string, () => unknown> = {
      "bots:list": () => [data.bot], "bots:get": () => data.bot, "bots:getCanonicalPhoto": () => null, "bots:pendingApprovals": () => [],
      "bots:live:summary": () => ({ botId: data.bot.id, preview: null, updatedAt: null, state: { kind: "idle" } }),
      "bots:live:subscribe": () => ({ botId: data.bot.id, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [], state: { kind: "idle" } }),
      "bots:rules:get": () => data.rules, "bots:routines:list": () => [], "bots:eventRoutines:list": () => [], "bots:health:report": () => null,
      "bots:memory:get": () => ({ botId: data.bot.id, available: true, entries: [], usedTokens: 0, tokenLimit: 2000 }),
      "bots:openWork:snapshot": () => data.snapshot,
      "bots:openWork:evidence": () => ({ itemId: "invoice", kind: "source", submissionId: "1", entryId: "2", title: "Original invoice request", text: "Compare <invoice> totals with the order.\nKeep the original text readable.", truncated: false }),
    };
    for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
  }, { bot, rules: defaultBotRulesView(bot.id), snapshot });
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  // The Bot's name opens its Advanced tab, whose Open work row opens the page.
  await page.getByRole("button", { name: "Work Helper settings" }).click();
  await page.getByRole("tabpanel", { name: "Advanced" }).getByRole("button", { name: /^Open work/u }).click();
  await expect(page.getByText("Waiting · Waiting for the receipt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View request", exact: true }).click();
  const evidence = page.getByRole("dialog", { name: "Original invoice request" });
  await expect(evidence).toContainText("Compare <invoice> totals with the order.");
  await evidence.getByRole("button", { name: "Close", exact: true }).click();
  await expect(evidence).toBeHidden();
  await page.getByRole("button", { name: "Edit work Review invoice" }).click();
  await expect(page.getByLabel("Work title")).toHaveValue("Review invoice");
  for (const width of [1280, 600, 390]) {
    await aiden.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]!.setSize(w, 900), width);
    await page.getByRole("button", { name: "Save work", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Save work", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByLabel("Work title").focus();
    await expect(page.getByLabel("Work title")).toBeFocused();
  }
  await page.screenshot({ path: test.info().outputPath("open-work-editor.png"), fullPage: true });
});
