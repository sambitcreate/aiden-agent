/* global clearTimeout, console, process, setTimeout */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";
import {
  assertMatchingPackageSourceFingerprint,
  packageSourceFingerprint,
  PACKAGE_SOURCE_FINGERPRINT_RELATIVE_PATH,
} from "./package-source-fingerprint.mjs";
import {
  assertSamePackagedArtifactIdentity,
  discoverPackagedApp,
  packagedArtifactIdentity,
  verifyMacPackage,
} from "./verify-macos-package.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PREFIX = "aiden-create-images-acceptance-";
const CONTROL_FILENAME = "control.json";
const RECEIPT_FILENAME = "receipt.json";
const CONTROL_SWITCH = "--aiden-create-images-acceptance-control";
const ACCEPTANCE_ENV = "AIDEN_CREATE_IMAGES_PACKAGED_ACCEPTANCE";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const TIMEOUT_MS = 90_000;
const POLL_MS = 50;
const DIAGNOSTIC_LIMIT = 8_192;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writePrivateJson(target, value) {
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: PRIVATE_FILE_MODE,
  });
  await fs.chmod(target, PRIVATE_FILE_MODE);
}

async function privateDirectory(target) {
  await fs.mkdir(target, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await fs.chmod(target, PRIVATE_DIRECTORY_MODE);
}

function captureDiagnostics(child) {
  let output = "";
  const append = (chunk) => {
    output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (output.length > DIAGNOSTIC_LIMIT) output = output.slice(-DIAGNOSTIC_LIMIT);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output.trim();
}

async function readReceipt(receiptPath, nonce) {
  const stat = await fs.lstat(receiptPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== PRIVATE_FILE_MODE
  ) {
    throw new Error("Packaged Create Images receipt is not a private regular file.");
  }
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  if (
    receipt?.version !== 1 ||
    receipt?.nonce !== nonce ||
    receipt?.route !== "/create-images/stress-100"
  ) {
    throw new Error("Packaged Create Images receipt does not match its one-shot control.");
  }
  return receipt;
}

function assertAcceptance(receipt) {
  const exactCounts = {
    initialNodeCount: 100,
    addedNodeCount: 101,
    duplicatedNodeCount: 102,
    undoNodeCount: 101,
    redoNodeCount: 102,
    deletedNodeCount: 101,
    nativeDeleteUndoNodeCount: 102,
    nativeDeleteRedoNodeCount: 101,
  };
  for (const [field, expected] of Object.entries(exactCounts)) {
    if (receipt[field] !== expected) {
      throw new Error(
        `Packaged Create Images ${field} was ${String(receipt[field])}, not ${expected}.`,
      );
    }
  }
  for (const field of [
    "uniqueAccessibleNodeLabels",
    "narrowValidationPassed",
    "narrowAddPlacementPassed",
    "focusRestoredAfterPalette",
    "focusRestoredAfterNativeDelete",
    "nativeNodeDeleteGraphPassed",
    "spatialConnectionPassed",
    "spatialInvalidDropPassed",
    "nativeEdgeDeletePassed",
    "keyboardConnectionPassed",
    "keyboardMoveUndoPassed",
    "repeatedAnnouncementPassed",
    "reducedMotionPassed",
    "rendererEgressProbePassed",
    "sandboxed",
    "contextIsolation",
    "responsiveWidthsPassed",
    "durableWorkflowPassed",
    "assetProtocolPreviewPassed",
    "rendererReloadPersistencePassed",
    "noGraphBase64Passed",
  ]) {
    if (receipt[field] !== true) throw new Error(`Packaged Create Images ${field} did not pass.`);
  }
  if (receipt.nodeIntegration !== false) {
    throw new Error("Packaged Create Images unexpectedly enabled renderer Node integration.");
  }
  if (
    !Number.isSafeInteger(receipt.rendererEgressProbeRequests) ||
    receipt.rendererEgressProbeRequests < 1 ||
    receipt.rendererEgressProbeBlocked !== receipt.rendererEgressProbeRequests
  ) {
    throw new Error("Packaged Create Images did not fail closed on the renderer egress probe.");
  }
  if (
    !Number.isSafeInteger(receipt.assetProtocolGrantCount) ||
    receipt.assetProtocolGrantCount < 1 ||
    !Number.isSafeInteger(receipt.assetProtocolRequests) ||
    receipt.assetProtocolRequests < 1 ||
    !Number.isSafeInteger(receipt.assetProtocolAuthorizations) ||
    receipt.assetProtocolAuthorizations < 1 ||
    receipt.assetProtocolAuthorizations !== receipt.assetProtocolRequests ||
    JSON.stringify(receipt.assetProtocolLastRequest) !==
      JSON.stringify({
        method: "GET",
        resourceType: "image",
        webContentsIdPresent: true,
        framePresent: true,
        frameIsMain: true,
        frameDetached: false,
      })
  ) {
    throw new Error(
      "Packaged Create Images did not traverse the installed production asset-request policy.",
    );
  }
  for (const field of ["rendererErrors", "networkRequests", "productFileMutations"]) {
    if (receipt[field] !== 0) {
      throw new Error(`Packaged Create Images recorded ${receipt[field]} ${field}.`);
    }
  }
  if (receipt.phaseTwoStorageRelationshipsPassed !== true) {
    throw new Error("Packaged Create Images did not verify its durable storage relationships.");
  }
  if (
    !Number.isSafeInteger(receipt.phaseTwoWorkflowRevision) ||
    receipt.phaseTwoWorkflowRevision < 2
  ) {
    throw new Error("Packaged Create Images did not report a durable edited workflow revision.");
  }
  if (
    !Number.isSafeInteger(receipt.phaseTwoAssetBytes) ||
    receipt.phaseTwoAssetBytes <= 20 * 1024 * 1024 ||
    receipt.phaseTwoAssetWidth !== 4_000 ||
    receipt.phaseTwoAssetHeight !== 4_000
  ) {
    throw new Error("Packaged Create Images did not persist its 16 MP, 20 MB fixture.");
  }
  const productFiles = receipt.phaseTwoProductFiles;
  if (!Array.isArray(productFiles) || productFiles.length !== 12) {
    throw new Error("Packaged Create Images did not report its twelve exact durable files.");
  }
  const assetPathPattern =
    /^user-data\/create-images\/assets\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})\.(png|jpg)$/u;
  const assetEntry = productFiles.find((entry) => assetPathPattern.test(entry?.path));
  const assetMatch =
    assetEntry && typeof assetEntry.path === "string"
      ? assetPathPattern.exec(assetEntry.path)
      : null;
  if (!assetMatch || assetMatch[1] !== assetMatch[2].slice(0, 2)) {
    throw new Error("Packaged Create Images durable evidence has an invalid asset path.");
  }
  const assetId = assetMatch[2];
  const workflowRoot = "user-data/create-images/workflows/packaged-phase-two";
  const predecessorPattern =
    /^user-data\/create-images\/\.asset-index\.json\.([a-f0-9]{64})\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.previous$/u;
  const workspacePredecessorPattern =
    /^user-data\/create-images\/\.workspace\.json\.([a-f0-9]{64})\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.previous$/u;
  const predecessors = productFiles.filter((entry) => predecessorPattern.test(entry?.path));
  if (
    predecessors.length !== 3 ||
    predecessors.some((entry) => predecessorPattern.exec(entry.path)?.[1] !== entry.digest)
  ) {
    throw new Error("Packaged Create Images durable evidence has invalid index predecessors.");
  }
  const workspacePredecessors = productFiles.filter((entry) =>
    workspacePredecessorPattern.test(entry?.path),
  );
  if (
    workspacePredecessors.length !== 1 ||
    workspacePredecessors.some(
      (entry) => workspacePredecessorPattern.exec(entry.path)?.[1] !== entry.digest,
    )
  ) {
    throw new Error("Packaged Create Images durable evidence has an invalid workspace predecessor.");
  }
  const expectedPaths = [
    "user-data/create-images/asset-index.json",
    assetEntry.path,
    "user-data/create-images/index.json",
    "user-data/create-images/run-index.json",
    `user-data/create-images/thumbnails/${assetId}/512.png`,
    "user-data/create-images/workspace.json",
    `${workflowRoot}/workflow.json`,
    `${workflowRoot}/workflow.last-known-good.json`,
    ...predecessors.map((entry) => entry.path),
    ...workspacePredecessors.map((entry) => entry.path),
  ].sort((left, right) => left.localeCompare(right));
  const actualPaths = productFiles.map((entry) => entry?.path).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Packaged Create Images durable evidence contains an unexpected path.");
  }
  for (const entry of productFiles) {
    if (
      !entry ||
      Object.keys(entry).sort().join(",") !== "bytes,digest,path" ||
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      typeof entry.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.digest)
    ) {
      throw new Error("Packaged Create Images durable evidence has invalid file metadata.");
    }
  }
  const workflowEntry = productFiles.find(
    (entry) => entry.path === `${workflowRoot}/workflow.json`,
  );
  const lastKnownGoodEntry = productFiles.find(
    (entry) => entry.path === `${workflowRoot}/workflow.last-known-good.json`,
  );
  if (
    assetEntry.digest !== assetId ||
    assetEntry.bytes !== receipt.phaseTwoAssetBytes ||
    workflowEntry?.bytes !== lastKnownGoodEntry?.bytes ||
    workflowEntry?.digest !== lastKnownGoodEntry?.digest
  ) {
    throw new Error("Packaged Create Images durable evidence failed its digest relationships.");
  }
  if (
    !Number.isSafeInteger(receipt.phaseTwoProductFileMutations) ||
    receipt.phaseTwoProductFileMutations !==
      productFiles.filter((entry) => entry.path !== "user-data/create-images/run-index.json").length
  ) {
    throw new Error("Packaged Create Images reported unexpected durable Phase 2 mutations.");
  }
  if (receipt.keyboardActions < 37 || receipt.liveRegionMutations < 17) {
    throw new Error("Packaged Create Images did not complete its keyboard/live-region sequence.");
  }
  if (
    typeof receipt.durationMs !== "number" ||
    !Number.isFinite(receipt.durationMs) ||
    receipt.durationMs <= 0 ||
    receipt.durationMs > TIMEOUT_MS
  ) {
    throw new Error("Packaged Create Images returned an invalid duration.");
  }
}

