import { E2E_ASSISTANT_RESPONSE, expect, finishLmStudioOnboarding, test } from "./fixtures";

// Unlike the other Bot specs, nothing here substitutes Bot IPC: the real Bot
// store, durable runtime and live projection answer the renderer. The fixture
// gives the isolated HOME its own default keychain so the store can write its
// rollback authority, and the deterministic LM Studio fixture answers each turn.
test.use({ isolatedKeychain: true });
test.skip(process.platform !== "darwin", "The isolated keychain fixture is macOS-only.");

test("a Bot made in the create flow answers through the real runtime and keeps its transcript across a relaunch", async ({ aiden }) => {
  const question = "Which errand comes first on Saturday?";
  const answer = "Collect the dry cleaning before the farmers market.";
  const turn = aiden.lmStudio.enqueueToolScenario!({ prompt: question, calls: [], finalText: answer });

  let page = aiden.page;
  const transcript = () => page.getByRole("main");
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await page.getByRole("button", { name: "Create my own" }).click();
  const dialog = page.getByRole("dialog", { name: "New Bot" });
  await dialog.getByLabel("Name").fill("Errand Planner");
  await dialog.getByLabel("What should it help with?").fill("Plan my weekend errands");
  await dialog.getByRole("button", { name: "Next" }).click();
  await page.getByRole("dialog", { name: "Connections" }).getByRole("button", { name: "Create" }).click();

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
