// Child-process half of the tool-assembly crash tests (run through
// kill-harness.mjs `scenario`). A Bot turn runs through the real assembly and
// stops at an approval prompt or inside a tool, announces it, and is SIGKILLed
// there by the parent.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createBotRegistry } from "../bot-extension.js";
import { shareImageCandidate } from "../bot-tool-candidates.js";
import { createBotHarnessHost } from "../harness-host.js";
import { declarePiRuntimeReplay } from "../../pi-runtime-tool.js";
import { assemblyDeps, assemblyState, FULL_GRANTS, testAuthority } from "./assembly-fixtures.js";
import { blockingUntilAborted, countingTool } from "./fixtures.js";
import { createFauxModels, FAUX_MODEL_REF } from "./faux.js";

type Emit = (tag: string, value: unknown) => void;

export interface AssemblyScenarioArgs {
  profileDir: string;
  home: string;
  botId: string;
  kind: "share-approval" | "subagent";
}

export async function run(args: AssemblyScenarioArgs, emit: Emit): Promise<void> {
  const ctx = BACKGROUND_CONTEXT;
  const state = assemblyState(testAuthority({ mode: "full", home: args.home, ...FULL_GRANTS }));
  const deps =
    args.kind === "share-approval"
      ? assemblyDeps(state, {
          candidates: (authority) => [shareImageCandidate(authority)],
          approve: async (request) => {
            emit("APPROVAL", request.waitId);
            return blockingUntilAborted(request.signal);
          },
        })
      : assemblyDeps(state, {
          candidates: () => [
            {
              // Declared replay-safe by the tool itself; the assembly must still treat it as unsafe.
              tool: declarePiRuntimeReplay(
                countingTool("subagent", async (_params, signal) => {
                  emit("TOOL_RUNNING", "subagent");
                  return blockingUntilAborted(signal);
                }),
                "safe",
              ),
            },
          ],
        });
  const firstResponse =
    args.kind === "share-approval"
      ? fauxAssistantMessage([fauxToolCall("share_image", { path: "photo.png" })], { stopReason: "toolUse" })
      : fauxAssistantMessage([fauxToolCall("subagent", { text: "delegate" })], { stopReason: "toolUse" });
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
