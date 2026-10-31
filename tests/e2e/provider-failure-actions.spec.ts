import { expect, finishLmStudioOnboarding, test, E2E_ASSISTANT_RESPONSE } from "./fixtures";

test("a failed reply's Try again sends a visible follow-up that answers", async ({ aiden }) => {
  const { page, lmStudio } = aiden;
  test.skip(!lmStudio.failCompletions, "needs the deterministic model to fail a request");
  await finishLmStudioOnboarding(page);
  const prompt = "Draft the changelog entry.";
  // An unrecognised client error: not retried, shown as a failure with Try again.
  lmStudio.failCompletions!(prompt, 1, 418);
  const composer = page.locator("textarea");
  await composer.fill(prompt);
  await composer.press("Enter");

  const card = page.locator("[data-provider-failure]");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Try that again.", { exact: true })).toBeVisible();
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toBeVisible();
  // The answered failure is history now: its card keeps its text but no buttons.
  await expect(card.getByRole("button")).toHaveCount(0);
});

test("a rejected sign-in's card opens Providers", async ({ aiden }) => {
  const { page, lmStudio } = aiden;
  test.skip(!lmStudio.failCompletions, "needs the deterministic model to fail a request");
  await finishLmStudioOnboarding(page);
  const prompt = "Check my calendar.";
  lmStudio.failCompletions!(prompt, 1, 401);
  const composer = page.locator("textarea");
  await composer.fill(prompt);
  await composer.press("Enter");

  const card = page.locator('[data-provider-failure="authentication"]');
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Open Providers" }).click();
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
});
