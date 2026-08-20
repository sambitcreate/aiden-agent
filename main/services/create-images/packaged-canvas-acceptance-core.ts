import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkflowDocumentV1 } from "../../../renderer/shared/create-images/schema.js";

export const CREATE_IMAGES_PACKAGED_ACCEPTANCE_ENV = "AIDEN_CREATE_IMAGES_PACKAGED_ACCEPTANCE";
export const CREATE_IMAGES_PACKAGED_ACCEPTANCE_SWITCH = "--aiden-create-images-acceptance-control";
export const CREATE_IMAGES_PACKAGED_ACCEPTANCE_ROOT_PREFIX = "aiden-create-images-acceptance-";
export const CREATE_IMAGES_PACKAGED_ACCEPTANCE_CONTROL_FILENAME = "control.json";
export const CREATE_IMAGES_PACKAGED_ACCEPTANCE_RECEIPT_FILENAME = "receipt.json";
export const CREATE_IMAGES_PACKAGED_ACCEPTANCE_VERSION = 1 as const;

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_CONTROL_BYTES = 4_096;
const VOLATILE_RUNTIME_USER_DATA_PATHS = new Set([
  "Cache",
  "Code Cache",
  "Cookies",
  "Cookies-journal",
  "Crashpad",
  "DIPS",
  "DIPS-wal",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUCache",
  "Local State",
  "Local Storage",
  "Network",
  "Network Persistent State",
  "Preferences",
  "QuotaManager",
  "QuotaManager-journal",
  "Service Worker",
  "Session Storage",
  "Shared Dictionary",
  "SharedStorage",
  "SharedStorage-wal",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "TransportSecurity",
  "Trust Tokens",
  "Trust Tokens-journal",
  "WebStorage",
  "blob_storage",
  "logs",
]);

export interface CreateImagesPackagedAcceptanceControl {
  version: typeof CREATE_IMAGES_PACKAGED_ACCEPTANCE_VERSION;
  nonce: string;
}

export interface CreateImagesPackagedAcceptanceReceipt {
  version: typeof CREATE_IMAGES_PACKAGED_ACCEPTANCE_VERSION;
  nonce: string;
  route: "/create-images/stress-100";
  initialNodeCount: 100;
  addedNodeCount: 101;
  duplicatedNodeCount: 102;
  undoNodeCount: 101;
  redoNodeCount: 102;
  deletedNodeCount: 101;
  nativeDeleteUndoNodeCount: 102;
  nativeDeleteRedoNodeCount: 101;
  spatialConnectionPassed: boolean;
  spatialInvalidDropPassed: boolean;
  nativeEdgeDeletePassed: boolean;
  keyboardConnectionPassed: boolean;
  keyboardMoveUndoPassed: boolean;
  repeatedAnnouncementPassed: boolean;
  uniqueAccessibleNodeLabels: boolean;
  narrowValidationPassed: boolean;
  narrowAddPlacementPassed: boolean;
  focusRestoredAfterPalette: boolean;
  focusRestoredAfterNativeDelete: boolean;
  nativeNodeDeleteGraphPassed: boolean;
  reducedMotionPassed: boolean;
  liveRegionMutations: number;
  keyboardActions: number;
  rendererErrors: number;
  networkRequests: number;
  rendererEgressProbePassed: boolean;
  rendererEgressProbeRequests: number;
  rendererEgressProbeBlocked: number;
  productFileMutations: number;
  durableWorkflowPassed: boolean;
  assetProtocolPreviewPassed: boolean;
  assetProtocolGrantCount: number;
  assetProtocolRequests: number;
  assetProtocolAuthorizations: number;
  assetProtocolLastRequest: CreateImagesPackagedAssetRequestEvidence;
  rendererReloadPersistencePassed: boolean;
  noGraphBase64Passed: boolean;
  phaseTwoProductFileMutations: number;
  phaseTwoProductFiles: ProductFileSnapshotEntry[];
  phaseTwoStorageRelationshipsPassed: boolean;
  phaseTwoWorkflowRevision: number;
  phaseTwoAssetBytes: number;
  phaseTwoAssetWidth: number;
  phaseTwoAssetHeight: number;
  responsiveWidthsPassed: boolean;
  sandboxed: boolean;
  contextIsolation: boolean;
  nodeIntegration: boolean;
  durationMs: number;
}

