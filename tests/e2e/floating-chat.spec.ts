import {
  expect,
  expectSquircleButtons,
  finishLmStudioOnboarding,
  test,
} from "./fixtures";
import { auditAccessibility } from "./axe-gate";
import { previewAppearance } from "./design-mode-helpers";
import type { ElectronApplication, Page } from "@playwright/test";

test.use({ workspaceSeed: true });

async function openQuickChatPage(app: ElectronApplication, mainPage: Page): Promise<Page> {
  const existing = app.windows().find((w) => w.url().includes("quick-chat.html"));
  if (existing) {
    await mainPage.evaluate(() => window.aidenAPI.ipc.invoke("quickChat:toggle"));
    await expect(existing.getByTestId("quick-chat-input")).toBeVisible({ timeout: 15_000 });
    return existing;
  }
  const nextWindowPromise = app.waitForEvent("window", {
    predicate: (win) => win.url().includes("quick-chat.html"),
    timeout: 15_000,
  });
  await mainPage.evaluate(() => window.aidenAPI.ipc.invoke("quickChat:toggle"));
  const quickPage = await nextWindowPromise;
  await quickPage.waitForLoadState("domcontentloaded");
  await expect(quickPage.getByTestId("quick-chat-input")).toBeVisible({ timeout: 15_000 });
  return quickPage;
}

test("floating starter morphs to mini-modal, stays ephemeral until attached to a workspace, and passes a11y + squircle checks", async ({
  aiden,
}) => {
  const { app, page } = aiden;
  await finishLmStudioOnboarding(page);

  const quickPage = await openQuickChatPage(app, page);
  await expect(quickPage.getByTestId("quick-chat-starter-bar")).toBeVisible();
  await expect(quickPage.getByTestId("quick-chat-target-chip")).toHaveText(/Temporary/u);
  await expect(quickPage.getByText(/Share screen/iu)).toHaveCount(0);

  // Accessibility & squircle checks on State 1 Floating Starter (light + dark).
  await expectSquircleButtons(quickPage);
  expect(await auditAccessibility(quickPage, { surface: "quick-chat-starter" })).toEqual([]);
  await quickPage.screenshot({
    path: test.info().outputPath("pr-quick-chat-state1-starter.png"),
  });
  await previewAppearance(page, "dark");
  await expect(quickPage.locator("html")).toHaveAttribute("data-appearance-scheme", "dark");
  expect(await auditAccessibility(quickPage, { surface: "quick-chat-starter-dark" })).toEqual([]);
  await quickPage.screenshot({
    path: test.info().outputPath("pr-quick-chat-state1-starter-dark.png"),
  });
  await previewAppearance(page, "light");
  await expect(quickPage.locator("html")).toHaveAttribute("data-appearance-scheme", "light");

  // Send a prompt -> morphs to State 2 Floating Mini-Modal and streams reply.
  const input = quickPage.getByTestId("quick-chat-input");
  await input.fill("Summarize floating chat architecture briefly");
  await input.press("Enter");

  await expect(quickPage.getByTestId("quick-chat-mini-modal")).toBeVisible({ timeout: 15_000 });
  await expect(quickPage.getByTestId("quick-chat-status-pill")).toContainText("Temporary");
  await expect(
    quickPage.getByText(/Deterministic E2E response/u).first(),
  ).toBeVisible({ timeout: 20_000 });

  // Wait for streaming and the streaming reveal fade-in to finish so axe measures settled contrast.
  await expect(quickPage.getByTestId("quick-chat-stop-btn")).toHaveCount(0, { timeout: 15_000 });
  await expect(quickPage.locator("[data-streaming]")).toHaveCount(0, { timeout: 5_000 });

  // Ephemeral chat must stay hidden from the main window's sidebar.
  await expect(
    page.locator("[data-sidebar]").getByRole("button", { name: /Deterministic E2E response/u }),
  ).toHaveCount(0);

  // Accessibility & squircle checks on State 2 Floating Mini-Modal (light + dark).
  await expectSquircleButtons(quickPage);
  expect(await auditAccessibility(quickPage, { surface: "quick-chat-modal" })).toEqual([]);
  await quickPage.screenshot({
    path: test.info().outputPath("pr-quick-chat-state2-modal.png"),
  });
  await previewAppearance(page, "dark");
  await expect(quickPage.locator("html")).toHaveAttribute("data-appearance-scheme", "dark");
  expect(await auditAccessibility(quickPage, { surface: "quick-chat-modal-dark" })).toEqual([]);
  await quickPage.screenshot({
    path: test.info().outputPath("pr-quick-chat-state2-modal-dark.png"),
  });
  await previewAppearance(page, "light");
  await expect(quickPage.locator("html")).toHaveAttribute("data-appearance-scheme", "light");

  // Attach the temporary chat in-place to the seeded project workspace via the unified status pill.
  await quickPage.getByTestId("quick-chat-status-pill").click();
  await quickPage.getByTestId("quick-chat-attach-workspace-btn").click();
  await expect(quickPage.getByRole("dialog", { name: /Attach to workspace/iu })).toBeVisible();
  await quickPage.getByRole("button", { name: /Aiden E2E workspace/u }).click();

  // Status pill disappears, dialog closes, and attached workspace appears in header.
  await expect(quickPage.getByTestId("quick-chat-status-pill")).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(
    quickPage.getByRole("dialog", { name: /Attach to workspace/iu }),
  ).toHaveCount(0, { timeout: 5_000 });
  await expect(quickPage.getByTestId("quick-chat-attached-workspace")).toContainText(
    "Aiden E2E workspace",
  );
  await quickPage.screenshot({
    path: test.info().outputPath("pr-quick-chat-attached.png"),
  });
  await previewAppearance(page, "dark");
  await expect(quickPage.locator("html")).toHaveAttribute("data-appearance-scheme", "dark");
  await quickPage.screenshot({
    path: test.info().outputPath("pr-quick-chat-attached-dark.png"),
  });
  await previewAppearance(page, "light");
});

test("expanding mid-stream hands off live generation seamlessly to the main window without aborting", async ({
  aiden,
}) => {
  const { app, page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);

  lmStudio.holdCompletions?.();
  const quickPage = await openQuickChatPage(app, page);
  const input = quickPage.getByTestId("quick-chat-input");
  await input.fill("Hold stream then expand to main window");
  await input.press("Enter");

  await expect(quickPage.getByTestId("quick-chat-mini-modal")).toBeVisible({ timeout: 15_000 });
  // Ensure the generation request reached the mock model and is actively held.
  await expect
    .poll(
      () =>
        lmStudio.requests.some(
          (r) =>
            r.url === "/v1/chat/completions" &&
            JSON.stringify(r.body).includes("Hold stream then expand to main window"),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

  // Click Expand mid-stream!
  await quickPage.getByTestId("quick-chat-expand-modal").click();

  // Main window navigates to the active chat and shows our user message.
  await expect(
    page.getByText("Hold stream then expand to main window").first(),
  ).toBeVisible({ timeout: 15_000 });

  // Release completion -> Main Window finishes streaming seamlessly!
  lmStudio.releaseCompletions?.();
  await expect(
    page.getByText(/Deterministic E2E response/u).first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden({
    timeout: 15_000,
  });

  // Main window shows the Temporary badge & Save/Attach controls on the expanded ephemeral chat.
  await expect(page.getByText("Temporary").first()).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("pr-quick-chat-expanded-main.png"),
  });
  await previewAppearance(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-appearance-scheme", "dark");
  await page.screenshot({
    path: test.info().outputPath("pr-quick-chat-expanded-main-dark.png"),
  });
  await previewAppearance(page, "light");
});
