import type { ElectronApplication } from "playwright";
import { BOT_FULL_ACCESS_NOTICE_VERSION, type BotCapabilityCatalog } from "../../renderer/shared/bot-capabilities";
import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { E2E_PROFILE_NAME, expect, finishLmStudioOnboarding, skipBotsOnboardingStep, test } from "./fixtures";

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

test("skipping provider setup explains the blocked Next and leaves a route to Providers", async ({ aiden }) => {
  const { page } = aiden;
  const onboarding = page.locator('section[aria-label="Set up Aiden"]');
  await onboarding.getByPlaceholder("Your name").fill(E2E_PROFILE_NAME);
  await onboarding.getByRole("button", { name: /^Next/u }).click();
  await expect(onboarding.getByRole("heading", { name: "Connect your AI" })).toBeVisible();

  const next = onboarding.getByRole("button", { name: /^Next/u });
  await expect(next).toBeDisabled();
  await expect(next).toHaveAccessibleDescription(
    "Sign in with ChatGPT to continue, or choose another connection.",
  );
  await expect(onboarding.getByText(/setup required/u)).toHaveCount(0);

  await onboarding.getByRole("button", { name: "Skip provider" }).click();
  await expect(onboarding.getByText("Provider setup skipped")).toBeVisible();
  await skipBotsOnboardingStep(onboarding);
  await onboarding.getByRole("button", { name: "Start using Aiden" }).click();
  await expect(onboarding).toBeHidden();

  await expect(page.getByText("What would you like to work on?")).toBeVisible();
  const connect = page.getByRole("button", { name: "Connect a provider", exact: true });
  await expect(connect.first()).toBeVisible();
  await connect.first().click();
  await expect(
    page.getByText(/Connect with credentials when required; Aiden keeps their model catalogs current/u),
  ).toBeVisible();
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

// The e2e profile has no macOS Keychain authority, so the real Bot store cannot
// open. Only the Bot IPC is substituted (as in bots-starter.spec.ts); the create
// flow, Advanced page, and their renderer state are the shipped code.
async function substituteBotIpc(app: ElectronApplication, options: { failFirstCreate: boolean }) {
  const catalog: BotCapabilityCatalog = {
    revision: "catalog-editor-fixture", providers: [{ id: "custom:lmstudio", label: "LM Studio", available: true,
      models: [{ id: "aiden-e2e-vision", label: "Aiden E2E Vision", available: true, supportsImages: true }] }],
    fileScopes: [], shellAvailable: true, connections: [], skills: [], otherCapabilities: [],
    notice: { version: BOT_FULL_ACCESS_NOTICE_VERSION, requiresAcknowledgement: false, acceptedAt: "2026-10-01T00:00:00.000Z", acceptedDecision: "continue_full" },
  };
  const bot = botFixture({ id: "bot-meal", name: "Meal Planner", description: "Plan my meals and grocery list every week" });
  const idle = { botId: bot.id, preview: null, updatedAt: null, state: { kind: "idle" } };
  // Shape of the bots:getBotAccess result (BotAccessState) for a Full-access Bot.
  const access = {
    access: { botId: bot.id, revision: "access-1", policyEpoch: "policy-1", summary: "Everything", accessMode: "full" },
    modelSelection: { providerId: "custom:lmstudio", modelId: "aiden-e2e-vision" },
  };
  await app.evaluate(({ ipcMain }, fixture) => {
    const state = { created: false, createCalls: 0, failFirstCreate: fixture.failFirstCreate, creates: [] as unknown[], accessUpdates: [] as unknown[] };
    (globalThis as unknown as { botCreateE2e: typeof state }).botCreateE2e = state;
    for (const channel of [
      "bots:list", "bots:get", "bots:create", "bots:introduce", "bots:getCapabilityCatalog",
      "bots:getBotAccess", "bots:updateBotAccess", "bots:live:subscribe", "bots:live:summary",
      "bots:getCanonicalPhoto", "bots:pendingApprovals",
    ]) ipcMain.removeHandler(channel);
    ipcMain.handle("bots:list", () => (state.created ? [fixture.bot] : []));
    ipcMain.handle("bots:get", () => fixture.bot);
    ipcMain.handle("bots:getCapabilityCatalog", () => fixture.catalog);
    ipcMain.handle("bots:create", (_event, input: unknown) => {
      state.createCalls += 1;
      state.creates.push(input);
      if (state.failFirstCreate && state.createCalls === 1) throw new Error("The test storage is unavailable.");
      state.created = true;
      return fixture.bot;
    });
    ipcMain.handle("bots:introduce", () => false);
    ipcMain.handle("bots:getBotAccess", () => fixture.access);
    ipcMain.handle("bots:updateBotAccess", (_event, input: unknown) => {
      state.accessUpdates.push(input);
      return { ...fixture.access.access, revision: "access-2", accessMode: "custom", custom: { providerId: "custom:lmstudio", modelId: "aiden-e2e-vision", fileScopeIds: [], shellEnabled: false, connectionIds: [], skillIds: [], otherCapabilityIds: [] } };
    });
    ipcMain.handle("bots:live:subscribe", () => ({ ...fixture.idle, epoch: "e1", seq: 0, entries: [], partial: null }));
    ipcMain.handle("bots:live:summary", () => fixture.idle);
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
  }, { bot, catalog, access, idle, failFirstCreate: options.failFirstCreate });
}

async function botCreateE2e(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as unknown as { botCreateE2e: {
    createCalls: number; creates: unknown[]; accessUpdates: unknown[];
  } }).botCreateE2e);
}

