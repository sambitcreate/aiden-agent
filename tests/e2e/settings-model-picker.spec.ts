import { E2E_MODEL_DISPLAY_NAME, expect, finishLmStudioOnboarding, test } from "./fixtures";

const SETTINGS_SECTIONS = [
  "Providers",
  "Model Pad",
  "Skills",
  "MCP Servers",
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
        page.getByText(/Pi-native providers need only their credentials/u),
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
    case "MCP Servers":
      await expect(page.getByText(/Connect tool providers or add your own server/u)).toBeVisible();
      return;
    case "Web Search":
      await expect(
        page.getByRole("heading", { level: 2, name: "Web Search (Exa)", exact: true }),
      ).toBeVisible();
      return;
    case "Remote Access":
      await expect(
        page.getByRole("heading", { level: 2, name: "Remote Access", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("switch", { name: "Enable Aiden Remote Access" })).toHaveAttribute(
        "data-state",
        "unchecked",
      );
      await expect(
        page.getByRole("group")
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
  await options.first().click();
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
