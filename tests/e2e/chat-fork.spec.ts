import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

type StoredMessage = { id: string; role: string; content: string };
type StoredChat = {
  id: string;
  title: string;
  workspaceId?: string;
  botId?: string;
  forkedFrom?: { chatId: string; messageId: string; position: string; at: number };
  messages: StoredMessage[];
};

async function regularChats(root: string): Promise<StoredChat[]> {
  let metas: StoredChat[] = [];
  try {
    metas = JSON.parse(await readFile(path.join(root, "chats", "index.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(
    metas
      .filter((chat) => !chat.botId && chat.workspaceId !== "assistant")
      .map(async (chat) =>
        JSON.parse(await readFile(path.join(root, "chats", `${chat.id}.json`), "utf8")) as StoredChat,
      ),
  );
}

const replies = (chat: StoredChat | undefined) =>
  chat?.messages.filter((message) => message.role === "assistant").length ?? 0;

async function workspaceHome(page: Page, workspaceId: string | undefined) {
  return page.evaluate(async (workspaceId) => {
    const homes = await (window as unknown as {
      aidenAPI: { ipc: { invoke<T>(channel: string): Promise<T> } };
    }).aidenAPI.ipc.invoke<Array<{ id: string; folderPath: string; permission: string; noWorkspace?: boolean }>>("workspaces:list");
    return homes.find((workspace) => workspace.id === workspaceId)!;
  }, workspaceId);
}

test("a chat forks from a reply or edits a prompt in a fork", async ({ aiden }) => {
  const { page, userDataDir } = aiden;
  await finishLmStudioOnboarding(page);
  const composer = page.locator("textarea");

  await composer.fill("Plan a weekend trip");
  await composer.press("Enter");
  await expect.poll(async () => replies((await regularChats(userDataDir))[0])).toBe(1);
  await composer.fill("What should we eat?");
  await composer.press("Enter");
  await expect.poll(async () => replies((await regularChats(userDataDir))[0])).toBe(2);
  const [source] = await regularChats(userDataDir);
  const [firstPrompt, firstReply, secondPrompt] = source.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const sourceHome = await workspaceHome(page, source.workspaceId);
  expect(sourceHome.noWorkspace).toBe(true);
  await writeFile(path.join(sourceHome.folderPath, "source-only.txt"), "Source private file");

  // Fork after the first reply.
  const forkFromReply = page.getByRole("button", { name: "Fork from here" }).first();
  await expect(forkFromReply).not.toHaveAttribute("aria-disabled", "true");
  await page.getByText(firstReply.content.trim().slice(0, 24), { exact: false }).first().hover();
  await forkFromReply.click();
  await expect.poll(async () => (await regularChats(userDataDir)).length).toBe(2);
  const afterFork = (await regularChats(userDataDir)).find((chat) => chat.forkedFrom)!;
  expect(afterFork.forkedFrom).toMatchObject({
    chatId: source.id,
    messageId: firstReply.id,
    position: "after",
  });
  expect(afterFork.messages.map((message) => message.content)).toEqual([
    firstPrompt.content,
    firstReply.content,
  ]);
  const lineage = page.locator("[data-chat-fork-lineage]");
  await expect(lineage).toContainText(afterFork.title);
  const sourceLink = lineage.getByRole("button", { name: `Forked from “${source.title}”` });
  await expect(sourceLink).toBeVisible();
  await expect(page.locator('[data-forked="true"]')).toHaveCount(1);

  // Opening a populated private fork must refresh its newly assigned workspace
  // before the next send, and must not expose the source's files.
  expect(afterFork.workspaceId).not.toBe(source.workspaceId);
  const forkHome = await workspaceHome(page, afterFork.workspaceId);
  expect(forkHome.noWorkspace).toBe(true);
  expect(forkHome.folderPath).not.toBe(sourceHome.folderPath);
  expect(forkHome.permission).toBe("ask");
  await expect(readFile(path.join(forkHome.folderPath, "source-only.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await composer.fill("Continue in the private fork");
  await composer.press("Enter");
  await expect.poll(async () => replies((await regularChats(userDataDir)).find((chat) => chat.id === afterFork.id))).toBe(2);
  expect(replies((await regularChats(userDataDir)).find((chat) => chat.id === source.id))).toBe(2);
  expect(await readFile(path.join(sourceHome.folderPath, "source-only.txt"), "utf8")).toBe("Source private file");

  // The lineage link returns to the source, where a later prompt can be edited in a fork.
  await sourceLink.click();
  await expect(page.getByRole("button", { name: "Edit in fork" })).toHaveCount(2);
  await page.getByRole("button", { name: "Edit in fork" }).nth(1).click();
  await expect(composer).toHaveValue(secondPrompt.content);
  await expect.poll(async () => (await regularChats(userDataDir)).length).toBe(3);
  const editFork = (await regularChats(userDataDir)).find(
    (chat) => chat.forkedFrom?.position === "before",
  )!;
  expect(editFork.forkedFrom?.messageId).toBe(secondPrompt.id);
  expect(editFork.messages.map((message) => message.content)).toEqual([
    firstPrompt.content,
    firstReply.content,
  ]);
  await expect(page.locator('[data-forked="true"]')).toHaveCount(2);

  // Editing the very first prompt opens a prefilled draft and persists nothing until sent.
  await page.locator("[data-chat-fork-lineage]").getByRole("button", { name: /^Forked from/u }).click();
  await expect(page.getByRole("button", { name: "Edit in fork" })).toHaveCount(2);
  await page.getByRole("button", { name: "Edit in fork" }).first().click();
  await expect(composer).toHaveValue(firstPrompt.content);
  expect(await regularChats(userDataDir)).toHaveLength(3);
});

test("duplicating a private chat opens an independent folder with its own access and follow-up turn", async ({ aiden }) => {
  const { page, userDataDir } = aiden;
  await finishLmStudioOnboarding(page);
  const composer = page.locator("textarea");
  await composer.fill("Start a chat to duplicate");
  await composer.press("Enter");
  await expect.poll(async () => replies((await regularChats(userDataDir))[0])).toBe(1);
  const [source] = await regularChats(userDataDir);
  const sourceHome = await workspaceHome(page, source.workspaceId);
  expect(sourceHome.noWorkspace).toBe(true);
  await writeFile(path.join(sourceHome.folderPath, "source-only.txt"), "Keep private");
  await page.evaluate((workspaceId) => (window as unknown as {
    aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } };
  }).aidenAPI.ipc.invoke("workspaces:update", workspaceId, { permission: "full" }), source.workspaceId);

  await page.locator("[data-chat-title-menu]").click();
  await page.getByRole("menuitem", { name: "Duplicate chat", exact: true }).click();
  await expect.poll(async () => (await regularChats(userDataDir)).length).toBe(2);
  const copied = (await regularChats(userDataDir)).find((chat) => chat.id !== source.id)!;
  expect(copied.messages.map((message) => message.content)).toEqual(source.messages.map((message) => message.content));
  expect(copied.workspaceId).not.toBe(source.workspaceId);
  const copyHome = await workspaceHome(page, copied.workspaceId);
  expect(copyHome.noWorkspace).toBe(true);
  expect(copyHome.folderPath).not.toBe(sourceHome.folderPath);
  expect(copyHome.permission).toBe("ask");
  expect((await workspaceHome(page, source.workspaceId)).permission).toBe("full");
  await expect(readFile(path.join(copyHome.folderPath, "source-only.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  await composer.fill("Continue in the duplicate");
  await composer.press("Enter");
  await expect.poll(async () => replies((await regularChats(userDataDir)).find((chat) => chat.id === copied.id))).toBe(2);
  expect(replies((await regularChats(userDataDir)).find((chat) => chat.id === source.id))).toBe(1);
  expect(await readFile(path.join(sourceHome.folderPath, "source-only.txt"), "utf8")).toBe("Keep private");
});
