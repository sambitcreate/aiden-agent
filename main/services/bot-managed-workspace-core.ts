/**
 * Main-only ownership and persistence rules for Bot managed homes.
 *
 * The core deliberately knows nothing about Electron, configStore, or Node's
 * filesystem. The production adapter is the only place that turns the opaque
 * directory name into an absolute path. Public Bot DTOs must never import the
 * resolution type exported from this module.
 */

export const BOT_MANAGED_WORKSPACE_VERSION = 2 as const;
export const BOT_MANAGED_WORKSPACE_LIMIT = 256;
export const BOT_MANAGED_IDENTIFIER_CHARS = 160;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PATH_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

interface StoredBotManagedWorkspaceBinding {
  botId: string;
  workspaceId: string;
  directoryName: string;
  createdAt: number;
  incarnation: BotManagedWorkspaceIncarnation;
}

export interface BotManagedWorkspaceDocument {
  version: typeof BOT_MANAGED_WORKSPACE_VERSION;
  bindings: StoredBotManagedWorkspaceBinding[];
}

export interface BotManagedHomeReceipt {
  version: typeof BOT_MANAGED_WORKSPACE_VERSION;
  botId: string;
  workspaceId: string;
  directoryName: string;
  createdAt: number;
  incarnation: BotManagedWorkspaceIncarnation;
}

/**
 * Adapter-proven identity of the owned directory. Decimal strings preserve the
 * full platform stat width without exposing a filesystem path.
 */
export interface BotManagedWorkspaceIncarnation {
  device: string;
  inode: string;
}

/** Receipt fields known before the filesystem has created and identified the home. */
export type BotManagedHomeProvisioningReceipt = Omit<BotManagedHomeReceipt, "incarnation">;

/** Safe main-process handle. It contains no filesystem path. */
export interface BotManagedWorkspaceHandle {
  botId: string;
  workspaceId: string;
  createdAt: number;
}

/** Main-only runtime resolution. Never project this object into IPC or HTTP. */
export interface BotManagedWorkspaceResolution extends BotManagedWorkspaceHandle {
  homePath: string;
  /** Main-only swap fence. Never project this object into IPC or HTTP. */
  incarnation: BotManagedWorkspaceIncarnation;
}

/** Durable reservation written into the lifecycle journal before provisioning. */
export type BotManagedWorkspaceReservation = BotManagedWorkspaceHandle;

export interface BotManagedHomeInspection {
  /** Canonical absolute path, proven by the storage adapter to remain below its owned root. */
  homePath: string;
  incarnation: BotManagedWorkspaceIncarnation;
  receipt: unknown;
}

export interface BotManagedWorkspaceStorage {
  readManifest(): Promise<unknown | null>;
  writeManifest(document: BotManagedWorkspaceDocument): Promise<void>;
  listHomeDirectoryNames(): Promise<readonly string[]>;
  inspectHome(directoryName: string): Promise<BotManagedHomeInspection | null>;
  /**
   * Must use exclusive creation and must never initialize Git. During explicit
   * journal reconciliation it may finish an exact, empty partial provision.
   */
  createHome(
    directoryName: string,
    receipt: BotManagedHomeProvisioningReceipt,
  ): Promise<BotManagedHomeInspection>;
  /** Removes only a matching receipt and an otherwise-empty owned directory. */
  removeOwnedEmptyHome(directoryName: string, receipt: BotManagedHomeReceipt): Promise<boolean>;
}

export interface BotManagedWorkspaceCoreOptions {
  storage: BotManagedWorkspaceStorage;
  now?: () => number;
  mintWorkspaceId(): string;
}

export class BotManagedWorkspaceStateError extends Error {
  readonly name = "BotManagedWorkspaceStateError";
}

export class BotManagedWorkspaceNotProvisionedError extends Error {
  readonly name = "BotManagedWorkspaceNotProvisionedError";
}

export class BotManagedWorkspaceConflictError extends Error {
  readonly name = "BotManagedWorkspaceConflictError";
}

