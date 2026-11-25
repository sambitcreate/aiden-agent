import type { Page } from "@playwright/test";
import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { expect, finishLmStudioOnboarding, test, E2E_ASSISTANT_RESPONSE } from "./fixtures";

// The reviewer's instructions, as the deterministic model sees them in the side call.
const REVIEW_PROMPT = "You are now checking whether the goal set in this chat is done";

/**
 * Types `/goal <objective>` and sends it. A goal is set only in an idle chat,
 * and the first answer may still be settling, so a refused send is tried again.
 * The command keeps its draft in the composer until it settles, so only a send
 * that came back refused (an error toast, the draft still there) is pressed
 * again: pressing while the first is still going would set the goal twice.
 */
async function setGoal(page: Page, objective: string): Promise<void> {
  const composer = page.locator("textarea");
  const draft = `/goal ${objective}`;
  const sent = page.getByText(objective, { exact: true }).first();
  const refused = page.locator("[data-sonner-toast][data-type='error']");
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden({ timeout: 15_000 });
  await composer.fill(draft);
  await composer.press("Enter");
  await expect(async () => {
    if (!(await sent.isVisible()) && (await refused.count()) > 0 && (await composer.inputValue()) === draft) {
      // Let the refusal clear first, so the next pass doesn't read it as a second one.
      await expect(refused).toHaveCount(0, { timeout: 10_000 });
      await composer.press("Enter");
    }
    await expect(sent).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

test("/goal as a new chat's first message creates the chat, the bar follows the round to Done, and Clear removes it", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { lmStudio, page } = aiden;
  await finishLmStudioOnboarding(page);
  // The deterministic model keeps no prompt cache, so the review is an isolated, tool-free request.
  lmStudio.answerToolFreeCompletions!(REVIEW_PROMPT, '{"verdict": "done", "reason": "The release notes are written."}');
  // A fresh draft: the objective becomes the chat's first message, and the bar appears above the composer.
  await setGoal(page, "Write the release notes");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE).last()).toBeVisible({ timeout: 15_000 });
  const bar = page.getByRole("group", { name: "Goal: Write the release notes" });
  await expect(bar).toBeVisible({ timeout: 15_000 });

  // The answer settles and the review goes out without the chat's tools, so it can't act.
  const reviews = () =>
    lmStudio.requests
      .filter((request) => request.url === "/v1/chat/completions" && JSON.stringify(request.body).includes(REVIEW_PROMPT))
      .map((request) => request.body as { tools?: unknown[] });
  await expect.poll(() => reviews().length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(reviews()[0]!.tools?.length ?? 0).toBe(0);
  // The reviewer judges it done, and the bar says so with its reason.
  await expect(bar).toHaveAttribute("data-goal-status", "done", { timeout: 30_000 });
  await expect(bar).toContainText("Done");
  await expect(bar).toContainText("The release notes are written.");
  await expect(bar.getByRole("button")).toHaveText(["Clear"]);
  await bar.screenshot({ path: test.info().outputPath("goal-bar-done.png") });

  // Keyboard reaches the action, and Clear removes the bar at once.
  const clear = bar.getByRole("button", { name: "Clear" });
  await clear.focus();
  await expect(clear).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(bar).toHaveCount(0);
});

test("Pause and Resume from the bar, and /goal clear from the composer", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { lmStudio, page } = aiden;
  await finishLmStudioOnboarding(page);
  const composer = page.locator("textarea");
  await composer.fill("Hello there");
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE).last()).toBeVisible({ timeout: 15_000 });

  // Hold the objective's answer so the goal stays at work while the person acts on it.
  lmStudio.holdCompletions!();
  try {
    await setGoal(page, "Tidy the changelog");
    const bar = page.getByRole("group", { name: "Goal: Tidy the changelog" });
    await expect(bar).toHaveAttribute("data-goal-status", "active", { timeout: 15_000 });
    await expect(bar).toContainText("Working · round 1 of 50");
    await bar.screenshot({ path: test.info().outputPath("goal-bar-working.png") });

    await bar.getByRole("button", { name: "Pause" }).click();
    await expect(bar).toHaveAttribute("data-goal-status", "paused");
    await expect(bar.getByRole("button")).toHaveText(["Resume", "Clear"]);
    await bar.screenshot({ path: test.info().outputPath("goal-bar-paused.png") });

    await bar.getByRole("button", { name: "Resume" }).click();
    await expect(bar).toHaveAttribute("data-goal-status", "active");
    await expect(bar).toContainText("Working · round 1 of 50");
  } finally {
    lmStudio.releaseCompletions!();
  }

  await expect(page.getByRole("button", { name: /stop/iu })).toHaveCount(0, { timeout: 30_000 });
  await composer.fill("/goal clear");
  await composer.press("Enter");
  await expect(page.getByRole("group", { name: "Goal: Tidy the changelog" })).toHaveCount(0, { timeout: 15_000 });
});

