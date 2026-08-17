import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTelegramAgentTools } from "./telegram-agent-tools.js";
import { registerTelegramDirectRuntime } from "./telegram-direct-runtime.js";

test("direct Telegram tools route explicit profile and thread targets", async () => {
  const calls: unknown[] = [];
  const unregister = registerTelegramDirectRuntime({
    async listProfiles() { return [{ name: "work", hasToken: true, settings: { allowedUserId: 7 } }]; },
    async listTargets() { return [{ threadId: 9, name: "Project", workspaceId: "w" }]; },
    async sendDirectMessage(input) { calls.push(["message", input]); },
    async sendDirectAttachment(input) { calls.push(["attachment", input]); },
    async sendDirectVoice(input) { calls.push(["voice", input]); },
  });
  try {
    const tools = new Map(buildTelegramAgentTools().map((tool) => [tool.name, tool]));
    await tools.get("telegram_message")!.execute("call", { text: "Hi", profile: "work", thread: "Project" });
    await tools.get("telegram_attach")!.execute("call", { path: "report.pdf", profile: "work", thread: 9 });
    await tools.get("telegram_voice")!.execute("call", { text: "Done", profile: "work" });
    assert.deepEqual(calls, [
      ["message", { text: "Hi", profile: "work", thread: "Project" }],
      ["attachment", { path: "report.pdf", profile: "work", thread: 9 }],
      ["voice", { text: "Done", profile: "work" }],
    ]);
  } finally {
    unregister();
  }
});
