import {
  BOT_CAPABILITY_LIMITS,
  BOT_FULL_ACCESS_NOTICE_VERSION,
  isPathSafeBotCapabilityId,
  type BotCustomSelection,
  type BotNoticeStatus,
} from "../../renderer/shared/bot-capabilities.js";
import {
  buildBotCapabilityCatalogSnapshot,
  type BotCapabilityCatalogSnapshot,
  type BotConnectionInventory,
  type BotOrdinaryCapabilityInventory,
  type BotProviderInventory,
  type BotShellInventory,
  type BotSkillInventory,
} from "./bot-capability-catalog-core.js";
import {
  assertBoundBotCustomSelectionOpaqueIds,
  assertBoundBotCustomSelectionCurrent,
  bindBotCustomSelection,
  createBotCapabilityOpaqueIdMint,
  reconcileBoundBotCustomSelection,
  withBotCapabilityTombstones,
  type BoundBotCustomSelection,
  type ReconciledBotCustomSelection,
} from "./bot-capability-bindings.js";

export interface BotApprovedLocationInventory {
  /** Main-only stable root identity. Never a path. */
  sourceId: string;
  label: string;
  description?: string;
  available: boolean;
  /** Covers canonical filesystem identity and the current root policy. */
  scopeFingerprint: string;
}

export interface BotMacFileInventory {
  fullMac: {
    available: boolean;
    /** Covers the current global/OS file-access contract. */
    scopeFingerprint: string;
  };
  botHome: {
    available: boolean;
    /** Covers the current managed-home access contract, not a public path. */
    scopeFingerprint: string;
  };
  approvedLocations: BotApprovedLocationInventory[];
}

/**
 * Main-process inventory seams. Implementations may use configStore, provider
 * runtime, approved-root state, MCP inspection, and skill discovery, but this
 * service never imports those app globals and tests need none of them.
 */
export interface BotCapabilityInventoryPorts {
  loadOpaqueSelectionKey(): Promise<Uint8Array>;
  /** Notice acknowledgement is isolated to one authenticated paired principal. */
  loadNoticeStatus(audienceId: string): Promise<BotNoticeStatus>;
  listProviders(signal: AbortSignal): Promise<readonly BotProviderInventory[]>;
  inspectMacFiles(signal: AbortSignal): Promise<BotMacFileInventory>;
  inspectShell(signal: AbortSignal): Promise<BotShellInventory>;
  inspectConnections(signal: AbortSignal): Promise<readonly BotConnectionInventory[]>;
  inspectSkills(
    signal: AbortSignal,
    target?: { botId: string },
  ): Promise<readonly BotSkillInventory[]>;
  inspectOtherCapabilities(signal: AbortSignal): Promise<readonly BotOrdinaryCapabilityInventory[]>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Bot capability catalog request was cancelled.");
}

function relayAbort(parent: AbortSignal, child: AbortController): () => void {
  const relay = () => child.abort(abortReason(parent));
  if (parent.aborted) relay();
  else parent.addEventListener("abort", relay, { once: true });
  return () => parent.removeEventListener("abort", relay);
}

export class BotCapabilityCatalogMainService {
  private keyPromise?: Promise<Uint8Array>;

  constructor(
    private readonly ports: BotCapabilityInventoryPorts,
    private readonly hooks: {
      onRuntimeSnapshot?(botId: string | undefined, snapshot: BotCapabilityCatalogSnapshot): void;
    } = {},
  ) {}

  private selectionKey(): Promise<Uint8Array> {
    this.keyPromise ??= this.ports.loadOpaqueSelectionKey().then((value) => {
      // The mint validates the exact length. Retain a private copy so a caller
      // cannot mutate the key buffer after this awaited boundary.
      const copy = Uint8Array.from(value);
      createBotCapabilityOpaqueIdMint(copy);
      return copy;
    });
    return this.keyPromise;
  }

  private audienceId(value: string): string {
    if (!isPathSafeBotCapabilityId(value, BOT_CAPABILITY_LIMITS.opaqueIdChars)) {
      throw new Error("Bot capability catalog requires a valid paired-device audience.");
    }
    return value;
  }

  private botId(value: string): string {
    if (!isPathSafeBotCapabilityId(value, BOT_CAPABILITY_LIMITS.botIdChars)) {
      throw new Error("Bot capability catalog requires a valid Bot identity.");
    }
    return value;
  }

