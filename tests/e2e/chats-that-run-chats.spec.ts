import type { Page } from "@playwright/test";
import { E2E_WORKSPACE_ID, expect, finishLmStudioOnboarding, test } from "./fixtures";
import { CHILD_COMPLETION_GROUP_MS } from "../../main/services/chat-orchestration/completion-delivery";

test.use({ workspaceSeed: true });

function invoke<T>(page: Page, channel: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(({ channel, args }) => {
    const { ipc } = (window as unknown as {
      aidenAPI: { ipc: { invoke<T>(name: string, ...args: unknown[]): Promise<T> } };
    }).aidenAPI;
    return ipc.invoke<T>(channel, ...args);
  }, { channel, args });
}

test("a chat starts two chats: one finishes and wakes it, one waits for you, and Stop all ends it", async ({ aiden }, testInfo) => {
  test.setTimeout(120_000);
  const { page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  // Ask mode: starting chats and a started chat's file write both come to the person.
  // The seeded workspace is a legacy Full one (Never ask), so give it its own Ask mode.
  await invoke(page, "workspaces:update", E2E_WORKSPACE_ID, { permission: "ask", approvalMode: "ask" });

  const testsTask = "E2E started chat: check that the tests pass.";
  const docsTask = "E2E started chat: write the release notes file.";
  const tests = lmStudio.enqueueToolScenario!({ prompt: testsTask, calls: [], finalText: "All 12 tests pass." });
  const docs = lmStudio.enqueueToolScenario!({
    prompt: docsTask,
    // A file write asks in Ask mode, so this chat waits for the person.
    calls: [{ name: "write_file", arguments: { path: "release-notes.md", content: "Release notes\n" } }],
    finalText: "The release notes are written.",
  });
  const prompt = "Chats e2e: split the release check across two chats.";
  const lead = lmStudio.enqueueToolScenario!({
    prompt,
    calls: [{
      name: "child_chats",
      arguments: { action: "start", chats: [{ title: "Run tests", task: testsTask }, { title: "Write notes", task: docsTask }] },
    }],
    finalText: "Started both chats; I'll hear back as each finishes.",
  });

  await page.locator("textarea").first().fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  // Starting chats is Consequential: Ask mode asks first.
  await page.getByRole("button", { name: "Allow once" }).first().click();
  await expect(page.getByText("Started both chats; I'll hear back as each finishes.").first()).toBeVisible();
  expect(lead.error).toBeUndefined();

  // The tests chat finishes on its own, and its ending wakes the lead with a Started chat notice.
  await expect.poll(() => tests.completed, { timeout: 30_000 }).toBe(true);
  await expect(page.locator('[data-agent-notice="chat"]').first()).toBeVisible({ timeout: 30_000 });

  expect(docs.error).toBeUndefined();
  // The docs chat's file write waits for the person, so the chip says it needs you.
  const chip = page.getByRole("button", { name: "1 chat working, 1 needs you" });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  const list = page.getByRole("dialog", { name: "Started chats" });
  await expect(list.locator('[data-started-chat-row]')).toHaveCount(2);
  await expect(list).toContainText("Run tests");
  await expect(list).toContainText("Done");
  await expect(list).toContainText("Write notes");
  await expect(list).toContainText("Needs your approval");
  await page.screenshot({ path: testInfo.outputPath("started-chats-chip.png") });

  // Open goes to the started chat: its header and the lead's message say where it came from.
  await list.getByRole("button", { name: "Open “Write notes”" }).click();
  await expect(page.locator("[data-chat-started-by-chat]")).toContainText(/Started by “.+”/u);
  await expect(page.locator("[data-message-from-lead-chat]").first()).toContainText(/From “.+”/u);
  await expect(page.locator('[data-started-by-chat="true"]').first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow once" }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("started-chat-lineage.png") });
  expect(docs.completed).toBe(false);

  // Back in the lead, Stop all ends the waiting chat; a stop the person made wakes nobody.
  await page.locator("[data-chat-started-by-chat]").getByRole("button", { name: /^Started by “/u }).click();
  const notices = await page.locator('[data-agent-notice="chat"]').count();
  await page.getByRole("button", { name: "1 chat working, 1 needs you" }).click();
  await page.getByRole("dialog", { name: "Started chats" }).getByRole("button", { name: "Stop all" }).click();
  await expect(page.getByRole("button", { name: "2 started chats" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "2 started chats" }).click();
  const after = page.getByRole("dialog", { name: "Started chats" });
  await expect(after).toContainText("Stopped");
  await expect(after.getByRole("button", { name: "Stop all" })).toHaveCount(0);
  expect(docs.completed).toBe(false);
  // Past the 10-second window in which endings share a notice: still no new one.
  await page.waitForTimeout(CHILD_COMPLETION_GROUP_MS + 1_000);
  await expect(page.locator('[data-agent-notice="chat"]')).toHaveCount(notices);
});