test("Create a bot keeps the draft after a failed save, then creates it with Full access", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await substituteBotIpc(aiden.app, { failFirstCreate: true });
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await page.getByRole("button", { name: "New Bot", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New Bot", exact: true });
  await editor.getByRole("textbox", { name: "Name" }).fill("Meal Planner");
  await editor.getByRole("textbox", { name: "What should it help with?" }).fill("Plan my meals and grocery list every week");
  await editor.getByRole("button", { name: "Next", exact: true }).click();
  // The second step renames the dialog to "Connections".
  const connections = page.getByRole("dialog", { name: "Connections", exact: true });
  await expect(connections.getByRole("group", { name: "Suggested connections" })).toBeVisible();
  await connections.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(connections.getByRole("alert")).toContainText("The test storage is unavailable.");
  await connections.getByRole("button", { name: "Back", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "Name" })).toHaveValue("Meal Planner");
  await expect(editor.getByRole("textbox", { name: "What should it help with?" })).toHaveValue("Plan my meals and grocery list every week");
});

test("Create a bot from a name and a help answer, then switch its Advanced access to Only what I choose", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await substituteBotIpc(aiden.app, { failFirstCreate: false });
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await page.getByRole("button", { name: "New Bot", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New Bot", exact: true });
  await editor.getByRole("textbox", { name: "Name" }).fill("Meal Planner");
  await editor.getByRole("textbox", { name: "What should it help with?" }).fill("Plan my meals and grocery list every week");
  await editor.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("dialog", { name: "Connections", exact: true }).getByRole("button", { name: "Skip", exact: true }).click();

  // Creating opens the Bot's chat; the request carries the name, the answer as
  // the subtitle, and Full access by default (no custom selection).
  await expect(page.getByPlaceholder("Ask Meal Planner")).toBeVisible();
  const { creates } = await botCreateE2e(aiden.app);
  expect(creates).toHaveLength(1);
  const created = creates[0];
  expect(created).toMatchObject({
    bot: { name: "Meal Planner", description: "Plan my meals and grocery list every week" },
    access: { accessMode: "full", catalogRevision: "catalog-editor-fixture", providerId: "custom:lmstudio", modelId: "aiden-e2e-vision" },
  });
  expect(created).not.toHaveProperty("access.custom");

  // Advanced is reached from the Bot's Profile, which the Bots list opens from its row menu.
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await page.getByRole("button", { name: /^Meal Planner/u }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Profile", exact: true }).click();
  await page.getByRole("button", { name: "More for Meal Planner", exact: true }).click();
  await page.getByRole("menuitem", { name: "Advanced", exact: true }).click();
  const onlyChoose = page.getByRole("radio", { name: "Only what I choose", exact: true });
  await expect(page.getByRole("radio", { name: "Everything", exact: true })).toBeChecked();
  await onlyChoose.click();
  await expect(onlyChoose).toBeChecked();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  const { accessUpdates } = await botCreateE2e(aiden.app);
  expect(accessUpdates).toMatchObject([{
    botId: "bot-meal",
    expectedRevision: "access-1",
    access: { accessMode: "custom", custom: { providerId: "custom:lmstudio", modelId: "aiden-e2e-vision", shellEnabled: false, fileScopeIds: [], connectionIds: [], skillIds: [], otherCapabilityIds: [] } },
  }]);
});


test("feature gallery reveals complete descriptions through keyboard focus at narrow widths", async ({ aiden }) => {
  const { page } = aiden;
  const onboarding = page.locator('section[aria-label="Set up Aiden"]');
  await onboarding.getByPlaceholder("Your name").fill(E2E_PROFILE_NAME);
  await onboarding.getByRole("button", { name: /^Next/u }).click();
  await onboarding.getByRole("button", { name: /LM Studio.*Use models running in LM Studio/u }).click();
  await onboarding.getByRole("button", { name: /^Next/u }).click();
  await skipBotsOnboardingStep(onboarding);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [1000, 600, 390]) {
    await aiden.app.evaluate(({ BrowserWindow }, nextWidth) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(320, 400);
      window.setSize(nextWidth, 800);
    }, width);
    const scripts = onboarding.getByRole("article", { name: /^Tool Scripts\./u });
    await scripts.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(scripts).toBeFocused();
    for (const name of [/^Tool Scripts\./u, /^Attachments & Vision\./u, /^Model Freedom\./u]) {
      const tile = onboarding.getByRole("article", { name });
      await tile.focus();
      await tile.scrollIntoViewIfNeeded();
      const description = tile.locator("[data-onboarding-feature-description]");
      await expect.poll(() => description.evaluate((element) => {
        const overlay = element.parentElement!.parentElement!;
        return getComputedStyle(overlay).opacity;
      })).toBe("1");
      const bounds = await description.evaluate((element) => {
        const text = element.getBoundingClientRect();
        const card = element.closest("article")!.getBoundingClientRect();
        return { top: text.top - card.top, bottom: card.bottom - text.bottom, left: text.left - card.left, right: card.right - text.right };
      });
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeGreaterThanOrEqual(0);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeGreaterThanOrEqual(0);
    }
  }
});


