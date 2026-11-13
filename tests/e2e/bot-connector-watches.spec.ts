import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { BOT_CONNECTOR_WATCH_TEMPLATES, type BotConnectorWatchCreateInput, type BotConnectorWatchEnableInput, type BotConnectorWatchIdentityInput, type BotConnectorWatchTestInput, type BotConnectorWatchUpdateInput, type BotConnectorWatchView } from "../../renderer/shared/bot-connector-watches";
import { defaultBotRulesView } from "../../renderer/shared/bot-rules";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// Exercise the shipped Electron bridge, controls and layout with deterministic
// connector metadata. Host authority and crash handoff have separate real-store suites.
test("connector watches require explicit source discovery and keep the editor usable at narrow widths", async ({ aiden }) => {
  const { page } = aiden;
  const bot = botFixture({ id: "bot-mail", name: "Inbox Helper" });
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }, data) => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {
      "bots:list": () => [data.bot],
      "bots:get": () => data.bot,
      "bots:getCanonicalPhoto": () => null,
      "bots:pendingApprovals": () => [],
      "bots:live:summary": () => ({ botId: data.bot.id, preview: null, updatedAt: null, state: { kind: "idle" } }),
      "bots:live:subscribe": () => ({ botId: data.bot.id, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [], state: { kind: "idle" } }),
      "bots:rules:get": () => data.rules,
      "bots:routines:list": () => [],
      "bots:eventRoutines:list": () => [],
      "bots:health:report": () => null,
      "bots:memory:get": () => ({ botId: data.bot.id, available: true, entries: [], usedTokens: 0, tokenLimit: 2000 }),
      "bots:connectorWatches:list": () => ({ supported: true, templates: data.templates, watches: [] }),
      "bots:connectorWatches:discoverSources": () => {
        (globalThis as { watchDiscoveries?: number }).watchDiscoveries = ((globalThis as { watchDiscoveries?: number }).watchDiscoveries ?? 0) + 1;
        return { choices: [{ id: "opaque-work-inbox", templateId: "mail_messages", providerLabel: "Mail", accountLabel: "Work", resourceLabel: "Inbox", available: true }], unavailableReasons: [] };
      },
      "bots:connectorWatches:testCheck": () => ({ checkedAt: 1, result: "baseline", itemCount: 2, changeCount: 0, preview: ["Invoice update", "Meeting notes"] }),
    };
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, ...args) => handler(...args));
    }
  }, { bot, templates: BOT_CONNECTOR_WATCH_TEMPLATES, rules: defaultBotRulesView(bot.id) });
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  // Watches live in the side panel's Routines tab; the Bot's name opens the panel.
  await page.getByRole("button", { name: "Inbox Helper settings" }).click();
  await page.getByRole("tab", { name: "Routines", exact: true }).click();
  const group = page.getByRole("heading", { name: "Connected-app watches", exact: true }).locator("xpath=ancestor::section[1]");
  await expect(group.getByText("No connected-app watches", { exact: true })).toBeVisible();
  expect(await aiden.app.evaluate(() => (globalThis as { watchDiscoveries?: number }).watchDiscoveries ?? 0)).toBe(0);
  await group.getByRole("button", { name: "Add watch", exact: true }).click();
  await group.getByLabel("Watch name").fill("Work invoices");
  await group.getByLabel("What the Bot should do").fill("Summarize important invoice changes.");
  await expect(group.getByRole("button", { name: "Add watch", exact: true })).toBeDisabled();
  await group.getByRole("button", { name: "Find sources" }).click();
  await group.getByRole("combobox", { name: "Connected source" }).click();
  await page.getByRole("option", { name: "Mail · Work · Inbox" }).click();
  await expect(group.getByRole("button", { name: "Add watch", exact: true })).toBeEnabled();
  await group.getByRole("button", { name: "Test check", exact: true }).click();
  await expect(group.getByText("Invoice update", { exact: true })).toBeVisible();
  for (const width of [1280, 600, 390]) {
    await aiden.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]!.setSize(w, 900), width);
    const save = group.getByRole("button", { name: "Add watch", exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    expect(await group.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await group.getByLabel("Watch name").focus();
    await expect(group.getByLabel("Watch name")).toBeFocused();
  }
  await page.screenshot({ path: test.info().outputPath("connector-watch-editor.png"), fullPage: true });
  expect(await aiden.app.evaluate(() => (globalThis as { watchDiscoveries?: number }).watchDiscoveries)).toBe(1);
});

