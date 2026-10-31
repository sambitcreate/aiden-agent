import assert from "node:assert/strict";
import test from "node:test";
import { BOT_BROWSER_WORKSPACE_CHANNEL, registerBotBrowserHandlers } from "./bot-browser.js";

test("bots:browser:workspace answers the Bot's browser workspace, null for a Bot that is gone, and refuses a bad id", async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const asked: string[] = [];
  registerBotBrowserHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    workspace: async (botId) => {
      asked.push(botId);
      return botId === "bot:ada" ? "bot-home-ada" : null;
    },
  });
  const invoke = (...args: unknown[]) => Promise.resolve(handlers.get(BOT_BROWSER_WORKSPACE_CHANNEL)!({}, ...args));

  assert.deepEqual(await invoke("bot:ada"), { workspaceId: "bot-home-ada" });
  assert.equal(await invoke("bot:gone"), null);
  for (const bad of ["", "../bot", 42, "x".repeat(161), undefined]) await assert.rejects(invoke(bad), /Invalid bot id/u);
  assert.deepEqual(asked, ["bot:ada", "bot:gone"], "a bad id never reaches the browser");
});
