// Narrow, packaged-only control contract for the Phase 5 subagent lifecycle
// soak. This deliberately contains no generic automation endpoint: the only
// accepted actions are fixed test actions, and all externally supplied data is
// reduced to a private, one-shot control record.

import { randomBytes } from "node:crypto";
import { linkSync, unlinkSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const SUBAGENT_PACKAGED_SOAK_ENV = "AIDEN_SUBAGENT_SOAK";
export const SUBAGENT_PACKAGED_SOAK_CONTROL_SWITCH = "--aiden-subagent-soak-control";
export const SUBAGENT_PACKAGED_SOAK_CONTROL_FILENAME = "control.json";
export const SUBAGENT_PACKAGED_SOAK_RECEIPT_FILENAME = "receipt.json";
export const SUBAGENT_PACKAGED_SOAK_ROOT_PREFIX = "aiden-subagent-soak-";
export const SUBAGENT_PACKAGED_SOAK_SCHEMA_VERSION = 1 as const;
export const SUBAGENT_PACKAGED_SOAK_CHAT_ID = "subagent-soak";
export const SUBAGENT_PACKAGED_SOAK_CHAT_PATH = `/chat/${SUBAGENT_PACKAGED_SOAK_CHAT_ID}`;
export const SUBAGENT_PACKAGED_SOAK_NAVIGATION_PATH = "/settings";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_CYCLE = 100_000;
const MAX_CONTROL_BYTES = 4_096;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
export const SUBAGENT_PACKAGED_SOAK_QUIT_FINALIZATION_GRACE_MS = 5_000;

export type SubagentPackagedSoakMode = "user_stop" | "navigate" | "quit";
export type SubagentPackagedSoakReceiptPhase = "action_dispatched" | "settled";

export interface SubagentPackagedSoakControl {
  version: typeof SUBAGENT_PACKAGED_SOAK_SCHEMA_VERSION;
  nonce: string;
  cycle: number;
  mode: SubagentPackagedSoakMode;
}

/** Aggregate-only data. No identifiers, task text, paths, model data, or output are allowed. */
export interface SubagentPackagedSoakMetrics {
  starts: number;
  completions: number;
  failures: number;
  timeouts: number;
  peakConcurrency: number;
  cleanupFailures: number;
}

export interface SubagentPackagedSoakReceipt {
  version: typeof SUBAGENT_PACKAGED_SOAK_SCHEMA_VERSION;
  nonce: string;
  cycle: number;
  mode: SubagentPackagedSoakMode;
  phase: SubagentPackagedSoakReceiptPhase;
  metrics: SubagentPackagedSoakMetrics;
}

/**
 * The final receipt is evidence only when its publisher still owns this
 * one-shot commit. A shutdown deadline can revoke that authority while a
 * staged write is still in flight.
 */
export interface SubagentPackagedSoakReceiptPublicationOptions {
  canPublish?: () => boolean;
}

export interface SubagentPackagedSoakSession {
  control: SubagentPackagedSoakControl;
  /** Canonical private cycle directory. Keep this internal; never send it to the renderer. */
  root: string;
  /** Canonical system temporary directory used to confine the one-shot root. */
  temporaryDirectory: string;
  controlPath: string;
  receiptPath: string;
}

export interface LoadSubagentPackagedSoakSessionInput {
  isPackaged: boolean;
  argv?: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  temporaryDirectory?: string;
  userId?: number | undefined;
}

export type SubagentPackagedSoakAction =
  | { kind: "renderer_stop" }
  | { kind: "main_navigate"; path: typeof SUBAGENT_PACKAGED_SOAK_NAVIGATION_PATH }
  | { kind: "normal_quit" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validCycle(value: unknown): value is number {
  return nonNegativeInteger(value) && value >= 1 && value <= MAX_CYCLE;
}

function validNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

function validMode(value: unknown): value is SubagentPackagedSoakMode {
  return value === "user_stop" || value === "navigate" || value === "quit";
}

function validReceiptPhase(value: unknown): value is SubagentPackagedSoakReceiptPhase {
  return value === "action_dispatched" || value === "settled";
}

function error(message = "Invalid packaged subagent soak control."): Error {
  // Do not interpolate caller-controlled paths or payloads into startup logs.
  return new Error(message);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mode === right.mode
  );
}

function hasPrivateMode(stat: Stats, expected: number): boolean {
  return (stat.mode & 0o777) === expected;
}

function isOwnedByCurrentUser(stat: Stats, userId: number | undefined): boolean {
  return userId === undefined || stat.uid === userId;
}

function assertPrivateDirectory(stat: Stats, userId: number | undefined): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !isOwnedByCurrentUser(stat, userId) ||
    !hasPrivateMode(stat, PRIVATE_DIRECTORY_MODE)
  ) {
    throw error();
  }
}