  private async buildSnapshot(input: {
    notice: BotNoticeStatus | Promise<BotNoticeStatus>;
    retainedBindings?: readonly BoundBotCustomSelection[];
    signal?: AbortSignal;
    botId?: string;
  }): Promise<BotCapabilityCatalogSnapshot> {
    const parent = input.signal ?? new AbortController().signal;
    if (parent.aborted) throw abortReason(parent);
    const controller = new AbortController();
    const cleanup = relayAbort(parent, controller);
    try {
      const [
        selectionKey,
        notice,
        providers,
        macFiles,
        shell,
        connections,
        skills,
        otherCapabilities,
      ] = await Promise.all([
        this.selectionKey(),
        input.notice,
        this.ports.listProviders(controller.signal),
        this.ports.inspectMacFiles(controller.signal),
        this.ports.inspectShell(controller.signal),
        this.ports.inspectConnections(controller.signal),
        this.ports.inspectSkills(
          controller.signal,
          input.botId === undefined ? undefined : { botId: this.botId(input.botId) },
        ),
        this.ports.inspectOtherCapabilities(controller.signal),
      ]);
      if (parent.aborted) throw abortReason(parent);
      const current = buildBotCapabilityCatalogSnapshot({
        inventory: {
          providers: [...providers],
          fileScopes: [
            {
              sourceId: "builtin.full_mac.v1",
              label: "Full Mac",
              description: "Files in locations your Mac lets Aiden access.",
              available: macFiles.fullMac.available,
              kind: "full_mac",
              scopeFingerprint: macFiles.fullMac.scopeFingerprint,
            },
            {
              sourceId: "builtin.bot_home.v1",
              label: "Bot folder",
              description: "Files in this bot's private Aiden folder.",
              available: macFiles.botHome.available,
              kind: "bot_home",
              scopeFingerprint: macFiles.botHome.scopeFingerprint,
            },
            ...macFiles.approvedLocations.map((location) => ({
              ...location,
              kind: "approved_location" as const,
            })),
          ],
          shell,
          connections: [...connections],
          skills: [...skills],
          otherCapabilities: [...otherCapabilities],
        },
        notice,
        mintOpaqueId: createBotCapabilityOpaqueIdMint(selectionKey),
      });
      const mintOpaqueId = createBotCapabilityOpaqueIdMint(selectionKey);
      for (const binding of input.retainedBindings ?? []) {
        assertBoundBotCustomSelectionOpaqueIds(binding, mintOpaqueId);
      }
      return input.retainedBindings?.length
        ? withBotCapabilityTombstones(current, input.retainedBindings)
        : current;
    } finally {
      cleanup();
    }
  }

  /** Public/Remote projection; a paired principal is always explicit and bounded. */
  async snapshot(input: {
    audienceId: string;
    retainedBindings?: readonly BoundBotCustomSelection[];
    signal?: AbortSignal;
    botId?: string;
  }): Promise<BotCapabilityCatalogSnapshot> {
    const audienceId = this.audienceId(input.audienceId);
    if (input.signal?.aborted) throw abortReason(input.signal);
    return this.buildSnapshot({
      notice: this.ports.loadNoticeStatus(audienceId),
      retainedBindings: input.retainedBindings,
      signal: input.signal,
      botId: input.botId,
    });
  }

  /**
   * Main-only Phase 3 seam. Its pending notice is never projected; the value
   * exists solely because the shared catalog shape requires a notice field.
   */
  async snapshotForRuntime(
    input: {
      retainedBindings?: readonly BoundBotCustomSelection[];
      signal?: AbortSignal;
      botId?: string;
    } = {},
  ): Promise<BotCapabilityCatalogSnapshot> {
    const snapshot = await this.buildSnapshot({
      notice: {
        version: BOT_FULL_ACCESS_NOTICE_VERSION,
        requiresAcknowledgement: true,
      },
      retainedBindings: input.retainedBindings,
      signal: input.signal,
      botId: input.botId,
    });
    this.hooks.onRuntimeSnapshot?.(input.botId, snapshot);
    return snapshot;
  }

  /** Re-read every inventory before binding, so a stale UI revision fails closed. */
  async bindCustom(input: {
    audienceId: string;
    selection: BotCustomSelection;
    catalogRevision: string;
    retainedBindings?: readonly BoundBotCustomSelection[];
    signal?: AbortSignal;
    botId?: string;
  }): Promise<BoundBotCustomSelection> {
    const snapshot = await this.snapshot({
      audienceId: input.audienceId,
      retainedBindings: input.retainedBindings,
      signal: input.signal,
      botId: input.botId,
    });
    return bindBotCustomSelection({
      selection: input.selection,
      catalogRevision: input.catalogRevision,
      snapshot,
    });
  }

  /** Re-read current facts and reject before Phase 3 admits any runtime use. */
  async assertCurrent(
    binding: BoundBotCustomSelection,
    input:
      | { mode: "runtime"; botId: string; signal?: AbortSignal }
      | { mode: "audience"; audienceId: string; botId: string; signal?: AbortSignal },
  ): Promise<void> {
    assertBoundBotCustomSelectionOpaqueIds(
      binding,
      createBotCapabilityOpaqueIdMint(await this.selectionKey()),
    );
    const snapshot =
      input.mode === "runtime"
        ? await this.snapshotForRuntime({ signal: input.signal, botId: input.botId })
        : await this.snapshot({
            audienceId: input.audienceId,
            signal: input.signal,
            botId: input.botId,
          });
    assertBoundBotCustomSelectionCurrent(binding, snapshot);
  }

  /** Return a safe unavailable tombstone view for settings/repair UX. */
  async reconcile(
    binding: BoundBotCustomSelection,
    input: { audienceId: string; botId: string; signal?: AbortSignal },
  ): Promise<ReconciledBotCustomSelection> {
    assertBoundBotCustomSelectionOpaqueIds(
      binding,
      createBotCapabilityOpaqueIdMint(await this.selectionKey()),
    );
    return reconcileBoundBotCustomSelection(
      binding,
      await this.snapshot({
        audienceId: input.audienceId,
        signal: input.signal,
        botId: input.botId,
      }),
    );
  }
}

export function createBotCapabilityCatalogMainService(
  ports: BotCapabilityInventoryPorts,
  hooks: {
    onRuntimeSnapshot?(botId: string | undefined, snapshot: BotCapabilityCatalogSnapshot): void;
  } = {},
): BotCapabilityCatalogMainService {
  return new BotCapabilityCatalogMainService(ports, hooks);
}
