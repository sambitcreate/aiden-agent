import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { botFixture } from "../../renderer/main/bots/test-fixtures";
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
  const box = await page.getByRole("main").first().boundingBox();
  expect(box, "the chat pane is laid out").not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
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

async function storedTriage(root: string, chatId: string): Promise<{ snoozedUntil?: number } | undefined> {
  try {
    const file = JSON.parse(await readFile(path.join(root, "chat-triage.json"), "utf8")) as {
      chats?: Record<string, { snoozedUntil?: number }>;
    };
    return file.chats?.[chatId];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

test("Snooze hides a chat, even the open one, and an approval in it brings it back and ends the snooze", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { page, lmStudio, userDataDir } = aiden;
  await finishLmStudioOnboarding(page);
  await switchToInbox(page);

  const composer = page.locator("textarea");
  await composer.fill("Check the release notes");
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE).last()).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await regularChatIds(userDataDir)).length).toBe(1);
  const [chatId] = await regularChatIds(userDataDir);

  const sidebar = page.locator("[data-sidebar]");
  const row = inboxRow(page, chatId!);
  await expect(sidebar.getByRole("group", { name: "Earlier" }).locator(`[data-inbox-row="local:${chatId}"]`)).toBeVisible();

  // Snooze for an hour from the row's ••• menu. The row goes at once, though its chat stays open.
  await row.hover();
  await row.getByRole("button", { name: /^More for /u }).click();
  await page.getByRole("menuitem", { name: "Snooze" }).click();
  await page.locator('[role="menuitem"][data-snooze-preset="hour"]').click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText(/^Snoozed until /u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect.poll(async () => (await storedTriage(userDataDir, chatId!))?.snoozedUntil ?? 0)
    .toBeGreaterThan(Date.now());

  // A run in the snoozed chat that waits on an approval brings it back to Needs you.
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
    finalText: "Scheduled the workspace brief.",
  });
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible({ timeout: 15_000 });
  await pointerToPane(page);
  await expect(sidebar.getByRole("group", { name: "Needs you" }).locator(`[data-inbox-row="local:${chatId}"]`))
    .toBeVisible();
  await expect(row.locator("[data-inbox-status]")).toHaveText(/^Approval/u);

  // The host ended the snooze, so once answered the chat stays listed rather than hiding again.
  await expect.poll(async () => (await storedTriage(userDataDir, chatId!))?.snoozedUntil).toBeUndefined();
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText("Scheduled the workspace brief.").last()).toBeVisible({ timeout: 15_000 });
  await expect(sidebar.getByRole("group", { name: "Earlier" }).locator(`[data-inbox-row="local:${chatId}"]`))
    .toBeVisible({ timeout: 15_000 });
});

test("after Mark done on the open chat, next and previous chat step from where it was", async ({ aiden }) => {
  test.setTimeout(120_000);
  const { page, userDataDir } = aiden;
  await finishLmStudioOnboarding(page);
  await switchToInbox(page);

  const composer = page.locator("textarea");
  for (const [index, prompt] of ["Plan the alpha launch", "Draft the bravo notes", "Review the charlie tests"].entries()) {
    if (index > 0) await page.getByRole("button", { name: "New Agent", exact: true }).click();
    await composer.fill(prompt);
    await composer.press("Enter");
    await expect(page.getByText(E2E_ASSISTANT_RESPONSE).last()).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await regularChatIds(userDataDir)).length).toBe(index + 1);
  }

  // The three chats in the order the Inbox shows them.
  const earlier = page.locator("[data-sidebar]").getByRole("group", { name: "Earlier" });
  await expect(earlier.locator("[data-inbox-row]")).toHaveCount(3);
  const shown = await earlier.locator("[data-inbox-row]").evaluateAll((rows) =>
    rows.map((row) => decodeURIComponent((row.getAttribute("data-inbox-row") ?? "").replace(/^local:/u, ""))),
  );
  const [first, middle, last] = shown;
  const opened = (chatId: string) => inboxRow(page, chatId).locator("[data-roving-item]");

  // Open the middle chat and mark it done from its row: it leaves the list.
  await opened(middle!).click();
  await expect(opened(middle!)).toHaveAttribute("aria-current", "page");
  await inboxRow(page, middle!).hover();
  await inboxRow(page, middle!).getByRole("button", { name: /^More for /u }).click();
  await page.getByRole("menuitem", { name: "Mark done" }).click();
  await pointerToPane(page);
  await expect(inboxRow(page, middle!)).toHaveCount(0);

  // Next opens the chat that was below it, not the top of the list.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
  await expect(opened(last!)).toHaveAttribute("aria-current", "page");

  // From a listed chat, previous steps up as usual.
  await page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
  await expect(opened(first!)).toHaveAttribute("aria-current", "page");
});

