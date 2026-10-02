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

test("computer control respects platform support and explains access before enabling", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const computerUse = page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Computer Use", exact: true });
  if (process.platform !== "darwin") {
    await expect(computerUse).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Enable Computer Use beta" })).toHaveCount(0);
    return;
  }
  await computerUse.click();
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

test("feature tour explains image and classifier disclosure on rendered cards", async ({ aiden }) => {
  const onboarding = aiden.page.locator('section[aria-label="Set up Aiden"]');
  await onboarding.getByPlaceholder("Your name").fill(E2E_PROFILE_NAME);
  await onboarding.getByRole("button", { name: /^Next/u }).click();
  await onboarding.getByRole("button", { name: /LM Studio.*Use models running in LM Studio/u }).click();
  await onboarding.getByRole("button", { name: /^Next/u }).click();
  await expect(onboarding.getByRole("heading", { name: "Everything Aiden brings together" })).toBeVisible();
  const images = onboarding.getByRole("article", { name: /Generate or edit attached images/u });
  await images.hover();
  await expect(images.getByText(/approving the prompt, reference images, and possible provider charges/u)).toBeVisible();
  const models = onboarding.getByRole("article", { name: /^Model Freedom/u });
  await models.hover();
  await expect(models.getByText(/classifiers.*approve sending it.*provider charges/u)).toBeVisible();
});

test("classifier approval lets users inspect late payload fields before denying", async ({ aiden }) => {
  await finishLmStudioOnboarding(aiden.page);
  const state = JSON.stringify({ early: "x".repeat(20_000), late: "PRIVATE-LATE-FIELD" });
  const questions = JSON.stringify({ verdict: { type: "bool", instructions: "Inspect every field", criteria: { true: "Accept", false: "Reject" } } });
  await aiden.app.evaluate(({ ipcMain }, payload) => {
    ipcMain.removeHandler("chat:start");
    ipcMain.removeHandler("chat:approve");
    ipcMain.handle("chat:start", (event, streamId: string) => {
      (globalThis as unknown as { classifierStreamId: string }).classifierStreamId = streamId;
      event.sender.send("chat:approval", { streamId, approvalId: "classifier-inspection", toolCallId: "classify-1", toolName: "classify", summary: "Classify structured data", details: {
        kind: "model-classification", providerId: "research", providerLabel: "Research team", modelId: "judge",
        stateJson: payload.state, questionsJson: payload.questions, stateBytes: Buffer.byteLength(payload.state), questionsBytes: Buffer.byteLength(payload.questions), payloadComplete: true,
      } });
      return { streamId };
    });
    ipcMain.handle("chat:approve", (_event, _id: string, decision: string) => {
      (globalThis as unknown as { classifierDecision: string }).classifierDecision = decision;
    });
  }, { state, questions });
  const composer = aiden.page.locator("textarea").first();
  await composer.fill("Inspect classification inputs");
  await composer.press("Enter");
  await expect(aiden.page.getByText(/Send the state and questions below to Research team/u)).toBeVisible();
  await aiden.page.getByText(/^State ·/u).click();
  const inspector = aiden.page.getByLabel("Complete classification state", { exact: true });
  await expect(inspector).toHaveText(state);
  await inspector.focus();
  await inspector.press("ControlOrMeta+End");
  await expect(inspector).toBeFocused();
  await aiden.page.getByText(/^Questions ·/u).click();
  await expect(aiden.page.getByLabel("Complete classification questions", { exact: true })).toHaveText(questions);
  await aiden.page.getByRole("button", { name: "Deny", exact: true }).click();
  expect(await aiden.app.evaluate(() => (globalThis as unknown as { classifierDecision: string }).classifierDecision)).toBe("deny");
  await aiden.app.evaluate(({ BrowserWindow }) => {
    const streamId = (globalThis as unknown as { classifierStreamId: string }).classifierStreamId;
    BrowserWindow.getAllWindows()[0]!.webContents.send("chat:approval", { streamId, approvalId: "missing-classifier-inputs", toolCallId: "classify-2", toolName: "classify", summary: "Inputs omitted" });
  });
  await expect(aiden.page.getByText("This malformed privileged action cannot be allowed. Deny it to continue.")).toBeVisible();
  await expect(aiden.page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
  await expect(aiden.page.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
});
