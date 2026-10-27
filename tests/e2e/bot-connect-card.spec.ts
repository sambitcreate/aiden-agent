import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// The e2e profile cannot open the real Bot store (no Keychain authority), so
// only the Bot IPC is substituted, as in bots-sidebar-panel.spec.ts. The chat,
// its connect card and the tap that adds the app are the shipped renderer.
// Main reports the card as `needs_access` when the app is connected in Aiden
// but left out of this Custom-access Bot; after the grant it re-projects the
// card, which then reads Connected.
test("a connect card for an app this Bot's access leaves out adds it only on the person's tap", async ({ aiden }) => {
  const { page } = aiden;
  const bot = botFixture({ id: "bot-notes", name: "Note Keeper", description: "Keeps my notes tidy" });
  await finishLmStudioOnboarding(page);

  await aiden.app.evaluate(({ ipcMain }, fixture) => {
    const state = { grants: [] as unknown[], connects: 0 };
    (globalThis as unknown as { connectCardE2e: typeof state }).connectCardE2e = state;
    for (const channel of [
      "bots:list",
      "bots:get",
      "bots:live:subscribe",
      "bots:live:summary",
      "bots:getCanonicalPhoto",
      "bots:pendingApprovals",
      "bots:connections:grant",
    ]) ipcMain.removeHandler(channel);
    const entries = (status: string) => [
      { id: "u1", type: "user", text: "Tidy my meeting notes", imageCount: 0 },
      {
        id: "c1",
        type: "connect_card",
        card: { type: "connect_card", pluginId: "notion", reason: "So I can file your meeting notes in Notion.", status },
      },
    ];
    const snapshot = (status: string, seq: number) => ({
      botId: fixture.id,
      epoch: "e1",
      seq,
      partial: null,
      state: { kind: "idle" },
      question: null,
      activity: null,
      queued: [],
      entries: entries(status),
    });
    ipcMain.handle("bots:list", () => [fixture]);
    ipcMain.handle("bots:get", () => fixture);
    ipcMain.handle("bots:live:summary", () => ({
      botId: fixture.id,
      preview: null,
      updatedAt: 1_000,
      state: { kind: "idle" },
      needsYou: false,
      lastReplyAt: null,
    }));
    ipcMain.handle("bots:live:subscribe", () => snapshot("needs_access", 0));
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
    ipcMain.handle("bots:connections:grant", (event, botId: unknown, pluginId: unknown) => {
      state.grants.push([botId, pluginId]);
      event.sender.send("bots:live:event", { botId: fixture.id, epoch: "e1", seq: 1, type: "snapshot", snapshot: snapshot("connected", 1) });
    });
  }, bot);

  await page.getByRole("button", { name: "Bots", exact: true }).click();
  const card = page.getByRole("group", { name: "Add Notion to this Bot" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("So I can file your meeting notes in Notion.");
  await expect(card).toContainText("Notion is connected in Aiden, but this Bot’s access doesn’t include it yet.");
  await expect(card.getByRole("button", { name: "Connect Notion" })).toHaveCount(0);
  // Showing the card grants nothing.
  expect(await aiden.app.evaluate(() => (globalThis as unknown as { connectCardE2e: { grants: unknown[] } }).connectCardE2e.grants)).toEqual([]);

  await card.getByRole("button", { name: "Add Notion to this Bot" }).click();
  await expect
    .poll(() => aiden.app.evaluate(() => (globalThis as unknown as { connectCardE2e: { grants: unknown[] } }).connectCardE2e.grants))
    .toEqual([["bot-notes", "notion"]]);
  const settled = page.getByRole("group", { name: "Notion", exact: true });
  await expect(settled).toContainText("Connected");
  await expect(page.getByRole("button", { name: "Add Notion to this Bot" })).toHaveCount(0);
});
