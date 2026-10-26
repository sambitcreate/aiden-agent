import { expect, finishLmStudioOnboarding, test, E2E_ASSISTANT_RESPONSE } from "./fixtures";

const RESUME_TURN = "Continue where you left off.";

for (const ending of ["crash", "quit"] as const) {
  test(`a reply cut short by a ${ending} offers Resume after relaunch and never resumes on its own`, async ({ aiden }) => {
    test.setTimeout(120_000);
    const { lmStudio } = aiden;
    let page = aiden.page;
    await finishLmStudioOnboarding(page);
    const prompt = `Write the long report before the ${ending}`;
    const reply = lmStudio.enqueueStreamedReply!(prompt);
    const composer = page.locator("textarea");
    await composer.fill(prompt);
    await composer.press("Enter");
    reply.push("The first section of the report");
    await expect(page.getByText("The first section of the report")).toBeVisible({ timeout: 15_000 });

    if (ending === "crash") aiden.app.process().kill("SIGKILL");
    page = await aiden.relaunch();
    await page.getByText(prompt).first().click().catch(() => undefined);
    await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 15_000 });

    const card = page.locator("[data-interrupted-reply]");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText("This reply was interrupted")).toBeVisible();
    // Never automatic: nothing is sent until the person chooses Resume.
    await page.waitForTimeout(1_000);
    await expect(page.getByText(RESUME_TURN)).toHaveCount(0);

    await card.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByText(RESUME_TURN)).toBeVisible();
    await expect(page.getByText(E2E_ASSISTANT_RESPONSE).last()).toBeVisible({ timeout: 15_000 });
    await expect(card).toHaveCount(0);
  });
}

test("a reply stopped with Stop does not offer Resume after relaunch", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { lmStudio } = aiden;
  let page = aiden.page;
  await finishLmStudioOnboarding(page);
  const prompt = "Write something I will stop";
  const reply = lmStudio.enqueueStreamedReply!(prompt);
  const composer = page.locator("textarea");
  await composer.fill(prompt);
  await composer.press("Enter");
  reply.push("A start that gets stopped");
  await expect(page.getByText("A start that gets stopped")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, { timeout: 15_000 });

  page = await aiden.relaunch();
  await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_500);
  await expect(page.locator("[data-interrupted-reply]")).toHaveCount(0);
});
