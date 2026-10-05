import { readFile } from "node:fs/promises";
import path from "node:path";
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
  await page.locator("[data-chat-fork-lineage]").getByRole("button").click();
  await expect(page.getByRole("button", { name: "Edit in fork" })).toHaveCount(2);
  await page.getByRole("button", { name: "Edit in fork" }).first().click();
  await expect(composer).toHaveValue(firstPrompt.content);
  expect(await regularChats(userDataDir)).toHaveLength(3);
});