export interface CreateImagesPackagedAcceptanceSession {
  control: CreateImagesPackagedAcceptanceControl;
  root: string;
  controlPath: string;
  receiptPath: string;
}

export interface LoadCreateImagesPackagedAcceptanceInput {
  isPackaged: boolean;
  argv?: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  temporaryDirectory?: string;
  userId?: number;
}

export function isCreateImagesDurableWorkflowPublication(
  workflow: WorkflowDocumentV1 | undefined,
  initialRevision: number,
  expectedPrompt: string,
): workflow is WorkflowDocumentV1 {
  return (
    workflow !== undefined &&
    Number.isSafeInteger(workflow.revision) &&
    workflow.revision > initialRevision &&
    workflow.nodes.some((node) => node.type === "prompt" && node.data.text === expectedPrompt)
  );
}

export interface ProductFileSnapshotEntry {
  path: string;
  bytes: number;
  digest: string;
}

export interface CreateImagesPackagedAssetRequestEvidence {
  method: "GET";
  resourceType: "image";
  webContentsIdPresent: true;
  framePresent: true;
  frameIsMain: true;
  frameDetached: false;
}

const PRODUCT_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const CREATE_IMAGES_PRODUCT_PREFIX = "user-data/create-images/";
const ASSET_INDEX_PREDECESSOR_PATTERN =
  /^user-data\/create-images\/\.asset-index\.json\.([a-f0-9]{64})\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.previous$/u;

/**
 * Produce strict, sanitized Create Images storage evidence for a fresh acceptance profile.
 * Every Create Images durable file must be an expected publication or one of
 * the three protected asset-index predecessors retained until restart; journals,
 * quarantine records, unexpected thumbnails, orphan assets, and non-empty run
 * indexes fail closed. The empty derived run index is expected after Phase 3.
 */
export function createImagesPhaseTwoProductFileEvidence(
  before: readonly ProductFileSnapshotEntry[],
  after: readonly ProductFileSnapshotEntry[],
  identity: { workflowId: string; assetId: string; assetExtension: "jpg" | "png" },
): ProductFileSnapshotEntry[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(identity.workflowId)) {
    throw new Error("Packaged Create Images storage evidence has an invalid workflow ID.");
  }
  if (!PRODUCT_DIGEST_PATTERN.test(identity.assetId)) {
    throw new Error("Packaged Create Images storage evidence has an invalid asset ID.");
  }
  if (before.some((entry) => entry.path.startsWith(CREATE_IMAGES_PRODUCT_PREFIX))) {
    throw new Error("Packaged Create Images storage evidence did not start from a fresh profile.");
  }
  const workflowRoot = `${CREATE_IMAGES_PRODUCT_PREFIX}workflows/${identity.workflowId}`;
  const fixedExpectedPaths = [
    `${CREATE_IMAGES_PRODUCT_PREFIX}asset-index.json`,
    `${CREATE_IMAGES_PRODUCT_PREFIX}assets/sha256/${identity.assetId.slice(0, 2)}/${identity.assetId}.${identity.assetExtension}`,
    `${CREATE_IMAGES_PRODUCT_PREFIX}index.json`,
    `${CREATE_IMAGES_PRODUCT_PREFIX}run-index.json`,
    `${CREATE_IMAGES_PRODUCT_PREFIX}thumbnails/${identity.assetId}/512.png`,
    `${workflowRoot}/workflow.json`,
    `${workflowRoot}/workflow.last-known-good.json`,
  ];
  const predecessorPaths = after
    .filter((entry) => ASSET_INDEX_PREDECESSOR_PATTERN.test(entry.path))
    .map((entry) => entry.path);
  if (predecessorPaths.length !== 3) {
    throw new Error(
      "Packaged Create Images storage evidence did not retain its three protected index predecessors.",
    );
  }
  for (const filePath of predecessorPaths) {
    const encodedDigest = ASSET_INDEX_PREDECESSOR_PATTERN.exec(filePath)?.[1];
    if (after.find((entry) => entry.path === filePath)?.digest !== encodedDigest) {
      throw new Error("Packaged Create Images storage evidence has an invalid index predecessor.");
    }
  }
  const expectedPaths = [...fixedExpectedPaths, ...predecessorPaths].sort((left, right) =>
    left.localeCompare(right),
  );
  const previous = new Map(before.map((entry) => [entry.path, entry]));
  const currentSnapshot = new Map(after.map((entry) => [entry.path, entry]));
  const mutatedPaths = [...new Set([...previous.keys(), ...currentSnapshot.keys()])]
    .filter((filePath) => {
      const left = previous.get(filePath);
      const right = currentSnapshot.get(filePath);
      return !left || !right || left.bytes !== right.bytes || left.digest !== right.digest;
    })
    .sort((left, right) => left.localeCompare(right));
  if (
    mutatedPaths.length !== expectedPaths.length ||
    mutatedPaths.some((filePath, index) => filePath !== expectedPaths[index])
  ) {
    throw new Error("Packaged Create Images storage evidence found unexpected file mutations.");
  }
  const productFiles = after
    .filter((entry) => entry.path.startsWith(CREATE_IMAGES_PRODUCT_PREFIX))
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    productFiles.length !== expectedPaths.length ||
    productFiles.some((entry, index) => entry.path !== expectedPaths[index])
  ) {
    throw new Error("Packaged Create Images storage evidence found unexpected durable files.");
  }
  if (
    productFiles.some(
      (entry) =>
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 1 ||
        !PRODUCT_DIGEST_PATTERN.test(entry.digest),
    )
  ) {
    throw new Error("Packaged Create Images storage evidence contains invalid file metadata.");
  }
  const byPath = new Map(productFiles.map((entry) => [entry.path, entry]));
  const asset = byPath.get(
    `${CREATE_IMAGES_PRODUCT_PREFIX}assets/sha256/${identity.assetId.slice(0, 2)}/${identity.assetId}.${identity.assetExtension}`,
  );
  const current = byPath.get(`${workflowRoot}/workflow.json`);
  const lastKnownGood = byPath.get(`${workflowRoot}/workflow.last-known-good.json`);
  if (
    asset?.digest !== identity.assetId ||
    !current ||
    !lastKnownGood ||
    current.bytes !== lastKnownGood.bytes ||
    current.digest !== lastKnownGood.digest
  ) {
    throw new Error(
      "Packaged Create Images durable files do not satisfy content-addressed relationships.",
    );
  }
  return productFiles;
}

