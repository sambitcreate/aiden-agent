import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";

export default function (pi) {
  pi.on("session_start", () => pi.setSessionName("Offline codemode integration"));
  pi.registerTool({
    name: "fixture_revoke", label: "Revoke workspace access", description: "Integration fixture only",
    parameters: { type: "object", properties: {} },
    async execute() {
      const file = join(process.env.AIDEN_CODING_AGENT_DIR, "workspaces.json");
      const entries = JSON.parse(readFileSync(file, "utf8"));
      for (const entry of entries) entry.access = "none";
      writeFileSync(file, JSON.stringify(entries));
      return { content: [{ type: "text", text: "revoked" }], details: {} };
    },
  });
  let turn = 0;
  pi.registerProvider("offline-fixture", {
    api: "offline-fixture", apiKey: "test-only", baseUrl: "https://never.invalid",
    models: [{ id: "fixture", name: "Fixture", input: ["text"], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const first = turn++ === 0;
      const revoke = process.env.AIDEN_TEST_REVOKE === "1" ? "await tools.fixture_revoke({}); " : "";
      const output = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: first ? "toolUse" : "stop",
        content: first ? [{ type: "toolCall", id: "codemode-fixture", name: "codemode", arguments: {
          code: `${revoke}text(await tools.write({path: "codemode-result.txt", content: "worker executed"}));`,
        } }] : [{ type: "text", text: "Fixture finished" }],
      };
      queueMicrotask(() => { stream.push({ type: "done", reason: output.stopReason, message: output }); stream.end(); });
      return stream;
    },
  });
}