function assertPrivateRegularFile(stat: Stats, userId: number | undefined): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    !isOwnedByCurrentUser(stat, userId) ||
    !hasPrivateMode(stat, PRIVATE_FILE_MODE)
  ) {
    throw error();
  }
}

function controlArgument(argv: readonly string[]): string | undefined {
  const prefix = `${SUBAGENT_PACKAGED_SOAK_CONTROL_SWITCH}=`;
  const values = argv
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (values.length !== 1 || values[0]?.length === 0) return undefined;
  return values[0];
}

function resolveUserId(input: LoadSubagentPackagedSoakSessionInput): number | undefined {
  if (input.userId !== undefined) return input.userId;
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function assertPrivateRoot(
  root: string,
  temporaryDirectory: string,
  userId: number | undefined,
): Promise<{ root: string; temporaryDirectory: string }> {
  const [canonicalRoot, canonicalTemporaryDirectory] = await Promise.all([
    fs.realpath(root),
    fs.realpath(temporaryDirectory),
  ]);
  if (
    path.dirname(canonicalRoot) !== canonicalTemporaryDirectory ||
    !path.basename(canonicalRoot).startsWith(SUBAGENT_PACKAGED_SOAK_ROOT_PREFIX)
  ) {
    throw error();
  }
  assertPrivateDirectory(await fs.lstat(canonicalRoot), userId);
  return { root: canonicalRoot, temporaryDirectory: canonicalTemporaryDirectory };
}

async function existingPath(target: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(target);
  } catch (caught: unknown) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw caught;
  }
}

/** Strictly parse the one-shot control file; arbitrary fields are rejected. */
export function parseSubagentPackagedSoakControl(value: unknown): SubagentPackagedSoakControl {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "nonce", "cycle", "mode"])) {
    throw error();
  }
  if (
    value.version !== SUBAGENT_PACKAGED_SOAK_SCHEMA_VERSION ||
    !validNonce(value.nonce) ||
    !validCycle(value.cycle) ||
    !validMode(value.mode)
  ) {
    throw error();
  }
  return {
    version: SUBAGENT_PACKAGED_SOAK_SCHEMA_VERSION,
    nonce: value.nonce,
    cycle: value.cycle,
    mode: value.mode,
  };
}

export function parseSubagentPackagedSoakMetrics(value: unknown): SubagentPackagedSoakMetrics {
  if (!isSubagentPackagedSoakMetrics(value)) {
    throw error("Invalid packaged subagent soak receipt.");
  }
  return {
    starts: value.starts,
    completions: value.completions,
    failures: value.failures,
    timeouts: value.timeouts,
    peakConcurrency: value.peakConcurrency,
    cleanupFailures: value.cleanupFailures,
  };
}

function isSubagentPackagedSoakMetrics(value: unknown): value is SubagentPackagedSoakMetrics {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "starts",
      "completions",
      "failures",
      "timeouts",
      "peakConcurrency",
      "cleanupFailures",
    ]) &&
    nonNegativeInteger(value.starts) &&
    nonNegativeInteger(value.completions) &&
    nonNegativeInteger(value.failures) &&
    nonNegativeInteger(value.timeouts) &&
    nonNegativeInteger(value.peakConcurrency) &&
    nonNegativeInteger(value.cleanupFailures)
  );
}

export function expectedSubagentPackagedSoakReceiptPhase(
  mode: SubagentPackagedSoakMode,
): SubagentPackagedSoakReceiptPhase {
  return mode === "quit" ? "action_dispatched" : "settled";
}

/** A quit-mode receipt is valid only after both parent and child teardown settle. */
export function canWriteSubagentPackagedSoakQuitReceipt(
  parentSettled: boolean,
  subagentsSettled: boolean,
): boolean {
  return parentSettled && subagentsSettled;
}

export type SubagentPackagedSoakQuitReceiptFinalization =
  | { status: "not_requested" }
  | { status: "lifecycle_unsettled" }
  | { status: "written" }
  | { status: "timed_out" }
  | { status: "failed"; error: unknown };

