import type {
  BotCapabilityIncarnation,
  BotCapabilityIncarnationInput,
  BotCapabilityIncarnationNamespace,
  BotCapabilityIncarnationReconcileOptions,
} from "./bot-capability-store-core.js";

export type {
  BotCapabilityIncarnation,
  BotCapabilityIncarnationInput,
  BotCapabilityIncarnationNamespace,
  BotCapabilityIncarnationReconcileOptions,
} from "./bot-capability-store-core.js";

/**
 * Inventory-facing incarnation port. Production implements this interface with
 * the Keychain-checkpointed Bot capability store; no independent authority file
 * is permitted because rolling it back could revive a stale Custom grant.
 */
export interface BotCapabilityIncarnationStore {
  reconcileNamespace(
    namespace: BotCapabilityIncarnationNamespace,
    resources: readonly BotCapabilityIncarnationInput[],
    options?: BotCapabilityIncarnationReconcileOptions,
  ): Promise<readonly BotCapabilityIncarnation[]>;
}

/** Small structural adapter retained for production-shape tests and dependency injection. */
export function createBotCapabilityIncarnationStore(
  backend: BotCapabilityIncarnationStore,
): BotCapabilityIncarnationStore {
  return {
    reconcileNamespace: (namespace, resources, options) =>
      backend.reconcileNamespace(namespace, resources, options),
  };
}
