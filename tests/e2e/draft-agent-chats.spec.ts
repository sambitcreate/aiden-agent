import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";
import { migratePiSessionJournal } from "../../main/services/pi-session-migration";

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
  await page.locator("textarea").fill("Unsent draft stays off disk");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  expect(await regularChats(userDataDir)).toEqual([]);
  // Leaving keeps the unsent text in this session only, never on disk.
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.locator("textarea")).toHaveValue("Unsent draft stays off disk");
  expect(await regularChats(userDataDir)).toEqual([]);
  for (let count = 0; count < 3; count++) {
    await page.getByRole("button", { name: "New Agent", exact: true }).click();
    await expect(page.locator("textarea")).toBeVisible();
  }
  // The typed draft is kept; repeated New Agent reuses one empty draft.
  await expect(page.locator("[data-sidebar] [data-draft-chat]")).toHaveCount(2);
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
  const journalRoot = path.join(aiden.userDataDir, "pi-compaction-sessions");
  const journalPath = path.join(journalRoot, "private-empty.jsonl");
  const journal = `${JSON.stringify({ type: "session", version: 3, id: "private-empty",
    timestamp: "2026-08-31T12:00:00.000Z", cwd: journalRoot,
    metadata: { kind: "aiden-chat-compaction-v1", chatId: "private-empty" } })}\n`;
  const privateJournal = journal + `${JSON.stringify({ type: "message", id: "private-message", parentId: null,
    timestamp: "2026-08-31T12:00:01.000Z", message: { role: "user", content: "Private journal history", timestamp: 1 } })}\n`;
  const promotedPath = path.join(journalRoot, "promoted-empty.jsonl");
  let promotedReceiptPath!: string;
  const reopened = await aiden.relaunch(async () => {
    // Seed only after Electron has closed so shutdown cannot flush a stale
    // in-memory chat index over the migration fixture.
    await mkdir(journalRoot, { recursive: true });
    for (const id of ["legacy-empty", "private-empty", "header-only-empty", "promoted-empty"]) await seed(id);
    await writeFile(journalPath, privateJournal);
    await writeFile(path.join(journalRoot, "header-only-empty.jsonl"), journal.replace(/private-empty/gu, "header-only-empty"));
    await writeFile(promotedPath, journal.replace(/private-empty/gu, "promoted-empty"));
    const promoted = await migratePiSessionJournal(promotedPath, "promoted-empty");
    promotedReceiptPath = promoted.receiptPath;
    const journalIndexPath = path.join(journalRoot, "aiden-journal-index.json");
    let journalIndex: { version: number; chats: Record<string, string[]> } = { version: 1, chats: {} };
    try { journalIndex = JSON.parse(await readFile(journalIndexPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    journalIndex.chats["promoted-empty"] = [promotedPath, promoted.receipt.backupPath, promoted.receiptPath];
    await writeFile(journalIndexPath, JSON.stringify(journalIndex));
    await rm(path.join(aiden.userDataDir, "empty-workspace-chats-migration-v1.json"), { force: true });
    expect((await index(aiden.userDataDir)).map((chat) => chat.id)).toEqual(expect.arrayContaining(["legacy-empty", "private-empty", "header-only-empty", "promoted-empty"]));
    expect(await readFile(journalPath, "utf8")).toBe(privateJournal);
  });
  await expect(reopened.locator("textarea")).toBeVisible();
  expect((await index(aiden.userDataDir)).some((chat) => chat.id === "legacy-empty")).toBe(false);
  expect((await index(aiden.userDataDir)).some((chat) => chat.id === "private-empty")).toBe(true);
  expect(await readFile(journalPath, "utf8")).toBe(privateJournal);
  expect((await index(aiden.userDataDir)).some((chat) => chat.id === "header-only-empty")).toBe(false);
  expect((await index(aiden.userDataDir)).some((chat) => chat.id === "promoted-empty")).toBe(false);
  await expect.poll(async () => { try { await readFile(promotedReceiptPath); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }).toBe(false);
  expect((await regularChats(aiden.userDataDir)).some((chat) => chat.messages.some((message) => message.content === "Keep this real conversation"))).toBe(true);
  await expect.poll(async () => JSON.parse(await readFile(path.join(aiden.userDataDir, "empty-workspace-chats-migration-v1.json"), "utf8")).complete).toBe(true);
  await aiden.relaunch(async () => {
    await seed("later-remote-empty");
    expect((await index(aiden.userDataDir)).some((chat) => chat.id === "later-remote-empty")).toBe(true);
  });
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

test("unreadable private history preserves candidates without leaving a future migration sweep", async ({ aiden }) => {
  await finishLmStudioOnboarding(aiden.page);
  const seed = async (id: string) => {
    const chat: StoredChat = { id, workspaceId: "default", title: "New chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    const directory = path.join(aiden.userDataDir, "chats");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify(chat));
    const { messages: _messages, ...meta } = chat;
    await writeFile(path.join(directory, "index.json"), JSON.stringify([...(await index(aiden.userDataDir)), meta]));
  };
  const journalRoot = path.join(aiden.userDataDir, "pi-compaction-sessions");
  const corruptJournal = path.join(journalRoot, "unreadable.jsonl.corrupt-test");
  const marker = path.join(aiden.userDataDir, "empty-workspace-chats-migration-v1.json");
  const reopened = await aiden.relaunch(async () => {
    await seed("uncertain-empty");
    await mkdir(journalRoot, { recursive: true });
    await writeFile(corruptJournal, "{broken header");
    await rm(marker, { force: true });
    expect((await index(aiden.userDataDir)).some((chat) => chat.id === "uncertain-empty")).toBe(true);
    expect(await readFile(corruptJournal, "utf8")).toBe("{broken header");
  });
  await expect(reopened.locator("textarea")).toBeVisible();
  expect(JSON.parse(await readFile(marker, "utf8")).complete).toBe(true);
  expect((await index(aiden.userDataDir)).some((chat) => chat.id === "uncertain-empty")).toBe(true);
  await aiden.relaunch(async () => {
    await rm(corruptJournal);
    await seed("created-after-migration");
    expect((await index(aiden.userDataDir)).some((chat) => chat.id === "created-after-migration")).toBe(true);
  });
  expect((await index(aiden.userDataDir)).some((chat) => chat.id === "created-after-migration")).toBe(true);
});

async function addWorkspace(page: import("@playwright/test").Page, name: string): Promise<string> {
  const created = await page.evaluate(async (workspaceName) => {
    const bridge = (window as unknown as {
      aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } };
    }).aidenAPI.ipc;
    return bridge.invoke<{ id: string }>("workspaces:create", { name: workspaceName, permission: "ask" });
  }, name);
  await page.reload();
  await expect(page.locator("textarea")).toBeVisible();
  return created.id;
}

test("the sidebar + starts a draft in its workspace and reuses only an empty draft", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  const workspaceId = await addWorkspace(page, "Second workspace");
  const sidebar = page.locator("[data-sidebar]");
  const header = sidebar.getByRole("button", { name: /^(Expand|Collapse) Second workspace/u });
  const plus = sidebar.getByRole("button", { name: "New chat in Second workspace", exact: true });
  const draftRows = sidebar.locator("[data-draft-chat]");
  const composer = page.locator("textarea");

  // Expanding a workspace never starts a chat or replaces the open draft.
  const draftId = () => draftRows.getAttribute("data-draft-chat");
  const initialDraft = await draftId();
  expect(initialDraft).toBeTruthy();
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(draftRows).toHaveCount(1);
  expect(await draftId()).toBe(initialDraft);

  // Focus anywhere in the workspace row reveals its actions for keyboard navigation.
  await page.mouse.move(1, 1);
  await expect(header).toBeFocused();
  await expect(plus).toHaveCSS("opacity", "1");
  await composer.focus();
  await expect(plus).toHaveCSS("opacity", "0");
  // The + remains keyboard reachable while it is hidden.
  await plus.focus();
  await expect(plus).toHaveCSS("opacity", "1");
  await plus.press("Enter");
  await expect(composer).toBeFocused();
  await expect.poll(draftId).not.toBe(initialDraft);
  await expect(draftRows).toHaveCount(1);
  await expect(draftRows).toHaveText("New chat");
  await expect(draftRows).toHaveAttribute("aria-current", "page");
  const secondDraft = await draftId();

  // An empty draft is reused by every entry point instead of stacking drafts.
  await header.hover();
  await plus.click();
  await expect(composer).toBeFocused();
  expect(await draftId()).toBe(secondDraft);
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  await expect(composer).toBeFocused();
  expect(await draftId()).toBe(secondDraft);
  await expect(draftRows).toHaveCount(1);

  // A draft with text is never reused, and it is kept for the user to return to.
  await composer.fill("Keep typing here");
  await header.hover();
  await plus.click();
  await expect(draftRows).toHaveCount(2);
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  const typedRow = sidebar.locator(`[data-draft-chat="${secondDraft}"]`);
  await expect(typedRow).toHaveText("New chat");
  await expect(typedRow).not.toHaveAttribute("aria-current", "page");
  const openRow = sidebar.locator('[data-draft-chat][aria-current="page"]');
  expect(await openRow.getAttribute("data-draft-chat")).not.toBe(secondDraft);

  // Its row reopens it with the text intact; the empty draft left behind goes.
  await typedRow.click();
  await expect(composer).toHaveValue("Keep typing here");
  await expect(composer).toBeFocused();
  await expect(typedRow).toHaveAttribute("aria-current", "page");
  await expect(draftRows).toHaveCount(1);
  expect(await regularChats(aiden.userDataDir)).toEqual([]);

  // Sending from the revived draft saves it in its workspace and drops the row.
  await composer.fill("Started from the sidebar plus");
  await composer.press("Enter");
  await expect.poll(async () => (await regularChats(aiden.userDataDir)).length).toBe(1);
  const [chat] = await regularChats(aiden.userDataDir);
  expect(chat.id).toBe(secondDraft);
  expect(chat.workspaceId).toBe(workspaceId);
  expect(chat.messages.filter((message) => message.role === "user").map((message) => message.content))
    .toEqual(["Started from the sidebar plus"]);
  await expect(draftRows).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /Started from the sidebar plus/u })).toBeVisible();
});

