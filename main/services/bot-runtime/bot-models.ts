// pi-ai `Models` views for Bot harnesses, one per Bot, each backed by the
// exact runtime that Bot resolved for its own provider binding. Aiden resolves
// a runtime (credentials pinned after Bot authority admission, and headers
// such as OpenCode's `x-opencode-session` attributed to that Bot) per Bot;
// generation looks the model up by the reference stored in the Bot's
// conversation and streams through that Bot's runtime. Two Bots on the same
// provider/model never see each other's runtime.

import type { Api, Model, Models } from "@earendil-works/pi-ai";

export interface BotModelRuntime {
  model: Model<Api>;
  models: Models;
  streams: Pick<Models, "streamSimple">;
}

export interface BotRuntimeModels {
  /** The `Models` view of one Bot's harness. */
  modelsFor(botId: string): Models;
  /** Make `runtime` the one this Bot uses for its provider/model. */
  register(botId: string, runtime: BotModelRuntime): void;
  /** Drop everything a deleted Bot resolved. */
  forget(botId: string): void;
}

const key = (provider: string, modelId: string) => `${provider}\u0000${modelId}`;

function botModels(runtimes: Map<string, BotModelRuntime>): Models {
  const runtimeFor = (model: Pick<Model<Api>, "provider" | "id">): BotModelRuntime => {
    const runtime = runtimes.get(key(model.provider, model.id));
    if (runtime === undefined) throw new Error("This Bot's AI model is not ready yet.");
    return runtime;
  };

  const overrides: Partial<Models> = {
    getModel: ((provider: string, modelId: string) => runtimes.get(key(provider, modelId))?.model) as Models["getModel"],
    streamSimple: ((model, context, options) => runtimeFor(model).streams.streamSimple(model, context, options)) as Models["streamSimple"],
    completeSimple: ((model, context, options) =>
      runtimeFor(model).streams.streamSimple(model, context, options).result()) as Models["completeSimple"],
    fetchDeferred: ((model, handle, options) => runtimeFor(model).models.fetchDeferred(model, handle, options)) as Models["fetchDeferred"],
    cancelDeferred: ((model, handle, options) => runtimeFor(model).models.cancelDeferred(model, handle, options)) as Models["cancelDeferred"],
  };

  return new Proxy({} as Models, {
    get(_target, property) {
      if (property in overrides) return overrides[property as keyof Models];
      return () => {
        throw new Error(`Bot models do not support ${String(property)}.`);
      };
    },
  });
}

export function createBotRuntimeModels(): BotRuntimeModels {
  const perBot = new Map<string, { runtimes: Map<string, BotModelRuntime>; models: Models }>();
  const entry = (botId: string) => {
    let found = perBot.get(botId);
    if (found === undefined) {
      const runtimes = new Map<string, BotModelRuntime>();
      found = { runtimes, models: botModels(runtimes) };
      perBot.set(botId, found);
    }
    return found;
  };

  return {
    modelsFor: (botId) => entry(botId).models,
    register(botId, runtime) {
      entry(botId).runtimes.set(key(runtime.model.provider, runtime.model.id), runtime);
    },
    forget(botId) {
      perBot.get(botId)?.runtimes.clear();
      perBot.delete(botId);
    },
  };
}
