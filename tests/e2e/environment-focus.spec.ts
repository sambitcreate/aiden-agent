import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

/** A Git repository with one commit and an uncommitted file, so Quick View shows Changes. */
function initRepositoryWithEdits(workspaceDir: string): void {
  execFileSync("git", ["init", "-b", "main", workspaceDir]);
  execFileSync("git", [
    "-C",
    workspaceDir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "Fixture",
  ]);
  writeFileSync(path.join(workspaceDir, "notes.md"), "Uncommitted edit\n");
}

/** Opens a collapsed Quick View card by its header. */
async function expandCard(quickView: Locator, title: string): Promise<void> {
  const header = quickView.getByRole("button", { name: title, exact: true });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
}

test.describe("Quick View rows", () => {
  test.use({ workspaceSeed: true });

  for (const reducedMotion of [false, true]) {
    test(`Quick View rows transfer focus to tools (reduced motion: ${reducedMotion})`, async ({
      aiden,
    }) => {
      const { page } = aiden;
      initRepositoryWithEdits(aiden.workspaceDir);
      await finishLmStudioOnboarding(page);
      await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
      await page.evaluate((reduced) => {
        document.documentElement.dataset.reduceMotion = String(reduced);
      }, reducedMotion);
      const quickView = page.getByRole("complementary", { name: "Quick View" });
      const tools = page.getByRole("complementary", { name: "Environment work surface" });
      const rows = [
        quickView.getByRole("button", { name: /^Browse files in / }),
        quickView.getByRole("button", { name: /^Changes,/ }),
        quickView.getByRole("button", { name: /^Compare branch/ }),
      ];
      for (const width of [900, 1600]) {
        await aiden.app.evaluate(
          ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800),
          width,
        );
        await page.locator("[data-quick-view-toggle]").click();
        // Cards start collapsed; the opened ones are remembered across the second width.
        if (width === 900) {
          await expandCard(quickView, "Environment");
          await expandCard(quickView, "Changes");
        }
        for (const [index, row] of rows.entries()) {
          if (index === 1) {
            await row.focus();
            await page.keyboard.press("Enter");
          } else {
            await row.click();
          }
          await expect(tools).toBeVisible();
          await expect(
            tools.getByRole("tablist", { name: "Environment views" }).getByRole("tab", { name: index === 0 ? "Files" : "Changes", exact: true }),
          ).toBeFocused();
          await expect(page.locator("[data-environment-stacked]")).toHaveAttribute(
            "data-environment-stacked",
            String(width === 900),
          );
          await expect(tools).not.toHaveAttribute("inert", "");
          if (index > 0) {
            await expect(
              tools.locator("#environment-review-panel").getByRole("tab", { name: index === 1 ? "Changes" : "Compare", exact: true }),
            ).toHaveAttribute("aria-selected", "true");
          }
          if (width === 900) await expect(quickView).toBeHidden();
          else await expect(quickView).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(tools).toBeHidden();
          await expect(quickView).toBeVisible();
          // Closing tools hands focus back to the row that opened them, even once uncovered.
          await expect(row).toBeFocused();
        }
        await page.keyboard.press("Escape");
        await expect(quickView).toBeHidden();
        await expect(page.locator("[data-quick-view-toggle]")).toBeFocused();
      }
    });
  }

  test("Escape closes Quick View and returns focus to its toggle", async ({ aiden }) => {
    const { page } = aiden;
    await finishLmStudioOnboarding(page);
    await page.locator("[data-quick-view-toggle]").click();
    const quickView = page.getByRole("complementary", { name: "Quick View" });
    // Opening Quick View puts focus on its first card.
    await expect(quickView.getByRole("button", { name: "Environment", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(quickView).toBeHidden();
    await expect(page.locator("[data-quick-view-toggle]")).toBeFocused();
  });

  test("Quick View rows still open tools after Quick View unmounts for Settings", async ({ aiden }) => {
    const { page } = aiden;
    await finishLmStudioOnboarding(page);
    await page.locator("[data-quick-view-toggle]").click();
    const quickView = page.getByRole("complementary", { name: "Quick View" });
    await expandCard(quickView, "Environment");
    await page.keyboard.press(`${PRIMARY_MODIFIER}+,`);
    await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await expect(page.locator('[data-environment-surface="quick-view"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Environment work surface" })).toBeHidden();
    await quickView.getByRole("button", { name: /^Browse files in / }).click();
    await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeFocused();
  });
});

test("closing Environment restores focus after its opening trigger disappears", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  const trigger = page.locator("[data-environment-toggle]");
  await trigger.click();
  await trigger.evaluate((element) => element.remove());
  const tools = page.getByRole("complementary", { name: "Environment work surface" });
  await tools.getByRole("button", { name: "Close environment panel" }).click();
  await expect(tools).toBeHidden();
  await expect(page.locator("[data-app-focus-root]")).toBeFocused();
});

test.describe("busy workspace", () => {
  test.use({ workspaceSeed: true });

  test("Quick View rows and surface close controls respect an in-flight Git operation", async ({
    aiden,
  }) => {
    const { page, app } = aiden;
    initRepositoryWithEdits(aiden.workspaceDir);
    execFileSync("git", ["-C", aiden.workspaceDir, "branch", "focus-test"]);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("git:checkout");
      ipcMain.handle(
        "git:checkout",
        () =>
          new Promise<void>((resolve) => {
            (globalThis as unknown as { releaseFocusCheckout: () => void }).releaseFocusCheckout =
              resolve;
          }),
      );
    });
    await finishLmStudioOnboarding(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 800));
    await page.locator("[data-environment-toggle]").click();
    await page.locator("[data-quick-view-toggle]").click();
    const quickView = page.getByRole("complementary", { name: "Quick View" });
    const tools = page.getByRole("complementary", { name: "Environment work surface" });
    await expandCard(quickView, "Environment");
    await expandCard(quickView, "Changes");
    const rows = [
      quickView.getByRole("button", { name: /^Browse files in / }),
      quickView.getByRole("button", { name: /^Changes,/ }),
      quickView.getByRole("button", { name: /^Compare branch/ }),
      quickView.getByRole("button", { name: "Open Changes in sidebar" }),
    ];
    await quickView.getByRole("button", { name: /^Branch main/u }).click();
    await page.getByRole("option", { name: "focus-test", exact: true }).click();
    await expect(page.locator("[data-quick-view-toggle]")).toBeDisabled();
    // Dismiss the branch picker while its IPC operation remains pending.
    await page.keyboard.press("Escape");
    try {
      for (const row of rows) await expect(row).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(quickView).toBeVisible();
      await tools.getByRole("button", { name: "Close environment panel" }).click();
      await expect(tools).toBeVisible();
    } finally {
      await app.evaluate(() =>
        (globalThis as unknown as { releaseFocusCheckout: () => void }).releaseFocusCheckout(),
      );
    }
    await expect(page.locator("[data-quick-view-toggle]")).toBeEnabled();
    await expect(rows[0]).toBeEnabled();
    await rows[0].click();
    await expect(tools.getByRole("tab", { name: "Files", exact: true })).toBeFocused();
    await tools.getByRole("button", { name: "Close environment panel" }).click();
    await expect(tools).toBeHidden();
  });
});

