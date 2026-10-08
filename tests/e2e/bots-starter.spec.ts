import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// The e2e profile has no macOS Keychain authority, so the real Bot store cannot
// open (bots:list fails with "Bot bootstrap marker could not be updated"). Only
// the Bot IPC is substituted, as in guided-setup.spec.ts; the onboarding,
// navigation, carousel, chat route and composer are the shipped renderer.
// A Bot turn cannot post an ask_user_question card: the durable Bot runtime does
// not offer that tool, so this flow ends at the message handed to bots:send.
test("an empty Bots list opens a starter Bot chat and sends the message to it", async ({ aiden }) => {
  const { page } = aiden;
  const bot = botFixture({ id: "bot-chief", name: "Chief of Staff", description: "Keeps your week on track" });
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }, fixture) => {
    const state = { created: false, sends: [] as unknown[] };
    (globalThis as unknown as { botStarterE2e: typeof state }).botStarterE2e = state;
    for (const channel of [
      "bots:list",
      "bots:get",
      "bots:createFromPreset",
      "bots:live:subscribe",
      "bots:live:summary",
      "bots:getCanonicalPhoto",
      "bots:pendingApprovals",
      "bots:send",
    ]) ipcMain.removeHandler(channel);
    const idle = { botId: fixture.id, preview: null, updatedAt: null, state: { kind: "idle" } };
    ipcMain.handle("bots:list", () => (state.created ? [fixture] : []));
    ipcMain.handle("bots:get", () => fixture);
    ipcMain.handle("bots:createFromPreset", () => {
      state.created = true;
      return { bot: fixture, created: true };
    });
    ipcMain.handle("bots:live:subscribe", () => ({ ...idle, epoch: "e1", seq: 0, entries: [], partial: null }));
    ipcMain.handle("bots:live:summary", () => idle);
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
    ipcMain.handle("bots:send", (_event, input: unknown) => {
      state.sends.push(input);
      return { submissionId: "s-1", deduped: false };
    });
  }, bot);

  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Meet Your First Bot" })).toBeVisible();
  const starters = page.getByRole("list", { name: "Starter Bots" });
  const chiefOfStaff = starters.getByRole("listitem").filter({ hasText: "Chief of Staff" });
  await chiefOfStaff.getByRole("button", { name: "Start Chat", exact: true }).click();

  const composer = page.getByPlaceholder("Ask Chief of Staff");
  await expect(composer).toBeVisible();
  const question = "What should I focus on today?";
  await composer.fill(question);
  await page.getByRole("button", { name: "Send message", exact: true }).click();

  await expect
    .poll(() =>
      aiden.app.evaluate(() => (globalThis as unknown as { botStarterE2e: { sends: unknown[] } }).botStarterE2e.sends.length),
    )
    .toBe(1);
  const sends = await aiden.app.evaluate(
    () => (globalThis as unknown as { botStarterE2e: { sends: unknown[] } }).botStarterE2e.sends,
  );
  expect(sends).toMatchObject([{ botId: "bot-chief", text: question }]);
});