for (const platform of ["linux", "darwin"] as const) {
  test(`Model Freedom renders platform-accurate providers and classifier disclosures on ${platform}`, async ({ aiden }) => {
    // Only platform capability IPC is substituted: the real onboarding data,
    // filtering, gallery card and accessible description are rendered unchanged.
    await aiden.app.evaluate(({ ipcMain }, hostPlatform) => {
      ipcMain.removeHandler("app:getInfo");
      ipcMain.handle("app:getInfo", () => ({
        name: "Aiden", version: "e2e", environment: "test",
        capabilities: { platform: hostPlatform, appleFoundationModels: hostPlatform === "darwin" },
      }));
    }, platform);
    await aiden.page.reload();
    const onboarding = aiden.page.locator('section[aria-label="Set up Aiden"]');
    await onboarding.getByPlaceholder("Your name").fill(E2E_PROFILE_NAME);
    await onboarding.getByRole("button", { name: /^Next/u }).click();
    await onboarding.getByRole("button", { name: /LM Studio.*Use models running in LM Studio/u }).click();
    await onboarding.getByRole("button", { name: /^Next/u }).click();
    const card = onboarding.getByRole("article", { name: /^Model Freedom\./u });
    await card.focus();
    const description = card.locator("[data-onboarding-feature-description]");
    await expect(description).toContainText("30+ Pi providers, ChatGPT sign-in");
    await expect(description).toContainText("custom endpoints");
    if (platform === "darwin") await expect(description).toContainText("Apple models");
    else {
      await expect(description).not.toContainText("Apple");
      await expect(card).not.toHaveAttribute("aria-label", /Apple/u);
    }
    await expect(description).toContainText("Enable local llama.cpp classification in a custom provider’s More options");
    await expect(description).toContainText("approve sending it; provider charges may apply");
  });
}

test("feature tour explains image and classifier disclosure on rendered cards", async ({ aiden }) => {
  const onboarding = aiden.page.locator('section[aria-label="Set up Aiden"]');
  await onboarding.getByPlaceholder("Your name").fill(E2E_PROFILE_NAME);
  await onboarding.getByRole("button", { name: /^Next/u }).click();
  await onboarding.getByRole("button", { name: /LM Studio.*Use models running in LM Studio/u }).click();
  await onboarding.getByRole("button", { name: /^Next/u }).click();
  await skipBotsOnboardingStep(onboarding);
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
