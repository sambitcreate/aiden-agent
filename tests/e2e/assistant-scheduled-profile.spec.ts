import { expect, finishLmStudioOnboarding, test } from "./fixtures";

test("local Assistant, Scheduled, Profile, and About surfaces stay safe to explore", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);

  // Assistant is a local dock. Exercise its state without submitting a prompt
  // (and therefore without creating a provider request or an assistant thread).
  await page.getByRole("button", { name: "Open Aiden" }).press("Enter");
  const assistantComposer = page.getByRole("textbox", { name: "Message Aiden" });
  const assistantPanel = assistantComposer.locator(
    "xpath=ancestor::div[.//button[@aria-label='New conversation']][1]",
  );
  await expect(assistantComposer).toBeVisible();
  await expect(page.getByRole("button", { name: "New conversation" })).toBeVisible();
  await expect(page.getByText("Try asking", { exact: true })).toBeVisible();
  // Main chat history has its own sidebar “Recent” bucket. A fresh Assistant
  // session deliberately has no saved Assistant threads to list yet.
  await expect(assistantPanel.getByText("Recent", { exact: true })).toHaveCount(0);
  await assistantComposer.fill("Unsaved assistant draft");
  await page.getByRole("button", { name: "Minimize Aiden" }).click();
  await expect(page.getByRole("button", { name: "Open Aiden" })).toBeVisible();
  await page.getByRole("button", { name: "Open Aiden" }).press("Enter");
  await expect(assistantComposer).toHaveValue("Unsaved assistant draft");
  await assistantComposer.fill("");
  await page.getByRole("button", { name: "Minimize Aiden" }).click();

  // Scheduled templates only open an editor. Escape closes it without saving;
  // unavailable creation remains a valid, explicit product state.
  await page.getByRole("button", { name: "Scheduled", exact: true }).click();
  await expect(page.getByText("Scheduled tasks", { exact: true }).first()).toBeVisible();
  const taskSearch = page.getByRole("searchbox", { name: "Search scheduled tasks" });
  await taskSearch.fill("definitely-not-a-schedule");
  await expect(taskSearch).toHaveValue("definitely-not-a-schedule");
  await expect(page.getByText("No matching tasks", { exact: true })).toBeVisible();
  await taskSearch.fill("");
  await expect(taskSearch).toHaveValue("");
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
  const dailyBrief = page.getByRole("button", { name: /Daily brief/u });
  await expect(dailyBrief).toBeVisible();
  if (await dailyBrief.isEnabled()) {
    await dailyBrief.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } else {
    await expect(page.getByRole("button", { name: "Create" })).toBeDisabled();
  }

  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  const profileName = page.getByRole("heading", {
    level: 2,
    name: "E2E Local User",
    exact: true,
  });
  await expect(profileName).toHaveText("E2E Local User");
  // Exercise the keyboard path so a short-lived success toast from the
  // scheduled-task editor cannot intercept an otherwise valid pointer click.
  const editProfileName = page.getByRole("button", { name: "Edit profile name" });
  await editProfileName.focus();
  await page.keyboard.press("Enter");
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