test("a round due while the chat is on screen starts in its window, where it can use the window's tools", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { lmStudio, page } = aiden;
  await finishLmStudioOnboarding(page);
  // The first review asks for another round; the second finds it done.
  lmStudio.answerToolFreeCompletions!(REVIEW_PROMPT, '{"verdict": "continue", "reason": "The outline is not drafted yet."}', { times: 1 });
  lmStudio.answerToolFreeCompletions!(REVIEW_PROMPT, '{"verdict": "done", "reason": "The outline is drafted."}');
  // Round 2 calls the to-do list, a tool only the chat's own window runs: a round without a window is refused it.
  const round = lmStudio.enqueueToolScenario!({
    prompt: "Keep going · round 2 of 50",
    calls: [{ name: "todo", arguments: { action: "create", subject: "Draft the outline" } }],
    finalText: "The outline is drafted.",
  });
  await setGoal(page, "Draft the outline");
  const bar = page.getByRole("group", { name: "Goal: Draft the outline" });
  await expect(bar).toBeVisible({ timeout: 15_000 });

  await expect.poll(() => round.completed, { timeout: 45_000 }).toBe(true);
  expect(round.error).toBeUndefined();
  expect(round.issuedToolNames).toEqual(["todo"]);
  expect(JSON.stringify(round.results[0]?.content ?? "")).not.toMatch(/not available in this (?:round|turn)/u);
  await expect(page.getByText("Keep going · round 2 of 50").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("The outline is drafted.").first()).toBeVisible({ timeout: 15_000 });
  await expect(bar).toHaveAttribute("data-goal-status", "done", { timeout: 30_000 });
});

test("a round on screen keeps running while its window shows Settings, and goes on to Done", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { lmStudio, page } = aiden;
  await finishLmStudioOnboarding(page);
  lmStudio.answerToolFreeCompletions!(REVIEW_PROMPT, '{"verdict": "continue", "reason": "The outline style is not chosen yet."}', { times: 1 });
  lmStudio.answerToolFreeCompletions!(REVIEW_PROMPT, '{"verdict": "done", "reason": "The outline is drafted."}');
  // Round 2 asks a question, a card only the chat's window can show.
  const round = lmStudio.enqueueToolScenario!({
    prompt: "Keep going · round 2 of 50",
    calls: [{ name: "ask_user_question", arguments: { questions: [{
      question: "Which outline style?", header: "Style",
      options: [{ label: "Bullets", description: "Short bullet points." }, { label: "Prose", description: "Full paragraphs." }],
    }] } }],
    finalText: "The outline is drafted.",
  });
  await setGoal(page, "Draft the outline");
  const bar = page.getByRole("group", { name: "Goal: Draft the outline" });
  await expect(page.getByRole("heading", { name: "Which outline style?" })).toBeVisible({ timeout: 45_000 });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  // Leaving the chat for Settings is not closing it: the round ran on, it wasn't paused as "The chat was closed".
  await expect.poll(() => round.completed, { timeout: 45_000 }).toBe(true);
  expect(round.error).toBeUndefined();
  await expect(bar).toHaveAttribute("data-goal-status", "done", { timeout: 45_000 });
  await expect(bar).not.toContainText("The chat was closed");
});

