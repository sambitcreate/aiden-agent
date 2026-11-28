import { expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });

test("a helper row in the chat card opens that helper's chat in the side panel", async ({
  aiden,
}) => {
  const { page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  const composer = page.locator("textarea").first();

  // One scout whose reply the test holds open, so it is still running when opened.
  const child = lmStudio.enqueueStreamedReply!("E2E helper chat child task");
  const prompt = "Helper chat test: ask one scout to look at the notes.";
  const scenario = lmStudio.enqueueToolScenario!({
    prompt,
    calls: [
      {
        name: "subagent",
        arguments: {
          tasks: [{ role: "scout", label: "Read the notes", task: "E2E helper chat child task" }],
        },
      },
    ],
    finalText: "The scout reported back.",
  });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  child.push("Reading the notes folder now.");

  const row = page
    .locator("[data-subagent-group]")
    .getByRole("button", { name: /^Open Read the notes\./u });
  await expect(row).toBeVisible();
  await row.click();

  const panel = page.locator("#environment-subagents-panel");
  const helperChat = panel.getByRole("article", { name: "Read the notes" });
  await expect(helperChat).toBeVisible();
  await expect(helperChat).toContainText("E2E helper chat child task");
  // Streaming text shows as it arrives; the newest word may wait for the next chunk.
  await expect(helperChat).toContainText("Reading the notes folder");
  await expect(helperChat).toContainText(/Running/u);
  // A helper with no helpers of its own offers a plain Stop, not Stop all.
  await expect(helperChat.getByRole("button", { name: "Stop Read the notes" })).toBeVisible();

  // Expand fills the main pane and hides the composer; Esc returns to the main chat.
  await helperChat.getByRole("button", { name: "Expand" }).click();
  const expanded = page.locator(
    '[data-subagent-helper-chat][data-subagent-helper-expanded="true"]',
  );
  await expect(expanded).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  // While the main pane shows the helper, the side panel says where it went,
  // with no second way back: the expanded chat's own footer is the only Back.
  await expect(panel.getByRole("heading", { name: "Showing in the main chat" })).toBeVisible();
  await expect(panel).toContainText("\u201cRead the notes\u201d is open in the main chat.");
  await expect(panel.getByRole("button", { name: "Back to main chat" })).toHaveCount(0);
  await expanded.getByRole("button", { name: "Back to main chat" }).click();
  await expect(expanded).toHaveCount(0);
  await expect(composer).toBeVisible();
  // Focus returns to the side panel's Expand button, which replaced the one that opened it.
  await expect(helperChat.getByRole("button", { name: "Expand" })).toBeFocused();

  // Esc also returns to the main chat. The pointer now rests over the chat
  // card's row, whose model card opens; it must not keep the Esc.
  await page.keyboard.press("Enter");
  await expect(expanded).toBeVisible();
  await expect(expanded.getByRole("heading", { name: "Read the notes" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(expanded).toHaveCount(0);
  await expect(composer).toBeVisible();
  await expect(helperChat.getByRole("button", { name: "Expand" })).toBeFocused();

  // When the scout finishes, its chat stays and says it is done.
  child.push(" The notes are fine.");
  child.finish();
  await expect(page.getByText("The scout reported back.")).toBeVisible();
  expect(scenario.error).toBeUndefined();
  await expect(helperChat).toContainText("The notes are fine.");
  await expect(helperChat).toContainText(/Done/u);
  await expect(helperChat.getByRole("button", { name: /^Stop / })).toHaveCount(0);
});
