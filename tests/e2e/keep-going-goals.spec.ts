import type { Page } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test, E2E_ASSISTANT_RESPONSE } from "./fixtures";

// The reviewer's instructions, as the deterministic model sees them in the side call.
const REVIEW_PROMPT = "You are now checking whether the goal set in this chat is done";

/**
 * Types `/goal <objective>` and sends it. A goal is set only in an idle chat,
 * and the first answer may still be settling, so a refused send is tried again.
 */
async function setGoal(page: Page, objective: string): Promise<void> {
  const composer = page.locator("textarea");
  const sent = page.getByText(objective, { exact: true }).first();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden({ timeout: 15_000 });
  await expect(async () => {
    if (!(await sent.isVisible())) {
      await composer.fill(`/goal ${objective}`);
      await composer.press("Enter");
    }
    await expect(sent).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

test("/goal sends the objective, the goal bar follows the round to Done, and Clear removes it", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { lmStudio, page } = aiden;
  await finishLmStudioOnboarding(page);
  // The deterministic model keeps no prompt cache, so the review is an isolated, tool-free request.
  lmStudio.answerToolFreeCompletions!(REVIEW_PROMPT, '{"verdict": "done", "reason": "The release notes are written."}');
  const composer = page.locator("textarea");
  await composer.fill("Hello there");
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE).last()).toBeVisible({ timeout: 15_000 });

  // The objective is sent as the person's own message, and the bar appears above the composer.
  await setGoal(page, "Write the release notes");
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
