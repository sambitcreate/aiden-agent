import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { E2E_ASSISTANT_RESPONSE, expect, finishLmStudioOnboarding, test } from "./fixtures";

type StoredChatMeta = { id: string; title: string; workspaceId?: string; botId?: string; createdAt: number };

async function regularChatIds(root: string): Promise<string[]> {
  try {
    const index = JSON.parse(await readFile(path.join(root, "chats", "index.json"), "utf8")) as StoredChatMeta[];
    return index
      .filter((chat) => !chat.botId && chat.workspaceId !== "assistant")
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((chat) => chat.id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function switchToInbox(page: Page) {
  await page.getByRole("button", { name: "Organize sidebar" }).click();
  await page.getByRole("menuitemradio", { name: "Inbox (Beta)" }).click();
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(page.locator("[data-sidebar] [data-inbox-view]")).toBeVisible();
}

/** The Inbox row for a local chat; its key is `local:<chatId>`. */
function inboxRow(page: Page, chatId: string) {
  return page.locator(`[data-sidebar] [data-inbox-row="local:${encodeURIComponent(chatId)}"]`);
}

/** Moves the pointer off the sidebar, so the Inbox isn't frozen in place. */
async function pointerToPane(page: Page) {
  const box = await page.locator("textarea").boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y - 120);
}

test("an approval waits in Needs you, and leaving the chat mid-approval leaves an Unavailable row", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { page, lmStudio, userDataDir } = aiden;
  await finishLmStudioOnboarding(page);
  await switchToInbox(page);

  const prompt = "Make me a weekday workspace brief";
  lmStudio.enqueueToolScenario!({
    prompt,
    calls: [{
      name: "schedule_task",
      arguments: {
        action: "create",
        name: "Workspace brief",
        cron: "0 9 * * 1-5",
        timezone: "America/New_York",
        prompt: "Summarize important workspace changes without modifying files.",
      },
    }],
    finalText: "This reply never arrives.",
  });
  const composer = page.locator("textarea");
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await regularChatIds(userDataDir)).length).toBe(1);
  const [chatId] = await regularChatIds(userDataDir);

  const needsYou = page.locator("[data-sidebar]").getByRole("group", { name: "Needs you" });
  const row = inboxRow(page, chatId!);
  await expect(needsYou.locator(`[data-inbox-row="local:${chatId}"]`)).toBeVisible();
  await expect(row.locator("[data-inbox-status]")).toHaveText(/^Approval/u);
  // The request is only in the row's description, never drawn in the row.
  const rowButton = row.locator("[data-roving-item]");
  await expect(rowButton).toHaveAttribute("aria-description", /^Approve: .*Workspace brief/u);
  await expect(row).not.toContainText("scheduled task");

  // Leaving the chat settles its prompt, so it can't be answered from here.
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  await expect(row.locator("[data-inbox-status]")).toHaveText(/^Unavailable/u, { timeout: 15_000 });
  await expect(rowButton).toHaveAttribute(
    "aria-description",
    /^Approval unavailable — return to retry: .*Workspace brief/u,
  );
  await rowButton.hover();
  await expect(page.getByRole("tooltip")).toContainText("Approval unavailable — return to retry");

  // Returning to the chat dismisses the Unavailable row.
  await rowButton.click();
  await expect(page.getByText(prompt).first()).toBeVisible();
  await pointerToPane(page);
  await expect(needsYou.locator(`[data-inbox-row="local:${chatId}"]`)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator("[data-sidebar]").getByRole("group", { name: "Earlier" })
    .locator(`[data-inbox-row="local:${chatId}"]`)).toBeVisible();
});

test("a remote-origin approval opens from its row or ⌘1 with Deny focused, and Approve moves it to Working", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { app, page, userDataDir } = aiden;
  await finishLmStudioOnboarding(page);
  await switchToInbox(page);

  const prompt = "Check the release notes";
  const composer = page.locator("textarea");
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE).last()).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await regularChatIds(userDataDir)).length).toBe(1);
  const [chatId] = await regularChatIds(userDataDir);
  await page.getByRole("button", { name: "New Agent", exact: true }).click();

  // A paired phone started a run in this chat that now waits on an approval.
  // Answering it here resolves it on the host, which goes on working.
  await app.evaluate(({ BrowserWindow, ipcMain }, chatId) => {
    const send = (channel: string, payload: unknown) =>
      BrowserWindow.getAllWindows()[0]?.webContents.send(channel, payload);
    let approval: Record<string, unknown> | null = {
      approvalId: "remote-approval-1",
      streamId: "remote-stream-1",
      chatId,
      summary: "Delete the build folder",
      toolCallId: "remote-tool-call-1",
      toolName: "workspace_shell",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      canAllow: true,
    };
    ipcMain.removeHandler("remote:getPendingApproval");
    ipcMain.handle("remote:getPendingApproval", (_event, requested) => (requested === chatId ? approval : null));
    ipcMain.removeHandler("remote:respondApprovalFromHost");
    ipcMain.handle("remote:respondApprovalFromHost", () => {
      approval = null;
      send("chats:activity-changed", {
        revision: 1_000_001,
        activeChatIds: [chatId],
        approvalChatIds: [],
        inputChatIds: [],
      });
      send("remote:approval-changed", { chatId });
      return { resolved: true };
    });
    send("chats:activity-changed", {
      revision: 1_000_000,
      activeChatIds: [chatId],
      approvalChatIds: [chatId],
      inputChatIds: [],
    });
    send("remote:approval-changed", { chatId });
  }, chatId!);

  const sidebar = page.locator("[data-sidebar]");
  const needsYou = sidebar.getByRole("group", { name: "Needs you" });
  const row = inboxRow(page, chatId!);
  await expect(needsYou.locator(`[data-inbox-row="local:${chatId}"]`)).toBeVisible();
  await expect(row.locator("[data-inbox-status]")).toHaveText(/^Approval/u);

  const deny = page.getByRole("button", { name: /^Deny/u });
  // ⌘1 opens the first Inbox row from an idle position.
  await pointerToPane(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page.getByText(prompt).first()).toBeVisible();
  await expect(deny).toBeFocused();

  // So does clicking the row.
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  await expect(deny).toHaveCount(0);
  await row.locator("[data-roving-item]").click();
  await expect(deny).toBeFocused();

  await pointerToPane(page);
  await page.getByRole("button", { name: /^Allow/u }).first().click();
  await expect(deny).toHaveCount(0);
  await expect(sidebar.getByRole("group", { name: "Working" }).locator(`[data-inbox-row="local:${chatId}"]`))
    .toBeVisible({ timeout: 15_000 });
  await expect(needsYou).toHaveCount(0);
});
