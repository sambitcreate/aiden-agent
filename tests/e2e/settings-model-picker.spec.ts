import { E2E_MODEL_DISPLAY_NAME, expect, expectSquircleButtons, finishLmStudioOnboarding, test } from "./fixtures";

const SETTINGS_SECTIONS = [
  "Providers",
  "Model Pad",
  "Skills",
  "Plugins",
  "Web Search",
  "Remote Access",
  "Scheduled tasks",
  "Aiden",
  "Computer Use",
  "Voice",
  "Keyboard shortcuts",
  "Appearance",
  "About",
] as const;

async function assertRenderedSettingsDestination(
  page: Parameters<typeof finishLmStudioOnboarding>[0],
  section: (typeof SETTINGS_SECTIONS)[number],
): Promise<void> {
  switch (section) {
    case "Providers":
      await expect(
        page.getByText(
          /Connect with credentials when required; Aiden keeps their model catalogs current/u,
        ),
      ).toBeVisible();
      return;
    case "Model Pad":
      await expect(
        page.getByRole("heading", { level: 2, name: "Personal Model Pad", exact: true }),
      ).toBeVisible();
      return;
    case "Skills":
      await expect(
        page.getByText(/Reusable instruction sets the assistant can invoke/u),
      ).toBeVisible();
      return;
    case "Plugins":
      await expect(
        page.getByText(/Browse plugins, connect hosted MCP servers, or add your own/u),
      ).toBeVisible();
      return;
    case "Web Search":
      await expect(
        page.getByRole("heading", { level: 1, name: "Web Search", exact: true }),
      ).toBeVisible();
      return;
    case "Remote Access":
      await expect(
        page.getByRole("heading", { level: 2, name: "Remote Access", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("switch", { name: "Enable Aiden Remote Access" }),
      ).toHaveAttribute("data-state", "unchecked");
      await expect(
        page
          .getByRole("group")
          .filter({ has: page.getByRole("switch", { name: "Enable Aiden Remote Access" }) })
          .getByText("Off", { exact: true }),
      ).toBeVisible();
      return;
    case "Scheduled tasks":
      await expect(
        page.getByRole("heading", { level: 2, name: "Scheduled tasks", exact: true }),
      ).toBeVisible();
      return;
    case "Aiden":
      await expect(
        page.getByRole("heading", { level: 2, name: "How Aiden works", exact: true }),
      ).toBeVisible();
      return;
    case "Computer Use":
      await expect(page.getByRole("heading", { level: 2, name: /^Computer Use/u })).toBeVisible();
      return;
    case "Voice":
      await expect(
        page.getByRole("heading", { level: 2, name: "Voice Input", exact: true }),
      ).toBeVisible();
      return;
    case "Keyboard shortcuts":
      await expect(
        page.getByRole("heading", { level: 1, name: "Keyboard shortcuts", exact: true }),
      ).toBeVisible();
      return;
    case "Appearance":
      await expect(
        page.getByRole("heading", { level: 1, name: "Appearance", exact: true }),
      ).toBeVisible();
      return;
    case "About":
      await expect(
        page.getByRole("heading", { level: 2, name: "About", exact: true }),
      ).toBeVisible();
  }
}

test("every Settings destination renders and a one-model local inventory stays usable", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);

  const modelTrigger = page.getByRole("button", { name: /^Selected model:/u });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settingsNavigation = page.getByRole("navigation", { name: "Settings" });
  const settingsSearch = page.getByRole("searchbox", { name: "Search settings" });
  await expect(settingsSearch).toBeVisible();

  await settingsSearch.fill("not-a-real-settings-section");
  await expect(page.getByText(/No settings match “not-a-real-settings-section”/u)).toBeVisible();
  await settingsSearch.press("Escape");
  await expect(settingsSearch).toHaveValue("");
  await expect(
    settingsNavigation.getByRole("button", { name: "Providers", exact: true }),
  ).toBeVisible();

  for (const section of SETTINGS_SECTIONS) {
    const destination = settingsNavigation.getByRole("button", { name: section, exact: true });
    await destination.click();
    await expect(destination).toHaveAttribute("aria-current", "page");
    await assertRenderedSettingsDestination(page, section);
    await expectSquircleButtons(page);
    if (section === "Appearance") {
      const light = page.locator('.appearance-mode-preview-light [data-preview-scheme="light"]');
      const dark = page.locator('.appearance-mode-preview-dark [data-preview-scheme="dark"]');
      const colors = async () => [await light.evaluate(el => getComputedStyle(el).backgroundColor), await dark.evaluate(el => getComputedStyle(el).backgroundColor)];
      const assertRestingPreviews = async () => {
        await page.getByRole("heading", { level: 1, name: "Appearance", exact: true }).click();
        for (const preview of await page.locator('.appearance-mode-preview, .appearance-mode-scene').all()) {
          const bounds = await preview.boundingBox();
          expect(bounds?.width).toBeGreaterThan(40);
          expect(bounds?.height).toBeGreaterThan(40);
        }
        const selected = page.locator('.appearance-mode-option[aria-checked="true"] .appearance-mode-option-label');
        await expect(selected).toHaveCount(1);
        const selectedFill = await selected.evaluate(el => getComputedStyle(el).backgroundColor);
        expect(selectedFill).not.toBe('rgba(0, 0, 0, 0)');
        for (const label of await page.locator('.appearance-mode-option[aria-checked="false"] .appearance-mode-option-label').all()) {
          expect(await label.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(selectedFill);
        }
      };
      await assertRestingPreviews();
      const before = await colors();
      expect(before[0]).not.toBe(before[1]);
      await page.locator('.appearance-mode-option').filter({hasText: 'Dark'}).click();
      await expect(page.locator('html')).toHaveClass(/dark/u);
      await expectSquircleButtons(page);
      expect(await colors()).toEqual(before);
      await assertRestingPreviews();
      await page.locator('.appearance-mode-option').filter({hasText: 'Light'}).click();
      await expect(page.locator('html')).not.toHaveClass(/dark/u);
      await expectSquircleButtons(page);
      expect(await colors()).toEqual(before);
      await assertRestingPreviews();
    }
    if (section === "Web Search") {
      await expect(page.getByText("Current search setup", { exact: true })).toBeVisible();
      await expect(page.getByRole("radiogroup", { name: "Web Search routing policy" })).toHaveCount(
        0,
      );

      const routingOptions = page.getByRole("button", { name: /Routing options/u });
      await expect(routingOptions).toHaveAttribute("aria-expanded", "false");
      await routingOptions.click();
      await expect(
        page.getByRole("radiogroup", { name: "Web Search routing policy" }),
      ).toBeVisible();
      await routingOptions.click();
      await expect(page.getByRole("radiogroup", { name: "Web Search routing policy" })).toHaveCount(
        0,
      );

      const browseProviders = page.getByRole("button", { name: /Browse providers/u });
      await browseProviders.click();
      await expect(
        page.getByRole("heading", { level: 1, name: "Browse providers", exact: true }),
      ).toBeFocused();
      const exaProvider = page.getByRole("button", { name: /^Exa/u });
      await exaProvider.click();
      await expect(page.getByRole("heading", { level: 1, name: "Exa", exact: true })).toBeFocused();
      await page.getByRole("button", { name: "All providers", exact: true }).click();
      await expect(exaProvider).toBeFocused();
      await page.getByRole("button", { name: "Back to Web Search", exact: true }).click();
      await expect(browseProviders).toBeFocused();
    }
  }

  const providers = settingsNavigation.getByRole("button", { name: "Providers", exact: true });
  await providers.click();
  const lmStudioRow = page
    .getByText("LM Studio (local)", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Configure']][1]");
  const configure = lmStudioRow.getByRole("button", { name: "Configure", exact: true });
  await configure.click();
  const providerDialog = page.getByRole("dialog", { name: "Configure LM Studio (local)" });
  await expect(
    providerDialog.getByRole("group", { name: "Base URL" }).locator("input"),
  ).toHaveValue(aiden.lmStudio.baseUrl);
  await expect(providerDialog.getByText("No authentication", { exact: true })).toBeVisible();
  await expect(providerDialog.locator('input[type="password"]')).toHaveCount(0);
  await expect(providerDialog.getByRole("button", { name: "Discover models" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(providerDialog).toBeHidden();
  await expect(configure).toBeFocused();

  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(modelTrigger).toBeVisible();

  await modelTrigger.click();
  await page.getByRole("tab", { name: "List", exact: true }).press("Enter");
  const filter = page.getByRole("combobox", { name: "Chat model" });
  await expect(filter).toBeFocused();
  await filter.fill("this-model-does-not-exist");
  await expect(page.getByText("No models found.", { exact: true })).toBeVisible();
  await filter.press("Escape");
  await expect(filter).toBeHidden();
  await expect(modelTrigger).toBeFocused();

  await modelTrigger.click();
  await page.getByRole("tab", { name: "List", exact: true }).press("Enter");
  const options = page.locator("[cmdk-item]");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText(E2E_MODEL_DISPLAY_NAME);
  await expect(filter).toBeFocused();
  await expect(options.first()).toHaveAttribute("data-selected", "true");
  await filter.press("Enter");
  await expect(modelTrigger).toHaveAttribute(
    "aria-label",
    new RegExp(`^Selected model: ${E2E_MODEL_DISPLAY_NAME}\\. Choose a model\\.$`, "u"),
  );

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const appearance = settingsNavigation.getByRole("button", { name: "Appearance", exact: true });
  await appearance.click();
  const dark = page.getByRole("radio", { name: "Dark", exact: true });
  await dark.click();
  await expect(dark).toHaveAttribute("aria-checked", "true");
  await providers.click();
  await appearance.click();
  await expect(page.getByRole("radio", { name: "Dark", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