test("New chat in… opens a draft in the chosen workspace from the chevron, the shortcut and the menu", async ({ aiden }) => {
  const { page, app } = aiden;
  await finishLmStudioOnboarding(page);
  const targetId = await addWorkspace(page, "Palette target");
  const composer = page.locator("textarea");
  const search = page.getByRole("combobox", { name: "Search workspaces" });
  const palette = page.locator("[data-command-palette-content]");
  const options = page.getByRole("option");

  // Chevron beside New Agent.
  await page.getByRole("button", { name: "New Agent", exact: true }).hover();
  await page.getByRole("button", { name: "New chat in…", exact: true }).click();
  await expect(search).toBeFocused();
  // Most recent first: the new workspace was added after the default one.
  await expect(options.nth(0)).toHaveText(/^Palette target/u);
  await expect(options.nth(1)).toHaveText(/current$/u);
  await expect(page.getByRole("option", { name: /^Open folder…/u })).toBeVisible();
  await expect(options.nth(1)).toHaveAttribute("aria-current", "true");
  // Esc returns to the command list, then closes the palette.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: /^Search commands/u })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // Native File menu item.
  await app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === "New Chat in…") return item;
        const nested = item.submenu ? find(item.submenu.items) : undefined;
        if (nested) return nested;
      }
      return undefined;
    };
    const item = find(Menu.getApplicationMenu()?.items ?? []);
    if (!item) throw new Error("New Chat in… is missing from the application menu");
    item.click();
  });
  await expect(search).toBeFocused();
  // Esc returns to the command list, then closes the palette.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: /^Search commands/u })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // Keyboard shortcut from outside a text field (inside one, the native menu
  // accelerator owns it, which the menu step above exercises).
  await page.getByRole("button", { name: "New Agent", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+Shift+N");
  await expect(search).toBeFocused();
  await search.fill("palette");
  await expect(options.first()).toHaveText(/^Palette target/u);
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(page.locator("[data-sidebar] [data-draft-chat]")).toHaveCount(1);

  await composer.fill("Started from New chat in");
  await composer.press("Enter");
  await expect.poll(async () => (await regularChats(aiden.userDataDir)).length).toBe(1);
  expect((await regularChats(aiden.userDataDir))[0].workspaceId).toBe(targetId);
});

test("New chat in… opens a typed path as a workspace and offers Clone", async ({ aiden }) => {
  const { page } = aiden;
  // HOME is the test root, so ~/palette-folder resolves inside it.
  await mkdir(path.join(aiden.rootDir, "palette-folder"));
  await finishLmStudioOnboarding(page);
  const search = page.getByRole("combobox", { name: "Search workspaces" });
  const palette = page.locator("[data-command-palette-content]");
  const composer = page.locator("textarea");

  await page.getByRole("button", { name: "New Agent", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+Shift+N");
  await expect(search).toBeFocused();
  await expect(page.getByRole("option", { name: "Clone repository…" })).toBeVisible();
  // A folder that is missing only its last segment can be created.
  await search.fill("~/palette-folder/missing/deeper");
  await expect(palette.getByText("The parent folder doesn't exist.")).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(0);
  await search.fill("~/palette-folder");
  await expect(page.getByRole("option", { name: /^Open \/.*palette-folder/u })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(page.locator("[data-new-chat-headline]")).toHaveText("What should we build in palette-folder?");
});