export class BotManagedWorkspaceRollbackError extends Error {
  readonly name = "BotManagedWorkspaceRollbackError";

  constructor(
    message: string,
    readonly errors: readonly unknown[] = [],
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isPathSafeBotManagedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= BOT_MANAGED_IDENTIFIER_CHARS &&
    value.normalize("NFKC") === value &&
    value !== "." &&
    value !== ".." &&
    PATH_SAFE_ID.test(value)
  );
}

export function isBotManagedWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

export function botManagedHomeDirectoryName(workspaceId: string): string {
  if (!isBotManagedWorkspaceId(workspaceId)) {
    throw new BotManagedWorkspaceStateError("Bot managed workspace identifier is invalid.");
  }
  return `home-${workspaceId}`;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStatIdentity(value: unknown, allowZero: boolean): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9][0-9]*)$/u.test(value) &&
    (allowZero || value !== "0")
  );
}

export function parseBotManagedWorkspaceIncarnation(
  value: unknown,
): BotManagedWorkspaceIncarnation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["device", "inode"]) ||
    !isStatIdentity(value.device, true) ||
    !isStatIdentity(value.inode, false)
  ) {
    throw new BotManagedWorkspaceStateError("Bot managed workspace incarnation is corrupt.");
  }
  return { device: value.device, inode: value.inode };
}

function parseBinding(value: unknown): StoredBotManagedWorkspaceBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["botId", "workspaceId", "directoryName", "createdAt", "incarnation"])
  ) {
    throw new BotManagedWorkspaceStateError("Bot managed workspace metadata is corrupt.");
  }
  if (
    !isPathSafeBotManagedIdentifier(value.botId) ||
    !isBotManagedWorkspaceId(value.workspaceId) ||
    value.directoryName !== botManagedHomeDirectoryName(value.workspaceId) ||
    !isTimestamp(value.createdAt)
  ) {
    throw new BotManagedWorkspaceStateError("Bot managed workspace metadata is corrupt.");
  }
  return {
    botId: value.botId,
    workspaceId: value.workspaceId,
    directoryName: value.directoryName,
    createdAt: value.createdAt,
    incarnation: parseBotManagedWorkspaceIncarnation(value.incarnation),
  };
}

export function parseBotManagedWorkspaceDocument(value: unknown): BotManagedWorkspaceDocument {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "bindings"])) {
    throw new BotManagedWorkspaceStateError("Bot managed workspace metadata is corrupt.");
  }
  if (value.version !== BOT_MANAGED_WORKSPACE_VERSION) {
    throw new BotManagedWorkspaceStateError(
      "Bot managed workspace metadata version is unsupported.",
    );
  }
  if (!Array.isArray(value.bindings) || value.bindings.length > BOT_MANAGED_WORKSPACE_LIMIT) {
    throw new BotManagedWorkspaceStateError("Bot managed workspace metadata is corrupt.");
  }
  const bindings = value.bindings.map(parseBinding);
  if (
    new Set(bindings.map(({ botId }) => botId)).size !== bindings.length ||
    new Set(bindings.map(({ workspaceId }) => workspaceId)).size !== bindings.length ||
    new Set(bindings.map(({ directoryName }) => directoryName)).size !== bindings.length
  ) {
    throw new BotManagedWorkspaceStateError(
      "Bot managed workspace metadata contains duplicate homes.",
    );
  }
  return { version: BOT_MANAGED_WORKSPACE_VERSION, bindings };
}

export function parseBotManagedHomeReceipt(value: unknown): BotManagedHomeReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "botId",
      "workspaceId",
      "directoryName",
      "createdAt",
      "incarnation",
    ]) ||
    value.version !== BOT_MANAGED_WORKSPACE_VERSION ||
    !isPathSafeBotManagedIdentifier(value.botId) ||
    !isBotManagedWorkspaceId(value.workspaceId) ||
    value.directoryName !== botManagedHomeDirectoryName(value.workspaceId) ||
    !isTimestamp(value.createdAt)
  ) {
    throw new BotManagedWorkspaceStateError("Bot managed home ownership receipt is corrupt.");
  }
  return {
    version: BOT_MANAGED_WORKSPACE_VERSION,
    botId: value.botId,
    workspaceId: value.workspaceId,
    directoryName: value.directoryName,
    createdAt: value.createdAt,
    incarnation: parseBotManagedWorkspaceIncarnation(value.incarnation),
  };
}

