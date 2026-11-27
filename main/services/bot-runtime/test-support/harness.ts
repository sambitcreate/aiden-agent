import type { TestContext } from "node:test";
import {
  Harness,
  MemoryStorage,
  ToolResultEntry,
  type Conversation,
} from "@earendil-works/pi-durable";
import { createBotRegistry, type BotExtensionDeps, type BotRegistry } from "../bot-extension.js";
import { FAUX_MODEL_REF, type FauxModels } from "./faux.js";

type HarnessOpenOptions = NonNullable<Parameters<typeof Harness.open>[1]>;
type HarnessContext = Parameters<typeof Harness.open>[2];

export type BotToolResultModel = {
  isError: boolean;
  toolName: string;
  toolCallId?: string;
  content: Array<{ type?: string; text?: string }>;
};

export async function openBotHarness({
  botId,
  deps,
  fauxModels,
  ctx,
  settings,
  t,
}: {
  botId: string;
  deps: BotExtensionDeps;
  fauxModels: FauxModels;
  ctx: HarnessContext;
  settings?: HarnessOpenOptions["settings"];
  t?: Pick<TestContext, "after">;
}): Promise<{ harness: Harness; root: Conversation; registry: BotRegistry }> {
  const registry = createBotRegistry(botId, deps);
  await registry.refresh();
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: fauxModels.models,
      registry,
      ...(settings === undefined ? {} : { settings }),
    },
    ctx,
  );
  registry.attachHarness(harness);
  if (t) {
    t.after(() => harness.close(ctx));
    const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
    return { harness, root, registry };
  }
  try {
    const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
    return { harness, root, registry };
  } catch (error) {
    await harness.close(ctx);
    throw error;
  }
}

export async function botToolResults(
  conversation: Conversation,
  ctx: HarnessContext,
): Promise<BotToolResultModel[]> {
  const view = await conversation.context(ctx);
  return view.entries
    .filter((entry) => entry.kind === ToolResultEntry.kind)
    .map((entry) => (entry as unknown as { model: BotToolResultModel[] }).model[0]!);
}
