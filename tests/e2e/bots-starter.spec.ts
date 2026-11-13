import { connectOnboardingLmStudio } from "./fixtures";
import { botFixture, catalogFixture } from "../../renderer/main/bots/test-fixtures";
import { E2E_PROFILE_NAME, expect, finishLmStudioOnboarding, test } from "./fixtures";

// The e2e profile has no macOS Keychain authority, so the real Bot store cannot
// open (bots:list fails with "Bot bootstrap marker could not be updated"). Only
// the Bot IPC is substituted, as in guided-setup.spec.ts; the onboarding,
// navigation, New bot dialog, chat route and composer are the shipped renderer.
// The turn streams back as live events from main, then the Bot asks a
// quick-reply question the way the durable runtime publishes a waiting
// ask_user_question card, and then hands the person a step the way it
// publishes a waiting hand_off card, and last asks the person to sign in the
// way it publishes a waiting sign_in card.
test("New bot makes a Bot from just a name and opens its chat, which sends and answers its quick-reply, hand-off and sign-in cards", async ({ aiden }) => {
  const { page } = aiden;
  const bot = botFixture({ id: "bot-chief", name: "Chief of Staff", description: "Keeps your week on track" });
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }, { fixture, catalog }) => {
    const state = { created: false, creates: [] as unknown[], introduced: [] as unknown[], sends: [] as unknown[], answers: [] as unknown[], handoffs: [] as unknown[], opened: [] as unknown[] };
    (globalThis as unknown as { botStarterE2e: typeof state }).botStarterE2e = state;
    for (const channel of [
      "bots:list",
      "bots:get",
      "bots:getCapabilityCatalog",
      "bots:create",
      "bots:introduce",
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
    ipcMain.handle("bots:getCapabilityCatalog", () => catalog);
    ipcMain.handle("bots:create", (_event, input: unknown) => {
      state.created = true;
      state.creates.push(input);
      return fixture;
    });
    ipcMain.handle("bots:introduce", (_event, botId: unknown) => {
      state.introduced.push(botId);
      return true;
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
  }, { fixture: bot, catalog: catalogFixture() });

  await page.getByRole("button", { name: "Bots", exact: true }).click();
  // One field: a name and Return make the Bot and open its chat.
  await page.getByRole("button", { name: "New bot", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New bot" });
  await expect(create.getByRole("textbox")).toHaveCount(1);
  const name = create.getByRole("textbox", { name: "Name your Bot" });
  await name.fill("Chief of Staff");
  await name.press("Enter");

  const composer = page.getByPlaceholder("Ask Chief of Staff");
  await expect(composer).toBeVisible();
  await expect(create).toBeHidden();
  const made = await aiden.app.evaluate(() => {
    const state = (globalThis as unknown as { botStarterE2e: { creates: unknown[]; introduced: unknown[] } }).botStarterE2e;
    return { creates: state.creates, introduced: state.introduced };
  });
  expect(made.creates).toMatchObject([{ bot: { name: "Chief of Staff" }, access: { accessMode: "full" } }]);
  expect(made.introduced).toEqual(["bot-chief"]);
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

  // The same message menu opens from its focused action on platforms without
  // a native Shift+F10 contextmenu event (including macOS).
  const messageActions = page.getByRole("button", { name: "Message actions for Chief of Staff’s message" });
  await messageActions.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await expect(composer).toHaveValue("> Start with your 10am review.\n\n");
  await composer.fill("");

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

  // The person starts answering: Family is picked but not yet submitted.
  await page.getByRole("button", { name: /Family/u }).click();
  await expect(page.getByRole("button", { name: /Family/u })).toHaveAttribute("aria-pressed", "true");

  // While the question waits, the Bot also hands the person a step. Both pile
  // up in the one Needs-you slot, but the question on show stays put: the
  // arrival only raises the count, and the half-made answer is kept. The step
  // ranks first, so Previous reaches it.
  await aiden.app.evaluate(({ BrowserWindow }, botId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("bots:live:event", {
        botId,
        epoch: "e1",
        seq: 8,
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
  const needsYou = page.getByRole("navigation", { name: "Needs you" });
  await expect(needsYou).toContainText("2 of 2");
  await expect(page.getByRole("heading", { name: "Which area matters most this week?" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Family/u })).toHaveAttribute("aria-pressed", "true");
  await expect(card).toHaveCount(0);
  await needsYou.getByRole("button", { name: "Previous" }).click();
  await expect(needsYou).toContainText("1 of 2");
  await expect(card.getByText("Needs you: Approve the calendar invite from Sam")).toBeVisible();
  await expect(card.getByRole("button", { name: "Take control" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Which area matters most this week?" })).toHaveCount(0);
  // Back to the question to finish it. Moving away from it let go of the pick
  // (only an arrival keeps it), so Family is chosen again.
  await needsYou.getByRole("button", { name: "Next" }).click();
  await expect(needsYou).toContainText("2 of 2");
  await expect(page.getByRole("heading", { name: "Which area matters most this week?" })).toBeVisible();
  const family = page.getByRole("button", { name: /Family/u });
  await expect(family).toHaveAttribute("aria-pressed", "false");
  await family.click();
  await expect(family).toHaveAttribute("aria-pressed", "true");
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

  // The question settles; the step is all that is left, so the header goes and
  // the card sits alone above the composer. Take control first, then I'm done.
  await aiden.app.evaluate(({ BrowserWindow }, botId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("bots:live:event", { botId, epoch: "e1", seq: 9, type: "question", question: null });
    }
  }, bot.id);
  await expect(card.getByText("Needs you: Approve the calendar invite from Sam")).toBeVisible();
  await expect(needsYou).toHaveCount(0);
  await expect(page.getByPlaceholder("Add a note and send to mark it done")).toBeVisible();
  await expect(card.getByRole("button", { name: "I’m done", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Take control", exact: true }).click();
  await card.getByRole("button", { name: "I’m done", exact: true }).click();
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
  await expect(page.getByText("Sign in for Chief of Staff with Take control above, then choose I’m done.")).toBeVisible();
  await expect(page.getByPlaceholder("Add a note and send to mark it done")).toHaveCount(0);
  await signIn.getByRole("button", { name: "Take control to sign in" }).click();
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
  await panelSignIn.getByRole("button", { name: "I’m done" }).click();
  await expect
    .poll(() =>
      aiden.app.evaluate(() => (globalThis as unknown as { botStarterE2e: { handoffs: unknown[] } }).botStarterE2e.handoffs),
    )
    .toEqual([
      { botId: "bot-chief", waitId: "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d", outcome: "done" },
      { botId: "bot-chief", waitId: "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", outcome: "done" },
    ]);
});

// Onboarding decides whether to make the first Bot when it loads, so the Bot
// IPC is substituted first and the window reloaded. The Bot's first message
// is the snapshot its chat subscribes to once it exists.
test("onboarding makes the first Bot by itself and its chat opens on its first message when setup finishes", async ({ aiden }) => {
  const { page } = aiden;
  const bot = botFixture({ id: "bot-chief", name: "Chief", description: undefined });
  const hello = "Hi, I’m Chief. What would you like help with?";
  await aiden.app.evaluate(({ ipcMain }, { fixture, hello }) => {
    const state = { created: 0 };
    (globalThis as unknown as { botOnboardingE2e: typeof state }).botOnboardingE2e = state;
    for (const channel of [
      "bots:list",
      "bots:get",
      "bots:createFirst",
      "bots:live:subscribe",
      "bots:live:summary",
      "bots:getCanonicalPhoto",
      "bots:pendingApprovals",
    ]) ipcMain.removeHandler(channel);
    const idle = { botId: fixture.id, preview: null, updatedAt: null, state: { kind: "idle" } };
    ipcMain.handle("bots:list", () => (state.created > 0 ? [fixture] : []));
    ipcMain.handle("bots:get", () => fixture);
    ipcMain.handle("bots:createFirst", () => {
      state.created += 1;
      return { bot: fixture, created: state.created === 1 };
    });
    ipcMain.handle("bots:live:subscribe", () => ({
      ...idle,
      epoch: "e1",
      seq: 1,
      entries: state.created > 0 ? [{ id: "a1", type: "assistant", text: hello, toolCalls: [], stopReason: "stop" }] : [],
      partial: null,
      question: null,
      activity: null,
      queued: [],
    }));
    ipcMain.handle("bots:live:summary", () => idle);
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
  }, { fixture: bot, hello });
  await page.reload();

  const onboarding = page.locator('section[aria-label="Set up Aiden"]');
  await expect(onboarding).toBeVisible();
  const next = onboarding.getByRole("button", { name: /^Next/u });
  await onboarding.getByPlaceholder("Your name").fill(E2E_PROFILE_NAME);
  await next.click();
  await connectOnboardingLmStudio(onboarding);

  // No choice to make: the last step already holds the first Bot.
  const firstBot = onboarding.getByRole("region", { name: "Your first Bot" });
  await expect(firstBot.getByRole("status")).toHaveText("Chief is ready");
  await onboarding.getByRole("button", { name: "Start using Aiden" }).click();
  await expect(onboarding).toBeHidden();

  const composer = page.getByPlaceholder("Ask Chief");
  await expect(composer).toBeVisible();
  await expect(page.getByText(hello)).toBeVisible();
  // Ready to type the answer in the Bot's chat straight away.
  await expect(composer).toBeFocused();
  await expect(page.getByRole("button", { name: "Chief settings" })).toBeVisible();
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