test.describe("branch search", () => {
  test.use({ workspaceSeed: true });

  test("creates a missing branch from the search text with the keyboard", async ({ aiden }) => {
    const { page, app } = aiden;
    execFileSync("git", ["init", "-b", "main", aiden.workspaceDir]);
    execFileSync("git", [
      "-C",
      aiden.workspaceDir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture",
    ]);
    await finishLmStudioOnboarding(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 800));
    await page.locator("[data-environment-toggle]").click();
    await page.locator("[data-quick-view-toggle]").click();
    const quickView = page.getByRole("complementary", { name: "Quick View" });
    await expandCard(quickView, "Environment");
    await quickView.getByRole("button", { name: /^Branch main/u }).click();
    await page.getByPlaceholder("Search branches").fill("release/next");
    await expect(page.getByRole("option", { name: "Create branch “release/next”…" })).toBeVisible();
    await page.keyboard.press("Enter");
    const name = page.getByRole("textbox", { name: "New branch name" });
    await expect(name).toHaveValue("release/next");
    await expect(name).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(quickView.getByRole("button", { name: /^Branch release\/next/u })).toBeVisible();
    const current = execFileSync("git", ["-C", aiden.workspaceDir, "branch", "--show-current"], {
      encoding: "utf8",
    });
    expect(current.trim()).toBe("release/next");
  });
});
