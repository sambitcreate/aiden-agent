import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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

test("a question withdrawn by a window reload is not kept on disk", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { lmStudio } = aiden;
  const page = aiden.page;
  await finishLmStudioOnboarding(page);
  const prompt = "Ask me something, then I reload";
  lmStudio.enqueueToolScenario!({
    prompt,
    calls: [
      {
        name: "ask_user_question",
        arguments: {
          questions: [{
            question: QUESTION,
            header: "Database",
            options: [
              { label: "Postgres", description: "Matches the rest of the stack." },
              { label: "SQLite", description: "Simplest to run." },
            ],
          }],
        },
      },
    ],
    finalText: "The reply went on without an answer.",
  });
  const composer = page.locator("textarea");
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect(page.getByRole("heading", { name: QUESTION })).toBeVisible({ timeout: 15_000 });
  const saved = () => readFile(path.join(aiden.userDataDir, "interrupted-waits.json"), "utf8").catch(() => "");
  await expect.poll(saved, { timeout: 15_000 }).toContain(QUESTION);

  // Reloading the window withdraws the card while Aiden keeps running: the reply
  // goes on without an answer, so a later crash must not offer it again.
  await page.reload();
  await page.getByText(prompt).first().click().catch(() => undefined);
  await expect(page.getByText("The reply went on without an answer.").first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(saved, { timeout: 15_000 }).not.toContain(QUESTION);
});

for (const approved of [false, true]) {
  test(`recovery shows a saved approval without replaying it (${approved ? "already executed" : "still pending"})`, async ({ aiden }) => {
    test.setTimeout(120_000);
    const { lmStudio } = aiden;
    let page = aiden.page;
    await finishLmStudioOnboarding(page);
    const prompt = "Make me a weekday workspace brief";
    lmStudio.enqueueToolScenario!({
      prompt,
      calls: [{
        name: "schedule_task",
        arguments: {
          action: "create",
          name: "Workspace brief",
          cron: "0 9 * * 1-5",
          timezone: "America/New_York",
          prompt: "Summarize important workspace changes without modifying files.",
        },
      }],
      finalText: "This reply never arrives.",
    });
    const composer = page.locator("textarea");
    await composer.fill(prompt);
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible({ timeout: 15_000 });

    const waitsFile = path.join(aiden.userDataDir, "interrupted-waits.json");
    const taskName = "Workspace brief";
    const taskCount = async () => {
      const file = await readFile(path.join(aiden.userDataDir, "schedules.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "[]";
        throw error;
      });
      return (JSON.parse(file) as Array<{ name: string }>).filter((task) => task.name === taskName).length;
    };
    await expect.poll(() => readFile(waitsFile, "utf8").catch(() => "")).toContain(taskName);
    const savedWait = await readFile(waitsFile, "utf8");
    if (approved) {
      lmStudio.holdCompletions!();
      await page.getByRole("button", { name: "Allow once" }).click();
      await expect.poll(taskCount).toBe(1);
      aiden.app.process().kill("SIGKILL");
    }
    // Model the old disk snapshot left by a crash before wait removal committed.
    page = await aiden.relaunch(approved ? () => writeFile(waitsFile, savedWait) : undefined);
    await page.getByText(prompt).first().click().catch(() => undefined);
    const card = page.locator("[data-interrupted-reply]");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("Check whether the action ran before trying it again.");
    await expect(card.getByRole("list", { name: "Saved approval requests" })).toContainText('Create scheduled task "Workspace brief"');
    await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);
    expect(await taskCount()).toBe(approved ? 1 : 0);
  });
}
