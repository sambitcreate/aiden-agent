import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listWorkspaceFiles, readWorkspaceFile } from "../services/workspace-files.js";
import { BOT_FILES_LIST_CHANNEL, BOT_FILES_READ_CHANNEL, registerBotFileHandlers } from "./bot-files.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "aiden-bot-files-"));
  const home = join(root, "home");
  await mkdir(join(home, "lists"), { recursive: true });
  await writeFile(join(home, "lists", "groceries.md"), "eggs\nmilk\n");
  await writeFile(join(root, "secret.txt"), "outside the Bot folder");
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerBotFileHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    homePath: async (botId) => {
      if (botId !== "bot:1") throw new Error("This bot is no longer available.");
      return home;
    },
    list: listWorkspaceFiles,
    read: readWorkspaceFile,
  });
  const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!({}, ...args));
  return { root, invoke };
}

test("bots:files lists and reads files in the Bot's own folder only", async (t) => {
  const { root, invoke } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));

  const index = (await invoke(BOT_FILES_LIST_CHANNEL, "bot:1")) as { entries: Array<{ path: string; kind: string }> };
  assert.ok(index.entries.some((entry) => entry.path === "lists/groceries.md" && entry.kind === "file"));
  assert.equal(index.entries.some((entry) => entry.path.includes("secret")), false);

  const document = (await invoke(BOT_FILES_READ_CHANNEL, "bot:1", "lists/groceries.md")) as { path: string; content: string };
  assert.deepEqual([document.path, document.content], ["lists/groceries.md", "eggs\nmilk\n"]);

  await assert.rejects(invoke(BOT_FILES_READ_CHANNEL, "bot:1", "../secret.txt"));
  await assert.rejects(invoke(BOT_FILES_LIST_CHANNEL, "bot:gone"), /no longer available/u);
  await assert.rejects(invoke(BOT_FILES_LIST_CHANNEL, "../bot"), /Invalid bot id/u);
  await assert.rejects(invoke(BOT_FILES_READ_CHANNEL, "bot:1", ""), /Invalid file path/u);
});
