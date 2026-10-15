import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

/** A Git repository with one commit; `edits` adds an uncommitted file so Changes shows. */
function initRepository(workspaceDir: string, { edits }: { edits: boolean }): void {
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
  if (edits) writeFileSync(path.join(workspaceDir, "notes.md"), "Uncommitted edit\n");
}

const sectionOrder = (quickView: Locator) => () =>
  quickView
    .locator("[data-quick-view-section]")
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-quick-view-section")));

test.describe("Quick View cards", () => {
  test.use({ workspaceSeed: true });

  test("sections collapse, survive a reload, and reorder by keyboard and pointer", async ({ aiden }) => {
    const { page } = aiden;
    initRepository(aiden.workspaceDir, { edits: true });
    await finishLmStudioOnboarding(page);
    await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await page.locator("[data-quick-view-toggle]").click();
    const quickView = page.getByRole("complementary", { name: "Quick View" });
    const order = sectionOrder(quickView);

    // Every card starts closed; open Changes, then close it again.
    const changesHeader = quickView.getByRole("button", { name: "Changes", exact: true });
    await expect(changesHeader).toHaveAttribute("aria-expanded", "false");
    await expect(quickView.getByRole("button", { name: /^Compare branch/ })).toHaveCount(0);
    await changesHeader.click();
    await expect(changesHeader).toHaveAttribute("aria-expanded", "true");
    await expect(quickView.getByRole("button", { name: /^Compare branch/ })).toBeVisible();
    await changesHeader.click();
    await expect(changesHeader).toHaveAttribute("aria-expanded", "false");
    await expect(quickView.getByRole("button", { name: /^Compare branch/ })).toHaveCount(0);

    // The fixture repo has an uncommitted edit, so Changes shows. There are no messages and
    // no subagents yet, so Context and Subagents stay out.
    await expect.poll(order).toEqual(["environment", "changes"]);

    // Keyboard: the grip moves its card, keeps focus, and announces the new position.
    const grip = quickView.getByRole("button", { name: "Move Changes" });
    const moved = quickView.getByRole("status").filter({ hasText: "moved to position" });
    await grip.focus();
    await page.keyboard.press("ArrowUp");
    await expect.poll(order).toEqual(["changes", "environment"]);
    await expect(grip).toBeFocused();
    await expect(moved).toHaveText("Changes moved to position 1 of 2");
    await page.keyboard.press("ArrowDown");
    await expect.poll(order).toEqual(["environment", "changes"]);
    await expect(grip).toBeFocused();
    await expect(moved).toHaveText("Changes moved to position 2 of 2");

    // Pointer: drag Changes above Environment.
    const environmentCard = quickView.locator('[data-quick-view-section="environment"]');
    await grip.hover();
    await expect(grip).not.toHaveCSS("opacity", "0");
    const from = await grip.boundingBox();
    const target = await environmentCard.boundingBox();
    expect(from).not.toBeNull();
    expect(target).not.toBeNull();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(from!.x + from!.width / 2, target!.y - 20, { steps: 12 });
    await page.mouse.up();
    await expect.poll(order).toEqual(["changes", "environment"]);

    await quickView.getByRole("button", { name: "Environment", exact: true }).click();
    await expect(quickView.getByRole("button", { name: "Environment", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await page.reload();
    // Quick View remembers that it was open; the order and the opened card come back too.
    await expect(quickView).toBeVisible();
    await expect.poll(order).toEqual(["changes", "environment"]);
    await expect(quickView.getByRole("button", { name: "Changes", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(quickView.getByRole("button", { name: "Environment", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("Changes stays hidden on a clean repository without commits to push or a PR", async ({ aiden }) => {
    const { page } = aiden;
    initRepository(aiden.workspaceDir, { edits: false });
    await finishLmStudioOnboarding(page);
    await page.locator("[data-quick-view-toggle]").click();
    const quickView = page.getByRole("complementary", { name: "Quick View" });
    const environmentHeader = quickView.getByRole("button", { name: "Environment", exact: true });
    // The collapsed Environment card names the branch once Git has answered.
    await expect(environmentHeader).toHaveAccessibleDescription("main");
    await expect(quickView.locator('[data-quick-view-section="changes"]')).toHaveCount(0);
  });

  test("the grip sits at the right edge and appears on hover", async ({ aiden }) => {
    const { page } = aiden;
    initRepository(aiden.workspaceDir, { edits: false });
    await finishLmStudioOnboarding(page);
    await page.locator("[data-quick-view-toggle]").click();
    const card = page.locator('[data-quick-view-section="environment"]');
    const grip = card.getByRole("button", { name: "Move Environment" });
    await expect(card).toBeVisible();
    // Opening Quick View focuses the first card's header, so move the pointer away first.
    await page.mouse.move(0, 0);
    await expect(grip).toHaveCSS("opacity", "0");
    await card.hover();
    await expect(grip).not.toHaveCSS("opacity", "0");
    await expect
      .poll(async () => {
        const [g, c] = [await grip.boundingBox(), await card.boundingBox()];
        return g && c ? c.x + c.width - (g.x + g.width) : Number.POSITIVE_INFINITY;
      })
      .toBeLessThan(16);
  });

  test("the Environment card's header shows the workspace folder in the file manager", async ({ aiden }) => {
    const { page, app } = aiden;
    await app.evaluate(({ ipcMain }) => {
      const opened: unknown[] = [];
      (globalThis as unknown as { quickViewOpenedFolders: unknown[] }).quickViewOpenedFolders = opened;
      ipcMain.removeHandler("workspaces:openFolder");
      ipcMain.handle("workspaces:openFolder", (_event, workspaceId: unknown) => {
        opened.push(workspaceId);
      });
    });
    await finishLmStudioOnboarding(page);
    await page.locator("[data-quick-view-toggle]").click();
    const quickView = page.getByRole("complementary", { name: "Quick View" });
    await quickView
      .locator('[data-quick-view-section="environment"]')
      .getByRole("button", { name: /^Show Aiden E2E workspace in (Finder|Files)$/u })
      .click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { quickViewOpenedFolders: unknown[] }).quickViewOpenedFolders),
      )
      .toHaveLength(1);
  });
});
