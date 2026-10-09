import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { E2E_PROFILE_NAME, expect, finishLmStudioOnboarding, test } from "./fixtures";

// The e2e profile has no macOS Keychain authority, so the real Bot store cannot
// open (bots:list fails with "Bot bootstrap marker could not be updated"). Only
// the Bot IPC is substituted, as in guided-setup.spec.ts; the onboarding,
// navigation, carousel, chat route and composer are the shipped renderer.
// The turn streams back as live events from main, then the Bot asks a
// quick-reply question the way the durable runtime publishes a waiting
// ask_user_question card.
test("an empty Bots list opens a starter Bot chat, sends to it, and answers its quick-reply card", async ({ aiden }) => {
  const { page } = aiden;
  const bot = botFixture({ id: "bot-chief", name: "Chief of Staff", description: "Keeps your week on track" });
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }, fixture) => {
    const state = { created: false, sends: [] as unknown[], answers: [] as unknown[] };
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
      "bots:answerQuestion",
    ]) ipcMain.removeHandler(channel);
    const idle = { botId: fixture.id, preview: null, updatedAt: null, state: { kind: "idle" } };
    ipcMain.handle("bots:list", () => (state.created ? [fixture] : []));
    ipcMain.handle("bots:get", () => fixture);
    ipcMain.handle("bots:createFromPreset", () => {
      state.created = true;
      return { bot: fixture, created: true };
    });
    ipcMain.handle("bots:live:subscribe", () => ({ ...idle, epoch: "e1", seq: 0, entries: [], partial: null, question: null }));
    ipcMain.handle("bots:live:summary", () => idle);
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
    ipcMain.handle("bots:send", (event, input: unknown) => {
      state.sends.push(input);
      // The live projection streams the turn back: the question, then the reply.
      const text = (input as { text: string }).text;
      const push = (seq: number, body: Record<string, unknown>) =>
        event.sender.send("bots:live:event", { botId: fixture.id, epoch: "e1", seq, ...body });
      setTimeout(() => {
        push(1, { type: "entry", entry: { id: "u1", type: "user", text, imageCount: 0 } });
        push(2, { type: "state", state: { kind: "running", submissionId: "s-1" } });
        push(3, { type: "partial", text: "Start with" });
        push(4, {
          type: "entry",
          entry: { id: "a1", type: "assistant", text: "Start with your 10am review.", toolCalls: [], stopReason: "stop" },
        });
        push(5, { type: "partial", text: null });
        push(6, { type: "state", state: { kind: "idle" } });
      }, 50);
      return { submissionId: "s-1", deduped: false };
    });
    ipcMain.handle("bots:answerQuestion", (_event, input: unknown) => {
      state.answers.push(input);
      return { answered: true };
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
  // The streamed turn renders from the live events: the question and the Bot's reply.
  await expect(page.getByText("Start with your 10am review.")).toBeVisible();
  await expect(page.getByText(question, { exact: true })).toBeVisible();

  // The Bot asks an A–E question: the card takes the composer's place.
  await aiden.app.evaluate(({ BrowserWindow }, botId) => {
    const question = {
      question: "Which area matters most this week?",
      header: "Focus",
      multiSelect: false,
      options: [
        { label: "Work", description: "Meetings and deadlines." },
        { label: "Family", description: "Plans at home." },
      ],
    };
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("bots:live:event", {
        botId,
        epoch: "e1",
        seq: 7,
        type: "question",
        question: { botId, waitId: "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", toolCallId: "call-1", questions: [question] },
      });
    }
  }, bot.id);
  await expect(page.getByRole("heading", { name: "Which area matters most this week?" })).toBeVisible();
  await expect(composer).toBeHidden();
  await page.getByRole("button", { name: /Family/u }).click();
  await expect(page.getByRole("button", { name: /Family/u })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Submit" }).click();

  await expect
    .poll(() =>
      aiden.app.evaluate(() => (globalThis as unknown as { botStarterE2e: { answers: unknown[] } }).botStarterE2e.answers.length),
    )
    .toBe(1);
  const answers = await aiden.app.evaluate(
    () => (globalThis as unknown as { botStarterE2e: { answers: unknown[] } }).botStarterE2e.answers,
  );
  expect(answers).toEqual([
    {
      botId: "bot-chief",
      waitId: "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c",
      answer: {
        version: 1,
        promptId: "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c",
        cancelled: false,
        answers: [{ questionIndex: 0, kind: "option", answer: "Family" }],
      },
    },
  ]);
});

// Onboarding decides whether to offer "Meet Your First Bot" when it loads, so
// the Bot IPC is substituted first and the window reloaded.
test("onboarding Start Chat creates the starter Bot and opens its chat when setup finishes", async ({ aiden }) => {
  const { page } = aiden;
  const bot = botFixture({ id: "bot-chief", name: "Chief of Staff", description: "Keeps your week on track" });
  await aiden.app.evaluate(({ ipcMain }, fixture) => {
    const state = { created: 0 };
    (globalThis as unknown as { botOnboardingE2e: typeof state }).botOnboardingE2e = state;
    for (const channel of [
      "bots:list",
      "bots:get",
      "bots:createFromPreset",
      "bots:live:subscribe",
      "bots:live:summary",
      "bots:getCanonicalPhoto",
      "bots:pendingApprovals",
    ]) ipcMain.removeHandler(channel);
    const idle = { botId: fixture.id, preview: null, updatedAt: null, state: { kind: "idle" } };
    ipcMain.handle("bots:list", () => (state.created > 0 ? [fixture] : []));
    ipcMain.handle("bots:get", () => fixture);
    ipcMain.handle("bots:createFromPreset", () => {
      state.created += 1;
      return { bot: fixture, created: true };
    });
    ipcMain.handle("bots:live:subscribe", () => ({ ...idle, epoch: "e1", seq: 0, entries: [], partial: null, question: null }));
    ipcMain.handle("bots:live:summary", () => idle);
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
  }, bot);
  await page.reload();

  const onboarding = page.locator('section[aria-label="Set up Aiden"]');
  await expect(onboarding).toBeVisible();
  const next = onboarding.getByRole("button", { name: /^Next/u });
  await onboarding.getByPlaceholder("Your name").fill(E2E_PROFILE_NAME);
  await next.click();
  const lmStudio = onboarding.getByRole("button", { name: /LM Studio.*Use models running in LM Studio/u });
  await lmStudio.click();
  await next.click();

  await expect(onboarding.getByRole("heading", { name: "Meet Your First Bot" })).toBeVisible();
  const starters = onboarding.getByRole("list", { name: "Starter Bots" });
  await starters
    .getByRole("listitem")
    .filter({ hasText: "Chief of Staff" })
    .getByRole("button", { name: "Start Chat", exact: true })
    .click();
  await expect(onboarding.getByRole("heading", { name: "Everything Aiden brings together" })).toBeVisible();
  await onboarding.getByRole("button", { name: "Start using Aiden" }).click();
  await expect(onboarding).toBeHidden();

  await expect(page.getByPlaceholder("Ask Chief of Staff")).toBeVisible();
  await expect(page.getByRole("button", { name: "Chief of Staff profile" })).toBeVisible();
  expect(
    await aiden.app.evaluate(() => (globalThis as unknown as { botOnboardingE2e: { created: number } }).botOnboardingE2e.created),
  ).toBe(1);
});
