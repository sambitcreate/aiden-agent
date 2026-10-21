// Child-process half of the Bot hand-off and sign-in crash tests (run through
// kill-harness.mjs `scenario`). It starts a Bot turn that hands a step to the
// person (or asks them to sign in) and announces the card's wait id, so the
// parent can SIGKILL the process while the card waits.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createBotRegistry } from "../bot-extension.js";
import { createBotHarnessHost } from "../harness-host.js";
import { createBotHandoffs } from "../bot-handoffs.js";
import { recordingDeps } from "./fixtures.js";
import { createFauxModels, FAUX_MODEL_REF } from "./faux.js";
import {
  HANDOFF_ARGS,
  HANDOFF_TOOL_NAME,
  handoffEntries,
  SIGN_IN_ARGS,
  SIGN_IN_TOOL_NAME,
  signInEntries,
} from "./handoff-fixtures.js";

type Emit = (tag: string, value: unknown) => void;

export interface HandoffScenarioArgs {
  profileDir: string;
  botId: string;
  /** Ask the person to sign in instead of handing off a step. */
  signIn?: boolean;
}

export async function run(args: HandoffScenarioArgs, emit: Emit): Promise<void> {
  const ctx = BACKGROUND_CONTEXT;
  const handoffs = createBotHandoffs();
  handoffs.onChange((botId) => {
    const [prompt] = handoffs.pending(botId);
    if (prompt) emit("HANDOFF", prompt.waitId);
  });
  const deps = recordingDeps({ tools: args.signIn ? signInEntries(handoffs, args.botId) : handoffEntries(handoffs, args.botId) });
  const call = args.signIn ? fauxToolCall(SIGN_IN_TOOL_NAME, SIGN_IN_ARGS) : fauxToolCall(HANDOFF_TOOL_NAME, HANDOFF_ARGS);
  const { models } = createFauxModels([fauxAssistantMessage([call], { stopReason: "toolUse" })]);
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
  const submission = await conversation.submit({ type: "input", content: "log in to my bank", requestId: "handoff" }, ctx);
  emit("SUBMITTED", String(submission.id));
}