export function parseBotManagedHomeProvisioningReceipt(
  value: unknown,
): BotManagedHomeProvisioningReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "botId", "workspaceId", "directoryName", "createdAt"]) ||
    value.version !== BOT_MANAGED_WORKSPACE_VERSION ||
    !isPathSafeBotManagedIdentifier(value.botId) ||
    !isBotManagedWorkspaceId(value.workspaceId) ||
    value.directoryName !== botManagedHomeDirectoryName(value.workspaceId) ||
    !isTimestamp(value.createdAt)
  ) {
    throw new BotManagedWorkspaceStateError(
      "Bot managed home provisioning receipt is corrupt.",
    );
  }
  return {
    version: BOT_MANAGED_WORKSPACE_VERSION,
    botId: value.botId,
    workspaceId: value.workspaceId,
    directoryName: value.directoryName,
    createdAt: value.createdAt,
  };
}

function receiptFor(binding: StoredBotManagedWorkspaceBinding): BotManagedHomeReceipt {
  return { version: BOT_MANAGED_WORKSPACE_VERSION, ...binding };
}

function provisioningReceiptFor(
  binding: Omit<StoredBotManagedWorkspaceBinding, "incarnation">,
): BotManagedHomeProvisioningReceipt {
  return { version: BOT_MANAGED_WORKSPACE_VERSION, ...binding };
}

function sameReceipt(left: BotManagedHomeReceipt, right: BotManagedHomeReceipt): boolean {
  return (
    left.version === right.version &&
    left.botId === right.botId &&
    left.workspaceId === right.workspaceId &&
    left.directoryName === right.directoryName &&
    left.createdAt === right.createdAt &&
    sameIncarnation(left.incarnation, right.incarnation)
  );
}

