import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { E2E_PROFILE_NAME, expect, finishLmStudioOnboarding, test } from "./fixtures";

// The e2e profile has no macOS Keychain authority, so the real Bot store cannot
// open (bots:list fails with "Bot bootstrap marker could not be updated"). Only
// the Bot IPC is substituted, as in guided-setup.spec.ts; the onboarding,
// navigation, carousel, chat route and composer are the shipped renderer.
// The turn streams back as live events from main, then the Bot asks a
// quick-reply question the way the durable runtime publishes a waiting
// ask_user_question card, and then hands the person a step the way it
// publishes a waiting hand_off card, and last asks the person to sign in the
// way it publishes a waiting sign_in card.
test("an empty Bots list opens a starter Bot chat, sends to it, and answers its quick-reply, hand-off and sign-in cards", async ({ aiden }) => {
  const { page } = aiden;
  const bot = botFixture({ id: "bot-chief", name: "Chief of Staff", description: "Keeps your week on track" });
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }, fixture) => {
    const state = { created: false, sends: [] as unknown[], answers: [] as unknown[], handoffs: [] as unknown[], opened: [] as unknown[] };
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
      "bots:answerHandoff",
      "bots:openHandoff",
    ]) ipcMain.removeHandler(channel);
    const idle = { botId: fixture.id, preview: null, updatedAt: null, state: { kind: "idle" } };
    ipcMain.handle("bots:list", () => (state.created ? [fixture] : []));
    ipcMain.handle("bots:get", () => fixture);
    ipcMain.handle("bots:createFromPreset", () => {
      state.created = true;
      return { bot: fixture, created: true };
    });
    ipcMain.handle("bots:live:subscribe", () => ({ ...idle, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [] }));
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
    ipcMain.handle("bots:answerHandoff", (_event, input: unknown) => {
      state.handoffs.push(input);
      return { answered: true };
    });
    ipcMain.handle("bots:openHandoff", (_event, input: unknown) => {
      state.opened.push(input);
      return { opened: "browser" };
    });
  }, bot);

  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Meet your first Bot" })).toBeVisible();
  const starters = page.getByRole("list", { name: "Starter Bots" });
  const chiefOfStaff = starters.getByRole("listitem").filter({ hasText: "Chief of Staff" });
  await chiefOfStaff.getByRole("button", { name: "Start chat", exact: true }).click();

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

  // The question settles, and the Bot hands the person a step: the card sits above the composer.
  await aiden.app.evaluate(({ BrowserWindow }, botId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("bots:live:event", { botId, epoch: "e1", seq: 8, type: "question", question: null });
      window.webContents.send("bots:live:event", {
        botId,
        epoch: "e1",
        seq: 9,
        type: "handoff",
        handoff: {
          botId,
          waitId: "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
          toolCallId: "call-2",
          kind: "action",
          action: "Approve the calendar invite from Sam",
          why: "Only you can accept invites on your work account.",
          source: "tool",
        },
      });
    }
  }, bot.id);
  const card = page.getByRole("group", { name: "Chief of Staff needs you" });
  await expect(card.getByText("Your turn: Approve the calendar invite from Sam")).toBeVisible();
  await expect(page.getByPlaceholder("Add a note and send to mark it done")).toBeVisible();
  await card.getByRole("button", { name: "Done", exact: true }).click();
  await expect
    .poll(() =>
      aiden.app.evaluate(() => (globalThis as unknown as { botStarterE2e: { handoffs: unknown[] } }).botStarterE2e.handoffs),
    )
    .toEqual([{ botId: "bot-chief", waitId: "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d", outcome: "done" }]);

  // The Bot asks the person to sign in to a site in its own browser. At this
  // width the Bot panel docks beside the chat, so the card stays in view.
  await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await aiden.app.evaluate(({ BrowserWindow }, botId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("bots:live:event", { botId, epoch: "e1", seq: 10, type: "handoff", handoff: null });
      window.webContents.send("bots:live:event", {
        botId,
        epoch: "e1",
        seq: 11,
        type: "handoff",
        handoff: {
          botId,
          waitId: "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
          toolCallId: "call-3",
          kind: "sign_in",
          action: "Sign in to github.com",
          why: "I need your GitHub account to read your issues.",
          open: { url: "https://github.com" },
          origin: "https://github.com",
          target: "browser",
          source: "tool",
        },
      });
    }
  }, bot.id);
  const signIn = page.getByRole("group", { name: "Chief of Staff needs you" });
  await expect(signIn.getByText("Sign in to github.com for Chief of Staff")).toBeVisible();
  await expect(signIn.getByText("Chief of Staff never sees your password.", { exact: false })).toBeVisible();
  // The answer is on the card: the composer takes no note while a sign-in waits.
  await expect(page.getByText("Sign in for Chief of Staff with Open sign-in above, then choose I’m signed in.")).toBeVisible();
  await expect(page.getByPlaceholder("Add a note and send to mark it done")).toHaveCount(0);
  await signIn.getByRole("button", { name: "Open sign-in" }).click();
  await expect
    .poll(() => aiden.app.evaluate(() => (globalThis as unknown as { botStarterE2e: { opened: unknown[] } }).botStarterE2e.opened))
    .toEqual([{ botId: "bot-chief", waitId: "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" }]);
  const botPanel = page.locator("#bot-panel");
  await expect(botPanel).toHaveAttribute("data-state", "open");
  await expect(botPanel).toHaveAttribute("data-surface-mode", "tools-pinned");
  await expect(botPanel.getByRole("group", { name: "Chief of Staff needs you" })).toHaveCount(0);
  // Narrower, the panel floats over the chat and its card, so it carries the card's buttons.
  await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 720));
  await expect(botPanel).toHaveAttribute("data-surface-mode", "tools-floating");
  const panelSignIn = botPanel.getByRole("group", { name: "Chief of Staff needs you" });
  await expect(panelSignIn.getByText("Sign in to github.com for Chief of Staff")).toBeVisible();
  await panelSignIn.getByRole("button", { name: "I’m signed in" }).click();
  await expect
    .poll(() =>
      aiden.app.evaluate(() => (globalThis as unknown as { botStarterE2e: { handoffs: unknown[] } }).botStarterE2e.handoffs),
    )
    .toEqual([
      { botId: "bot-chief", waitId: "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d", outcome: "done" },
      { botId: "bot-chief", waitId: "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", outcome: "done" },
    ]);
});

