import {
  E2E_MODEL_ID,
  E2E_MODEL_DISPLAY_NAME,
  expect,
  finishLmStudioOnboarding,
  test,
} from "./fixtures";

test("custom model options survive save and rediscovery, and can be reset", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Providers", exact: true })
    .click();
  const configure = page
    .getByText("LM Studio (local)", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Configure']][1]")
    .getByRole("button", { name: "Configure", exact: true });
  const dialog = page.getByRole("dialog", {
    name: "Configure LM Studio (local)",
  });
  await configure.click();
  await dialog
    .getByRole("button", { name: "More options", exact: true })
    .click();
  await dialog
    .locator("summary")
    .filter({ hasText: E2E_MODEL_DISPLAY_NAME })
    .click();
  const vision = dialog.getByRole("switch", {
    name: `${E2E_MODEL_ID}: Vision`,
    exact: true,
  });
  await expect(vision).toHaveAttribute("data-state", "checked");
  await vision.click();
  await dialog
    .getByRole("switch", { name: `${E2E_MODEL_ID}: Open weights`, exact: true })
    .click();
  await dialog
    .getByRole("spinbutton", {
      name: `${E2E_MODEL_ID}: Context length (tokens)`,
      exact: true,
    })
    .fill("8192");
  await dialog
    .getByRole("spinbutton", {
      name: `${E2E_MODEL_ID}: Maximum images per message`,
      exact: true,
    })
    .fill("2");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await configure.click();
  await dialog
    .getByRole("button", { name: "More options", exact: true })
    .click();
  await dialog
    .locator("summary")
    .filter({ hasText: E2E_MODEL_DISPLAY_NAME })
    .click();
  await expect(vision).toHaveAttribute("data-state", "unchecked");
  await expect(
    dialog.getByRole("spinbutton", {
      name: `${E2E_MODEL_ID}: Context length (tokens)`,
      exact: true,
    }),
  ).toHaveValue("8192");
  await dialog
    .getByRole("button", { name: "Discover models", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Discover models", exact: true }),
  ).toBeEnabled();
  await expect(vision).toHaveAttribute("data-state", "unchecked");
  await dialog
    .getByRole("button", { name: "Use detected capabilities", exact: true })
    .click();
  await expect(vision).toHaveAttribute("data-state", "checked");
  await expect(
    dialog.getByRole("switch", {
      name: `${E2E_MODEL_ID}: Open weights`,
      exact: true,
    }),
  ).toHaveAttribute("data-state", "unchecked");
  await dialog
    .getByRole("textbox", { name: "Model ID", exact: true })
    .fill("manual-private-model");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await configure.click();
  await dialog
    .getByRole("button", { name: "More options", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Discover models", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Discover models", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.locator("summary").filter({ hasText: "manual-private-model" }),
  ).toBeVisible();
  await dialog
    .getByRole("group", { name: "Base URL", exact: true })
    .locator("input")
    .fill("http://127.0.0.1:1/v1");
  await dialog
    .getByRole("textbox", { name: "Model ID", exact: true })
    .fill("manual-without-discovery");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await configure.click();
  await dialog
    .getByRole("button", { name: "More options", exact: true })
    .click();
  await dialog
    .getByRole("group", { name: "Base URL", exact: true })
    .locator("input")
    .fill("http://127.0.0.1:2/v1");
  await dialog
    .getByRole("textbox", { name: "Model ID", exact: true })
    .fill("manual-without-discovery");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
});
