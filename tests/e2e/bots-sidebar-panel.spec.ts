import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// The e2e profile cannot open the real Bot store (no Keychain authority), so
// only the Bot IPC is substituted, as in bots-starter.spec.ts. The sidebar,
// routing, panel and workspace panel are the shipped renderer.
test("the Bots page lists only Bots, opens the latest one, and its panel shows a file it made without touching the workspace panel", async ({
  aiden,
}) => {
  const { page } = aiden;
  const planner = botFixture({ id: "bot-planner", name: "Planner", description: "Plans meals" });
  const inbox = botFixture({ id: "bot-inbox", name: "Inbox Helper", description: "Email" });
  await finishLmStudioOnboarding(page);
  await page.locator("[data-environment-toggle]").click();
  await expect(page.locator("#environment-panel")).toHaveAttribute("data-state", "open");
  const workspaceTabs = await page.evaluate(() => localStorage.getItem("aiden-agent.environment.open-tabs-v1"));

  await aiden.app.evaluate(({ ipcMain }, bots) => {
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
    const [plannerBot] = bots;
    for (const channel of [
      "bots:list",
      "bots:get",
      "bots:live:subscribe",
      "bots:live:summary",
      "bots:getCanonicalPhoto",
      "bots:pendingApprovals",
      "bots:files:list",
      "bots:files:read",
    ]) ipcMain.removeHandler(channel);
    ipcMain.handle("bots:list", () => bots);
    ipcMain.handle("bots:get", (_event, botId: string) => byId.get(botId) ?? null);
    ipcMain.handle("bots:live:summary", (_event, botId: string) => ({
      botId,
      preview: botId === plannerBot!.id ? "Here’s your week." : "Inbox is clear.",
      updatedAt: botId === plannerBot!.id ? 2_000 : 1_000,
      state: { kind: "idle" },
      needsYou: false,
      lastReplyAt: null,
    }));
    ipcMain.handle("bots:live:subscribe", (_event, botId: string) => ({
      botId,
      epoch: "e1",
      seq: 0,
      partial: null,
      state: { kind: "idle" },
      question: null,
      activity: null,
      queued: [],
      entries:
        botId === plannerBot!.id
          ? [
              { id: "u1", type: "user", text: "Plan dinners", imageCount: 0 },
              { id: "f1", type: "file", path: "lists/groceries.md", operation: "written" },
              { id: "a1", type: "assistant", text: "Here’s your week.", toolCalls: [], stopReason: "stop" },
            ]
          : [],
    }));
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
    ipcMain.handle("bots:files:list", () => ({
      entries: [
        { path: "lists", name: "lists", parentPath: "", depth: 0, kind: "directory" },
        { path: "lists/groceries.md", name: "groceries.md", parentPath: "lists", depth: 1, kind: "file" },
      ],
      truncated: false,
      skippedDirectories: 0,
    }));
    ipcMain.handle("bots:files:read", (_event, _botId: string, path: string) => ({
      path,
      content: "eggs\nmilk",
      size: 9,
      modifiedAt: 1,
      version: "v1",
    }));
  }, [planner, inbox]);

  await page.getByRole("button", { name: "Bots", exact: true }).click();
  const botsNav = page.getByRole("navigation", { name: "Bots" });
  await expect(botsNav.getByRole("button", { name: /^Planner/u })).toBeVisible();
  await expect(botsNav.getByRole("button", { name: /^Inbox Helper/u })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  await expect(page.getByPlaceholder("Ask Planner")).toBeVisible();
  // Still open, but covered: the workspace panel keeps its state while a Bots page is showing.
  await expect(page.locator("#environment-panel")).toHaveAttribute("data-state", "covered");

  await page.getByRole("button", { name: "Open groceries.md" }).click();
  const panel = page.getByRole("complementary", { name: "Bot panel" });
  await expect(panel.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByLabel("Contents of lists/groceries.md")).toHaveText("eggs\nmilk");

  const sendToggle = () =>
    aiden.app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("app:command", { commandId: "environment.toggle" });
      }
    });
  await sendToggle();
  await expect(page.locator("#bot-panel")).toHaveAttribute("data-state", "closed");
  await sendToggle();
  await expect(page.locator("#bot-panel")).toHaveAttribute("data-state", "open");
  expect(await page.evaluate(() => localStorage.getItem("aiden-agent.environment.open-tabs-v1"))).toBe(workspaceTabs);

  await page.getByRole("button", { name: "Back to Aiden" }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.locator("#environment-panel")).toHaveAttribute("data-state", "open");
  expect(await page.evaluate(() => localStorage.getItem("aiden-agent.environment.open-tabs-v1"))).toBe(workspaceTabs);
});
