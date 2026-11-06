import { readFileSync } from "node:fs";
import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { defaultBotRulesView } from "../../renderer/shared/bot-rules";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const peers = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/fixtures/bot-peers.json", import.meta.url), "utf8"));

// The real routed renderer and Electron bridge; host authority/recovery have
// separate durable-session suites, not a fake production readiness flag.
test("Bot pairs review both names, preserve lost requests and inspect Stop outcomes at phone widths", async ({ aiden }) => {
  const { page } = aiden, bot = botFixture({ id: peers.settings.botId, name: "Planner" });
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }, data) => {
    const settings = { ...data.peers.settings, revision: "initial", pairs: [] }; delete settings.lastMutationId;
    let exchange = { ...data.peers.waiting, state: "running", lastStop: undefined, request: data.peers.detail.request };
    const state = globalThis as { peerChanges?: unknown[]; peerStops?: unknown[] }; state.peerChanges = []; state.peerStops = [];
    const accepted = new Set<string>();
    const handlers: Record<string, (...args: unknown[]) => unknown> = {
      "bots:list": () => [data.bot], "bots:get": () => data.bot, "bots:getCanonicalPhoto": () => null, "bots:pendingApprovals": () => [],
      "bots:live:summary": () => ({ botId: data.bot.id, preview: null, updatedAt: null, state: { kind: "idle" } }),
      "bots:live:subscribe": () => ({ botId: data.bot.id, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [], state: { kind: "idle" } }),
      "bots:rules:get": () => data.rules, "bots:routines:list": () => [], "bots:eventRoutines:list": () => [], "bots:health:report": () => null,
      "bots:memory:get": () => ({ botId: data.bot.id, available: true, entries: [], usedTokens: 0, tokenLimit: 2000 }),
      "bots:openWork:snapshot": () => ({ botId: data.bot.id, revision: "empty", items: [], undo: [] }),
      "bots:peers:settings": () => settings, "bots:peers:catalog": () => data.peers.catalog,
      "bots:peers:exchanges": () => ({ ...data.peers.exchanges, exchanges: [{ ...data.peers.exchanges.exchanges[0], state: exchange.state }] }),
      "bots:peers:exchange": () => exchange, "bots:peers:evidence": () => data.peers.evidence,
      "bots:peers:mutate": (input) => {
        const request = input as { mutationId: string }; state.peerChanges!.push(request);
        const replayed = accepted.has(request.mutationId);
        if (!replayed) {
          accepted.add(request.mutationId); Object.assign(settings, { pairs: data.peers.settings.pairs, revision: "later_phone_edit", lastMutationId: "55555555-5555-4555-8555-555555555555" });
          throw new Error("Lost accepted pair reply.");
        }
        return { ok: true, mutationId: request.mutationId, replayed, snapshot: settings };
      },
      "bots:peers:stop": (input) => {
        const request = input as { mutationId: string }; state.peerStops!.push(request);
        const replayed = state.peerStops!.length > 1;
        exchange = { ...exchange, state: replayed ? "running" : "stopping", lastStop: { mutationId: request.mutationId, state: replayed ? "blocked" : "requested", at: Date.now(), ...(replayed ? { reason: "mixed_inputs" } : {}) } };
        return { ok: true, mutationId: request.mutationId, replayed, exchange };
      },
    };
    for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, (_event, ...args) => handler(...args)); }
  }, { bot, rules: defaultBotRulesView(bot.id), peers });
  await page.reload(); await page.getByRole("button", { name: "Bots", exact: true }).click(); await page.getByRole("button", { name: "Planner profile", exact: true }).click();
  await page.getByRole("button", { name: "Manage Bot messaging", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Bot messaging · Planner", exact: true });
  await manager.getByRole("combobox", { name: "Bot to approve", exact: true }).click(); await page.getByRole("option", { name: "Researcher", exact: true }).click();
  await manager.getByRole("button", { name: "Review pair", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Approve Bot pair", exact: true });
  await expect(review.getByText("Planner ↔ Researcher", { exact: true })).toBeVisible();
  expect(await aiden.app.evaluate(() => (globalThis as { peerChanges?: unknown[] }).peerChanges)).toHaveLength(0);
  await review.getByRole("button", { name: "Approve both directions", exact: true }).click();
  await expect(manager.getByRole("alert")).toContainText("Lost accepted pair reply.");
  await manager.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Manage Bot messaging", exact: true }).click();
  await manager.getByRole("button", { name: "Retry saved change", exact: true }).click();
  await expect(manager.getByText("Bot messaging settings saved.", { exact: true })).toBeVisible();
  const changes = await aiden.app.evaluate(() => (globalThis as { peerChanges?: unknown[] }).peerChanges!); expect(changes).toHaveLength(2); expect(changes[1]).toEqual(changes[0]);
  await manager.getByRole("button", { name: "View exchange", exact: true }).click();
  const exchange = page.getByRole("dialog", { name: "Bot exchange", exact: true });
  await exchange.getByRole("button", { name: "View source", exact: true }).click();
  const evidence = exchange.getByRole("heading", { name: peers.evidence.title, exact: true }).locator("xpath=ancestor::section[1]");
  await expect(evidence.getByText(peers.evidence.text, { exact: true })).toBeVisible();
  await exchange.getByRole("button", { name: "Stop exchange", exact: true }).click(); await page.getByRole("dialog", { name: "Stop this exchange?", exact: true }).getByRole("button", { name: "Confirm Stop", exact: true }).click();
  await expect(exchange.getByRole("button", { name: "Retry saved Stop", exact: true })).toBeVisible();
  await exchange.getByRole("button", { name: "Retry saved Stop", exact: true }).click();
  await expect(exchange.getByText("The host refused Stop because this run includes other inputs.", { exact: true })).toBeVisible();
  const stops = await aiden.app.evaluate(() => (globalThis as { peerStops?: unknown[] }).peerStops!); expect(stops).toHaveLength(2); expect(stops[1]).toEqual(stops[0]);
  for (const width of [1280, 600, 390]) {
    await aiden.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]!.setSize(w, 900), width);
    await exchange.getByRole("button", { name: "View source", exact: true }).scrollIntoViewIfNeeded(); await expect(exchange.getByRole("button", { name: "View source", exact: true })).toBeInViewport();
    expect(await exchange.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await exchange.getByRole("button", { name: "View source", exact: true }).focus(); await expect(exchange.getByRole("button", { name: "View source", exact: true })).toBeFocused();
  }
  await page.screenshot({ path: test.info().outputPath("bot-exchange.png"), fullPage: true });
});
