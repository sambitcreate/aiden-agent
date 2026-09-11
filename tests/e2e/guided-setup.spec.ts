import type { BotCapabilityCatalog } from "../../renderer/shared/bot-capabilities";
import { E2E_PROFILE_NAME, expect, finishLmStudioOnboarding, test } from "./fixtures";

test("onboarding exposes the four primary AI choices and validates custom setup", async ({ aiden }) => {
  const { page } = aiden;
  const onboarding = page.locator('section[aria-label="Set up Aiden"]');
  await onboarding.getByPlaceholder("Your name").fill(E2E_PROFILE_NAME);
  await onboarding.getByRole("button", { name: /^Next/u }).click();
  for (const name of [/^ChatGPT /u, /^LM Studio /u, /^Ollama /u, /^Other Custom Provider /u]) {
    await expect(onboarding.getByRole("button", { name })).toBeVisible();
  }
  await expect(onboarding.getByRole("button", { name: /^Other ways/u })).toHaveAttribute("aria-expanded", "false");
  await onboarding.getByRole("button", { name: /^Other Custom Provider /u }).click();
  const custom = page.getByRole("dialog", { name: "Configure Custom Provider" });
  await expect(custom).toBeVisible();
  await custom.getByRole("button", { name: "Save", exact: true }).click();
  await expect(custom.getByText("Discover models and choose an available default before continuing.")).toBeVisible();
  await custom.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(onboarding.getByRole("heading", { name: "Connect your AI" })).toBeVisible();
});

test("computer control explains data access before enabling and cancellation keeps it off", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Computer Use", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Enable Computer Use beta" });
  await expect(toggle).toHaveAttribute("data-state", "unchecked");
  await toggle.click();
  const review = page.getByRole("dialog", { name: "Let Aiden help with apps?" });
  await expect(review.getByText(/selected AI provider may receive screenshots/u)).toBeVisible();
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(toggle).toHaveAttribute("data-state", "unchecked");
});

test("Create a bot submits limited access in two steps and retains a failed draft", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  // This editor test isolates IPC because the test profile has no native Keychain
  // authority. Real Bot storage/permission transactions run in test:bots.
  const catalog: BotCapabilityCatalog = {
    revision: "catalog-editor-fixture", providers: [{ id: "custom:lmstudio", label: "LM Studio", available: true,
      models: [{ id: "aiden-e2e-vision", label: "Aiden E2E Vision", available: true, supportsImages: true }] }],
    fileScopes: [], shellAvailable: true, connections: [], skills: [], otherCapabilities: [],
    notice: { version: "bot-full-access-v1", requiresAcknowledgement: true },
  };
  await aiden.app.evaluate(({ ipcMain }, fixture) => {
    for (const channel of ["bots:list", "bots:getCapabilityCatalog", "bots:create"]) ipcMain.removeHandler(channel);
    ipcMain.handle("bots:list", () => []);
    ipcMain.handle("bots:getCapabilityCatalog", () => fixture);
    ipcMain.handle("bots:create", (_event, input: unknown) => {
      (globalThis as unknown as { botEditorSubmission: unknown }).botEditorSubmission = input;
      throw new Error("The test storage is unavailable.");
    });
  }, catalog);
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await page.getByRole("button", { name: "Create a bot", exact: true }).first().click();
  const editor = page.getByRole("dialog", { name: "Create a bot", exact: true });
  await expect(editor.getByText("Step 1 of 2")).toBeVisible();
  await editor.getByPlaceholder("Release reviewer").fill("Writing bot");
  await editor.getByPlaceholder("Describe the role, priorities, tone, and how this bot should approach work.").fill("Turn rough notes into a clear weekly update.");
  await editor.getByRole("button", { name: "Review model and access", exact: true }).click();
  await expect(editor.getByText("Step 2 of 2")).toBeVisible();
  await expect(editor.getByRole("button", { name: "Custom", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(editor.getByRole("button", { name: "Full", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(editor.getByRole("button", { name: "Create a bot", exact: true })).toBeEnabled();
  await editor.getByRole("button", { name: "Create a bot", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("Your choices are still here.");
  const submission = await aiden.app.evaluate(() => (globalThis as unknown as { botEditorSubmission: unknown }).botEditorSubmission);
  expect(submission).toMatchObject({ bot: { name: "Writing bot" }, access: {
    accessMode: "custom", custom: { providerId: "custom:lmstudio", modelId: "aiden-e2e-vision",
      shellEnabled: false, fileScopeIds: [], connectionIds: [], skillIds: [], otherCapabilityIds: [] },
  } });
  await editor.getByRole("button", { name: "Back", exact: true }).click();
  await expect(editor.getByPlaceholder("Release reviewer")).toHaveValue("Writing bot");
});
