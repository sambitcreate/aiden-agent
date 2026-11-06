import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// Bot persistence needs Keychain authority unavailable in the mock app profile.
// Substitute its projected feed; keep routing, transcript components and actions real.
test("Bot messages name their sender and saved replies stay visible without starting a turn", async ({
  aiden,
}, testInfo) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  const bot = botFixture({ id: "bot-planner", name: "Planner" });
  await aiden.app.evaluate(({ ipcMain }, fixture) => {
    for (const channel of [
      "bots:list",
      "bots:get",
      "bots:getCanonicalPhoto",
      "bots:live:summary",
      "bots:live:subscribe",
      "bots:pendingApprovals",
    ])
      ipcMain.removeHandler(channel);
    ipcMain.handle("bots:list", () => [fixture]);
    ipcMain.handle("bots:get", () => fixture);
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
    ipcMain.handle("bots:live:summary", () => ({
      botId: fixture.id,
      preview: "Saved answer while paused",
      updatedAt: 2000,
      state: { kind: "idle" },
      needsYou: false,
      lastReplyAt: null,
    }));
    ipcMain.handle("bots:live:subscribe", () => ({
      botId: fixture.id,
      epoch: "messaging-fixture",
      seq: 0,
      partial: null,
      state: { kind: "idle" },
      question: null,
      activity: null,
      queued: [],
      entries: [
        {
          id: "asked",
          type: "bot_message",
          kind: "request",
          botId: "bot-jester",
          botName: "Jester",
          text: "Could you check the plan?",
          at: 1000,
        },
        { id: "answer", type: "assistant", text: "I checked it.", toolCalls: [], stopReason: "stop", at: 1001 },
        {
          id: "reply",
          type: "bot_message",
          kind: "reply",
          botId: "bot-cos",
          botName: "COS",
          text: "The appointments are ready.",
          at: 1002,
        },
        {
          id: "waiting",
          type: "bot_message_status",
          data: {
            deliveryId: "waiting",
            botId: "bot-cos",
            botName: "COS",
            outcome: "waiting_approval",
            waitId: "events",
            summary: "Create 3 events",
          },
          at: 1003,
        },
        {
          id: "saved",
          type: "bot_message_status",
          data: {
            deliveryId: "saved",
            botId: "bot-cos",
            botName: "COS",
            outcome: "replied_while_paused",
            text: "Saved answer while paused",
          },
          at: 1004,
        },
      ],
    }));
  }, bot);
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  const conversation = page.getByLabel("Conversation", {exact: true});
  await expect(conversation.getByText("Jester asked", { exact: true })).toBeVisible();
  await expect(conversation.getByText("Could you check the plan?", { exact: true })).toBeVisible();
  await expect(conversation.getByText("COS replied", { exact: true }).first()).toBeVisible();
  await expect(conversation.getByText("The appointments are ready.", { exact: true })).toBeVisible();
  await expect(conversation.getByText("COS is waiting for you to approve: Create 3 events", { exact: true })).toBeVisible();
  await expect(conversation.getByText("Saved answer while paused", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Allow once|Approve|Retry)$/u })).toHaveCount(0);
  await expect(page.getByPlaceholder("Ask Planner")).toBeVisible();
  await expect(page.getByText("LM Studio (local) added.", { exact: true })).toBeHidden();
  for (const [scheme, width] of [
    ["light", 1280],
    ["dark", 600],
  ] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.evaluate(async (mode) => {
      const appearance = await window.aidenAPI.ipc.invoke("settings:getAppearance") as Record<string, unknown>;
      await window.aidenAPI.ipc.invoke("settings:previewAppearance", { ...appearance, mode, reduceMotion: "on" });
    }, scheme);
    await expect(page.locator("html")).toHaveAttribute("data-appearance-scheme", scheme);
    await aiden.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size, 900), width);
    await expect(conversation.getByText("Saved answer while paused", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`bot-messaging-${scheme}.png`) });
  }
  expect(aiden.lmStudio.requests.filter((request) => request.url === "/v1/chat/completions")).toHaveLength(0);
});
