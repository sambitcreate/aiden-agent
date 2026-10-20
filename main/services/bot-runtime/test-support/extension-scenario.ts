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
  /** `handoff-answered`: the person answers Done at once, and the child dies while the answer is recorded. */
  kind: "approval" | "tools" | "handoff" | "handoff-answered";
}

/** The rule hand-off every `handoff` scenario call gets. */
export const SCENARIO_RULE_HANDOFF = {
  rule: { id: "default.purchase", label: "Make a purchase or booking" },
  summary: "Click Place your order — Safari",
  action: "Make a purchase or booking",
  why: "Your rule “Make a purchase or booking” hands this to you.",
} as const;

export async function run(args: ScenarioArgs, emit: Emit): Promise<void> {
  const ctx = BACKGROUND_CONTEXT;
  const hang = (name: string) =>
    countingTool(name, async (_params, signal) => {
      emit("TOOL_RUNNING", name);
      return blockingUntilAborted(signal);
    });
  const deps =
    args.kind === "handoff" || args.kind === "handoff-answered"
      ? recordingDeps({
          tools: [{ tool: countingTool("gated"), replay: "unsafe" }],
          policy: () => ({ allowed: true, handoff: { ...SCENARIO_RULE_HANDOFF, rule: { ...SCENARIO_RULE_HANDOFF.rule } } }),
          handoff: async (request) => {
            emit("HANDOFF", request.waitId);
            if (args.kind === "handoff-answered") return { outcome: "done", note: "Booked for two" };
            return blockingUntilAborted(request.signal);
          },
        })
      : args.kind === "approval"
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
  if (args.kind === "handoff-answered") {
    deps.recordHandoff = async (record) => {
      emit("RECORDING", record.toolCallId);
      await new Promise<never>(() => undefined);
    };
  }
  const firstResponse =
    args.kind !== "tools"
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
