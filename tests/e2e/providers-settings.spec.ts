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

  const remove = page.getByRole("button", { name: "Remove LM Studio (local)" });
  const confirm = page.getByRole("alertdialog", { name: "Remove this provider?" });
  // Cancelling returns focus to the button that opened the confirmation.
  await remove.click();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(remove).toBeFocused();

  await remove.click();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(confirm.getByRole("alert")).toContainText("Provider store is locked.");
  await expect(confirm).toBeVisible();

  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole("button", { name: "Remove LM Studio (local)" })).toHaveCount(0);
});

test("Enter in a dialog text field saves, and Escape still cancels", async ({ aiden }) => {
  const { page } = aiden;
  await openProviders(page);
  const configure = page
    .getByText("LM Studio (local)", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Manage']][1]")
    .getByRole("button", { name: "Manage", exact: true });
  await configure.click();
  const dialog = page.getByRole("dialog", { name: "Configure LM Studio (local)" });
  const name = dialog.getByRole("group", { name: "Name", exact: true }).getByRole("textbox");
  await name.fill("Studio box");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Studio box", { exact: true })).toHaveCount(0);

  await configure.click();
  await name.fill("Studio box");
  await name.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Studio box", { exact: true })).toBeVisible();
});

type HarnessRuntime = Record<string, unknown> & { status: string };

/**
 * Replace the agent-runtime IPC with a controllable stand-in, so the real
 * renderer and dialog see install progress, completion and failure arrive
 * asynchronously, as the main process sends them, without downloading anything.
 */
async function stubAgentRuntime(app: import("@playwright/test").ElectronApplication, runtime: HarnessRuntime) {
  await app.evaluate(({ ipcMain }, initial) => {
    const state = globalThis as unknown as {
      harnessRuntime: Record<string, unknown>;
      finishInstall?: () => void;
    };
    state.harnessRuntime = initial;
    const status = () => ({
      providerId: "antigravity",
      publisher: "Google",
      runtime: state.harnessRuntime,
      signedIn: false,
      busy: false,
    });
    for (const channel of ["providers:harness:status", "providers:harness:install", "providers:harness:cancel", "providers:harness:remove"]) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.handle("providers:harness:status", () => status());
    // Install resolves only when the test finishes it, like a real download.
    ipcMain.handle("providers:harness:install", () => new Promise((resolve) => {
      state.finishInstall = () => resolve(status());
    }));
    ipcMain.handle("providers:harness:cancel", () => undefined);
    ipcMain.handle("providers:harness:remove", () => {
      state.harnessRuntime = { status: "not_installed", version: "1.3.0", downloadBytes: 111_456_962, requiredBytes: 900_000_000, downloadHost: "dl.google.com" };
      return status();
    });
  }, runtime);
}

/** Push a runtime state the way the main process broadcasts it. */
async function sendAgentRuntime(app: import("@playwright/test").ElectronApplication, runtime: HarnessRuntime, finishInstall = false) {
  await app.evaluate(({ BrowserWindow }, { next, finish }) => {
    const state = globalThis as unknown as { harnessRuntime: Record<string, unknown>; finishInstall?: () => void };
    state.harnessRuntime = next;
    const status = { providerId: "antigravity", publisher: "Google", runtime: next, signedIn: false, busy: false };
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("providers:harness:changed", status);
    if (finish) state.finishInstall?.();
  }, { next: runtime, finish: finishInstall });
}

async function openAntigravitySetup(page: import("@playwright/test").Page) {
  const more = page.getByRole("button", { name: /^Show \d+ more providers?$/u });
  if (await more.isVisible()) await more.click();
  await page
    .getByText("Google Antigravity", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Set up']][1]")
    .getByRole("button", { name: "Set up", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Set up Google Antigravity" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("agent runtime focus follows its actions when install finishes or fails in the background", async ({ aiden }) => {
  const { page, app } = aiden;
  test.skip(process.platform !== "darwin" && process.platform !== "linux", "Antigravity is offered on macOS and Linux only.");
  await openProviders(page);
  await stubAgentRuntime(app, {
    status: "not_installed",
    version: "1.3.0",
    downloadBytes: 111_456_962,
    requiredBytes: 900_000_000,
    downloadHost: "dl.google.com",
  });
  const dialog = await openAntigravitySetup(page);
  await expect(dialog).toContainText("Installing downloads 111 MB from dl.google.com and needs about 900 MB free.");

  // Install from the keyboard: the button disables, then unmounts when progress arrives.
  await dialog.getByRole("button", { name: "Install Google Antigravity" }).focus();
  await page.keyboard.press("Enter");
  await sendAgentRuntime(app, { status: "installing", version: "1.3.0", phase: "downloading", receivedBytes: 55_000_000, totalBytes: 110_000_000 });
  const cancel = dialog.getByRole("button", { name: "Cancel installation" });
  await expect(cancel).toBeFocused();
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");

  // A failure arriving while Cancel has focus hands focus to Retry, not the dialog.
  await sendAgentRuntime(app, { status: "failed", version: "1.3.0", message: "The download was interrupted.", downloadBytes: 1, requiredBytes: 2 }, true);
  const retry = dialog.getByRole("button", { name: "Retry installation" });
  await expect(retry).toBeFocused();

  // Retry, then a completion arriving while Cancel has focus hands focus to Remove runtime.
  await page.keyboard.press("Enter");
  await sendAgentRuntime(app, { status: "installing", version: "1.3.0", phase: "verifying" });
  await expect(cancel).toBeFocused();
  await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  await sendAgentRuntime(app, { status: "installed", version: "1.3.0" }, true);
  const remove = dialog.getByRole("button", { name: "Remove runtime" });
  await expect(remove).toBeFocused();

  // Escape backs out of the inline remove confirmation and leaves the dialog open.
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Keep", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(remove).toBeFocused();
});
