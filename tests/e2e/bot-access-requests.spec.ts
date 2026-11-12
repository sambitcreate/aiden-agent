import { botFixture } from "../../renderer/main/bots/test-fixtures";
import type { BotPendingAccessRequest } from "../../renderer/shared/bot-access-requests";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

interface AccessE2eState {
  answers: unknown[];
  failNext: boolean;
  saveForFuture: boolean;
  release(): void;
  replace(request: BotPendingAccessRequest): void;
}

// Substitute the projected Bot feed because the mock profile has no Keychain
// authority. The card, keyboard interaction, IPC client and error handling are real.
test("access cards keep their scope visible and wait for the host's answer", async ({ aiden }, testInfo) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  const bot = botFixture({id: "bot-access", name: "Planner"});
  const request: BotPendingAccessRequest = {
    botId: bot.id,
    waitId: "11112233-4455-4677-8899-aabbccddeeff",
    toolCallId: "access-call-1",
    target: "folder",
    label: "Taxes",
    place: "~/Documents/Taxes",
    why: "To sort this year's receipts without changing the rest of your Documents folder.",
    choices: ["not_now", "always", "once"],
  };
  await aiden.app.evaluate(({ipcMain, BrowserWindow}, input) => {
    let pending: typeof input.request | null = input.request;
    let seq = 0;
    let release: (() => void) | undefined;
    const snapshot = () => ({
      botId: input.bot.id, epoch: "access-e2e", seq, partial: null,
      state: {kind: "idle"}, question: null, handoff: null,
      accessRequest: pending, activity: null, queued: [], entries: [],
    });
    const publish = () => {
      seq += 1;
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("bots:live:event", {botId: input.bot.id, epoch: "access-e2e", seq, type: "snapshot", snapshot: snapshot()});
      }
    };
    const state: AccessE2eState = {
      answers: [], failNext: true, saveForFuture: false,
      release: () => { release?.(); release = undefined; },
      replace: (next) => { pending = next; publish(); },
    };
    (globalThis as unknown as {accessRequestE2e: AccessE2eState}).accessRequestE2e = state;
    for (const channel of ["bots:list", "bots:get", "bots:live:subscribe", "bots:live:summary", "bots:getCanonicalPhoto", "bots:pendingApprovals", "bots:answerAccessRequest"]) ipcMain.removeHandler(channel);
    ipcMain.handle("bots:list", () => [input.bot]);
    ipcMain.handle("bots:get", () => input.bot);
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
    ipcMain.handle("bots:live:summary", () => ({botId: input.bot.id, preview: null, updatedAt: 1000, state: {kind: "idle"}, needsYou: pending !== null, lastReplyAt: null}));
    ipcMain.handle("bots:live:subscribe", snapshot);
    ipcMain.handle("bots:answerAccessRequest", async (_event, answer: unknown) => {
      state.answers.push(answer);
      await new Promise<void>(resolve => { release = resolve; });
      if (state.failNext) {
        state.failNext = false;
        throw new Error("The folder could not be saved. Please try again.");
      }
      pending = null;
      publish();
      return {answered: true, ...(state.saveForFuture ? {savedForFuture: true} : {})};
    });
  }, {bot, request});
  await page.getByRole("button", {name: "Bots", exact: true}).click();
  const card = page.getByRole("group", {name: "Planner wants to use Taxes", exact: true});
  await expect(card).toBeVisible();
  await expect(card).toContainText(request.place!);
  await expect(card).toContainText(request.why);
  await expect(card.getByRole("button")).toHaveText(["Not now", "Always for this folder", "Allow once"]);
  await card.getByRole("button", {name: "Not now", exact: true}).focus();
  await page.keyboard.press("Tab");
  await expect(card.getByRole("button", {name: "Always for this folder", exact: true})).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(card.getByRole("button", {name: "Allow once", exact: true})).toBeFocused();
  await expect(page.getByText("LM Studio (local) added.", {exact: true})).toBeHidden();
  for (const [mode, width] of [["light", 1280], ["dark", 600]] as const) {
    await page.evaluate(async scheme => {
      const appearance = await window.aidenAPI.ipc.invoke("settings:getAppearance") as Record<string, unknown>;
      await window.aidenAPI.ipc.invoke("settings:previewAppearance", {...appearance, mode: scheme, reduceMotion: "on"});
    }, mode);
    await aiden.app.evaluate(({BrowserWindow}, size) => BrowserWindow.getAllWindows()[0]!.setSize(size, 900), width);
    await expect(page.locator("html")).toHaveAttribute("data-appearance-scheme", mode);
    await expect(card.getByRole("button", {name: "Allow once", exact: true})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path: testInfo.outputPath(`access-card-${mode}.png`)});
  }
  await card.getByRole("button", {name: "Always for this folder", exact: true}).click();
  for (const button of await card.getByRole("button").all()) await expect(button).toBeDisabled();
  expect(await aiden.app.evaluate(() => (globalThis as unknown as {accessRequestE2e: AccessE2eState}).accessRequestE2e.answers)).toEqual([{botId: bot.id, waitId: request.waitId, choice: "always"}]);
  await aiden.app.evaluate(() => (globalThis as unknown as {accessRequestE2e: AccessE2eState}).accessRequestE2e.release());
  await expect(page.getByText("The folder could not be saved. Please try again.", {exact: false}).first()).toBeVisible();
  await expect(card.getByRole("button", {name: "Allow once", exact: true})).toBeEnabled();
  await card.getByRole("button", {name: "Allow once", exact: true}).click();
  await expect(card.getByRole("button", {name: "Not now", exact: true})).toBeDisabled();
  await aiden.app.evaluate(() => (globalThis as unknown as {accessRequestE2e: AccessE2eState}).accessRequestE2e.release());
  await expect(card).toBeHidden();
  await expect(page.getByPlaceholder("Ask Planner")).toBeVisible();

  const {place: _place, ...wholeMac} = request;
  const wholeMacRequest: BotPendingAccessRequest = {...wholeMac, waitId: "22222233-4455-4677-8899-aabbccddeeff", target: "whole_mac", label: "your whole Mac", choices: ["not_now", "once"]};
  await aiden.app.evaluate((_electron, next) => (globalThis as unknown as {accessRequestE2e: AccessE2eState}).accessRequestE2e.replace(next), wholeMacRequest);
  const wholeCard = page.getByRole("group", {name: "Planner wants to use your whole Mac", exact: true});
  await expect(wholeCard).toBeVisible();
  await expect(wholeCard.getByRole("button", {name: "Always for this folder", exact: true})).toHaveCount(0);
  await wholeCard.getByRole("button", {name: "Not now", exact: true}).click();
  await expect(wholeCard.getByRole("button", {name: "Allow once", exact: true})).toBeDisabled();
  await aiden.app.evaluate(() => (globalThis as unknown as {accessRequestE2e: AccessE2eState}).accessRequestE2e.release());
  await expect(wholeCard).toBeHidden();
  const futureRequest: BotPendingAccessRequest = {...request, waitId: "33332233-4455-4677-8899-aabbccddeeff"};
  await aiden.app.evaluate((_electron, next) => {
    const state = (globalThis as unknown as {accessRequestE2e: AccessE2eState}).accessRequestE2e;
    state.saveForFuture = true;
    state.replace(next);
  }, futureRequest);
  const futureCard = page.getByRole("group", {name: "Planner wants to use Taxes", exact: true});
  await expect(futureCard).toBeVisible();
  await futureCard.getByRole("button", {name: "Always for this folder", exact: true}).click();
  await expect(futureCard.getByRole("button", {name: "Not now", exact: true})).toBeDisabled();
  await aiden.app.evaluate(() => (globalThis as unknown as {accessRequestE2e: AccessE2eState}).accessRequestE2e.release());
  await expect(futureCard).toBeHidden();
  await expect(page.getByText("Folder approval recorded.", {exact: true})).toBeVisible();
  expect(await aiden.app.evaluate(() => (globalThis as unknown as {accessRequestE2e: AccessE2eState}).accessRequestE2e.answers)).toEqual([
    {botId: bot.id, waitId: request.waitId, choice: "always"},
    {botId: bot.id, waitId: request.waitId, choice: "once"},
    {botId: bot.id, waitId: "22222233-4455-4677-8899-aabbccddeeff", choice: "not_now"},
    {botId: bot.id, waitId: futureRequest.waitId, choice: "always"},
  ]);
  expect(aiden.lmStudio.requests.filter(r => r.url === "/v1/chat/completions")).toHaveLength(0);
});

