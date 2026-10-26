import { expect, finishLmStudioOnboarding, test, E2E_ASSISTANT_RESPONSE } from "./fixtures";

const PROMPT = "Answer once the server recovers.";

test("a reply the provider fails with server errors counts down, tries again and answers", async ({ aiden }) => {
  const { page, lmStudio } = aiden;
  test.skip(!lmStudio.failCompletions, "needs the deterministic model to answer 502");
  await finishLmStudioOnboarding(page);
  lmStudio.failCompletions!(PROMPT, 2, 502);
  const completions = () =>
    lmStudio.requests.filter(
      (request) =>
        request.url === "/v1/chat/completions" &&
        JSON.stringify((request.body as { messages?: unknown } | null)?.messages ?? "").includes(PROMPT) &&
        Boolean((request.body as { tools?: unknown[] } | null)?.tools?.length),
    );

  const composer = page.locator("textarea");
  await composer.fill(PROMPT);
  await composer.press("Enter");

  // The first retry waits 2 seconds, the second 4.
  await expect(page.getByText(/Trying again in \ds \(2 of 6\)/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
  await expect(page.getByText(/Trying again in \ds \(3 of 6\)/u)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Trying again/u)).toHaveCount(0);
  await expect(page.locator("[data-provider-failure]")).toHaveCount(0);
  expect(completions()).toHaveLength(3);
});

test("Stop during a retry wait ends the reply without another request", async ({ aiden }) => {
  const { page, lmStudio } = aiden;
  test.skip(!lmStudio.failCompletions, "needs the deterministic model to answer 502");
  await finishLmStudioOnboarding(page);
  lmStudio.failCompletions!(PROMPT, 6, 503);
  const completions = () =>
    lmStudio.requests.filter(
      (request) =>
        request.url === "/v1/chat/completions" &&
        JSON.stringify((request.body as { messages?: unknown } | null)?.messages ?? "").includes(PROMPT) &&
        Boolean((request.body as { tools?: unknown[] } | null)?.tools?.length),
    );

  const composer = page.locator("textarea");
  await composer.fill(PROMPT);
  await composer.press("Enter");
  await expect(page.getByText(/Trying again in \ds \(2 of 6\)/u)).toBeVisible();
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(page.getByText(/Trying again/u)).toHaveCount(0);
  await page.waitForTimeout(3_000);
  expect(completions()).toHaveLength(1);
});
