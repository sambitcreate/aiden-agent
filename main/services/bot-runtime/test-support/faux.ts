// Test helpers: a pi-ai faux provider wired into a `Models` collection, so
// runtime tests can count provider requests as an independent oracle.

import { createModels, type Models } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL = "faux-model";
export const FAUX_MODEL_REF = { provider: FAUX_PROVIDER, modelId: FAUX_MODEL } as const;

export interface FauxModels {
  models: Models;
  faux: FauxProviderHandle;
  /** Provider requests made so far. */
  calls(): number;
}

export function createFauxModels(
  responses: FauxResponseStep[] = [],
  options: { tokensPerSecond?: number; provider?: string; modelId?: string; input?: ("text" | "image")[] } = {},
): FauxModels {
  const faux = fauxProvider({
    provider: options.provider ?? FAUX_PROVIDER,
    models: [
      {
        id: options.modelId ?? FAUX_MODEL,
        contextWindow: 200_000,
        maxTokens: 8_000,
        ...(options.input === undefined ? {} : { input: options.input }),
      },
    ],
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { models, faux, calls: () => faux.state.callCount };
}

/** A long answer that streams for many seconds at a low token rate. */
export function slowAnswer(): FauxResponseStep {
  return fauxAssistantMessage("word ".repeat(2_000));
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 20, what = "condition" } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
