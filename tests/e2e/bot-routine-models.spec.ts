import { readFileSync } from "node:fs";
import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { defaultBotRulesView } from "../../renderer/shared/bot-rules";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const models = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/fixtures/bot-routine-models.json", import.meta.url), "utf8"));

test("a routine model and its explicit fallback can be saved from the routed Profile with responsive controls", async ({ aiden }) => {
  const { page } = aiden, bot = botFixture({ id: "bot_model", name: "Model Helper" });
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }, data) => {
    const settings = { ...data.models.settings, selection: { mode: "inherit" }, revision: "initial" }; delete settings.lastMutationId;
    const state = globalThis as { routineModelSaves?: unknown[] }; state.routineModelSaves = [];
    const handlers: Record<string, (...args: unknown[]) => unknown> = {
      "bots:list": () => [data.bot], "bots:get": () => data.bot, "bots:getCanonicalPhoto": () => null, "bots:pendingApprovals": () => [],
      "bots:live:summary": () => ({ botId: data.bot.id, preview: null, updatedAt: null, state: { kind: "idle" } }),
      "bots:live:subscribe": () => ({ botId: data.bot.id, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [], state: { kind: "idle" } }),
      "bots:rules:get": () => data.rules,
      "bots:routines:list": () => [{ id: "routine_model", botId: data.bot.id, name: "Morning review", prompt: "Review the morning updates.", schedule: { kind: "daily", time: "09:00" }, timezone: "UTC", label: "Every day at 9:00 AM", enabled: true, updatedAt: 10, pendingFireCount: 0 }],
      "bots:eventRoutines:list": () => [], "bots:health:report": () => null,
      "bots:memory:get": () => ({ botId: data.bot.id, available: true, entries: [], usedTokens: 0, tokenLimit: 2000 }),
      "bots:openWork:snapshot": () => ({ botId: data.bot.id, revision: "empty", items: [], undo: [] }),
      "bots:routineModels:read": () => settings,
      "bots:routineModels:catalog": () => data.models.catalog,
      "bots:routineModels:runs": () => data.models.runs,
      "bots:routineModels:save": (input) => {
        const request = input as { mutationId: string; selection: { mode: string } };
        state.routineModelSaves!.push(request); Object.assign(settings, { selection: request.selection, revision: "saved", lastMutationId: request.mutationId });
        return { ok: true, mutationId: request.mutationId, replayed: false, settings };
      },
    };
    for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, (_event, ...args) => handler(...args)); }
  }, { bot, rules: defaultBotRulesView(bot.id), models });
  await page.reload();
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await page.getByRole("button", { name: "Model Helper profile" }).click();
  await page.getByRole("button", { name: "Model for Morning review", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Model for Morning review" });
  await dialog.getByRole("combobox", { name: "Model choice", exact: true }).click();
  await page.getByRole("option", { name: "Choose a routine model", exact: true }).click();
  await dialog.getByRole("button", { name: "Primary model", exact: true }).click();
  await page.getByRole("option", { name: /Reasoner/ }).click();
  await dialog.getByRole("combobox", { name: "Primary model thinking" }).click();
  await page.getByRole("option", { name: "High", exact: true }).click();
  await dialog.getByRole("switch", { name: "Allow a fallback I choose" }).click();
  await expect(dialog.getByRole("button", { name: "Save model", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Fallback model", exact: true }).click();
  await page.getByRole("option", { name: /Writer/ }).click();
  await dialog.getByRole("button", { name: "Save model", exact: true }).click();
  await expect(dialog.getByText("Routine model saved. Future runs use this choice.", { exact: true })).toBeVisible();
  const saves = await aiden.app.evaluate(() => (globalThis as { routineModelSaves?: unknown[] }).routineModelSaves);
  expect(saves).toHaveLength(1);
  expect((saves![0] as { selection: unknown }).selection).toEqual({ mode: "selected", primary: { providerId: "provider_1", modelId: "model_a", thinkingLevel: "high" }, fallback: { providerId: "provider_2", modelId: "model_b", thinkingLevel: "off" } });
  await expect(dialog.getByText("Chosen Reasoner · Primary service · High thinking", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Used Writer", { exact: true })).toBeVisible();
  for (const width of [1280, 600, 390]) {
    await aiden.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]!.setSize(w, 900), width);
    await dialog.getByRole("button", { name: "Save model", exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Save model", exact: true })).toBeInViewport();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const saveBox = await dialog.getByRole("button", { name: "Save model", exact: true }).boundingBox();
    const grantBox = await dialog.getByText("Saving grants this routine access to the chosen models under the Bot’s rules and spending limits.", { exact: true }).boundingBox();
    expect(saveBox!.y).toBeGreaterThanOrEqual(grantBox!.y + grantBox!.height);
    await dialog.getByRole("combobox", { name: "Model choice", exact: true }).focus();
    await expect(dialog.getByRole("combobox", { name: "Model choice", exact: true })).toBeFocused();
  }
  await page.screenshot({ path: test.info().outputPath("routine-model-choices.png"), fullPage: true });
});