/** A failed packaged-soak receipt finalization must not exit successfully. */
export function requiresSubagentPackagedSoakFailureExit(
  session: SubagentPackagedSoakSession | undefined,
  finalization: SubagentPackagedSoakQuitReceiptFinalization,
): boolean {
  return session !== undefined && finalization.status !== "written";
}

export class SubagentPackagedSoakQuitFinalizationTimeout extends Error {
  constructor() {
    super("Packaged subagent soak quit finalization exceeded its shutdown budget.");
  }
}

function withinSubagentPackagedSoakQuitFinalizationDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new SubagentPackagedSoakQuitFinalizationTimeout());
  return new Promise<T>((resolve, reject) => {
    let completed = false;
    const finish = (callback: () => void) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(new SubagentPackagedSoakQuitFinalizationTimeout())),
      remaining,
    );
    void Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}

/**
 * A failed soak metric flush or receipt write must withhold the receipt. The
 * caller keeps ordinary app shutdown available, but a true packaged-soak
 * session becomes a nonzero failure before any later cleanup can mask it.
 */
export async function tryFinalizeSubagentPackagedSoakQuitReceipt(
  session: SubagentPackagedSoakSession | undefined,
  parentSettled: boolean,
  subagentsSettled: boolean,
  {
    flushMetrics,
    snapshotMetrics,
    writeReceipt,
    timeoutMs = SUBAGENT_PACKAGED_SOAK_QUIT_FINALIZATION_GRACE_MS,
    withinDeadline = withinSubagentPackagedSoakQuitFinalizationDeadline,
  }: {
    flushMetrics: () => Promise<void>;
    snapshotMetrics: () => Promise<SubagentPackagedSoakMetrics>;
    writeReceipt: (
      target: SubagentPackagedSoakSession,
      metrics: SubagentPackagedSoakMetrics,
      publication: SubagentPackagedSoakReceiptPublicationOptions,
    ) => Promise<unknown>;
    timeoutMs?: number;
    withinDeadline?: <T>(operation: () => Promise<T>, deadline: number) => Promise<T>;
  },
): Promise<SubagentPackagedSoakQuitReceiptFinalization> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let publicationRevoked = false;
  const canPublish = () => !publicationRevoked && Date.now() < deadline;
  try {
    await withinDeadline(flushMetrics, deadline);
    if (!session) return { status: "not_requested" };
    if (!canWriteSubagentPackagedSoakQuitReceipt(parentSettled, subagentsSettled)) {
      return { status: "lifecycle_unsettled" };
    }
    const metrics = await withinDeadline(snapshotMetrics, deadline);
    await withinDeadline(
      () => writeReceipt(session, metrics, { canPublish }),
      deadline,
    );
    return { status: "written" };
  } catch (error) {
    // A raced or injected timeout does not cancel the operation it started.
    // Revoke publication before returning so a delayed production writer can
    // only clean up its private staging file, never publish `receipt.json`.
    publicationRevoked = true;
    if (error instanceof SubagentPackagedSoakQuitFinalizationTimeout) {
      return { status: "timed_out" };
    }
    return { status: "failed", error };
  }
}

export function parseSubagentPackagedSoakReceipt(value: unknown): SubagentPackagedSoakReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "nonce", "cycle", "mode", "phase", "metrics"])
  ) {
    throw error("Invalid packaged subagent soak receipt.");
  }
  const control = parseSubagentPackagedSoakControl({
    version: value.version,
    nonce: value.nonce,
    cycle: value.cycle,
    mode: value.mode,
  });
  if (
    !validReceiptPhase(value.phase) ||
    value.phase !== expectedSubagentPackagedSoakReceiptPhase(control.mode)
  ) {
    throw error("Invalid packaged subagent soak receipt.");
  }
  return {
    ...control,
    phase: value.phase,
    metrics: parseSubagentPackagedSoakMetrics(value.metrics),
  };
}