interface AllowedE2eState {
  answers: unknown[];
  release(): void;
}

// Public IPC fixtures isolate the UI from the mock profile's unavailable
// Keychain. Real book, service and handler behavior is covered headlessly.
test("repeated approvals lead to a removable entry on the profile and in Settings", async ({ aiden }, testInfo) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  const bot = botFixture({ id: "bot-allowed", name: "Ada" });
  await aiden.app.evaluate(({ ipcMain, BrowserWindow }, bot) => {
    let pending = true, release: (() => void) | undefined;
    const prompt = { botId: bot.id, waitId: "ordinary-approval", toolCallId: "calendar-call", toolName: "calendar_create", summary: "Create the project review event", always: { key: "calendar-create", count: 3 } };
    let entries = [{ kind: "folder", id: "folder_root_a", botId: bot.id, what: "Folder · ~/Documents/Taxes", createdAt: "2026-11-03T12:00:00Z" }] as Array<import("../../renderer/shared/tool-approval-scope").BotAllowedEntry>;
    const broadcast = (channel: string, payload: unknown) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload);
    };
    const changed = () => broadcast("bots:allowed:changed", { botId: bot.id });
    const state: AllowedE2eState = { answers: [], release: () => { release?.(); release = undefined; } };
    (globalThis as unknown as { allowedE2e: AllowedE2eState }).allowedE2e = state;
    for (const channel of ["bots:list", "bots:get", "bots:getCanonicalPhoto", "bots:pendingApprovals", "bots:live:summary", "bots:live:subscribe", "bots:approve", "bots:allowed:list", "bots:allowed:remove"]) ipcMain.removeHandler(channel);
    ipcMain.handle("bots:list", () => [bot]);
    ipcMain.handle("bots:get", () => bot);
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => pending ? [prompt] : []);
    ipcMain.handle("bots:live:summary", () => ({ botId: bot.id, preview: null, updatedAt: 1000, state: { kind: "idle" }, needsYou: pending, lastReplyAt: null }));
    ipcMain.handle("bots:live:subscribe", () => ({ botId: bot.id, epoch: "allowed-e2e", seq: 0, entries: [], partial: null, state: { kind: "idle" }, question: null, handoff: null, accessRequest: null, plan: null, activity: null, queued: [] }));
    ipcMain.handle("bots:approve", async (_event, answer: unknown) => {
      state.answers.push(answer);
      await new Promise<void>(resolve => { release = resolve; });
      pending = false;
      broadcast("bots:approval-settled", { botId: bot.id, waitId: prompt.waitId, outcome: "allowed" });
      entries = [{ kind: "rule", id: "rule_calendar", botId: bot.id, what: "Calendar · Create event", createdAt: "2026-11-04T12:00:00Z", uses: 0 }, ...entries];
      changed();
      return { decided: true };
    });
    ipcMain.handle("bots:allowed:list", (_event, input?: { botId?: string }) => entries.filter(row => !input?.botId || row.botId === input.botId));
    ipcMain.handle("bots:allowed:remove", (_event, input: { botId: string; entryId: string }) => {
      const before = entries.length;
      entries = entries.filter(row => row.botId !== input.botId || row.id !== input.entryId);
      changed(); return { removed: before !== entries.length };
    });
  }, bot);
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  const card = page.getByRole("region", { name: "Review before Calendar create", exact: true });
  await expect(card).toContainText("You’ve allowed this 3 times in the last 2 weeks.");
  const draft = page.locator("textarea");
  await draft.fill("Keep this unsent draft");
  for (const [mode, width] of [["light", 1280], ["dark", 600]] as const) {
    await page.evaluate(async mode => {
      const appearance = await window.aidenAPI.ipc.invoke("settings:getAppearance") as Record<string, unknown>;
      await window.aidenAPI.ipc.invoke("settings:previewAppearance", { ...appearance, mode, reduceMotion: "on" });
    }, mode);
    await aiden.app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 900), width);
    await expect(card.getByRole("button", { name: "More ways to allow", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`repeated-approval-${mode}.png`) });
  }
  // Keyboard only: Deny, Allow once, then the menu with Ada's own Always.
  await card.getByRole("button", { name: "Deny", exact: true }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(card.getByRole("button", { name: "More ways to allow", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const always = page.getByRole("menuitem", { name: /^Always allow for Ada/u });
  await expect(always).toBeVisible();
  await page.keyboard.press("Enter");
  expect(await aiden.app.evaluate(() => (globalThis as unknown as { allowedE2e: AllowedE2eState }).allowedE2e.answers)).toEqual([{ waitId: "ordinary-approval", decision: "allow", scope: "always" }]);
  await expect(draft).toHaveValue("Keep this unsent draft");
  await aiden.app.evaluate(() => (globalThis as unknown as { allowedE2e: AllowedE2eState }).allowedE2e.release());
  await expect(page.getByText("Always allow requested.", { exact: true })).toBeVisible();
  await expect(page.getByText("Ada won’t ask about this again.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Allowed without asking", exact: true })).toBeVisible();
  await expect(page.getByText("Calendar · Create event", { exact: true })).toBeVisible();
  await expect(page.getByText("Folder · ~/Documents/Taxes", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("allowed-list-dark.png") });
  const ruleRow = page.getByRole("group", { name: "Calendar · Create event", exact: true });
  await ruleRow.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("Calendar · Create event", { exact: true })).toBeHidden();
  await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 900));
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.getByRole("button", { name: "Back to Aiden", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Bots & Approvals", exact: true }).click();
  await expect(page.getByText("Folder · ~/Documents/Taxes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("No Bot does anything without asking yet.", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("allowed-settings-empty-dark.png") });
  expect(aiden.lmStudio.requests.filter(request => request.url === "/v1/chat/completions")).toHaveLength(0);
});
