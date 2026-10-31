import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// Bot computers need an Apple silicon Mac and the e2e profile has no Bot store
// authority, so only the platform capability, the Bot IPC and the Bot-computer
// IPC are substituted. The panel, the Computer tab and the app's stylesheet
// are the shipped renderer: this is where the CSS cascade decides the colour.
test("a computer that fails to start says why in the status red, not in the empty state's grey", async ({ aiden }) => {
  const { page } = aiden;
  const planner = botFixture({ id: "bot-planner", name: "Planner", description: "Plans meals" });
  await finishLmStudioOnboarding(page);

  await aiden.app.evaluate(({ ipcMain }, bot) => {
    const vmName = "aiden-bot-0123456789abcdef";
    for (const channel of [
      "app:getInfo",
      "bots:list",
      "bots:get",
      "bots:live:subscribe",
      "bots:live:summary",
      "bots:getCanonicalPhoto",
      "bots:pendingApprovals",
      "bots:routines:list",
      "botComputers:status",
      "botComputers:pointer",
      "botComputers:viewerGrant",
    ]) ipcMain.removeHandler(channel);
    ipcMain.handle("app:getInfo", () => ({
      name: "Aiden",
      version: "e2e",
      environment: "test",
      capabilities: { platform: "darwin", subagents: true, bots: true, computerUse: true, botComputers: true },
    }));
    ipcMain.handle("bots:list", () => [bot]);
    ipcMain.handle("bots:get", (_event, botId: string) => (botId === bot.id ? bot : null));
    ipcMain.handle("bots:live:summary", (_event, botId: string) => ({
      botId,
      preview: "",
      updatedAt: 1_000,
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
      entries: [],
    }));
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
    ipcMain.handle("bots:routines:list", () => []);
    ipcMain.handle("botComputers:status", () => ({
      setup: { kind: "ready", baseBuild: "25G83", baseVersion: "26.6.2", updateAvailable: false },
      settings: { maxRunning: 2, idleStopMinutes: 10 },
      diskUsedBytes: 0,
      computers: [{ botId: bot.id, vmName, state: "stopped", baseBuild: "25G83", outdated: false, controller: "bot" }],
      requirements: {
        downloadBytes: 19_772_231_540,
        baseDiskBytes: 50_000_000_000,
        setupFreeBytes: 84_196_731_252,
        memoryPerComputerBytes: 8 * 1024 ** 3,
        baseVersion: "26.6.2",
      },
    }));
    ipcMain.handle("botComputers:pointer", () => null);
    ipcMain.handle("botComputers:viewerGrant", () => {
      throw new Error("Not enough free memory to start Planner's computer.");
    });
  }, planner);
  // The panel opens on Activity, so the person switching to Computer is what starts it.
  await page.evaluate(() => {
    localStorage.setItem("aiden-agent.bot-panel.open", "true");
    localStorage.setItem("aiden-agent.bot-panel.tab", "activity");
  });
  await page.reload();

  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await expect(page.getByPlaceholder("Ask Planner")).toBeVisible();
  const panel = page.getByRole("complementary", { name: "Bot panel" });
  await panel.getByRole("tab", { name: "Computer" }).click();
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText("Not enough free memory");
  await expect(panel.getByRole("button", { name: "Try again" })).toBeVisible();

  // The theme's own tokens, resolved in this page, are the oracle.
  const colors = await alert.evaluate((element) => {
    const resolve = (token: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      element.parentElement!.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return { alert: getComputedStyle(element).color, red: resolve("--status-red"), secondary: resolve("--text-secondary") };
  });
  expect(colors.red).not.toBe(colors.secondary);
  expect(colors.alert).toBe(colors.red);
  // The note above it keeps the empty state's secondary text.
  const note = panel.getByText("It starts when Planner needs it, or when you start it here.");
  expect(await note.evaluate((element) => getComputedStyle(element).color)).toBe(colors.secondary);
});
