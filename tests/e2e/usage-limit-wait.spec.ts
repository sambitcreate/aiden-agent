import { expect, finishLmStudioOnboarding, test, E2E_ASSISTANT_RESPONSE } from "./fixtures";

const PROMPT = "Answer once the rate limit clears.";

test("a reply the provider turns away at its rate limit waits with the same model, and Retry now sends it", async ({ aiden }) => {
  const { page, lmStudio } = aiden;
  test.skip(!lmStudio.rateLimitCompletions, "needs the deterministic model to answer 429");
  await finishLmStudioOnboarding(page);
  // An hour away: well inside the default six-hour longest wait, so the reply waits.
  lmStudio.rateLimitCompletions!(PROMPT, 1, { "retry-after": "3600" });
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

  const waiting = page.getByText(/Waiting for .+’s usage limit · next try/u);
  await expect(waiting).toBeVisible();
  expect(completions()).toHaveLength(1);
  // The rejection is not a failed reply: nothing the provider said is shown, and Stop still works.
  await expect(page.getByText("Rate limit reached for requests")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();

  await page.getByRole("button", { name: "Retry now" }).click();
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toBeVisible();
  await expect(waiting).toHaveCount(0);
  const sent = completions();
  expect(sent).toHaveLength(2);
  const model = (request: (typeof sent)[number]) => (request.body as { model?: unknown }).model;
  expect(model(sent[1]!), "the retry keeps the model").toBe(model(sent[0]!));
});
