import { expect, finishLmStudioOnboarding, test } from "./fixtures";

async function openProviders(page: import("@playwright/test").Page) {
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Providers", exact: true })
    .click();
}

test("provider explanations open from the keyboard", async ({ aiden }) => {
  const { page } = aiden;
  await openProviders(page);
  const info = page.getByRole("button", { name: "About provider connections" });
  await info.focus();
  await page.keyboard.press("Enter");
  const explanation = page.getByRole("dialog", { name: "Provider connections" });
  await expect(explanation).toBeVisible();
  await expect(info).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(explanation).toBeHidden();
  await expect(info).toBeFocused();
});

test("a failed provider removal stays open with the error, then succeeds on retry", async ({
  aiden,
}) => {
  const { page, app } = aiden;
  await openProviders(page);
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as unknown as { failNextProviderRemove?: boolean };
    state.failNextProviderRemove = true;
    // Wrap the real handler so the retry exercises the production removal path.
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<
          string,
          (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
        >;
      }
    )._invokeHandlers;
    const original = handlers.get("providers:remove");
    if (!original) throw new Error("providers:remove is not registered");
    ipcMain.removeHandler("providers:remove");
    ipcMain.handle("providers:remove", (event, ...args) => {
      if (state.failNextProviderRemove) {
        state.failNextProviderRemove = false;
        throw new Error("Provider store is locked.");
      }
      return original(event, ...args);
    });
  });

  await page.getByRole("button", { name: "Remove LM Studio (local)" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Remove this provider?" });
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(confirm.getByRole("alert")).toContainText("Provider store is locked.");
  await expect(confirm).toBeVisible();

  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole("button", { name: "Remove LM Studio (local)" })).toHaveCount(0);
});
