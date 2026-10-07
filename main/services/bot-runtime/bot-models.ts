// One pi-ai `Models` view for every Bot harness, backed by the exact runtime
// each Bot resolved for its own provider binding. Aiden resolves a runtime
// (credentials pinned after Bot authority admission) per provider/model;
// generation looks the model up by the reference stored in the Bot's
// conversation and streams through that runtime.

import type { Api, Model, Models } from "@earendil-works/pi-ai";

export interface BotModelRuntime {
  model: Model<Api>;
  models: Models;
  streams: Pick<Models, "streamSimple">;
}

export interface BotRuntimeModels {
  models: Models;
  /** Make `runtime` the one used for its provider/model. */
  register(runtime: BotModelRuntime): void;
}

const key = (provider: string, modelId: string) => `${provider}\u0000${modelId}`;

export function createBotRuntimeModels(): BotRuntimeModels {
  const runtimes = new Map<string, BotModelRuntime>();
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

  const models = new Proxy({} as Models, {
    get(_target, property) {
      if (property in overrides) return overrides[property as keyof Models];
      return () => {
        throw new Error(`Bot models do not support ${String(property)}.`);
      };
    },
  });

  return {
    models,
    register(runtime) {
      runtimes.set(key(runtime.model.provider, runtime.model.id), runtime);
    },
  };
}
