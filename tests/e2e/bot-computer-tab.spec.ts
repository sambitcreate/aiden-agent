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

test("Settings shows Linux Bot computer sizes, 1-4 running choices, and no macOS permissions step when Linux mode is reported", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);

  await aiden.app.evaluate(({ ipcMain }) => {
    let settings = { maxRunning: 2, idleStopMinutes: 10 };
    for (const channel of ["app:getInfo", "botComputers:status", "botComputers:updateSettings"]) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.handle("app:getInfo", () => ({
      name: "Aiden",
      version: "e2e",
      environment: "test",
      capabilities: { platform: "darwin", subagents: true, bots: true, computerUse: true, botComputers: true },
    }));
    ipcMain.handle("botComputers:status", () => ({
      setup: { kind: "not_set_up" },
      settings,
      diskUsedBytes: 0,
      freeDiskBytes: 200_000_000_000,
      computers: [],
      requirements: {
        downloadBytes: 3_221_225_472,
        baseDiskBytes: 8_000_000_000,
        setupFreeBytes: 20_401_094_656,
        memoryPerComputerBytes: 4 * 1024 ** 3,
        baseVersion: "13",
        guestOs: "linux",
        maxRunningLimit: 4,
      },
    }));
    ipcMain.handle("botComputers:updateSettings", (_event, patch: Partial<typeof settings>) => {
      settings = { ...settings, ...patch };
      return settings;
    });
  });
  await page.reload();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settingsNav = page.getByRole("navigation", { name: "Settings" });
  await settingsNav.getByRole("button", { name: "Computers & VMs", exact: true }).click();
  await page.getByRole("tab", { name: "Bot computers", exact: true }).click();

  await expect(page.getByRole("button", { name: "Set up", exact: true })).toBeVisible();
  await expect(page.getByText(/downloads Debian 13 \(about 3 GB, plus desktop packages\)/u)).toBeVisible();
  await expect(page.getByText(/base computer of about 8 GB/u)).toBeVisible();
  await expect(page.getByText(/needs about 20 GB free/u)).toBeVisible();
  await expect(page.getByText(/about 4 GB of memory/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up element control" })).toHaveCount(0);

  const runningLimit = page.getByRole("combobox", { name: "Computers running at once" });
  await runningLimit.click();
  await expect(page.getByRole("option", { name: "4 computers", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "4 computers", exact: true }).click();
  await expect(runningLimit).toContainText("4 computers");
});
