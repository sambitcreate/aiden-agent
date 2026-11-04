import { botFixture } from "../../renderer/main/bots/test-fixtures";
import type { BotPlanView } from "../../renderer/shared/bot-plans";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

interface PlanE2eState {
  answers: unknown[];
  failNext: boolean;
  release(): void;
  replace(plan: BotPlanView | null): void;
}

// The mock profile has no Keychain authority. Supply the public host feed;
// the card, composer, keyboard controls and renderer IPC client remain real.
test("plan approval waits for the host, then becomes a stoppable checklist", async ({ aiden }, testInfo) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  const bot = botFixture({ id: "bot-plans", name: "Planner" });
  const plan: BotPlanView = {
    botId: bot.id, planId: "weekly-report", status: "pending", revision: 1, from: "Jester",
    title: "Prepare the weekly report", why: "Gather the receipts and share a short summary with the team.",
    steps: [{ text: "Find the receipts", status: "pending" }, { text: "Write the report", status: "pending" }, { text: "Share the summary", status: "pending" }],
    items: [
      { id: "i1", line: "Calendar · create events (up to 5)", details: ["Create an event"], used: 0, max: 5 },
      { id: "i2", line: "Files · read ~/Documents/Receipts for this plan", details: ["~/Documents/Receipts", "Read only · allowed once, for this plan only"] },
    ],
  };
  await aiden.app.evaluate(({ ipcMain, BrowserWindow }, input) => {
    let shown: BotPlanView | null = input.plan, seq = 0;
    let release: (() => void) | undefined;
    const snapshot = () => ({ botId: input.bot.id, epoch: "plans-e2e", seq, entries: [], partial: null,
      state: { kind: "idle" }, question: null, handoff: null, accessRequest: null, plan: shown, activity: null, queued: [] });
    const publish = () => {
      seq++;
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("bots:live:event", {
        botId: input.bot.id, epoch: "plans-e2e", seq, type: "snapshot", snapshot: snapshot(),
      });
    };
    const state: PlanE2eState = { answers: [], failNext: true,
      release: () => { release?.(); release = undefined; }, replace: next => { shown = next; publish(); } };
    (globalThis as unknown as { planE2e: PlanE2eState }).planE2e = state;
    for (const channel of ["bots:list", "bots:get", "bots:getCanonicalPhoto", "bots:pendingApprovals", "bots:live:summary", "bots:live:subscribe", "bots:plans:respond"]) ipcMain.removeHandler(channel);
    ipcMain.handle("bots:list", () => [input.bot]);
    ipcMain.handle("bots:get", () => input.bot);
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
    ipcMain.handle("bots:live:summary", () => ({ botId: input.bot.id, preview: null, updatedAt: 1000, state: { kind: "idle" }, needsYou: shown?.status === "pending", lastReplyAt: null }));
    ipcMain.handle("bots:live:subscribe", snapshot);
    ipcMain.handle("bots:plans:respond", async (_event, value: { botId: string; planId: string; decision: "approve" | "not_now" | "stop" }) => {
      state.answers.push(value);
      await new Promise<void>(resolve => { release = resolve; });
      if (state.failNext) { state.failNext = false; throw new Error("That answer could not be sent. Please try again."); }
      if (value.decision === "approve" && shown) shown = { ...shown, status: "active", revision: shown.revision + 1, expiresAt: Date.now() + 10 * 60_000,
        steps: shown.steps.map((step, index) => ({ ...step, status: index === 0 ? "done" : index === 1 ? "skipped" : "pending" })),
        items: shown.items.map(item => item.max === undefined ? item : { ...item, used: 2 }) };
      else if (value.decision === "stop" && shown) shown = { ...shown, status: "stopped", revision: shown.revision + 1 };
      else shown = null;
      publish();
      return { result: "done" };
    });
  }, { bot, plan });
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await expect(page.getByText(plan.title, { exact: true })).toBeVisible();
  await expect(page.getByText("Jester asked Planner to do this", { exact: true })).toBeVisible();
  await expect(page.getByText(plan.why, { exact: true })).toBeVisible();
  for (const step of plan.steps) await expect(page.getByText(step.text, { exact: true })).toBeVisible();
  for (const item of plan.items) await expect(page.getByText(item.line, { exact: true })).toBeVisible();
  const draft = page.locator("textarea");
  await expect(draft).toBeEnabled();
  await draft.fill("Keep this draft while the plan waits");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await draft.press("Enter");
  await expect(draft).toHaveValue("Keep this draft while the plan waits");
  await expect(page.getByText("Create an event", { exact: true })).toBeHidden();
  const details = page.getByRole("button", { name: /^(Show|Hide) details$/u });
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Create an event", { exact: true })).toBeVisible();
  await expect(page.getByText("Read only · allowed once, for this plan only", { exact: true })).toBeVisible();
  for (const [mode, width] of [["light", 1280], ["dark", 600]] as const) {
    await page.evaluate(async scheme => {
      const appearance = await window.aidenAPI.ipc.invoke("settings:getAppearance") as Record<string, unknown>;
      await window.aidenAPI.ipc.invoke("settings:previewAppearance", { ...appearance, mode: scheme, reduceMotion: "on" });
    }, mode);
    await aiden.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size, 900), width);
    await expect(page.locator("html")).toHaveAttribute("data-appearance-scheme", mode);
    await expect(page.getByRole("button", { name: "Approve plan", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`plan-pending-${mode}.png`) });
  }
  const approve = page.getByRole("button", { name: "Approve plan", exact: true });
  await approve.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Not now", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(approve).toBeDisabled();
  await expect(page.getByRole("button", { name: "Not now", exact: true })).toBeDisabled();
  await aiden.app.evaluate(() => (globalThis as unknown as { planE2e: PlanE2eState }).planE2e.release());
  await expect(page.getByText("That answer could not be sent. Please try again.", { exact: false }).first()).toBeVisible();
  await expect(approve).toBeEnabled();
  await approve.dblclick();
  await expect(approve).toBeDisabled();
  expect(await aiden.app.evaluate(() => (globalThis as unknown as { planE2e: PlanE2eState }).planE2e.answers)).toEqual([
    { botId: bot.id, planId: plan.planId, decision: "approve" }, { botId: bot.id, planId: plan.planId, decision: "approve" },
  ]);
  await aiden.app.evaluate(() => (globalThis as unknown as { planE2e: PlanE2eState }).planE2e.release());
  const stop = page.getByRole("button", { name: "Stop plan", exact: true });
  await expect(stop).toBeVisible();
  await expect(approve).toBeHidden();
  await expect(page.getByText(/Approved.*ends in 10 min/u)).toBeVisible();
  await expect(page.getByText("2 of 5 used", { exact: true })).toBeVisible();
  await expect(draft).toHaveValue("Keep this draft while the plan waits");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("plan-active-dark.png") });
  await stop.click();
  await expect(stop).toBeDisabled();
  await aiden.app.evaluate(() => (globalThis as unknown as { planE2e: PlanE2eState }).planE2e.release());
  await expect(page.getByText("Plan ended · 2 of 3 steps", { exact: true })).toBeVisible();
  await expect(stop).toBeHidden();
  const declined = { ...plan, planId: "declined-report", from: undefined };
  await aiden.app.evaluate((_electron, next) => (globalThis as unknown as { planE2e: PlanE2eState }).planE2e.replace(next), declined);
  await expect(page.getByText("Planner has a plan", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve plan", exact: true })).toBeDisabled();
  await aiden.app.evaluate(() => (globalThis as unknown as { planE2e: PlanE2eState }).planE2e.release());
  await expect(page.getByText(plan.title, { exact: true })).toBeHidden();
  expect(await aiden.app.evaluate(() => (globalThis as unknown as { planE2e: PlanE2eState }).planE2e.answers)).toEqual([
    { botId: bot.id, planId: plan.planId, decision: "approve" }, { botId: bot.id, planId: plan.planId, decision: "approve" },
    { botId: bot.id, planId: plan.planId, decision: "stop" }, { botId: bot.id, planId: declined.planId, decision: "not_now" },
  ]);
  expect(aiden.lmStudio.requests.filter(request => request.url === "/v1/chat/completions")).toHaveLength(0);
});
