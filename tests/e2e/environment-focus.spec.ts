import { execFileSync } from "node:child_process";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

for (const reducedMotion of [false, true]) {
  test(`Quick View actions transfer focus after menu dismissal (reduced motion: ${reducedMotion})`, async ({
    aiden,
  }) => {
    const { page } = aiden;
    await finishLmStudioOnboarding(page);
    await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
    await page.evaluate((reduced) => {
      document.documentElement.dataset.reduceMotion = String(reduced);
    }, reducedMotion);
    const quickView = page.getByRole("complementary", { name: "Quick View" });
    const tools = page.getByRole("complementary", { name: "Environment work surface" });
    for (const width of [900, 1600]) {
      await aiden.app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800),
        width,
      );
      await page.locator("[data-quick-view-toggle]").click();
      for (const [index, name] of ["Browse files", "Review changes", "Compare branch"].entries()) {
        const actions = quickView.getByRole("button", { name: "Quick View actions" });
        await actions.click();
        const item = page.getByRole("menuitem", { name });
        if (index === 1) {
          await page.keyboard.press("Home");
          await expect(item).toBeFocused();
          await page.keyboard.press("Enter");
        } else {
          await item.click();
        }
        await expect(page.getByRole("menu")).toBeHidden();
        await expect(tools).toBeVisible();
        await expect(
          tools.getByRole("tab", { name: index === 0 ? "Files" : "Review", exact: true }),
        ).toBeFocused();
        await expect(page.locator("[data-environment-stacked]")).toHaveAttribute(
          "data-environment-stacked",
          String(width === 900),
        );
        if (index > 0) {
          await expect(
            tools.getByRole("tab", { name: index === 1 ? "Changes" : "Compare", exact: true }),
          ).toHaveAttribute("aria-selected", "true");
        }
        if (width === 900) await expect(quickView).toBeHidden();
        else await expect(quickView).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(tools).toBeHidden();
        await expect(quickView).toBeVisible();
        // A later Escape dismisses only the menu and cannot replay its last destination.
        await actions.click();
        await page.keyboard.press("Escape");
        await expect(actions).toBeFocused();
        await expect(tools).toBeHidden();
      }
      await page.keyboard.press("Escape");
      await expect(quickView).toBeHidden();
      await expect(page.locator("[data-quick-view-toggle]")).toBeFocused();
    }
  });
}

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

test("Escape dismisses Quick View actions before closing the surface", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.locator("[data-quick-view-toggle]").click();
  const quickView = page.getByRole("complementary", { name: "Quick View" });
  const actions = quickView.getByRole("button", { name: "Quick View actions" });
  await actions.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(quickView).toBeVisible();
  await expect(actions).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(quickView).toBeHidden();
  await expect(page.locator("[data-quick-view-toggle]")).toBeFocused();
});

test.describe("busy workspace", () => {
  test.use({ workspaceSeed: true });

  test("Quick View menu and surface close controls respect an in-flight Git operation", async ({
    aiden,
  }) => {
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
    await quickView.getByRole("button", { name: /^Branch main/u }).click();
    await page.getByRole("option", { name: "focus-test", exact: true }).click();
    await expect(page.locator("[data-quick-view-toggle]")).toBeDisabled();
    // Dismiss the branch picker while its IPC operation remains pending.
    await page.keyboard.press("Escape");
    const actions = quickView.getByRole("button", { name: "Quick View actions" });
    try {
      await actions.click();
      for (const name of ["Review changes", "Browse files", "Compare branch"]) {
        await expect(page.getByRole("menuitem", { name })).toBeDisabled();
      }
      await page.keyboard.press("Home");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
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
    await actions.click();
    await page.getByRole("menuitem", { name: "Browse files" }).click();
    await expect(tools.getByRole("tab", { name: "Files", exact: true })).toBeFocused();
    await tools.getByRole("button", { name: "Close environment panel" }).click();
    await expect(tools).toBeHidden();
  });
});

test("unmounting Quick View with its actions menu open does not reopen tools", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.locator("[data-quick-view-toggle]").click();
  await page.getByRole("button", { name: "Quick View actions" }).click();
  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
  await expect(page.locator('[data-environment-surface="quick-view"]')).toHaveCount(0);
  await expect(page.getByRole("menu")).toBeHidden();
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Environment work surface" })).toBeHidden();
  await page.getByRole("button", { name: "Quick View actions" }).click();
  await page.getByRole("menuitem", { name: "Browse files" }).click();
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeFocused();
});

for (const invalidation of [
  "remove-trigger",
  "close-surface",
  "remove-trigger-new-focus",
] as const) {
  test(`menu selection restores safe focus when teardown invalidates its destination: ${invalidation}`, async ({
    aiden,
  }) => {
    const { page } = aiden;
    await finishLmStudioOnboarding(page);
    await page.locator("[data-quick-view-toggle]").click();
    await page.getByRole("button", { name: "Quick View actions" }).click();
    // Exercise the actual menu selection before Radix's deferred close autofocus.
    await page.getByRole("menuitem", { name: "Browse files" }).evaluate((item, invalidation) => {
      (item as HTMLElement).click();
      if (invalidation.startsWith("remove-trigger"))
        document.querySelector('[aria-label="Quick View actions"]')?.remove();
      else document.querySelector<HTMLButtonElement>("[data-quick-view-toggle]")?.click();
      if (invalidation === "remove-trigger-new-focus")
        queueMicrotask(() => document.querySelector("textarea")?.focus());
    }, invalidation);
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(
      page.getByRole("complementary", { name: "Environment work surface" }),
    ).toBeHidden();
    await expect(
      page.locator(
        invalidation === "remove-trigger-new-focus" ? "textarea" : "[data-app-focus-root]",
      ),
    ).toBeFocused();
  });
}
