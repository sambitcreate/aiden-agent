import type { AppSettings } from "../types.js";
import type { LiveToolPrepareInput, LiveToolProvider } from "./live-tools.js";
import { createEndSessionToolProvider } from "./end-session-tool.js";
import { liveChatToolProviderFactory } from "./live-chat-tools.js";

/**
 * Builds one group of Aiden Live tools for a starting session, or null when
 * its switch is off or the platform cannot offer it. Factories run in order,
 * and the declarations reach Gemini in that order.
 */
export type LiveToolProviderFactory = (
  input: LiveToolPrepareInput,
  settings: AppSettings,
) => Promise<LiveToolProvider | null> | LiveToolProvider | null;

/** Every Live tool group. Each feature adds one entry here. */
export const LIVE_TOOL_PROVIDER_FACTORIES: readonly LiveToolProviderFactory[] = [
  // Saying goodbye ends the session (always on while Live is on).
  (input) => createEndSessionToolProvider(input),
  (input, settings) => liveChatToolProviderFactory(input, settings),
];

/** Runs the factories; a factory that throws leaves its tools out. */
export async function prepareLiveToolProviders(
  input: LiveToolPrepareInput,
  settings: AppSettings,
  factories: readonly LiveToolProviderFactory[] = LIVE_TOOL_PROVIDER_FACTORIES,
): Promise<LiveToolProvider[]> {
  const providers: LiveToolProvider[] = [];
  for (const factory of factories) {
    if (input.signal.aborted) break;
    try {
      const provider = await factory(input, settings);
      if (provider) providers.push(provider);
    } catch {
      // One feature failing to set up must not stop Live from starting.
    }
  }
  if (input.signal.aborted) {
    for (const provider of providers) provider.close?.();
    return [];
  }
  return providers;
}