function invalidControl(): Error {
  return new Error("Invalid packaged Create Images acceptance control.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function privateMode(actual: number, expected: number): boolean {
  return (actual & 0o777) === expected;
}

function ownedBy(stat: { uid: number }, userId: number | undefined): boolean {
  return userId === undefined || stat.uid === userId;
}

function sameFileIdentity(
  left: { dev: number; ino: number; uid: number; nlink: number; size: number; mode: number },
  right: { dev: number; ino: number; uid: number; nlink: number; size: number; mode: number },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mode === right.mode
  );
}

function controlArgument(argv: readonly string[]): string | undefined {
  const prefix = `${CREATE_IMAGES_PACKAGED_ACCEPTANCE_SWITCH}=`;
  const values = argv
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  return values.length === 1 && values[0] ? values[0] : undefined;
}

export function parseCreateImagesPackagedAcceptanceControl(
  value: unknown,
): CreateImagesPackagedAcceptanceControl {
  if (!isRecord(value) || Object.keys(value).length !== 2) throw invalidControl();
  if (
    value.version !== CREATE_IMAGES_PACKAGED_ACCEPTANCE_VERSION ||
    typeof value.nonce !== "string" ||
    !NONCE_PATTERN.test(value.nonce)
  ) {
    throw invalidControl();
  }
  return { version: CREATE_IMAGES_PACKAGED_ACCEPTANCE_VERSION, nonce: value.nonce };
}

