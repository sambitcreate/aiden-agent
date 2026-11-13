import { connectOnboardingLmStudio, E2E_ASSISTANT_RESPONSE, E2E_PROFILE_NAME, expect, test } from "./fixtures";

// Unlike the other Bot specs, nothing here substitutes Bot IPC: the real Bot
// store, durable runtime and live projection answer the renderer. The fixture
// gives the isolated HOME its own default keychain so the store can write its
// rollback authority, and the deterministic LM Studio fixture answers each turn.
test.use({ isolatedKeychain: true });
test.skip(process.platform !== "darwin", "The isolated keychain fixture is macOS-only.");

test("onboarding's first Bot greets the person, and a Bot made with New bot answers through the real runtime and keeps its transcript across a relaunch", async ({ aiden }) => {
  const question = "Which errand comes first on Saturday?";
  const answer = "Collect the dry cleaning before the farmers market.";
  const turn = aiden.lmStudio.enqueueToolScenario!({ prompt: question, calls: [], finalText: answer });

  let page = aiden.page;
  const transcript = () => page.getByRole("main");
  // With an empty Bot store, onboarding makes the first Bot by itself and
  // finishing setup opens its chat on its first real message.
  const onboarding = page.locator('section[aria-label="Set up Aiden"]');
  await expect(onboarding).toBeVisible();
  await onboarding.getByPlaceholder("Your name").fill(E2E_PROFILE_NAME);
  await onboarding.getByRole("button", { name: /^Next/u }).click();
  await connectOnboardingLmStudio(onboarding);
  await expect(onboarding.getByRole("region", { name: "Your first Bot" }).getByRole("status")).toHaveText("Chief is ready");
  await onboarding.getByRole("button", { name: "Start using Aiden" }).click();
  await expect(onboarding).toBeHidden();
  await expect(page.getByPlaceholder("Ask Chief")).toBeVisible();
  await expect(transcript().getByText(E2E_ASSISTANT_RESPONSE, { exact: true })).toBeVisible();

  // New bot takes only a name.
  await page.getByRole("button", { name: "Create", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "New bot" }).click();
  const dialog = page.getByRole("dialog", { name: "New bot" });
  await dialog.getByRole("textbox", { name: "Name your Bot" }).fill("Errand Planner");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  // The create flow's self-intro is the Bot's first real turn.
  const composer = page.getByPlaceholder("Ask Errand Planner");
  await expect(composer).toBeVisible();
  await expect(transcript().getByText(E2E_ASSISTANT_RESPONSE, { exact: true })).toBeVisible();

  await composer.fill(question);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(transcript().getByText(answer, { exact: true })).toBeVisible();
  await expect(transcript().getByText(question, { exact: true })).toBeVisible();
  expect(turn.completed).toBe(true);
  const completions = () => aiden.lmStudio.requests.filter(({ url }) => url === "/v1/chat/completions").length;
  const completionsBeforeRelaunch = completions();

  page = await aiden.relaunch();
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await expect(page.getByPlaceholder("Ask Errand Planner")).toBeVisible();
  await expect(transcript().getByText(E2E_ASSISTANT_RESPONSE, { exact: true })).toBeVisible();
  await expect(transcript().getByText(question, { exact: true })).toBeVisible();
  await expect(transcript().getByText(answer, { exact: true })).toBeVisible();
  // The transcript is read back from the Bot's durable session, not re-asked.
  expect(completions()).toBe(completionsBeforeRelaunch);
});
