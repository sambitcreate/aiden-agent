import { expect, finishLmStudioOnboarding, test, E2E_ASSISTANT_RESPONSE } from "./fixtures";

const QUESTION = "Which database should the new service use?";

for (const ending of ["crash", "quit"] as const) {
  test(`a question waiting at a ${ending} is asked again after relaunch, and the answer starts a new turn`, async ({ aiden }) => {
    test.setTimeout(120_000);
    const { lmStudio } = aiden;
    let page = aiden.page;
    await finishLmStudioOnboarding(page);
    const prompt = `Set up the new service before the ${ending}`;
    lmStudio.enqueueToolScenario!({
      prompt,
      calls: [
        {
          name: "ask_user_question",
          arguments: {
            questions: [
              {
                question: QUESTION,
                header: "Database",
                options: [
                  { label: "Postgres", description: "Matches the rest of the stack." },
                  { label: "SQLite", description: "Simplest to run." },
                ],
              },
            ],
          },
        },
      ],
      finalText: "This reply never arrives.",
    });
    const composer = page.locator("textarea");
    await composer.fill(prompt);
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: QUESTION })).toBeVisible({ timeout: 15_000 });

    if (ending === "crash") aiden.app.process().kill("SIGKILL");
    page = await aiden.relaunch();
    await page.getByText(prompt).first().click().catch(() => undefined);
    await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole("status", { name: "Question from before a restart" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: QUESTION })).toBeVisible();
    // The question replaces the plain Resume card, so only one of them can send.
    await expect(page.locator("[data-interrupted-reply]")).toHaveCount(0);
    // Never automatic: nothing is sent until the person answers.
    await page.waitForTimeout(1_000);
    await expect(page.getByText("Answering the question you asked before Aiden restarted", { exact: false })).toHaveCount(0);

    await page.getByRole("button", { name: /SQLite/u }).click();
    await page.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByText(/Answering the question you asked before Aiden restarted/u)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Answer: SQLite/u)).toBeVisible();
    await expect(page.getByText(E2E_ASSISTANT_RESPONSE).last()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("status", { name: "Question from before a restart" })).toHaveCount(0);
    await expect(page.locator("[data-interrupted-reply]")).toHaveCount(0);
  });
}

test("closing a question from before a restart leaves the plain Resume card", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { lmStudio } = aiden;
  let page = aiden.page;
  await finishLmStudioOnboarding(page);
  const prompt = "Ask me something, then I quit";
  lmStudio.enqueueToolScenario!({
    prompt,
    calls: [
      {
        name: "ask_user_question",
        arguments: {
          questions: [
            {
              question: QUESTION,
              header: "Database",
              options: [
                { label: "Postgres", description: "Matches the rest of the stack." },
                { label: "SQLite", description: "Simplest to run." },
              ],
            },
          ],
        },
      },
    ],
    finalText: "This reply never arrives.",
  });
  const composer = page.locator("textarea");
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect(page.getByRole("heading", { name: QUESTION })).toBeVisible({ timeout: 15_000 });

  page = await aiden.relaunch();
  await page.getByText(prompt).first().click().catch(() => undefined);
  await expect(page.getByRole("heading", { name: QUESTION })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Close questionnaire" }).click();
  const card = page.locator("[data-interrupted-reply]");
  await expect(card).toBeVisible();
  await expect(page.getByRole("heading", { name: QUESTION })).toHaveCount(0);

  // Dismissed for good: another relaunch does not ask again.
  page = await aiden.relaunch();
  await page.getByText(prompt).first().click().catch(() => undefined);
  await expect(page.locator("[data-interrupted-reply]")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: QUESTION })).toHaveCount(0);
});