test("Settings → Appearance → Sidebar switches the view, and the Organize menu agrees", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Appearance", exact: true }).click();
  const picker = page.getByRole("radiogroup", { name: "Sidebar" });
  await expect(picker.getByRole("radio", { name: "By workspace" })).toHaveAttribute("aria-checked", "true");
  await picker.getByRole("radio", { name: "Inbox (Beta)" }).click();
  await expect(picker.getByRole("radio", { name: "Inbox (Beta)" })).toHaveAttribute("aria-checked", "true");
  await expect(picker.getByRole("radio", { name: "By workspace" })).toHaveAttribute("aria-checked", "false");

  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.locator("[data-sidebar] [data-inbox-view]")).toBeVisible();
  await page.getByRole("button", { name: "Organize sidebar" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Inbox (Beta)" })).toHaveAttribute("aria-checked", "true");
  // Switching back from the menu shows in Settings too.
  await page.getByRole("menuitemradio", { name: "Recent", exact: true }).click();
  await expect(page.locator("[data-sidebar] [data-inbox-view]")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(picker.getByRole("radio", { name: "Recent only" })).toHaveAttribute("aria-checked", "true");
});

// The e2e profile cannot open the real Bot store, so only the Bot IPC is
// substituted, as in bots-sidebar-panel.spec.ts.
test("Bots that need you or have news sit in the Inbox, open there, and the Bots button still reaches the Bot list", async ({ aiden }) => {
  test.setTimeout(90_000);
  const { app, page } = aiden;
  const asker = botFixture({ id: "bot-asker", name: "Trip Planner", description: "Plans trips" });
  const writer = botFixture({ id: "bot-writer", name: "News Digest", description: "Morning news" });
  await finishLmStudioOnboarding(page);
  await app.evaluate(({ ipcMain }, bots) => {
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
    const [askerBot] = bots;
    const updatedAt = Date.now();
    // An hour ahead, so the reply is newer than the Bot read record however
    // long the launch takes to write it: unread never hangs on timing.
    const repliedAt = updatedAt + 60 * 60_000;
    for (const channel of [
      "bots:list",
      "bots:get",
      "bots:live:subscribe",
      "bots:live:summary",
      "bots:getCanonicalPhoto",
      "bots:pendingApprovals",
    ]) ipcMain.removeHandler(channel);
    ipcMain.handle("bots:list", () => bots);
    ipcMain.handle("bots:get", (_event, botId: string) => byId.get(botId) ?? null);
    ipcMain.handle("bots:live:summary", (_event, botId: string) => ({
      botId,
      preview: botId === askerBot!.id ? "Which dates work?" : "Here’s today’s digest.",
      updatedAt,
      state: { kind: "idle" },
      needsYou: botId === askerBot!.id,
      lastReplyAt: botId === askerBot!.id ? null : repliedAt,
    }));
    ipcMain.handle("bots:live:subscribe", (_event, botId: string) => ({
      botId,
      epoch: "e1",
      seq: 0,
      partial: null,
      state: { kind: "idle" },
      question: null,
      activity: null,
      queued: [],
      entries: [],
    }));
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
  }, [asker, writer]);
  await switchToInbox(page);

  const sidebar = page.locator("[data-sidebar]");
  const botRow = (id: string) => sidebar.locator(`[data-inbox-row="local:${encodeURIComponent(`bot:${id}`)}"]`);
  const needsYou = sidebar.getByRole("group", { name: "Needs you" });
  const updates = sidebar.getByRole("group", { name: "Updates" });
  await expect(needsYou.locator(`[data-inbox-row="local:${encodeURIComponent(`bot:${asker.id}`)}"]`)).toBeVisible();
  await expect(botRow(asker.id).locator("[data-inbox-status]")).toHaveText(/^Needs you/u);
  await expect(botRow(asker.id)).toContainText("Bot");
  await expect(updates.locator(`[data-inbox-row="local:${encodeURIComponent(`bot:${writer.id}`)}"]`)).toBeVisible();

  // Mark read clears the Bot's news. Like any row acted on, it takes its live
  // place at once, even under the pointer, and a read Bot's place is off the list.
  await botRow(writer.id).hover();
  await page.getByRole("button", { name: "Mark read: News Digest" }).click();
  await expect(botRow(writer.id)).toHaveCount(0);
  await expect(botRow(asker.id)).toBeVisible();
  // It records the reply as seen, not a visit, so the Bots button still opens the last Bot viewed.
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("aiden-agent.bots-sidebar.v1") ?? "{}") as {
      seenReplyAt?: Record<string, number>;
      lastViewed?: Record<string, number>;
    });
  expect(Object.keys(stored.seenReplyAt ?? {})).toContain(writer.id);
  expect(Object.keys(stored.lastViewed ?? {})).not.toContain(writer.id);

  // Opening a Bot from its row keeps the Inbox and marks the row as the open page.
  await botRow(asker.id).locator("[data-roving-item]").click();
  await expect(page.getByPlaceholder("Ask Trip Planner")).toBeVisible();
  await expect(sidebar.locator("[data-inbox-view]")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Bots" })).toHaveCount(0);
  await expect(botRow(asker.id).locator("[data-roving-item]")).toHaveAttribute("aria-current", "page");

  // The Bots button still shows the Bot list.
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  const botsNav = page.getByRole("navigation", { name: "Bots" });
  await expect(botsNav.getByRole("button", { name: /^Trip Planner/u })).toBeVisible();
  await expect(botsNav.getByRole("button", { name: /^News Digest/u })).toBeVisible();
});
