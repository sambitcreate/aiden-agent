import path from "node:path";
import type { Page } from "@playwright/test";
import {
  E2E_PROFILE_NAME,
  expect,
  readJsonFile,
  skipBotsOnboardingStep,
  test,
} from "./fixtures";

const USAGE_SWITCH = { name: "Share anonymous usage and crash data" } as const;

async function openDiagnosticsSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "About", exact: true }).click();
  const group = page.locator("section.settings-group").filter({ has: page.getByRole("heading", { name: "Usage data" }) });
  await expect(group).toBeVisible();
  return group;
}

test.describe("usage data", () => {
  test.use({ portableConfigSeed: "empty" });

  test("is on in onboarding, and turning it off in Settings survives relaunch", async ({ aiden }) => {
    const onboarding = aiden.page.locator('section[aria-label="Set up Aiden"]');
    await onboarding.getByPlaceholder("Your name").fill(E2E_PROFILE_NAME);
    await onboarding.getByRole("button", { name: /^Next/u }).click();
    const lmStudio = onboarding.getByRole("button", { name: /LM Studio.*Use models running in LM Studio/u });
    await lmStudio.click();
    await onboarding.getByRole("button", { name: /^Next/u }).click();
    await skipBotsOnboardingStep(onboarding);

    await expect(onboarding.getByRole("switch", USAGE_SWITCH)).toBeChecked();
    await onboarding.getByRole("button", { name: "What’s sent" }).click();
    const sheet = aiden.page.getByRole("dialog", { name: "What’s sent" });
    await expect(sheet.getByText("app_opened", { exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toBeHidden();

    await onboarding.getByRole("button", { name: "Start using Aiden" }).click();
    await expect(onboarding).toBeHidden();
    // A new install answered the question in onboarding, so the upgrade notice never appears.
    await expect(aiden.page.getByRole("region", { name: "Aiden now shares anonymous usage data" })).toHaveCount(0);

    const group = await openDiagnosticsSettings(aiden.page);
    const control = group.getByRole("switch", USAGE_SWITCH);
    await expect(control).toBeChecked();
    await control.click();
    await expect(control).not.toBeChecked();
    await expect
      .poll(async () =>
        (await readJsonFile<{ analytics?: { enabled?: boolean } }>(path.join(aiden.userDataDir, "settings.json")))
          .analytics?.enabled,
      )
      .toBe(false);

    const page = await aiden.relaunch();
    const reopened = await openDiagnosticsSettings(page);
    await expect(reopened.getByRole("switch", USAGE_SWITCH)).not.toBeChecked();
  });
});