interface CalendarJourneyState {
  discoveries: number;
  watches: BotConnectorWatchView[];
  creates: BotConnectorWatchCreateInput[];
  updates: BotConnectorWatchUpdateInput[];
  checks: BotConnectorWatchTestInput[];
  enables: BotConnectorWatchEnableInput[];
  runs: BotConnectorWatchIdentityInput[];
  removals: BotConnectorWatchIdentityInput[];
  runAdmissions: number;
}

test("an eligible Calendar watch supports preview, editing, pause, same-request run replay and removal", async ({ aiden }) => {
  const { page } = aiden;
  const bot = botFixture({ id: "bot-calendar", name: "Calendar Helper" });
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }, data) => {
    const state: CalendarJourneyState = { discoveries: 0, watches: [], creates: [], updates: [], checks: [], enables: [], runs: [], removals: [], runAdmissions: 0 };
    (globalThis as { calendarJourney?: CalendarJourneyState }).calendarJourney = state;
    const source = { providerLabel: "Google Calendar", accountLabel: "Work", resourceLabel: "Team events" };
    let revision = 0;
    const nextRevision = () => `calendar-r${++revision}`;
    const current = (input: BotConnectorWatchIdentityInput) => {
      const watch = state.watches.find((row) => row.id === input.id);
      if (!watch || input.botId !== data.bot.id || input.expectedRevision !== watch.revision) throw new Error("Calendar fixture rejected a stale or cross-Bot write.");
      return watch;
    };
    const runReceipts = new Map<string, { id: string; revision: string; admitted: boolean }>();
    const handlers = {
      "bots:list": () => [data.bot],
      "bots:get": () => data.bot,
      "bots:getCanonicalPhoto": () => null,
      "bots:pendingApprovals": () => [],
      "bots:live:summary": () => ({ botId: data.bot.id, preview: null, updatedAt: null, state: { kind: "idle" } }),
      "bots:live:subscribe": () => ({ botId: data.bot.id, epoch: "calendar-e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [], state: { kind: "idle" } }),
      "bots:rules:get": () => data.rules,
      "bots:routines:list": () => [],
      "bots:eventRoutines:list": () => [],
      "bots:health:report": () => null,
      "bots:memory:get": () => ({ botId: data.bot.id, available: true, entries: [], usedTokens: 0, tokenLimit: 2000 }),
      "bots:connectorWatches:list": () => ({ supported: true, templates: data.templates, watches: state.watches }),
      "bots:connectorWatches:discoverSources": () => {
        state.discoveries++;
        return { choices: [
          { id: "opaque-other-mail", templateId: "mail_messages", providerLabel: "Mail", accountLabel: "Personal", resourceLabel: "Inbox", available: true },
          { id: "opaque-team-calendar", templateId: "calendar_upcoming", ...source, available: true },
        ], unavailableReasons: [] };
      },
      "bots:connectorWatches:testCheck": (input: BotConnectorWatchTestInput) => {
        state.checks.push(structuredClone(input));
        return { checkedAt: 1, result: "changed", itemCount: 1, changeCount: 1, preview: ["Team planning · 10:00"] };
      },
      "bots:connectorWatches:create": (input: BotConnectorWatchCreateInput) => {
        state.creates.push(structuredClone(input));
        if (input.botId !== data.bot.id || input.sourceChoiceId !== "opaque-team-calendar" || input.condition.kind !== "calendar") throw new Error("Calendar fixture requires its exact opaque source choice.");
        const watch: BotConnectorWatchView = { id: input.mutationId, botId: input.botId, revision: nextRevision(), name: input.name, prompt: input.prompt,
          condition: input.condition, everyMinutes: input.everyMinutes, templateId: "calendar_upcoming", source, enabled: true, state: "waiting" };
        state.watches.push(watch);
        return watch;
      },
      "bots:connectorWatches:update": (input: BotConnectorWatchUpdateInput) => {
        state.updates.push(structuredClone(input));
        const watch = current(input);
        Object.assign(watch, { name: input.name, prompt: input.prompt, condition: input.condition, everyMinutes: input.everyMinutes, revision: nextRevision() });
        return watch;
      },
      "bots:connectorWatches:setEnabled": (input: BotConnectorWatchEnableInput) => {
        state.enables.push(structuredClone(input));
        const watch = current(input);
        watch.enabled = input.enabled; watch.state = input.enabled ? "waiting" : "paused"; watch.revision = nextRevision();
        return watch;
      },
      "bots:connectorWatches:runNow": (input: BotConnectorWatchIdentityInput) => {
        state.runs.push(structuredClone(input));
        const prior = runReceipts.get(input.mutationId);
        if (prior) return prior;
        const watch = current(input);
        state.runAdmissions++;
        runReceipts.set(input.mutationId, { id: watch.id, revision: watch.revision, admitted: true });
        throw new Error("Calendar run response lost after admission.");
      },
      "bots:connectorWatches:remove": (input: BotConnectorWatchIdentityInput) => {
        state.removals.push(structuredClone(input));
        current(input);
        state.watches = state.watches.filter((row) => row.id !== input.id);
        return { id: input.id, revision: nextRevision(), removed: true };
      },
    };
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, input) => handler(input as never));
    }
  }, { bot, rules: defaultBotRulesView(bot.id), templates: BOT_CONNECTOR_WATCH_TEMPLATES.map((item) => item.kind === "calendar" ? { ...item, available: true, unavailableReason: undefined } : item) });
  const snapshot = () => aiden.app.evaluate(() => (globalThis as { calendarJourney?: CalendarJourneyState }).calendarJourney!);
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  // Watches live in the side panel's Routines tab; the Bot's name opens the panel.
  await page.getByRole("button", { name: "Calendar Helper settings" }).click();
  await page.getByRole("tab", { name: "Routines", exact: true }).click();
  const group = page.getByRole("heading", { name: "Connected-app watches", exact: true }).locator("xpath=ancestor::section[1]");
  await expect(group.getByText("No connected-app watches", { exact: true })).toBeVisible();
  expect((await snapshot()).discoveries).toBe(0);
  await group.getByRole("button", { name: "Add watch", exact: true }).click();
  await group.getByLabel("Watch name").fill("Team agenda");
  await group.getByLabel("What the Bot should do").fill("Prepare an agenda for upcoming team events.");
  await group.getByRole("combobox", { name: "What to watch" }).click();
  await page.getByRole("option", { name: "Upcoming calendar events", exact: true }).click();
  await expect(group.getByLabel("Sender filter")).toHaveCount(0);
  await expect(group.getByText(/The first Calendar check can report events already in the upcoming window/u)).toBeVisible();
  await expect(group.getByText(/The first successful Mail check records a baseline/u)).toHaveCount(0);
  await expect(group.getByText("Look ahead (minutes)", { exact: true })).toBeVisible();
  await expect(group.getByText("Time zone", { exact: true })).toBeVisible();
  await group.getByRole("spinbutton", { name: "Look ahead (minutes)", exact: true }).fill("120");
  await group.getByRole("textbox", { name: "Time zone", exact: true }).fill("America/New_York");
  await group.getByRole("combobox", { name: "Check every" }).click();
  await page.getByRole("option", { name: "15 minutes", exact: true }).click();
  await expect(group.getByRole("button", { name: "Add watch", exact: true })).toBeDisabled();
  await group.getByRole("button", { name: "Find sources", exact: true }).click();
  await group.getByRole("combobox", { name: "Connected source" }).click();
  await expect(page.getByRole("option", { name: "Mail · Personal · Inbox" })).toHaveCount(0);
  await page.getByRole("option", { name: "Google Calendar · Work · Team events", exact: true }).click();
  await group.getByRole("button", { name: "Test check", exact: true }).click();
  await expect(group.getByText("Team planning · 10:00", { exact: true })).toBeVisible();
  const preview = await snapshot();
  expect(preview.checks).toEqual([{ botId: bot.id, sourceChoiceId: "opaque-team-calendar", condition: { kind: "calendar", lookAheadMinutes: 120, timezone: "America/New_York" } }]);
  expect(preview.watches).toHaveLength(0);
  expect(preview.runAdmissions).toBe(0);
  await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(600, 1000));
  await group.getByText("Look ahead (minutes)", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("calendar-watch-editor.png"), fullPage: true });
  await group.getByRole("button", { name: "Add watch", exact: true }).click();
  await expect(group.getByRole("button", { name: "Edit watch Team agenda" })).toBeVisible();
  const created = await snapshot();
  expect(created.creates).toHaveLength(1);
  expect(created.watches[0]).toMatchObject({ id: created.creates[0]!.mutationId, botId: bot.id, templateId: "calendar_upcoming", everyMinutes: 15,
    condition: { kind: "calendar", lookAheadMinutes: 120, timezone: "America/New_York" }, source: { providerLabel: "Google Calendar", accountLabel: "Work", resourceLabel: "Team events" } });
  await group.getByRole("button", { name: "Edit watch Team agenda" }).click();
  await group.getByRole("button", { name: "Test saved watch", exact: true }).click();
  await expect.poll(async () => (await snapshot()).checks.length).toBe(2);
  expect((await snapshot()).checks[1]).toEqual({ botId: bot.id, id: created.watches[0]!.id, expectedRevision: created.watches[0]!.revision });
  await group.getByLabel("Look ahead (minutes)").fill("180");
  await group.getByLabel("Time zone").fill("Europe/London");
  await group.getByRole("button", { name: "Save watch", exact: true }).click();
  await expect(group.getByRole("button", { name: "Save watch", exact: true })).toHaveCount(0);
  const edited = await snapshot();
  expect(edited.updates).toHaveLength(1);
  expect(edited.updates[0]!.expectedRevision).toBe(created.watches[0]!.revision);
  expect(edited.updates[0]!.sourceChoiceId).toBeUndefined();
  expect(edited.watches[0]!.condition).toEqual({ kind: "calendar", lookAheadMinutes: 180, timezone: "Europe/London" });
  const enabled = group.getByRole("switch", { name: "Team agenda on" });
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await expect(group.getByText(/Paused · First check pending/u)).toBeVisible();
  await enabled.click();
  await expect(enabled).toBeChecked();
  await group.getByRole("button", { name: "Run Team agenda now", exact: true }).click();
  await expect(group.getByText(/Calendar run response lost after admission/u)).toBeVisible();
  await expect(group.getByRole("button", { name: "Run Team agenda now", exact: true })).toBeDisabled();
  await group.getByRole("button", { name: "Retry same request", exact: true }).click();
  await expect(group.getByText(/Run request confirmed/u)).toBeVisible();
  const replayed = await snapshot();
  expect(replayed.runAdmissions).toBe(1);
  expect(replayed.runs).toHaveLength(2);
  expect(replayed.runs[1]).toEqual(replayed.runs[0]);
  expect(replayed.enables.map((input) => input.enabled)).toEqual([false, true]);
  expect(replayed.discoveries).toBe(1);
  await page.screenshot({ path: test.info().outputPath("calendar-watch-saved.png"), fullPage: true });
  await group.getByRole("button", { name: "Remove watch Team agenda" }).click();
  expect((await snapshot()).removals).toHaveLength(0);
  await group.getByRole("button", { name: "Remove watch", exact: true }).click();
  await expect(group.getByText("No connected-app watches", { exact: true })).toBeVisible();
  const removed = await snapshot();
  expect(removed.removals).toHaveLength(1);
  expect(removed.removals[0]!.id).toBe(created.watches[0]!.id);
  expect(removed.watches).toHaveLength(0);
});
