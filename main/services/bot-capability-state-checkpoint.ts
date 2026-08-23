import { constants } from "node:fs";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BotCapabilityOpaqueKeyStore } from "./bot-capability-key-store.js";
import {
  BotCapabilityUnavailableError,
  parseBotCapabilityState,
  type BotCapabilityState,
} from "./bot-capability-store-core.js";
import type { BotCapabilityPersistence } from "./bot-capability-store.js";

const VERSION = 1 as const;
const FILE = "bot-capability-state-head.json";
const MAX_BYTES = 1_024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAC_DOMAIN = "aiden.bot-capability-state-head.v1\0";

interface CommittedHead {
  version: typeof VERSION;
  phase: "committed";
  sequence: number;
  digest: string;
  mac: string;
}

interface PendingHead {
  version: typeof VERSION;
  phase: "pending";
  previousSequence: number;
  previousDigest: string;
  nextSequence: number;
  nextDigest: string;
  mac: string;
}

type StateHead = CommittedHead | PendingHead;

export interface BotCapabilityStateCheckpoint {
  initialize(
    state: BotCapabilityState,
    stateFilePresent: boolean,
  ): Promise<void>;
  commit<Result>(
    previous: BotCapabilityState,
    next: BotCapabilityState,
    publish: () => Promise<Result>,
  ): Promise<Result>;
}

/** Independently persisted authority anchor (Keychain in production). */
export interface BotCapabilityRollbackAnchor {
  load(): Promise<string | null>;
  store(value: string, expected: string | null): Promise<void>;
}

export interface BotCapabilityBootstrapMarkerState {
  phase: "pending" | "consumed";
  keyProof: string;
}

/** One-way Keychain marker, stored independently from the Bot service directory. */
export interface BotCapabilityBootstrapMarker {
  load(): Promise<BotCapabilityBootstrapMarkerState | null>;
  store(
    next: BotCapabilityBootstrapMarkerState,
    expected: BotCapabilityBootstrapMarkerState | null,
  ): Promise<void>;
}

export type BotCapabilityInitialBootstrapDisposition =
  "clean" | "legacy" | "deny";

export class BotCapabilityCommitUncertainError extends BotCapabilityUnavailableError {
  readonly commitCause: unknown;

  constructor(cause: unknown) {
    super(
      "Bot access may have changed without completing its rollback checkpoint. Restart Aiden to reconcile it safely.",
    );
    this.name = "BotCapabilityCommitUncertainError";
    this.commitCause = cause;
  }
}

function unavailable(message: string): BotCapabilityUnavailableError {
  return new BotCapabilityUnavailableError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function stateDigest(state: BotCapabilityState): string {
  return createHash("sha256")
    .update(JSON.stringify(parseBotCapabilityState(state)))
    .digest("hex");
}

function unsignedHead(
  head: Omit<CommittedHead, "mac"> | Omit<PendingHead, "mac">,
): string {
  return `${MAC_DOMAIN}${JSON.stringify(head)}`;
}

function signHead(
  head: Omit<CommittedHead, "mac"> | Omit<PendingHead, "mac">,
  key: Uint8Array,
): StateHead {
  return {
    ...head,
    mac: createHmac("sha256", key).update(unsignedHead(head)).digest("hex"),
  } as StateHead;
}

function verifyMac(head: StateHead, key: Uint8Array): void {
  const { mac, ...unsigned } = head;
  const expected = createHmac("sha256", key)
    .update(unsignedHead(unsigned))
    .digest();
  const actual = Buffer.from(mac, "hex");
  if (
    actual.byteLength !== expected.byteLength ||
    !timingSafeEqual(actual, expected)
  ) {
    throw unavailable("Bot access rollback checkpoint authentication failed.");
  }
}

function parseHead(bytes: Buffer, key: Uint8Array): StateHead {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    throw unavailable("Bot access rollback checkpoint is invalid.");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw unavailable("Bot access rollback checkpoint is invalid.");
  }
  if (!isRecord(value) || value.version !== VERSION || !isDigest(value.mac)) {
    throw unavailable("Bot access rollback checkpoint is invalid.");
  }
  let head: StateHead;
  if (
    value.phase === "committed" &&
    Object.keys(value).length === 5 &&
    isSequence(value.sequence) &&
    isDigest(value.digest)
  ) {
    head = value as unknown as CommittedHead;
  } else if (
    value.phase === "pending" &&
    Object.keys(value).length === 7 &&
    isSequence(value.previousSequence) &&
    isDigest(value.previousDigest) &&
    isSequence(value.nextSequence) &&
    isDigest(value.nextDigest) &&
    value.nextSequence > value.previousSequence
  ) {
    head = value as unknown as PendingHead;
  } else {
    throw unavailable("Bot access rollback checkpoint is invalid.");
  }
  verifyMac(head, key);
  return head;
}

