import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test, waitForToastsToClear } from "./fixtures";

async function startPersistedChat(page: Page): Promise<void> {
  await finishLmStudioOnboarding(page);
  await page.locator("textarea").fill("Top bar check");
  await page.locator("textarea").press("Enter");
  await expect(page.locator("[data-chat-title-menu]")).toBeVisible({ timeout: 20_000 });
  await waitForToastsToClear(page);
}

async function openChipMenu(page: Page) {
  await page.locator("[data-workspace-chip]").click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

test.describe("folder workspaces", () => {
  test.use({ workspaceSeed: true });

  test("a plain folder gets folder actions but no Git-only ones", async ({ aiden }) => {
    const { page } = aiden;
    await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await startPersistedChat(page);

    await expect(page.locator("[data-workspace-chip]")).toHaveAccessibleName(
      "Workspace Aiden E2E workspace",
    );
    const menu = await openChipMenu(page);
    await expect(menu.getByText("Not a Git repository", { exact: true })).toBeVisible();
    await expect(menu.getByText(aiden.workspaceDir, { exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy folder path" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy branch name" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Open on GitHub" })).toHaveCount(0);
    await closeMenu(page);

    // Changes needs a repository; Files and Browser do not.
    await expect(page.locator('[data-workspace-tool="review"]')).toHaveCount(0);
    const files = page.locator('[data-workspace-tool="files"]');
    await expect(files).toHaveAccessibleName("Show Files");
    await files.click();
    const panel = page.getByRole("complementary", { name: "Environment work surface" });
    await expect(panel.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(files).toHaveAttribute("aria-pressed", "true");
    await expect(files).toHaveAccessibleName("Hide Files");
    await files.click();
    await expect(panel).toBeHidden();
    await expect(files).toHaveAttribute("aria-pressed", "false");

    // Pressing a different tool while one is showing switches the panel to it.
    const browser = page.locator('[data-workspace-tool="browser"]');
    await files.click();
    await browser.click();
    await expect(browser).toHaveAttribute("aria-pressed", "true");
    await expect(files).toHaveAttribute("aria-pressed", "false");
    await expect(panel).toBeVisible();
  });

  test("a Git repository adds branch, GitHub, and Changes", async ({ aiden }) => {
    const { page } = aiden;
    execFileSync("git", ["init", "-b", "main", aiden.workspaceDir]);
    execFileSync("git", [
      "-C", aiden.workspaceDir,
      "-c", "user.email=e2e@example.com",
      "-c", "user.name=Aiden E2E",
      "commit", "--allow-empty", "-m", "init",
    ]);
    execFileSync("git", [
      "-C", aiden.workspaceDir,
      "remote", "add", "origin", "https://github.com/example-owner/example-repo.git",
    ]);
    await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await startPersistedChat(page);

    const menu = await openChipMenu(page);
    await expect(menu.locator("[data-workspace-chip-branch]")).toHaveText("main");
    await expect(menu.getByRole("menuitem", { name: "Copy branch name" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Open on GitHub" })).toBeVisible();
    await closeMenu(page);

    const changes = page.locator('[data-workspace-tool="review"]');
    await changes.click();
    const panel = page.getByRole("complementary", { name: "Environment work surface" });
    await expect(panel.locator("#environment-review-tab")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(changes).toHaveAttribute("aria-pressed", "true");
  });

  test("the title menu renames the chat everywhere it is shown", async ({ aiden }) => {
    const { page } = aiden;
    await startPersistedChat(page);
    await page.locator("[data-chat-title-menu]").click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    const dialog = page.getByRole("dialog", { name: "Rename chat" });
    await dialog.getByRole("textbox", { name: "Chat name" }).fill("Renamed from the top bar");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("[data-chat-title-menu]")).toContainText("Renamed from the top bar");
    await expect(
      page.locator("[data-sidebar]").getByText("Renamed from the top bar", { exact: true }),
    ).toBeVisible();
  });
});

test("a workspace without a folder keeps only folder-free tools", async ({ aiden }) => {
  const { page } = aiden;
  await startPersistedChat(page);
  await expect(page.locator('[data-workspace-tool="review"]')).toHaveCount(0);
  await expect(page.locator('[data-workspace-tool="files"]')).toHaveCount(0);
  await expect(page.locator('[data-workspace-tool="browser"]')).toBeVisible();
  const menu = await openChipMenu(page);
  await expect(menu.getByText("No folder", { exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(0);
  await closeMenu(page);
});

test("back and forward move through in-app navigation", async ({ aiden }) => {
  const { page } = aiden;
  await startPersistedChat(page);
  const back = page.getByRole("button", { name: "Go back", exact: true });
  const forward = page.getByRole("button", { name: "Go forward", exact: true });
  await expect(forward).toBeDisabled();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
  await expect(back).toBeEnabled();
  await back.click();
  await expect(page.locator("textarea")).toBeVisible();
  await expect(page.locator("[data-chat-title-menu]")).toBeVisible();
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
  await expect(forward).toBeDisabled();
});

test("a collapsed sidebar keeps the title clear of the leading controls", async ({ aiden }) => {
  const { page } = aiden;
  await startPersistedChat(page);
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  const forward = page.getByRole("button", { name: "Go forward", exact: true });
  const title = page.locator("[data-chat-title-menu]");
  await expect(page.getByRole("button", { name: "Show sidebar", exact: true })).toBeVisible();
  // Wait for the header padding transition to settle before measuring.
  await expect.poll(async () => {
    const [controls, heading] = await Promise.all([forward.boundingBox(), title.boundingBox()]);
    return Boolean(controls && heading && heading.x >= controls.x + controls.width);
  }).toBe(true);
});

