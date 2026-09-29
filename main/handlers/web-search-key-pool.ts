/**
 * Web Search API-key pool IPC.
 *
 * Every channel returns only the redacted pool projection: opaque entry IDs,
 * labels, order, strategy, and cooldown state. Key material is write-only.
 * Dependencies are injected so the channel surface can be registered and
 * invoked in tests without Electron.
 */

import type { WebSearchCredentialAccess } from "../services/web-search-credential-core.js";
import {
  isWebSearchKeyPoolEntryId,
  webSearchKeyPoolRendererState,
  webSearchKeyPoolSupported,
  type WebSearchKeyPoolDocument,
  type WebSearchKeyPoolRendererState,
  type WebSearchKeyPoolTracker,
} from "../services/web-search-key-pool-core.js";
import type {
  BoundedNonSecretProviderConfig,
  WebSearchProviderId,
} from "../services/web-search-provider-registry-core.js";

export const WEB_SEARCH_KEY_POOL_CHANNELS = Object.freeze([
  "webSearch:keyPool:get",
  "webSearch:keyPool:add",
  "webSearch:keyPool:remove",
  "webSearch:keyPool:reorder",
  "webSearch:keyPool:setStrategy",
  "webSearch:keyPool:resetCooldown",
] as const);

export interface WebSearchKeyPoolHandlerDependencies<Event> {
  readonly handle: (
    channel: string,
    handler: (event: Event, ...args: unknown[]) => unknown,
  ) => void;
  readonly credentials: WebSearchCredentialAccess;
  readonly tracker: WebSearchKeyPoolTracker;
  readonly providerConfig: (
    providerId: WebSearchProviderId,
  ) => Promise<BoundedNonSecretProviderConfig | undefined>;
  /** Returns a liveness check for the sender document; throws for a foreign sender. */
  readonly owner: (event: Event) => { isDestroyed(): boolean };
  /** Throws while a rollout fence forbids credential changes for this provider. */
  readonly assertMutationAllowed: (providerId: WebSearchProviderId) => void;
}

const INACTIVE = "The renderer document is no longer active.";

export function registerWebSearchKeyPoolHandlers<Event>(
  dependencies: WebSearchKeyPoolHandlerDependencies<Event>,
): void {
  const { credentials, tracker } = dependencies;

  const resolve = async (event: Event, providerId: unknown) => {
    const owner = dependencies.owner(event);
    if (owner.isDestroyed()) throw new Error(INACTIVE);
    if (!webSearchKeyPoolSupported(providerId)) {
      throw new Error("This Web Search provider does not support multiple API keys.");
    }
    const reference = credentials.reference(
      providerId,
      await dependencies.providerConfig(providerId),
    );
    return { owner, providerId, reference, isCurrent: () => !owner.isDestroyed() };
  };

  const project = (
    providerId: Parameters<typeof webSearchKeyPoolRendererState>[0],
    document: WebSearchKeyPoolDocument,
    owner: { isDestroyed(): boolean },
  ): WebSearchKeyPoolRendererState => {
    if (owner.isDestroyed()) throw new Error(INACTIVE);
    // Removed entries must not leave cooldown state behind for a reused ID.
    tracker.retain(
      providerId,
      document.entries.map((entry) => entry.id),
    );
    return webSearchKeyPoolRendererState(providerId, document, tracker);
  };

  const mutation = (
    channel: (typeof WEB_SEARCH_KEY_POOL_CHANNELS)[number],
    run: (
      context: Awaited<ReturnType<typeof resolve>>,
      ...args: unknown[]
    ) => Promise<WebSearchKeyPoolDocument>,
  ) => {
    dependencies.handle(channel, async (event: Event, ...args: unknown[]) => {
      const [providerId, ...rest] = args;
      const context = await resolve(event, providerId);
      dependencies.assertMutationAllowed(context.providerId);
      const document = await run(context, ...rest);
      return project(context.providerId, document, context.owner);
    });
  };

  dependencies.handle("webSearch:keyPool:get", async (event: Event, ...args: unknown[]) => {
    const context = await resolve(event, args[0]);
    return project(
      context.providerId,
      await credentials.listPool(context.reference),
      context.owner,
    );
  });

  mutation("webSearch:keyPool:add", (context, secret, label) =>
    credentials.addPoolKey(context.reference, secret, label, context.isCurrent),
  );

  mutation("webSearch:keyPool:remove", async (context, entryId) => {
    const document = await credentials.removePoolKey(context.reference, entryId, context.isCurrent);
    if (isWebSearchKeyPoolEntryId(entryId)) tracker.clear(context.providerId, entryId);
    return document;
  });

  mutation("webSearch:keyPool:reorder", (context, orderedIds) =>
    credentials.reorderPool(context.reference, orderedIds, context.isCurrent),
  );

  mutation("webSearch:keyPool:setStrategy", (context, strategy) =>
    credentials.setPoolStrategy(context.reference, strategy, context.isCurrent),
  );

  mutation("webSearch:keyPool:resetCooldown", async (context, entryId) => {
    if (!isWebSearchKeyPoolEntryId(entryId)) throw new Error("Invalid Web Search key entry.");
    tracker.clear(context.providerId, entryId);
    return credentials.listPool(context.reference);
  });
}
