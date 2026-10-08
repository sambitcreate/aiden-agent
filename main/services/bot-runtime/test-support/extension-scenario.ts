// Child-process half of the extension crash tests (run through
// kill-harness.mjs `scenario`). It starts a Bot turn that reaches a tool call
// or an approval prompt and announces it, so the parent can SIGKILL it there.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createBotRegistry } from "../bot-extension.js";
import { createBotHarnessHost } from "../harness-host.js";
import { blockingUntilAborted, countingTool, recordingDeps } from "./fixtures.js";
import { createFauxModels, FAUX_MODEL_REF } from "./faux.js";

type Emit = (tag: string, value: unknown) => void;

export interface ScenarioArgs {
  profileDir: string;
  botId: string;
  kind: "approval" | "tools";
}

export async function run(args: ScenarioArgs, emit: Emit): Promise<void> {
  const ctx = BACKGROUND_CONTEXT;
  const hang = (name: string) =>
    countingTool(name, async (_params, signal) => {
      emit("TOOL_RUNNING", name);
      return blockingUntilAborted(signal);
    });
  const deps =
    args.kind === "approval"
      ? recordingDeps({
          tools: [{ tool: countingTool("gated"), replay: "unsafe" }],
          policy: () => ({ allowed: true, approval: { summary: "Run gated" } }),
          approve: async (request) => {
            emit("APPROVAL", request.waitId);
            return blockingUntilAborted(request.signal);
          },
        })
      : recordingDeps({
          tools: [
            { tool: hang("unsafe_op"), replay: "unsafe" },
            { tool: hang("safe_op"), replay: "safe" },
          ],
        });
  const firstResponse =
    args.kind === "approval"
      ? fauxAssistantMessage([fauxToolCall("gated", { text: "x" })], { stopReason: "toolUse" })
      : fauxAssistantMessage(
          [fauxToolCall("unsafe_op", { text: "u" }), fauxToolCall("safe_op", { text: "s" })],
          { stopReason: "toolUse" },
        );
  const { models } = createFauxModels([firstResponse]);
  const registries = new Map<string, ReturnType<typeof createBotRegistry>>();
  const host = await createBotHarnessHost({
    profileDir: args.profileDir,
    models,
    buildRegistry: (botId) => {
      const registry = createBotRegistry(botId, deps);
      registries.set(botId, registry);
      return registry;
    },
  });
  if ("unavailable" in host) throw new Error("profile locked");
  const { conversation } = await host.open(args.botId);
  await registries.get(args.botId)!.refresh();
  await conversation.configure({ model: FAUX_MODEL_REF }, ctx);
  const submission = await conversation.submit({ type: "input", content: "go", requestId: "scenario" }, ctx);
  emit("SUBMITTED", String(submission.id));
}
