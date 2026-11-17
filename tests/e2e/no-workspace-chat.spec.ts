import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

type StoredWorkspace = { id: string; name: string; folderPath?: string; permission?: string; noWorkspace?: true };
type ChatIndexEntry = { id: string; title: string; workspaceId?: string; botId?: string };

async function workspaces(page: Page): Promise<StoredWorkspace[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } };
      }
    ).aidenAPI.ipc.invoke<StoredWorkspace[]>("workspaces:list"),
  );
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

async function savedReplies(userDataDir: string, chatId: string): Promise<number> {
  try {
    const saved = JSON.parse(await readFile(path.join(userDataDir, "chats", `${chatId}.json`), "utf8")) as {
      messages: Array<{ role: string }>;
    };
    return saved.messages.filter((message) => message.role === "assistant").length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
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

test("chat history IPC creates and reloads an ordinary chat after startup", async ({ aiden }) => {
  const { page, userDataDir } = aiden;
  await finishLmStudioOnboarding(page);
  const workspaceId = (await workspaces(page))[0].id;
  const created = await page.evaluate(async (workspaceId) => {
    const ipc = (window as unknown as {
      aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } };
    }).aidenAPI.ipc;
    return ipc.invoke<{ id: string; title: string; workspaceId: string }>("chats:create", {
      workspaceId,
      title: "History startup check",
    });
  }, workspaceId);
  expect(created).toMatchObject({ title: "History startup check", workspaceId });
  expect((await regularChats(userDataDir)).map((chat) => chat.id)).toContain(created.id);
  const loaded = await page.evaluate((chatId) => (
    window as unknown as {
      aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } };
    }
  ).aidenAPI.ipc.invoke<{ chat: { id: string; messages: unknown[] } }>("chats:get", chatId), created.id);
  expect(loaded.chat).toMatchObject({ id: created.id, messages: [] });
});

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
  const firstHome = (await workspaces(page)).find((workspace) => workspace.id === first.workspaceId);
  expect(firstHome?.noWorkspace).toBe(true);
  expect(path.dirname(firstHome!.folderPath!)).toBe(path.join(userDataDir, "chat-folders"));
  expect(await isDirectory(firstHome!.folderPath!)).toBe(true);

  // A hidden folder that went missing is made again on the next message.
  // Wait for the first reply to finish: removing the folder mid-reply stops it.
  await expect.poll(() => savedReplies(userDataDir, first.id), { timeout: 20_000 }).toBe(1);
  await rm(firstHome!.folderPath!, { recursive: true });
  await page.locator("textarea").fill("And a packing list");
  await page.locator("textarea").press("Enter");
  await expect.poll(() => savedReplies(userDataDir, first.id), { timeout: 20_000 }).toBe(2);
  expect(await isDirectory(firstHome!.folderPath!)).toBe(true);

  // A new chat from the Chats group gets a folder of its own, and the access
  // chosen before sending applies to it alone. A No workspace chat has no
  // Workspace settings, so its approvals chip always shows and offers Chat only.
  await chatsGroup.hover();
  await page.getByRole("button", { name: "New chat without a workspace" }).click();
  await page.getByRole("button", { name: /^Approvals: /u }).click();
  await page
    .getByRole("radiogroup", { name: "Approvals" })
    .getByRole("radio", { name: "Approvals: Chat only", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /^Approvals: Chat only\./u })).toBeVisible();
  await sendAndWaitForReply(page, "Draft a soup recipe", userDataDir, 2);
  const second = (await regularChats(userDataDir)).find((chat) => chat.id !== first.id)!;
  const secondHome = (await workspaces(page)).find((workspace) => workspace.id === second.workspaceId);
  expect(secondHome?.noWorkspace).toBe(true);
  expect(secondHome!.folderPath).not.toBe(firstHome!.folderPath);
  expect(secondHome!.permission).toBe("none");
  expect((await workspaces(page)).find((workspace) => workspace.id === firstHome!.id)?.permission).toBe("ask");

  // One Chats group lists both, and the hidden folders never show as workspace rows.
  await expect(page.locator("[data-sidebar]").getByRole("button", { name: /^(Collapse|Expand) Chats$/u })).toHaveCount(1);
  await expect(page.locator("[data-sidebar]").getByRole("button", { name: /No workspace/u })).toHaveCount(0);

  // A new chat opened from the soup chat starts in its hidden workspace.
  const secondRow = (await page.locator('aside button[aria-current="page"]').elementHandle())!;
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  await expect(page.getByText("What’s on your mind?")).toBeVisible();

  // Deleting a chat releases its folder; the other chat keeps its own.
  await secondRow.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menu").getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(async () => (await workspaces(page)).some((workspace) => workspace.id === secondHome!.id)).toBe(false);
  await expect.poll(() => isDirectory(secondHome!.folderPath!)).toBe(false);
  expect(await isDirectory(firstHome!.folderPath!)).toBe(true);

  // The open new chat stays in the Chats group and sends from a folder that
  // still exists.
  await expect(page.getByRole("button", { name: "Choose a workspace" })).toHaveText("No workspace");
  await sendAndWaitForReply(page, "Suggest a book", userDataDir, 2);
  const third = (await regularChats(userDataDir)).find((chat) => chat.id !== first.id)!;
  const thirdHome = (await workspaces(page)).find((workspace) => workspace.id === third.workspaceId);
  expect(thirdHome?.noWorkspace).toBe(true);
  expect(await isDirectory(thirdHome!.folderPath!)).toBe(true);
});

test("a selected skill reaches the first turn after allocating a fresh private folder", async ({ aiden }) => {
  const { page, userDataDir, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  await page.evaluate(() => (window as unknown as {
    aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } };
  }).aidenAPI.ipc.invoke("skills:save", {
    id: "private-handoff-fixture",
    name: "Private handoff fixture",
    description: "A skill selected before its private folder exists.",
    instructions: "PRIVATE_HANDOFF_INSTRUCTION: Apply the chosen review checklist.",
    enabled: true,
  }));
  await page.reload();
  await sendAndWaitForReply(page, "Populate the original private home", userDataDir, 1);
  const [source] = await regularChats(userDataDir);
  await expect.poll(() => savedReplies(userDataDir, source.id)).toBe(1);
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  const composer = page.locator("textarea");
  await composer.fill("$");
  await page.getByRole("listbox", { name: "Skills" })
    .getByRole("option", { name: /Private handoff fixture/u }).click();
  const prompt = "Apply my selected checklist in the new private chat";
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect.poll(async () => (await regularChats(userDataDir)).length).toBe(2);
  const target = (await regularChats(userDataDir)).find((chat) => chat.id !== source.id)!;
  expect(target.workspaceId).not.toBe(source.workspaceId);
  await expect.poll(() => savedReplies(userDataDir, target.id)).toBe(1);
  expect(lmStudio.requests.some((request) => {
    const body = JSON.stringify(request.body);
    return body.includes(prompt) && body.includes("PRIVATE_HANDOFF_INSTRUCTION");
  })).toBe(true);
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
  await expect.poll(async () => (await workspaces(page)).find((workspace) => workspace.id === "default")?.noWorkspace).toBe(true);
  const home = (await workspaces(page)).find((workspace) => workspace.id === "default")!;
  expect(await isDirectory(home.folderPath!)).toBe(true);
  expect((await regularChats(aiden.userDataDir)).map((entry) => entry.workspaceId)).toEqual(["default"]);
  await expect(page.locator("[data-sidebar]").getByRole("button", { name: /^(Collapse|Expand) Chats$/u })).toBeVisible();
});