test("a round on screen stops, pausing the goal as closed, when its window opens a Bot's conversation", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { lmStudio, page } = aiden;
  await finishLmStudioOnboarding(page);
  // Bot persistence needs Keychain authority the mock profile lacks: one Bot's feed is stubbed, its pane is real.
  await aiden.app.evaluate(({ ipcMain }, fixture) => {
    for (const channel of ["bots:list", "bots:get", "bots:getCanonicalPhoto", "bots:live:summary", "bots:live:subscribe", "bots:pendingApprovals"])
      ipcMain.removeHandler(channel);
    ipcMain.handle("bots:list", () => [fixture]);
    ipcMain.handle("bots:get", () => fixture);
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
    ipcMain.handle("bots:live:summary", () => ({
      botId: fixture.id, preview: "", updatedAt: 1000, state: { kind: "idle" }, needsYou: false, lastReplyAt: null,
    }));
    ipcMain.handle("bots:live:subscribe", () => ({
      botId: fixture.id, epoch: "goal-fixture", seq: 0, partial: null, state: { kind: "idle" }, question: null, activity: null, queued: [], entries: [],
    }));
  }, botFixture({ id: "bot-planner", name: "Planner" }));
  lmStudio.answerToolFreeCompletions!(REVIEW_PROMPT, '{"verdict": "continue", "reason": "The outline style is not chosen yet."}', { times: 1 });
  // Round 2 asks a question, so it is still running in the window when the person moves on.
  lmStudio.enqueueToolScenario!({
    prompt: "Keep going · round 2 of 50",
    calls: [{ name: "ask_user_question", arguments: { questions: [{
      question: "Which outline style?", header: "Style",
      options: [{ label: "Bullets", description: "Short bullet points." }, { label: "Prose", description: "Full paragraphs." }],
    }] } }],
    finalText: "The outline is drafted.",
  });
  await setGoal(page, "Draft the outline");
  await expect(page.getByRole("heading", { name: "Which outline style?" })).toBeVisible({ timeout: 45_000 });
  const chatId = await page.evaluate(async () => {
    const chats = (await window.aidenAPI.ipc.invoke("chats:list")) as Array<{ id: string }>;
    return chats[0]!.id;
  });
  const goal = () => page.evaluate(async (id) => (await window.aidenAPI.ipc.invoke("chats:goal:get", id)) as { status: string; reason?: string } | null, chatId);
  expect((await goal())?.status).toBe("active");
  // Leaving the chat pane detaches the round and closes its question, and the
  // round then asks the model again. A real model takes a while to answer; the
  // deterministic one answers at once, which could end the round before the
  // Bot's pane reports what the window shows. Holding the answer keeps the
  // round running, as it would be, when the window moves on.
  lmStudio.holdCompletions!();

  // A Bot's conversation is another chat: the round this window owns stops, and the goal says why.
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await expect(page.getByPlaceholder("Message Planner")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await goal())?.status, { timeout: 15_000 }).toBe("paused");
  expect((await goal())?.reason).toBe("The chat was closed");
  lmStudio.releaseCompletions!();
});

/** A suggestion near the 300-character limit: the card must show all of it. */
const LONG_OBJECTIVE =
  "Finish the settings migration: move every remaining preference into the new store, keep reading the old file until the copy is verified, " +
  "delete the old file only after a successful read, and note anything that could not be moved";

test("Aiden suggests a goal: Not now dismisses it, and Start sends the objective as your message and sets the goal", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { lmStudio, page } = aiden;
  await finishLmStudioOnboarding(page);
  lmStudio.answerToolFreeCompletions!(REVIEW_PROMPT, '{"verdict": "done", "reason": "The settings store is migrated."}');
  lmStudio.enqueueToolScenario!({
    prompt: "Tidy the docs folder",
    calls: [{ name: "propose_goal", arguments: { objective: "Tidy every page in the docs folder" } }],
    finalText: "I suggested a goal for this.",
  });
  lmStudio.enqueueToolScenario!({
    prompt: "Migrate the settings store",
    calls: [{ name: "propose_goal", arguments: { objective: LONG_OBJECTIVE } }],
    finalText: "I suggested a goal for this.",
  });
  const composer = page.locator("textarea");
  const idle = () => expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden({ timeout: 30_000 });

  await composer.fill("Tidy the docs folder");
  await composer.press("Enter");
  const declined = page.getByRole("group", { name: "Suggested goal: Tidy every page in the docs folder" });
  await expect(declined).toBeVisible({ timeout: 30_000 });
  await idle();
  await declined.getByRole("button", { name: "Not now" }).click();
  await expect(declined).toHaveCount(0);
  await expect(page.getByRole("group", { name: /^Goal: / })).toHaveCount(0);

  await composer.fill("Migrate the settings store");
  await composer.press("Enter");
  const card = page.getByRole("group", { name: `Suggested goal: ${LONG_OBJECTIVE}` });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await idle();
  await expect(card).toContainText("Keep going until:");
  // Every character Start would send is on screen: the objective wraps, never clips.
  const objective = card.locator("[data-goal-proposal-objective]");
  await expect(objective).toHaveText(LONG_OBJECTIVE);
  expect(await objective.evaluate((element) => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await card.screenshot({ path: test.info().outputPath("goal-proposal-card.png") });
  await card.getByRole("button", { name: "Start" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator("[data-user-message-bubble]").filter({ hasText: "Finish the settings migration" })).toBeVisible({ timeout: 15_000 });
  const bar = page.getByRole("group", { name: `Goal: ${LONG_OBJECTIVE}` });
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await expect(bar).toHaveAttribute("data-goal-status", "done", { timeout: 45_000 });
});
