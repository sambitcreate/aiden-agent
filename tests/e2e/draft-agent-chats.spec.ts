import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

type StoredChat = { id: string; title: string; workspaceId?: string; botId?: string;
  createdAt: number; updatedAt: number; messages: Array<{ role: string; content: string }> };
async function index(root: string): Promise<Omit<StoredChat, "messages">[]> {
  try { return JSON.parse(await readFile(path.join(root, "chats", "index.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function regularChats(root: string): Promise<StoredChat[]> {
  const metas = (await index(root)).filter((chat) => !chat.botId && chat.workspaceId !== "assistant");
  return Promise.all(metas.map(async (chat) => JSON.parse(await readFile(path.join(root, "chats", `${chat.id}.json`), "utf8"))));
}

test("abandoned drafts never persist; first send creates exactly one conversation and survives promotion", async ({ aiden }) => {
  const { page, userDataDir } = aiden;
  await finishLmStudioOnboarding(page);
  expect(await regularChats(userDataDir)).toEqual([]);
  await page.locator("textarea").fill("Unsent draft must disappear");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  expect(await regularChats(userDataDir)).toEqual([]);
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.locator("textarea")).toHaveValue("");
  for (let count = 0; count < 3; count++) {
    await page.getByRole("button", { name: "New Agent", exact: true }).click();
    await expect(page.locator("textarea")).toBeVisible();
  }
  expect(await regularChats(userDataDir)).toEqual([]);
  await page.locator("textarea").fill("First persisted draft message");
  await page.locator("textarea").press("Enter");
  await expect.poll(async () => (await regularChats(userDataDir)).length).toBe(1);
  await expect.poll(async () => (await regularChats(userDataDir))[0]?.messages.some((message) => message.role === "assistant")).toBe(true);
  const [sent] = await regularChats(userDataDir);
  expect(sent.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["First persisted draft message"]);
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  await page.locator("textarea").fill("Another abandoned draft");
  const reopened = await aiden.relaunch();
  await expect(reopened.locator("textarea")).toBeVisible();
  expect((await regularChats(userDataDir)).map((chat) => chat.id)).toEqual([sent.id]);
});

test("startup migration removes legacy empty chats once and keeps sent conversations", async ({ aiden }) => {
  await finishLmStudioOnboarding(aiden.page);
  await aiden.page.locator("textarea").fill("Keep this real conversation");
  await aiden.page.locator("textarea").press("Enter");
  await expect.poll(async () => (await regularChats(aiden.userDataDir))[0]?.messages.some((message) => message.role === "assistant")).toBe(true);
  const before = await index(aiden.userDataDir);
  const workspaceId = before.find((chat) => !chat.botId && chat.workspaceId !== "assistant")!.workspaceId;
  const seed = async (id: string) => {
    const chat: StoredChat = { id, workspaceId, title: "New chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    await writeFile(path.join(aiden.userDataDir, "chats", `${id}.json`), JSON.stringify(chat));
    const { messages: _messages, ...meta } = chat;
    await writeFile(path.join(aiden.userDataDir, "chats", "index.json"), JSON.stringify([...(await index(aiden.userDataDir)), meta]));
  };
  await seed("legacy-empty");
  await seed("private-empty");
  await seed("header-only-empty");
  const journalRoot = path.join(aiden.userDataDir, "pi-compaction-sessions");
  await mkdir(journalRoot, { recursive: true });
  const journalPath = path.join(journalRoot, "private-empty.jsonl");
  const journal = `${JSON.stringify({ type: "session", version: 3, id: "private-empty",
    timestamp: "2026-08-31T12:00:00.000Z", cwd: journalRoot,
    metadata: { kind: "aiden-chat-compaction-v1", chatId: "private-empty" } })}\n`;
  const privateJournal = journal + `${JSON.stringify({ type: "message", id: "private-message", parentId: null,
    timestamp: "2026-08-31T12:00:01.000Z", message: { role: "user", content: "Private journal history", timestamp: 1 } })}\n`;
  await writeFile(journalPath, privateJournal);
  await writeFile(path.join(journalRoot, "header-only-empty.jsonl"), journal.replace(/private-empty/gu, "header-only-empty"));
  await rm(path.join(aiden.userDataDir, "empty-workspace-chats-migration-v1.json"), { force: true });
  const reopened = await aiden.relaunch();
  await expect(reopened.locator("textarea")).toBeVisible();
  expect((await index(aiden.userDataDir)).some((chat) => chat.id === "legacy-empty")).toBe(false);
  expect((await index(aiden.userDataDir)).some((chat) => chat.id === "private-empty")).toBe(true);
  expect(await readFile(journalPath, "utf8")).toBe(privateJournal);
  expect((await index(aiden.userDataDir)).some((chat) => chat.id === "header-only-empty")).toBe(false);
  expect((await regularChats(aiden.userDataDir)).some((chat) => chat.messages.some((message) => message.content === "Keep this real conversation"))).toBe(true);
  await expect.poll(async () => JSON.parse(await readFile(path.join(aiden.userDataDir, "empty-workspace-chats-migration-v1.json"), "utf8")).complete).toBe(true);
  await seed("later-remote-empty");
  await aiden.relaunch();
  expect((await index(aiden.userDataDir)).some((chat) => chat.id === "later-remote-empty")).toBe(true);
});

test("failed first send retains its draft and retry commits once", async ({ aiden }) => {
  await finishLmStudioOnboarding(aiden.page);
  await aiden.app.evaluate(({ ipcMain }) => {
    // Test-only fault injection at the real IPC boundary, without a production seam.
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown> })._invokeHandlers;
    const original = handlers.get("chats:createWithFirstMessage")!;
    let fail = true;
    handlers.set("chats:createWithFirstMessage", (event, ...args) => {
      if (fail) { fail = false; throw new Error("Test first-send storage failure"); }
      return original(event, ...args);
    });
  });
  const composer = aiden.page.locator("textarea");
  await composer.fill("Recover this first message");
  await composer.press("Enter");
  await expect(aiden.page.getByText(/Test first-send storage failure/u)).toBeVisible();
  await expect(composer).toHaveValue("Recover this first message");
  expect(await regularChats(aiden.userDataDir)).toEqual([]);
  await composer.press("Enter");
  await expect.poll(async () => (await regularChats(aiden.userDataDir))[0]?.messages.some((message) => message.role === "assistant")).toBe(true);
  expect((await regularChats(aiden.userDataDir))).toHaveLength(1);
  expect((await regularChats(aiden.userDataDir))[0].messages.filter((message) => message.role === "user")).toHaveLength(1);
});

test("late first-send receipt cannot navigate back or start a response in a different draft", async ({ aiden }) => {
  await finishLmStudioOnboarding(aiden.page);
  await aiden.app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown> })._invokeHandlers;
    const original = handlers.get("chats:createWithFirstMessage")!;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (globalThis as unknown as { releaseDraftReceipt: () => void }).releaseDraftReceipt = release;
    handlers.set("chats:createWithFirstMessage", async (event, ...args) => {
      const receipt = await original(event, ...args);
      await gate;
      return receipt;
    });
  });
  await aiden.page.locator("textarea").fill("Committed before navigating away");
  await aiden.page.locator("textarea").press("Enter");
  await expect.poll(async () => (await regularChats(aiden.userDataDir)).length).toBe(1);
  await aiden.page.getByRole("button", { name: "New Agent", exact: true }).click();
  await aiden.page.locator("textarea").fill("Keep the new draft here");
  const destination = aiden.page.url();
  await aiden.app.evaluate(() => (globalThis as unknown as { releaseDraftReceipt: () => void }).releaseDraftReceipt());
  // The published sidebar receipt proves the late save completed without
  // selecting or generating the previously committed conversation.
  await expect(aiden.page.locator("[data-sidebar]").getByRole("button", { name: /Committed before navigating away/u })).toBeVisible();
  expect(aiden.page.url()).toBe(destination);
  await expect(aiden.page.locator("textarea")).toHaveValue("Keep the new draft here");
  const [chat] = await regularChats(aiden.userDataDir);
  expect(chat.messages.map((message) => message.role)).toEqual(["user"]);
  expect(aiden.lmStudio.requests.filter((request) => request.url.endsWith("/chat/completions"))).toHaveLength(0);
});