/** Returns no session unless all explicit gates are present; normal launches remain inert. */
export async function loadSubagentPackagedSoakSession(
  input: LoadSubagentPackagedSoakSessionInput,
): Promise<SubagentPackagedSoakSession | undefined> {
  const environment = input.environment ?? process.env;
  if (!input.isPackaged || environment[SUBAGENT_PACKAGED_SOAK_ENV] !== "1") return undefined;

  const suppliedControlPath = controlArgument(input.argv ?? process.argv.slice(1));
  if (!suppliedControlPath || !path.isAbsolute(suppliedControlPath)) {
    throw error("Packaged subagent soak requires one private control file.");
  }
  if (path.basename(suppliedControlPath) !== SUBAGENT_PACKAGED_SOAK_CONTROL_FILENAME) {
    throw error();
  }

  const userId = resolveUserId(input);
  const resolvedControlPath = path.resolve(suppliedControlPath);
  const { root, temporaryDirectory } = await assertPrivateRoot(
    path.dirname(resolvedControlPath),
    input.temporaryDirectory ?? os.tmpdir(),
    userId,
  );
  const canonicalControlPath = await fs.realpath(resolvedControlPath);
  if (canonicalControlPath !== path.join(root, SUBAGENT_PACKAGED_SOAK_CONTROL_FILENAME)) {
    throw error();
  }

  const before = await fs.lstat(canonicalControlPath);
  assertPrivateRegularFile(before, userId);
  if (before.size > MAX_CONTROL_BYTES) throw error();
  const contents = await fs.readFile(canonicalControlPath, "utf8");
  const after = await fs.lstat(canonicalControlPath);
  assertPrivateRegularFile(after, userId);
  if (!sameIdentity(before, after)) throw error();

  let control: SubagentPackagedSoakControl;
  try {
    control = parseSubagentPackagedSoakControl(JSON.parse(contents));
  } catch {
    throw error();
  }

  const receiptPath = path.join(root, SUBAGENT_PACKAGED_SOAK_RECEIPT_FILENAME);
  if (await existingPath(receiptPath)) throw error();
  return { control, root, temporaryDirectory, controlPath: canonicalControlPath, receiptPath };
}

/** Returns the fixed action only; it never accepts renderer JavaScript or a caller-provided route. */
export function subagentPackagedSoakAction(
  mode: SubagentPackagedSoakMode,
): SubagentPackagedSoakAction {
  switch (mode) {
    case "user_stop":
      return { kind: "renderer_stop" };
    case "navigate":
      return { kind: "main_navigate", path: SUBAGENT_PACKAGED_SOAK_NAVIGATION_PATH };
    case "quit":
      return { kind: "normal_quit" };
  }
}

export function createSubagentPackagedSoakReceipt(
  control: SubagentPackagedSoakControl,
  metrics: SubagentPackagedSoakMetrics,
): SubagentPackagedSoakReceipt {
  return {
    ...control,
    phase: expectedSubagentPackagedSoakReceiptPhase(control.mode),
    metrics: parseSubagentPackagedSoakMetrics(metrics),
  };
}

/**
 * Persist the one final, aggregate-only receipt with create-new semantics.
 * A stale or attacker-created receipt cannot be overwritten or followed.
 */
export async function writeSubagentPackagedSoakReceipt(
  session: SubagentPackagedSoakSession,
  metrics: SubagentPackagedSoakMetrics,
  { canPublish = () => true }: SubagentPackagedSoakReceiptPublicationOptions = {},
): Promise<SubagentPackagedSoakReceipt> {
  const userId = typeof process.getuid === "function" ? process.getuid() : undefined;
  const privateRoot = await assertPrivateRoot(session.root, session.temporaryDirectory, userId);
  if (
    privateRoot.root !== session.root ||
    session.receiptPath !== path.join(session.root, SUBAGENT_PACKAGED_SOAK_RECEIPT_FILENAME)
  ) {
    throw error();
  }
  if (!canPublish()) {
    throw error("Packaged subagent soak receipt publication was revoked.");
  }
  if (await existingPath(session.receiptPath)) throw error();

  const receipt = createSubagentPackagedSoakReceipt(session.control, metrics);
  const stagingPath = path.join(
    session.root,
    `.${SUBAGENT_PACKAGED_SOAK_RECEIPT_FILENAME}.${randomBytes(16).toString("hex")}.pending`,
  );
  let published = false;
  try {
    const handle = await fs.open(stagingPath, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    assertPrivateRegularFile(await fs.lstat(stagingPath), userId);
    if (!canPublish()) {
      throw error("Packaged subagent soak receipt publication was revoked.");
    }
    // `link` is create-new: unlike rename on macOS, it cannot replace an
    // existing receipt. The private staged inode becomes the final evidence
    // only while the caller's commit authority is still live.
    linkSync(stagingPath, session.receiptPath);
    published = true;
    unlinkSync(stagingPath);
    return receipt;
  } catch (caught) {
    if (!published) await fs.rm(stagingPath, { force: true });
    throw caught;
  }
}