function sameIncarnation(
  left: BotManagedWorkspaceIncarnation,
  right: BotManagedWorkspaceIncarnation,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameProvisioningReceipt(
  receipt: BotManagedHomeReceipt,
  expected: BotManagedHomeProvisioningReceipt,
): boolean {
  return (
    receipt.version === expected.version &&
    receipt.botId === expected.botId &&
    receipt.workspaceId === expected.workspaceId &&
    receipt.directoryName === expected.directoryName &&
    receipt.createdAt === expected.createdAt
  );
}

function cloneDocument(document: BotManagedWorkspaceDocument): BotManagedWorkspaceDocument {
  return {
    version: BOT_MANAGED_WORKSPACE_VERSION,
    bindings: document.bindings.map((binding) => ({
      ...binding,
      incarnation: { ...binding.incarnation },
    })),
  };
}

function handleFor(binding: StoredBotManagedWorkspaceBinding): BotManagedWorkspaceHandle {
  return { botId: binding.botId, workspaceId: binding.workspaceId, createdAt: binding.createdAt };
}

function bindingFor(
  reservation: BotManagedWorkspaceReservation,
): Omit<StoredBotManagedWorkspaceBinding, "incarnation"> {
  if (
    !isPathSafeBotManagedIdentifier(reservation.botId) ||
    !isBotManagedWorkspaceId(reservation.workspaceId) ||
    !isTimestamp(reservation.createdAt)
  ) {
    throw new BotManagedWorkspaceStateError("Bot managed workspace reservation is invalid.");
  }
  return {
    botId: reservation.botId,
    workspaceId: reservation.workspaceId,
    createdAt: reservation.createdAt,
    directoryName: botManagedHomeDirectoryName(reservation.workspaceId),
  };
}

function assertSameBinding(
  existing: StoredBotManagedWorkspaceBinding,
  expected: Omit<StoredBotManagedWorkspaceBinding, "incarnation">,
): void {
  if (
    existing.botId !== expected.botId ||
    existing.workspaceId !== expected.workspaceId ||
    existing.directoryName !== expected.directoryName ||
    existing.createdAt !== expected.createdAt
  ) {
    throw new BotManagedWorkspaceConflictError(
      "The pending Bot workspace does not match its durable binding.",
    );
  }
}

/**
 * Durable one-home-per-Bot service. All operations serialize within the process;
 * the production app creates one instance under its single-instance main owner.
 */
export function createBotManagedWorkspaceCore(options: BotManagedWorkspaceCoreOptions) {
  const now = options.now ?? Date.now;
  let mutationTail: Promise<void> = Promise.resolve();

  const serialized = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const loadDocument = async (): Promise<BotManagedWorkspaceDocument> => {
    const raw = await options.storage.readManifest();
    return raw === null
      ? { version: BOT_MANAGED_WORKSPACE_VERSION, bindings: [] }
      : parseBotManagedWorkspaceDocument(raw);
  };

  const inspectBinding = async (
    binding: StoredBotManagedWorkspaceBinding,
  ): Promise<BotManagedWorkspaceResolution> => {
    const inspection = await options.storage.inspectHome(binding.directoryName);
    if (!inspection) {
      throw new BotManagedWorkspaceStateError("This Bot's managed home is missing.");
    }
    const receipt = parseBotManagedHomeReceipt(inspection.receipt);
    if (
      !sameReceipt(receipt, receiptFor(binding)) ||
      !sameIncarnation(inspection.incarnation, binding.incarnation)
    ) {
      throw new BotManagedWorkspaceStateError(
        "This Bot's managed home does not match its private ownership record.",
      );
    }
    return {
      ...handleFor(binding),
      homePath: inspection.homePath,
      incarnation: { ...binding.incarnation },
    };
  };

  const auditDocument = async (
    document: BotManagedWorkspaceDocument,
    allowedPendingDirectoryName?: string,
  ): Promise<void> => {
    const expected = new Set(document.bindings.map(({ directoryName }) => directoryName));
    for (const directoryName of await options.storage.listHomeDirectoryNames()) {
      if (directoryName === allowedPendingDirectoryName) continue;
      if (!expected.has(directoryName)) {
        throw new BotManagedWorkspaceStateError(
          "Bot managed workspace storage contains an unbound or foreign home.",
        );
      }
    }
    for (const binding of document.bindings) await inspectBinding(binding);
  };

  const provisionReservation = async (
    reservation: BotManagedWorkspaceReservation,
    reconciliation: boolean,
  ): Promise<BotManagedWorkspaceResolution> => {
    const requested = bindingFor(reservation);
    const document = await loadDocument();
    const byBot = document.bindings.find(({ botId }) => botId === requested.botId);
    if (byBot) {
      if (reconciliation) assertSameBinding(byBot, requested);
      else if (byBot.workspaceId !== requested.workspaceId) {
        return inspectBinding(byBot);
      }
      await auditDocument(document);
      return inspectBinding(byBot);
    }
    if (document.bindings.length >= BOT_MANAGED_WORKSPACE_LIMIT) {
      throw new BotManagedWorkspaceStateError("Aiden supports up to 256 Bot managed homes.");
    }
    if (document.bindings.some(({ workspaceId }) => workspaceId === requested.workspaceId)) {
      throw new BotManagedWorkspaceConflictError(
        "The pending Bot workspace identifier is already bound to another Bot.",
      );
    }

    await auditDocument(document, reconciliation ? requested.directoryName : undefined);
    let inspection: BotManagedHomeInspection;
    if (reconciliation) {
      inspection = await options.storage.createHome(
        requested.directoryName,
        provisioningReceiptFor(requested),
      );
    } else {
      const existing = await options.storage.inspectHome(requested.directoryName);
      if (existing) {
        throw new BotManagedWorkspaceStateError(
          "Bot managed workspace storage contains an unbound home that requires reconciliation.",
        );
      }
      inspection = await options.storage.createHome(
        requested.directoryName,
        provisioningReceiptFor(requested),
      );
    }
    const actualReceipt = parseBotManagedHomeReceipt(inspection.receipt);
    if (
      !sameProvisioningReceipt(actualReceipt, provisioningReceiptFor(requested)) ||
      !sameIncarnation(actualReceipt.incarnation, inspection.incarnation)
    ) {
      throw new BotManagedWorkspaceStateError(
        "Bot managed home creation returned the wrong ownership receipt.",
      );
    }

    const next = cloneDocument(document);
    const published = { ...requested, incarnation: { ...inspection.incarnation } };
    next.bindings.push(published);
    try {
      await options.storage.writeManifest(next);
    } catch (error) {
      const removed = await options.storage
        .removeOwnedEmptyHome(requested.directoryName, actualReceipt)
        .catch(() => false);
      if (!removed) {
        throw new BotManagedWorkspaceRollbackError(
          "Aiden could not publish or safely roll back this Bot's managed home.",
          [error],
        );
      }
      throw error;
    }
    await auditDocument(next);
    return {
      ...handleFor(published),
      homePath: inspection.homePath,
      incarnation: { ...published.incarnation },
    };
  };

  const reserve = (botId: string): BotManagedWorkspaceReservation => {
    if (!isPathSafeBotManagedIdentifier(botId)) {
      throw new BotManagedWorkspaceStateError("Bot identifier is invalid.");
    }
    const workspaceId = options.mintWorkspaceId();
    if (!isBotManagedWorkspaceId(workspaceId)) {
      throw new BotManagedWorkspaceStateError(
        "The main process minted an invalid Bot workspace identifier.",
      );
    }
    const createdAt = now();
    if (!isTimestamp(createdAt)) {
      throw new BotManagedWorkspaceStateError("Bot managed workspace timestamp is invalid.");
    }
    return { botId, workspaceId, createdAt };
  };

  return {
    reserve,

    provision(
      botId: string,
      reservation?: BotManagedWorkspaceReservation,
    ): Promise<BotManagedWorkspaceResolution> {
      return serialized(async () => {
        if (!isPathSafeBotManagedIdentifier(botId)) {
          throw new BotManagedWorkspaceStateError("Bot identifier is invalid.");
        }
        const selected = reservation ?? reserve(botId);
        if (selected.botId !== botId) {
          throw new BotManagedWorkspaceConflictError(
            "Bot managed workspace reservation belongs to another Bot.",
          );
        }
        const document = await loadDocument();
        const existing = document.bindings.find((binding) => binding.botId === botId);
        if (existing) {
          if (reservation) assertSameBinding(existing, bindingFor(reservation));
          await auditDocument(document);
          return inspectBinding(existing);
        }
        return provisionReservation(selected, false);
      });
    },

    /** Explicit startup recovery for a reservation recorded in the lifecycle journal. */
    reconcileProvision(
      reservation: BotManagedWorkspaceReservation,
    ): Promise<BotManagedWorkspaceResolution> {
      return serialized(() => provisionReservation(reservation, true));
    },

    resolve(botId: string): Promise<BotManagedWorkspaceResolution> {
      return serialized(async () => {
        if (!isPathSafeBotManagedIdentifier(botId)) {
          throw new BotManagedWorkspaceStateError("Bot identifier is invalid.");
        }
        const document = await loadDocument();
        await auditDocument(document);
        const binding = document.bindings.find((candidate) => candidate.botId === botId);
        if (!binding) {
          throw new BotManagedWorkspaceNotProvisionedError(
            "This Bot does not have a valid managed home.",
          );
        }
        return inspectBinding(binding);
      });
    },

    /**
     * Re-proves a prior resolution immediately before an effect. A directory
     * replacement, binding change, or stale path fails closed.
     */
    revalidate(
      expected: BotManagedWorkspaceResolution,
    ): Promise<BotManagedWorkspaceResolution> {
      return serialized(async () => {
        if (
          !isPathSafeBotManagedIdentifier(expected.botId) ||
          !isBotManagedWorkspaceId(expected.workspaceId) ||
          !isTimestamp(expected.createdAt)
        ) {
          throw new BotManagedWorkspaceStateError(
            "Bot managed workspace revalidation token is invalid.",
          );
        }
        const expectedIncarnation = parseBotManagedWorkspaceIncarnation(expected.incarnation);
        const document = await loadDocument();
        const binding = document.bindings.find(({ botId }) => botId === expected.botId);
        if (!binding) {
          throw new BotManagedWorkspaceNotProvisionedError(
            "This Bot does not have a valid managed home.",
          );
        }
        if (
          binding.workspaceId !== expected.workspaceId ||
          binding.createdAt !== expected.createdAt ||
          !sameIncarnation(binding.incarnation, expectedIncarnation)
        ) {
          throw new BotManagedWorkspaceConflictError(
            "This Bot's managed home binding changed after it was resolved.",
          );
        }
        const current = await inspectBinding(binding);
        if (
          current.homePath !== expected.homePath ||
          !sameIncarnation(current.incarnation, expectedIncarnation)
        ) {
          throw new BotManagedWorkspaceStateError(
            "This Bot's managed home changed after it was resolved.",
          );
        }
        return current;
      });
    },

    listBindings(): Promise<readonly BotManagedWorkspaceHandle[]> {
      return serialized(async () => {
        const document = await loadDocument();
        await auditDocument(document);
        return document.bindings.map(handleFor);
      });
    },

    audit(): Promise<void> {
      return serialized(async () => auditDocument(await loadDocument()));
    },

    rollbackProvision(input: {
      botId: string;
      workspaceId: string;
      createdAt: number;
      /** The caller must derive this from its durable lifecycle checkpoint. */
      identityCommitted: false;
    }): Promise<void> {
      return serialized(async () => {
        if (input.identityCommitted !== false) {
          throw new BotManagedWorkspaceRollbackError(
            "A Bot managed home cannot be rolled back after identity commit.",
          );
        }
        if (
          !isPathSafeBotManagedIdentifier(input.botId) ||
          !isBotManagedWorkspaceId(input.workspaceId) ||
          !isTimestamp(input.createdAt)
        ) {
          throw new BotManagedWorkspaceStateError("Bot managed workspace rollback is invalid.");
        }
        const directoryName = botManagedHomeDirectoryName(input.workspaceId);
        const document = await loadDocument();
        const binding = document.bindings.find(({ botId }) => botId === input.botId);
        await auditDocument(
          {
            ...document,
            bindings: document.bindings.filter(({ botId }) => botId !== input.botId),
          },
          directoryName,
        );
        const expected = bindingFor(input);
        if (binding) assertSameBinding(binding, expected);
        const inspection = await options.storage.inspectHome(directoryName);
        if (inspection) {
          const actualReceipt = parseBotManagedHomeReceipt(inspection.receipt);
          if (
            !sameProvisioningReceipt(actualReceipt, provisioningReceiptFor(expected)) ||
            !sameIncarnation(actualReceipt.incarnation, inspection.incarnation)
          ) {
            throw new BotManagedWorkspaceRollbackError(
              "Aiden preserved this Bot's managed home because its ownership changed.",
            );
          }
          if (!(await options.storage.removeOwnedEmptyHome(directoryName, actualReceipt))) {
            throw new BotManagedWorkspaceRollbackError(
              "Aiden preserved this Bot's managed home because it is no longer empty.",
            );
          }
        }
        if (binding) {
          const next = cloneDocument(document);
          next.bindings = next.bindings.filter(({ botId }) => botId !== input.botId);
          await options.storage.writeManifest(next);
        }
      });
    },
  };
}

export type BotManagedWorkspaceCore = ReturnType<typeof createBotManagedWorkspaceCore>;