async function waitForReceiptOrExit(receiptPath, nonce, childState, deadline) {
  while (Date.now() < deadline) {
    try {
      return await readReceipt(receiptPath, nonce);
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const outcome = childState.outcome();
    if (outcome) {
      throw new Error(
        `Packaged Aiden exited before acceptance receipt (${outcome.code ?? outcome.signal ?? outcome.error ?? "unknown"}).`,
      );
    }
    await sleep(POLL_MS);
  }
  throw new Error("Packaged Create Images acceptance timed out.");
}

function monitorChild(child) {
  let outcome;
  const promise = new Promise((resolve) => {
    child.once("error", (error) => {
      outcome = { error };
      resolve(outcome);
    });
    child.once("exit", (code, signal) => {
      if (outcome) return;
      outcome = { code, signal };
      resolve(outcome);
    });
  });
  return { promise, outcome: () => outcome };
}

function waitForChildExitBefore(childState, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new Error("Packaged Aiden did not exit before the acceptance deadline."));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Packaged Aiden did not exit before the acceptance deadline."));
    }, remaining);
    childState.promise.then(
      (outcome) => {
        clearTimeout(timeout);
        resolve(outcome);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await new Promise((resolve) => child.once("exit", resolve));
  clearTimeout(timeout);
}

function readEmbeddedSourceFingerprint(appPath) {
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  const contents = extractFile(asarPath, PACKAGE_SOURCE_FINGERPRINT_RELATIVE_PATH);
  return JSON.parse(contents.toString("utf8"));
}

async function writeDurableAttestation(appPath, receipt, identity, source) {
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  const outputDirectory = path.join(repositoryRoot, "build", "create-images-packaged-acceptance");
  const outputPath = path.join(outputDirectory, "attestation.json");
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(
    outputPath,
    `${JSON.stringify(
      {
        version: 1,
        recordedAt: new Date().toISOString(),
        appPath,
        asarPath,
        artifactIdentity: identity,
        asarSha256: identity.appAsarSha256,
        codeSignatureCdHash: identity.cdHash,
        sourceHead: source.head,
        sourceFingerprintSha256: source.sha256,
        receipt,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: PRIVATE_FILE_MODE },
  );
  await fs.chmod(outputPath, PRIVATE_FILE_MODE);
  return outputPath;
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("Packaged Create Images acceptance is macOS-only.");
  }
  const explicitApp = process.argv[2];
  const appPath = path.resolve(
    explicitApp ?? (await discoverPackagedApp(path.join(repositoryRoot, "release", "development"))),
  );
  await verifyMacPackage(appPath);
  const verifiedIdentity = await packagedArtifactIdentity(appPath);
  const embeddedSource = readEmbeddedSourceFingerprint(appPath);
  assertMatchingPackageSourceFingerprint(
    embeddedSource,
    await packageSourceFingerprint(repositoryRoot),
    "Packaged Create Images app",
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), ROOT_PREFIX));
  await fs.chmod(root, PRIVATE_DIRECTORY_MODE);
  const userData = path.join(root, "user-data");
  const configDir = path.join(root, "portable-config");
  await Promise.all([privateDirectory(userData), privateDirectory(configDir)]);
  const nonce = randomBytes(32).toString("base64url");
  const controlPath = path.join(root, CONTROL_FILENAME);
  const receiptPath = path.join(root, RECEIPT_FILENAME);
  await writePrivateJson(controlPath, { version: 1, nonce });
  const executable = path.join(appPath, "Contents", "MacOS", "Aiden Agent");
  const child = spawn(
    executable,
    [`--user-data-dir=${userData}`, `${CONTROL_SWITCH}=${controlPath}`],
    {
      env: {
        ...process.env,
        AIDEN_CONFIG_DIR: configDir,
        AIDEN_CREATE_IMAGES_ENABLED: "1",
        [ACCEPTANCE_ENV]: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!child.pid) throw new Error("Packaged Aiden did not start.");
  const diagnostics = captureDiagnostics(child);
  const childState = monitorChild(child);
  const deadline = Date.now() + TIMEOUT_MS;
  let passed = false;
  try {
    const receipt = await waitForReceiptOrExit(receiptPath, nonce, childState, deadline);
    assertAcceptance(receipt);
    const outcome = await waitForChildExitBefore(childState, deadline);
    if (outcome.error || outcome.code !== 0 || outcome.signal !== null) {
      throw new Error(`Packaged Aiden did not exit cleanly (${outcome.code ?? outcome.signal}).`);
    }
    const finalIdentity = await packagedArtifactIdentity(appPath);
    assertSamePackagedArtifactIdentity(verifiedIdentity, finalIdentity, "Accepted app");
    assertMatchingPackageSourceFingerprint(
      embeddedSource,
      await packageSourceFingerprint(repositoryRoot),
      "Packaged Create Images app",
    );
    const attestationPath = await writeDurableAttestation(
      appPath,
      receipt,
      finalIdentity,
      embeddedSource,
    );
    console.log(JSON.stringify(receipt, null, 2));
    console.log(`Packaged Create Images attestation: ${attestationPath}`);
    console.log(
      "Packaged Create Images route, keyboard, focus, and side-effect acceptance passed.",
    );
    passed = true;
  } catch (error) {
    const tail = diagnostics();
    if (tail) console.error(tail);
    console.error(`Packaged Create Images evidence retained at ${root}`);
    throw error;
  } finally {
    await terminate(child);
    if (passed) await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