async function readPrivateControl(
  controlPath: string,
  userId: number | undefined,
): Promise<CreateImagesPackagedAcceptanceControl> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(controlPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      !ownedBy(before, userId) ||
      !privateMode(before.mode, PRIVATE_FILE_MODE) ||
      before.size < 1 ||
      before.size > MAX_CONTROL_BYTES
    ) {
      throw invalidControl();
    }
    const bytes = Buffer.alloc(before.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (read.bytesRead !== bytes.length || !sameFileIdentity(before, after)) {
      throw invalidControl();
    }
    return parseCreateImagesPackagedAcceptanceControl(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidControl();
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function loadCreateImagesPackagedAcceptanceSession(
  input: LoadCreateImagesPackagedAcceptanceInput,
): Promise<CreateImagesPackagedAcceptanceSession | undefined> {
  const environment = input.environment ?? process.env;
  const argv = input.argv ?? process.argv;
  if (!input.isPackaged || environment[CREATE_IMAGES_PACKAGED_ACCEPTANCE_ENV] !== "1") {
    return undefined;
  }
  const suppliedControlPath = controlArgument(argv);
  if (!suppliedControlPath || !path.isAbsolute(suppliedControlPath)) throw invalidControl();
  const temporaryDirectory = await fs.realpath(input.temporaryDirectory ?? os.tmpdir());
  const controlPath = await fs.realpath(suppliedControlPath);
  const root = await fs.realpath(path.dirname(controlPath));
  if (
    path.dirname(root) !== temporaryDirectory ||
    !path.basename(root).startsWith(CREATE_IMAGES_PACKAGED_ACCEPTANCE_ROOT_PREFIX) ||
    path.basename(controlPath) !== CREATE_IMAGES_PACKAGED_ACCEPTANCE_CONTROL_FILENAME
  ) {
    throw invalidControl();
  }
  const rootStat = await fs.lstat(root);
  const userId =
    input.userId ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !ownedBy(rootStat, userId) ||
    !privateMode(rootStat.mode, PRIVATE_DIRECTORY_MODE)
  ) {
    throw invalidControl();
  }
  const receiptPath = path.join(root, CREATE_IMAGES_PACKAGED_ACCEPTANCE_RECEIPT_FILENAME);
  try {
    await fs.lstat(receiptPath);
    throw invalidControl();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    control: await readPrivateControl(controlPath, userId),
    root,
    controlPath,
    receiptPath,
  };
}

async function snapshotTarget(
  target: string,
  displayRoot: string,
  displayPrefix: "config" | "user-data",
  output: ProductFileSnapshotEntry[],
): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error("Product persistence snapshot rejected a symlink.");
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target);
    entries.sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      await snapshotTarget(path.join(target, entry), displayRoot, displayPrefix, output);
    }
    return;
  }
  if (!stat.isFile()) throw new Error("Product persistence snapshot rejected a special file.");
  const bytes = await fs.readFile(target);
  output.push({
    path: path.posix.join(
      displayPrefix,
      path.relative(displayRoot, target).split(path.sep).join("/"),
    ),
    bytes: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"),
  });
}

/** Snapshot every Aiden-owned durable record, excluding explicit Chromium/runtime-only paths. */
export async function snapshotCreateImagesProductFiles(input: {
  configDir: string;
  userDataDir: string;
}): Promise<readonly ProductFileSnapshotEntry[]> {
  const output: ProductFileSnapshotEntry[] = [];
  await snapshotTarget(input.configDir, input.configDir, "config", output);
  let userDataEntries: string[] = [];
  try {
    userDataEntries = await fs.readdir(input.userDataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  userDataEntries.sort((left, right) => left.localeCompare(right));
  for (const name of userDataEntries) {
    if (VOLATILE_RUNTIME_USER_DATA_PATHS.has(name)) continue;
    await snapshotTarget(
      path.join(input.userDataDir, name),
      input.userDataDir,
      "user-data",
      output,
    );
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

export function countCreateImagesProductFileMutations(
  before: readonly ProductFileSnapshotEntry[],
  after: readonly ProductFileSnapshotEntry[],
): number {
  const previous = new Map(before.map((entry) => [entry.path, entry]));
  const current = new Map(after.map((entry) => [entry.path, entry]));
  const paths = new Set([...previous.keys(), ...current.keys()]);
  let mutations = 0;
  for (const filePath of paths) {
    const left = previous.get(filePath);
    const right = current.get(filePath);
    if (!left || !right || left.bytes !== right.bytes || left.digest !== right.digest) {
      mutations += 1;
    }
  }
  return mutations;
}

export async function writeCreateImagesPackagedAcceptanceReceipt(
  session: CreateImagesPackagedAcceptanceSession,
  receipt: CreateImagesPackagedAcceptanceReceipt,
): Promise<void> {
  if (receipt.nonce !== session.control.nonce) throw invalidControl();
  const handle = await fs.open(session.receiptPath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(session.receiptPath, PRIVATE_FILE_MODE);
  const directory = await fs.open(session.root, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