function assertOwned(
  info: Awaited<ReturnType<fs.FileHandle["stat"]>>,
  label: string,
): void {
  const getuid = process.getuid;
  if (typeof getuid === "function" && info.uid !== getuid()) {
    throw unavailable(`${label} has the wrong owner.`);
  }
}

async function privateRoot(candidate: string): Promise<string> {
  if (
    !path.isAbsolute(candidate) ||
    path.resolve(candidate) === path.parse(candidate).root
  ) {
    throw unavailable(
      "Bot access rollback checkpoint requires a private absolute root.",
    );
  }
  const requested = path.resolve(candidate);
  await fs.mkdir(requested, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = await fs.lstat(requested);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw unavailable(
      "Bot access rollback checkpoint root is not a private directory.",
    );
  }
  assertOwned(info, "Bot access rollback checkpoint root");
  await fs.chmod(requested, PRIVATE_DIRECTORY_MODE);
  return fs.realpath(requested);
}

async function readPrivateHead(file: string): Promise<Buffer> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw unavailable(
        "Bot access rollback checkpoint is not a private regular file.",
      );
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      throw unavailable(
        "Bot access rollback checkpoint is not a private regular file.",
      );
    }
    assertOwned(info, "Bot access rollback checkpoint");
    if (info.size === 0 || info.size > MAX_BYTES) {
      throw unavailable("Bot access rollback checkpoint is invalid.");
    }
    if ((info.mode & 0o777) !== PRIVATE_FILE_MODE)
      await handle.chmod(PRIVATE_FILE_MODE);
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writePrivateHead(root: string, head: StateHead): Promise<void> {
  const destination = path.join(root, FILE);
  const staged = path.join(root, `.${FILE}.${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(head)}\n`, "utf8");
  try {
    const handle = await fs.open(staged, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(staged, destination);
    const directory = await fs.open(root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.rm(staged, { force: true }).catch(() => undefined);
  }
}

function committedFor(
  state: BotCapabilityState,
  key: Uint8Array,
): CommittedHead {
  return signHead(
    {
      version: VERSION,
      phase: "committed",
      sequence: state.sequence,
      digest: stateDigest(state),
    },
    key,
  ) as CommittedHead;
}

function headMatchesState(
  sequence: number,
  digest: string,
  state: BotCapabilityState,
): boolean {
  return state.sequence === sequence && stateDigest(state) === digest;
}

export function createBotCapabilityStateCheckpoint(options: {
  root(): string | Promise<string>;
  keyStore: BotCapabilityOpaqueKeyStore;
  anchor: BotCapabilityRollbackAnchor;
  bootstrapMarker: BotCapabilityBootstrapMarker;
  /** Independent identity stores classify the only permitted initial bootstrap. */
  inspectInitialBootstrap():
    | BotCapabilityInitialBootstrapDisposition
    | Promise<BotCapabilityInitialBootstrapDisposition>;
  /** Test-only crash seam immediately before publishing a head. */
  beforeHeadWrite?: (phase: StateHead["phase"]) => Promise<void>;
  /** Test-only crash seam after publishing a pending or committed head. */
  afterHeadWrite?: (phase: StateHead["phase"]) => Promise<void>;
}): BotCapabilityStateCheckpoint {
  let initialized = false;

  const write = async (root: string, head: StateHead): Promise<void> => {
    await options.beforeHeadWrite?.(head.phase);
    await writePrivateHead(root, head);
    await options.afterHeadWrite?.(head.phase);
  };

  const loadHead = async (
    root: string,
    key: Uint8Array,
  ): Promise<StateHead | undefined> => {
    try {
      return parseHead(await readPrivateHead(path.join(root, FILE)), key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  const reconcile = async (
    state: BotCapabilityState,
    stateFilePresent: boolean,
  ): Promise<{
    root: string;
    key: Uint8Array;
    head: CommittedHead;
    anchorValue: string;
  }> => {
    const root = await privateRoot(await options.root());
    const [storedAnchor, initialMarker] = await Promise.all([
      options.anchor.load(),
      options.bootstrapMarker.load(),
    ]);
    if (storedAnchor === null && initialMarker?.phase === "consumed") {
      throw unavailable(
        "Bot access rollback authority is missing after bootstrap was consumed; access remains disabled for repair.",
      );
    }

    const keyResult = await options.keyStore.loadWithMetadata();
    const key = keyResult.key;
    const keyProof = createHash("sha256").update(key).digest("hex");
    if (initialMarker && initialMarker.keyProof !== keyProof) {
      throw unavailable(
        "Bot access bootstrap marker does not match its installation key; access remains disabled for repair.",
      );
    }
    const existing = await loadHead(root, key);

    if (storedAnchor === null) {
      if (
        stateFilePresent ||
        state.sequence !== 0 ||
        existing ||
        (initialMarker === null &&
          (await options.inspectInitialBootstrap()) === "deny")
      ) {
        throw unavailable(
          "Bot access rollback authority is missing; access remains disabled for repair.",
        );
      }
      const pendingMarker: BotCapabilityBootstrapMarkerState = {
        phase: "pending",
        keyProof,
      };
      if (initialMarker === null) {
        await options.bootstrapMarker.store(pendingMarker, null);
      }
      const head = committedFor(state, key);
      const anchorValue = JSON.stringify(head);
      // The key-bound pending marker is claimed before the anchor. A crash on
      // either side resumes only with the same local key; losing that key or a
      // consumed anchor fails closed instead of reopening legacy migration.
      await options.anchor.store(anchorValue, null);
      await options.bootstrapMarker.store(
        { phase: "consumed", keyProof },
        pendingMarker,
      );
      await write(root, head);
      return { root, key, head, anchorValue };
    }

    const anchor = parseHead(Buffer.from(storedAnchor, "utf8"), key);
    if (anchor.phase !== "committed") {
      throw unavailable("Bot access rollback authority is not committed.");
    }
    let head: CommittedHead;
    let anchorValue = JSON.stringify(anchor);
    let publishAnchor = false;
    if (headMatchesState(anchor.sequence, anchor.digest, state)) {
      head = committedFor(state, key);
    } else if (
      // The only permissible anchor/state mismatch is the publication side of
      // our signed pending transaction: JSON reached disk before Keychain did.
      existing?.phase === "pending" &&
      anchor.sequence === existing.previousSequence &&
      anchor.digest === existing.previousDigest &&
      headMatchesState(existing.nextSequence, existing.nextDigest, state)
    ) {
      head = committedFor(state, key);
      anchorValue = JSON.stringify(head);
      publishAnchor = true;
    } else {
      throw unavailable(
        "Bot access state is older than or different from its independent rollback authority.",
      );
    }

    // Upgrade an authority written before the one-way marker existed, or resume
    // a crash after claiming its key-bound pending marker. Validation above must
    // succeed before a legacy marker can be claimed. The crash states are
    // monotonic: before `pending`, initial inspection may retry; after `pending`,
    // only the same local key may resume; after `consumed`, a verified anchor is
    // mandatory and the local mirror is repairable. A profile last opened by a
    // pre-marker Aiden remains in the unavoidable compatibility window until
    // this validation and marker upgrade completes once.
    const pendingMarker: BotCapabilityBootstrapMarkerState = {
      phase: "pending",
      keyProof,
    };
    if (initialMarker === null) {
      await options.bootstrapMarker.store(pendingMarker, null);
    }
    if (publishAnchor) {
      await options.anchor.store(anchorValue, storedAnchor);
    }
    if (initialMarker?.phase !== "consumed") {
      await options.bootstrapMarker.store(
        { phase: "consumed", keyProof },
        pendingMarker,
      );
    }
    if (
      !existing ||
      existing.phase !== "committed" ||
      existing.sequence !== head.sequence ||
      existing.digest !== head.digest
    ) {
      await write(root, head);
    }
    return { root, key, head, anchorValue };
  };

  return {
    async initialize(state, stateFilePresent): Promise<void> {
      await reconcile(state, stateFilePresent);
      initialized = true;
    },

    async commit(previous, next, publish): Promise<unknown> {
      if (!initialized) {
        throw unavailable("Bot access rollback protection is not initialized.");
      }
      const current = await reconcile(previous, true);
      const previousDigest = stateDigest(previous);
      const nextDigest = stateDigest(next);
      if (
        previous.sequence === next.sequence &&
        previousDigest === nextDigest
      ) {
        return publish();
      }
      if (next.sequence <= previous.sequence) {
        throw unavailable(
          "Bot access commit sequence did not advance monotonically.",
        );
      }
      const pending = signHead(
        {
          version: VERSION,
          phase: "pending",
          previousSequence: previous.sequence,
          previousDigest,
          nextSequence: next.sequence,
          nextDigest,
        },
        current.key,
      );
      await write(current.root, pending);
      try {
        const result = await publish();
        const committed = committedFor(next, current.key);
        const anchorValue = JSON.stringify(committed);
        await options.anchor.store(anchorValue, current.anchorValue);
        await write(current.root, committed);
        return result;
      } catch (error) {
        // The pending head is durable. From this point a thrown publication,
        // Keychain update, or final mirror write may have committed externally.
        throw new BotCapabilityCommitUncertainError(error);
      }
    },
  } as BotCapabilityStateCheckpoint;
}

/**
 * Couple each JSON publication to a signed two-phase rollback checkpoint.
 * The filesystem head is the crash journal; the independently persisted anchor
 * is authoritative against rollback of the complete Bot service directory.
 */
export function withBotCapabilityStateCheckpoint(
  persistence: BotCapabilityPersistence,
  checkpoint: BotCapabilityStateCheckpoint,
): BotCapabilityPersistence {
  let initialized = false;
  let poisoned = false;
  let tail: Promise<void> = Promise.resolve();

  const serialized = <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const ensureInitialized = async (): Promise<BotCapabilityState> => {
    if (poisoned) {
      throw unavailable(
        "Bot access is paused after an uncertain commit. Restart Aiden to reconcile it safely.",
      );
    }
    const state = await persistence.load();
    if (!initialized) {
      await checkpoint.initialize(
        state,
        (await persistence.loadedDiskContents()) !== null,
      );
      initialized = true;
    }
    return state;
  };

  return {
    load: () => serialized(ensureInitialized),
    save: (next) =>
      serialized(async () => {
        const previous = await ensureInitialized();
        try {
          await checkpoint.commit(previous, next, () => persistence.save(next));
        } catch (error) {
          if (error instanceof BotCapabilityCommitUncertainError)
            poisoned = true;
          throw error;
        }
      }),
    update: (mutation) =>
      serialized(async () => {
        const previous = await ensureInitialized();
        const next = structuredClone(previous);
        const result = await mutation(next);
        try {
          await checkpoint.commit(previous, next, () => persistence.save(next));
        } catch (error) {
          if (error instanceof BotCapabilityCommitUncertainError)
            poisoned = true;
          throw error;
        }
        return result;
      }),
    loadedFromCorruptFile: () => persistence.loadedFromCorruptFile(),
    loadedFromUnsafeFile: () => persistence.loadedFromUnsafeFile(),
    loadedDiskContents: () => persistence.loadedDiskContents(),
  };
}
