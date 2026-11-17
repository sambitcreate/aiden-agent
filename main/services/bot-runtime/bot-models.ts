// pi-ai `Models` views for Bot harnesses, one per Bot, each backed by the
// exact runtime that Bot resolved for its own provider binding. Aiden resolves
// a runtime (credentials pinned after Bot authority admission, and headers
// such as OpenCode's `x-opencode-session` attributed to that Bot) per Bot;
// generation looks the model up by the reference stored in the Bot's
// conversation and streams through that Bot's runtime. Two Bots on the same
// provider/model never see each other's runtime.

import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { streamSimpleWaitingOutUsageLimits, type UsageLimitStreamOptions } from "../usage-limit-stream.js";
import { withBotReplySilenceLimit, type BotReplySilenceOptions } from "./bot-reply-silence.js";
import { isAcpHarnessProvider } from "../../../renderer/shared/acp-harness.js";

export interface BotModelRuntime {
  model: Model<Api>;
  models: Models;
  streams: Pick<Models, "streamSimple">;
  provider?: { id: string; label: string };
}

export interface BotRuntimeModelsOptions {
  /** How a Bot's replies and routines wait out provider usage limits; undefined sends straight through. */
  usageLimits?: (botId: string, runtime: BotModelRuntime) => UsageLimitStreamOptions | undefined;
  /**
   * How long a reply may stay silent after its words, and the timer and log it
   * uses; `false` turns the limit off for that runtime. An agent harness never
   * has one. Undefined uses the defaults.
   */
  replySilence?: (runtime: BotModelRuntime) => BotReplySilenceOptions | false;
}

export interface BotRuntimeModels {
  /** The `Models` view of one Bot's harness. Its requests wait out usage limits. */
  modelsFor(botId: string): Models;
  /** The same models for background chores, such as memory tidy-up, which never wait. */
  backgroundModelsFor(botId: string): Models;
  /** Make `runtime` the one this Bot uses for its provider/model. */
  register(botId: string, runtime: BotModelRuntime): void;
  /** Drop everything a deleted Bot resolved. */
  forget(botId: string): void;
}

const key = (provider: string, modelId: string) => `${provider}\u0000${modelId}`;

function botModels(
  runtimes: Map<string, BotModelRuntime>,
  limitsFor?: (runtime: BotModelRuntime) => UsageLimitStreamOptions | undefined,
  silenceFor?: (runtime: BotModelRuntime) => BotReplySilenceOptions | false,
): Models {
  const runtimeFor = (model: Pick<Model<Api>, "provider" | "id">): BotModelRuntime => {
    const runtime = runtimes.get(key(model.provider, model.id));
    if (runtime === undefined) throw new Error("This Bot's AI model is not ready yet.");
    return runtime;
  };

  const stream = (model: Model<Api>, context: Parameters<Models["streamSimple"]>[1], options?: Parameters<Models["streamSimple"]>[2]) => {
    const runtime = runtimeFor(model);
    const limits = limitsFor?.(runtime);
    const send = (sent: typeof options) =>
      limits
        ? streamSimpleWaitingOutUsageLimits(model, sent, (next) => runtime.streams.streamSimple(model, context, next), limits)
        : runtime.streams.streamSimple(model, context, sent);
    // An agent harness runs its own tools inside one stream, so its quiet stretches are work.
    const harness = runtime.provider !== undefined && isAcpHarnessProvider(runtime.provider.id);
    const silence = harness ? false : silenceFor ? silenceFor(runtime) : {};
    if (silence === false) return send(options);
    // A reply that goes silent after its words ends as finished (bot-reply-silence.ts).
    return withBotReplySilenceLimit(options?.signal, (signal) => send({ ...options, signal }), silence);
  };

  const overrides: Partial<Models> = {
    getModel: ((provider: string, modelId: string) => runtimes.get(key(provider, modelId))?.model) as Models["getModel"],
    streamSimple: ((model, context, options) => stream(model, context, options)) as Models["streamSimple"],
    completeSimple: ((model, context, options) => stream(model, context, options).result()) as Models["completeSimple"],
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

export function createBotRuntimeModels(options: BotRuntimeModelsOptions = {}): BotRuntimeModels {
  const perBot = new Map<string, { runtimes: Map<string, BotModelRuntime>; models: Models; background: Models }>();
  const entry = (botId: string) => {
    let found = perBot.get(botId);
    if (found === undefined) {
      const runtimes = new Map<string, BotModelRuntime>();
      const limitsFor = options.usageLimits;
      found = {
        runtimes,
        models: botModels(runtimes, limitsFor ? (runtime) => limitsFor(botId, runtime) : undefined, options.replySilence),
        background: botModels(runtimes, undefined, options.replySilence),
      };
      perBot.set(botId, found);
    }
    return found;
  };

  return {
    modelsFor: (botId) => entry(botId).models,
    backgroundModelsFor: (botId) => entry(botId).background,
    register(botId, runtime) {
      entry(botId).runtimes.set(key(runtime.model.provider, runtime.model.id), runtime);
    },
    forget(botId) {
      perBot.get(botId)?.runtimes.clear();
      perBot.delete(botId);
    },
  };
}
