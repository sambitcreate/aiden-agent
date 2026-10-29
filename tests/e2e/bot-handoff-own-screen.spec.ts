import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// The e2e profile cannot open the real Bot store (no Keychain authority), so
// only the Bot IPC is substituted, as in bots-starter.spec.ts. The chat, its
// hand-off card and the panel it opens are the shipped renderer. A step the
// Bot hands over in its own browser (`target: "browser"`) opens there, never
// in the person's own browser.
test("a step on the Bot's own browser opens in the Bot's browser, not the person's, and is answered Done", async ({ aiden }) => {
  const { page } = aiden;
  const bot = botFixture({ id: "bot-shop", name: "Grocer", description: "Orders the weekly shop" });
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));

  await aiden.app.evaluate(({ ipcMain }, fixture) => {
    const state = { answers: [] as unknown[], opened: [] as unknown[] };
    (globalThis as unknown as { ownScreenE2e: typeof state }).ownScreenE2e = state;
    for (const channel of [
      "bots:list",
      "bots:get",
      "bots:live:subscribe",
      "bots:live:summary",
      "bots:getCanonicalPhoto",
      "bots:pendingApprovals",
      "bots:answerHandoff",
      "bots:openHandoff",
    ]) ipcMain.removeHandler(channel);
    const idle = { botId: fixture.id, preview: null, updatedAt: 1_000, state: { kind: "idle" }, needsYou: false, lastReplyAt: null };
    ipcMain.handle("bots:list", () => [fixture]);
    ipcMain.handle("bots:get", () => fixture);
    ipcMain.handle("bots:live:summary", () => idle);
    ipcMain.handle("bots:live:subscribe", () => ({
      botId: fixture.id,
      epoch: "e1",
      seq: 0,
      partial: null,
      state: { kind: "idle" },
      question: null,
      activity: null,
      queued: [],
      entries: [
        { id: "u1", type: "user", text: "Order this week's groceries", imageCount: 0 },
        { id: "a1", type: "assistant", text: "The basket is ready. One step is yours.", toolCalls: [], stopReason: "stop" },
      ],
    }));
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
    ipcMain.handle("bots:answerHandoff", (_event, input: unknown) => {
      state.answers.push(input);
      return { answered: true };
    });
    ipcMain.handle("bots:openHandoff", (_event, input: unknown) => {
      state.opened.push(input);
      return { opened: "browser" };
    });
  }, bot);

  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await expect(page.getByText("The basket is ready. One step is yours.")).toBeVisible();
  await aiden.app.evaluate(({ BrowserWindow }, botId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("bots:live:event", {
        botId,
        epoch: "e1",
        seq: 1,
        type: "handoff",
        handoff: {
          botId,
          waitId: "3c7e9a1b-5d2f-4e8a-9b6c-0a1d2e3f4a5b",
          toolCallId: "call-1",
          kind: "action",
          action: "Choose the delivery slot on the checkout page",
          why: "The shop wants you to pick the time yourself.",
          open: { url: "https://shop.example/checkout" },
          target: "browser",
          source: "tool",
        },
      });
    }
  }, bot.id);

  const card = page.getByRole("group", { name: "Grocer needs you" });
  await expect(card.getByText("Your turn: Choose the delivery slot on the checkout page")).toBeVisible();
  await expect(card).toContainText("Opens in Grocer’s own browser at shop.example, not in yours.");
  await expect(card.getByRole("button", { name: "Open shop.example" })).toHaveCount(0);
  await card.getByRole("button", { name: "Open in Grocer’s browser" }).click();
  await expect
    .poll(() => aiden.app.evaluate(() => (globalThis as unknown as { ownScreenE2e: { opened: unknown[] } }).ownScreenE2e.opened))
    .toEqual([{ botId: "bot-shop", waitId: "3c7e9a1b-5d2f-4e8a-9b6c-0a1d2e3f4a5b" }]);
  // The Bot's panel opens beside the chat, on its browser.
  await expect(page.locator("#bot-panel")).toHaveAttribute("data-state", "open");

  await card.getByRole("button", { name: "Done", exact: true }).click();
  await expect
    .poll(() => aiden.app.evaluate(() => (globalThis as unknown as { ownScreenE2e: { answers: unknown[] } }).ownScreenE2e.answers))
    .toEqual([{ botId: "bot-shop", waitId: "3c7e9a1b-5d2f-4e8a-9b6c-0a1d2e3f4a5b", outcome: "done" }]);
});