// Onboarding decides whether to offer "Meet your first Bot" when it loads, so
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
    ipcMain.handle("bots:live:subscribe", () => ({ ...idle, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [] }));
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

  await expect(onboarding.getByRole("heading", { name: "Meet your first Bot" })).toBeVisible();
  const starters = onboarding.getByRole("list", { name: "Starter Bots" });
  await starters
    .getByRole("listitem")
    .filter({ hasText: "Chief of Staff" })
    .getByRole("button", { name: "Start chat", exact: true })
    .click();
  await expect(onboarding.getByRole("heading", { name: "Everything Aiden brings together" })).toBeVisible();
  await onboarding.getByRole("button", { name: "Start using Aiden" }).click();
  await expect(onboarding).toBeHidden();

  await expect(page.getByPlaceholder("Ask Chief of Staff")).toBeVisible();
  // Ready to type in the Bot's chat straight away.
  await expect(page.getByPlaceholder("Ask Chief of Staff")).toBeFocused();
  await expect(page.getByRole("button", { name: "Chief of Staff profile" })).toBeVisible();
  expect(
    await aiden.app.evaluate(() => (globalThis as unknown as { botOnboardingE2e: { created: number } }).botOnboardingE2e.created),
  ).toBe(1);
});

// Under Reduce Motion the working face cannot glance, so it holds the glance's
// look-aside pose: still, and still different from an idle face.
test("under Reduce Motion a working Bot's face looks aside without moving, and an idle face looks ahead", async ({ aiden }) => {
  const { page } = aiden;
  const working = botFixture({ id: "bot-chief", name: "Chief of Staff" });
  const idle = botFixture({ id: "bot-owl", name: "Night Owl" });
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }, fixtures) => {
    for (const channel of [
      "bots:list",
      "bots:get",
      "bots:live:summary",
      "bots:live:subscribe",
      "bots:getCanonicalPhoto",
      "bots:pendingApprovals",
    ]) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.handle("bots:list", () => fixtures);
    // /bots opens one Bot's chat, so that Bot's own reads are answered too.
    ipcMain.handle("bots:get", (_event, botId: string) => fixtures.find((bot) => bot.id === botId) ?? null);
    ipcMain.handle("bots:live:subscribe", (_event, botId: string) => ({
      botId,
      epoch: "e1",
      seq: 0,
      entries: [],
      partial: null,
      state: { kind: "idle" },
      question: null,
      activity: null,
      queued: [],
    }));
    ipcMain.handle("bots:pendingApprovals", () => []);
    ipcMain.handle("bots:live:summary", (_event, botId: string) => ({
      botId,
      preview: null,
      updatedAt: null,
      state: botId === "bot-chief" ? { kind: "running", submissionId: "s-1" } : { kind: "idle" },
      needsYou: false,
      lastReplyAt: null,
    }));
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
  }, [working, idle]);
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.getByRole("button", { name: "Bots", exact: true }).click();
  const face = (name: string) =>
    page.getByRole("listitem").filter({ hasText: name }).locator(".bot-avatar-eyes").first();
  const pose = (name: string) =>
    face(name).evaluate((eyes) => ({
      transform: getComputedStyle(eyes).transform,
      moving: eyes.getAnimations({ subtree: true }).length > 0,
    }));
  await expect(page.getByRole("listitem").filter({ hasText: "Chief of Staff" }).getByText("Thinking…")).toBeAttached();

  await expect.poll(async () => (await pose("Chief of Staff")).transform).not.toBe("none");
  expect(await pose("Chief of Staff")).toMatchObject({ moving: false });
  expect(await pose("Night Owl")).toEqual({ transform: "none", moving: false });
});
