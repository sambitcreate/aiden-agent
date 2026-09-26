import { expect, finishLmStudioOnboarding, test } from "./fixtures";

test("local Aiden Live, Scheduled, Profile, and About surfaces stay safe to explore", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);

  // The dock is now the one-time Aiden Live setup entry point. Exercise the
  // keyboard path without requesting system permissions or contacting Google.
  const liveSetupTrigger = page.getByRole("button", { name: "Set up Aiden Live" });
  await liveSetupTrigger.press("Enter");
  const liveSetup = page.getByRole("dialog", { name: "Set up Aiden Live" });
  await expect(liveSetup).toBeVisible();
  await expect(liveSetup.getByText("Beta", { exact: true })).toBeVisible();
  await expect(liveSetup.getByText("Google Live model", { exact: true })).toBeVisible();
  await expect(liveSetup.getByText("Microphone", { exact: true })).toBeVisible();
  await expect(liveSetup.getByText("Screen and Accessibility", { exact: true })).toBeVisible();
  await expect(liveSetup.getByText("Scheduled tasks", { exact: true })).toBeVisible();
  await liveSetup.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(liveSetup).toHaveCount(0);
  await expect(liveSetupTrigger).toBeVisible();

  // Natural-language creation stays available even if manual task dependencies
  // are unavailable. Templates only open an editor; Escape closes without saving.
  await page.getByRole("button", { name: "Scheduled", exact: true }).click();
  await expect(page.getByText("Scheduled tasks", { exact: true }).first()).toBeVisible();
  const taskSearch = page.getByRole("searchbox", { name: "Search scheduled tasks" });
  await taskSearch.fill("definitely-not-a-schedule");
  await expect(taskSearch).toHaveValue("definitely-not-a-schedule");
  await expect(page.getByText("No matching tasks", { exact: true })).toBeVisible();
  const clearTaskSearch = page.getByRole("button", { name: "Clear scheduled task search" });
  await clearTaskSearch.click();
  await expect(taskSearch).toHaveValue("");
  await expect(taskSearch).toBeFocused();
  await expect(clearTaskSearch).toHaveCount(0);
  await expect(page.getByText("No matching tasks", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Active", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Active", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "Paused", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Paused", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "All", exact: true }).click();
  const createWithAiden = page.getByRole("button", { name: "Create with Aiden", exact: true });
  await expect(createWithAiden).toBeEnabled();
  await createWithAiden.click();
  const seededComposer = page.locator("textarea");
  await expect(seededComposer).toHaveValue("Create an automation that ");
  await page.getByRole("button", { name: "Scheduled", exact: true }).click();
  const dailyBrief = page.getByRole("button", { name: /Daily brief/u });
  await expect(dailyBrief).toBeVisible();
  if (await dailyBrief.isEnabled()) {
    await dailyBrief.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } else {
    await expect(dailyBrief).toBeDisabled();
  }

  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  const profileName = page.getByRole("heading", {
    level: 2,
    name: "E2E Local User",
    exact: true,
  });
  await expect(profileName).toHaveText("E2E Local User");
  // The editor is a normal visible action here; exercise the same pointer path
  // a user takes after the scheduled-task dialog has fully closed.
  const editProfileName = page.getByRole("button", { name: "Edit profile name" });
  await expect(editProfileName).toBeVisible();
  await expect(editProfileName).toBeEnabled();
  await editProfileName.click();
  const profileInput = page.getByRole("textbox", { name: "Profile name" });
  await profileInput.fill("   ");
  await expect(page.getByRole("button", { name: "Save profile name" })).toBeDisabled();
  await profileInput.fill("Temporary E2E name");
  await expect(page.getByRole("button", { name: "Save profile name" })).toBeEnabled();
  await page.getByRole("button", { name: "Cancel editing profile name" }).click();
  await expect(profileName).toHaveText("E2E Local User");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("All settings", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
  await expect(page.getByText(/^Version .+ Beta/u)).toBeVisible();
  await expect(page.getByText("Diagnostics", { exact: true })).toBeVisible();
  await expect(page.getByText(/Nothing is uploaded automatically/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export…", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Enable…", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("never uploaded automatically");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Delete…", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("does not delete chats");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  const mainComposer = page.locator("textarea");
  await expect(mainComposer).toBeVisible();
  await expect(mainComposer).toHaveValue("");
  await expect(
    page.getByRole("button", { name: /^Selected model: .+\. Choose a model\.$/u }),
  ).toBeVisible();
});
