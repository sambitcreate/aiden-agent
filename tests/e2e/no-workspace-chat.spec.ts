import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

type StoredWorkspace = { id: string; name: string; folderPath?: string; noWorkspace?: true };
type ChatIndexEntry = { id: string; title: string; workspaceId?: string; botId?: string };

async function workspaces(userDataDir: string): Promise<StoredWorkspace[]> {
  return (JSON.parse(await readFile(path.join(userDataDir, "config.json"), "utf8")) as { workspaces: StoredWorkspace[] }).workspaces;
}

async function regularChats(userDataDir: string): Promise<ChatIndexEntry[]> {
  try {
    const index = JSON.parse(await readFile(path.join(userDataDir, "chats", "index.json"), "utf8")) as ChatIndexEntry[];
    return index.filter((chat) => !chat.botId && chat.workspaceId !== "assistant");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const isDirectory = (target: string) => stat(target).then((entry) => entry.isDirectory(), () => false);

async function sendAndWaitForReply(page: Page, text: string, userDataDir: string, count: number) {
  await page.locator("textarea").fill(text);
  await page.locator("textarea").press("Enter");
  await expect.poll(async () => (await regularChats(userDataDir)).length, { timeout: 20_000 }).toBe(count);
  await expect(page.locator("[data-chat-title-menu]")).toBeVisible({ timeout: 20_000 });
}

test("No workspace chats each run in their own hidden folder and share one Chats group", async ({ aiden }) => {
  const { page, userDataDir } = aiden;
  await finishLmStudioOnboarding(page);

  await page.getByRole("button", { name: "Choose a workspace" }).click();
  await page.getByRole("option", { name: /^No workspace/u }).click();
  await expect(page.getByRole("button", { name: "Choose a workspace" })).toHaveText("No workspace");
  await expect(page.locator("[data-new-chat-headline]")).toHaveCount(0);
  await expect(page.getByText("What’s on your mind?")).toBeVisible();
  const chatsGroup = page.locator("[data-sidebar]").getByRole("button", { name: /^(Collapse|Expand) Chats$/u });
  await expect(chatsGroup).toBeVisible();

  await sendAndWaitForReply(page, "Plan a weekend trip", userDataDir, 1);
  const [first] = await regularChats(userDataDir);
  const firstHome = (await workspaces(userDataDir)).find((workspace) => workspace.id === first.workspaceId);
  expect(firstHome?.noWorkspace).toBe(true);
  expect(path.dirname(firstHome!.folderPath!)).toBe(path.join(userDataDir, "chat-folders"));
  expect(await isDirectory(firstHome!.folderPath!)).toBe(true);

  // A new chat from the Chats group gets a folder of its own when it is sent.
  await chatsGroup.hover();
  await page.getByRole("button", { name: "New chat without a workspace" }).click();
  await sendAndWaitForReply(page, "Draft a soup recipe", userDataDir, 2);
  const second = (await regularChats(userDataDir)).find((chat) => chat.id !== first.id)!;
  const secondHome = (await workspaces(userDataDir)).find((workspace) => workspace.id === second.workspaceId);
  expect(secondHome?.noWorkspace).toBe(true);
  expect(secondHome!.folderPath).not.toBe(firstHome!.folderPath);

  // One Chats group lists both, and the hidden folders never show as workspace rows.
  await expect(page.locator("[data-sidebar]").getByRole("button", { name: /^(Collapse|Expand) Chats$/u })).toHaveCount(1);
  await expect(page.locator("[data-sidebar]").getByRole("button", { name: /No workspace/u })).toHaveCount(0);

  // Deleting a chat releases its folder; the other chat keeps its own.
  const row = page.locator('aside button[aria-current="page"]');
  await row.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menu").getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(async () => (await workspaces(userDataDir)).some((workspace) => workspace.id === secondHome!.id)).toBe(false);
  await expect.poll(() => isDirectory(secondHome!.folderPath!)).toBe(false);
  expect(await isDirectory(firstHome!.folderPath!)).toBe(true);
});

test("an older install's folderless default workspace becomes the home of its chats on the next start", async ({ aiden }) => {
  await finishLmStudioOnboarding(aiden.page);
  await sendAndWaitForReply(aiden.page, "Remember this chat", aiden.userDataDir, 1);
  const [chat] = await regularChats(aiden.userDataDir);
  expect(chat.workspaceId).toBe("default");
  const page = await aiden.relaunch(async () => {
    // Rewind the default workspace to how every install had it before this change.
    const configPath = path.join(aiden.userDataDir, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { workspaces: StoredWorkspace[] };
    config.workspaces = config.workspaces.map((workspace) =>
      workspace.id === "default" ? { ...workspace, name: "Workspace", folderPath: undefined, noWorkspace: undefined } : workspace,
    );
    await writeFile(configPath, JSON.stringify(config));
  });
  await expect.poll(async () => (await workspaces(aiden.userDataDir)).find((workspace) => workspace.id === "default")?.noWorkspace).toBe(true);
  const home = (await workspaces(aiden.userDataDir)).find((workspace) => workspace.id === "default")!;
  expect(await isDirectory(home.folderPath!)).toBe(true);
  expect((await regularChats(aiden.userDataDir)).map((entry) => entry.workspaceId)).toEqual(["default"]);
  await expect(page.locator("[data-sidebar]").getByRole("button", { name: /^(Collapse|Expand) Chats$/u })).toBeVisible();
});
