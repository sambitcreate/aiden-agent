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
  await expect(page.getByText("Saved for future tasks.", {exact: true})).toBeVisible();
  expect(await aiden.app.evaluate(() => (globalThis as unknown as {accessRequestE2e: AccessE2eState}).accessRequestE2e.answers)).toEqual([
    {botId: bot.id, waitId: request.waitId, choice: "always"},
    {botId: bot.id, waitId: request.waitId, choice: "once"},
    {botId: bot.id, waitId: "22222233-4455-4677-8899-aabbccddeeff", choice: "not_now"},
    {botId: bot.id, waitId: futureRequest.waitId, choice: "always"},
  ]);
  expect(aiden.lmStudio.requests.filter(r => r.url === "/v1/chat/completions")).toHaveLength(0);
});
