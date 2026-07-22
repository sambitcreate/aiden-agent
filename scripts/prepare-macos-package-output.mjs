/* global console, process */

import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");

export const MAC_PACKAGE_OUTPUTS = Object.freeze({
  development: path.join("release", "development"),
  distribution: path.join("release", "distribution"),
});
export const MAC_DISTRIBUTION_STAGING_OUTPUT = path.join("release", ".distribution-staging");
export const COMPUTER_USE_ACCEPTANCE_RECEIPT = path.join(
  "build",
  "computer-use-acceptance-receipt.json",
);

function resolvedDescendant(root, relative) {
  const resolvedRoot = path.resolve(root);
  const output = path.resolve(resolvedRoot, relative);
  if (path.relative(resolvedRoot, output) !== relative) {
    throw new Error(`Refusing unsafe package path: ${output}`);
  }
  return output;
}

export function resolveMacPackageOutput(mode, root = repositoryRoot) {
  const relative = MAC_PACKAGE_OUTPUTS[mode];
  if (!relative) throw new Error("Package output mode must be development or distribution.");
  return resolvedDescendant(root, relative);
}

export function resolveMacDistributionStaging(root = repositoryRoot) {
  return resolvedDescendant(root, MAC_DISTRIBUTION_STAGING_OUTPUT);
}

export function resolveComputerUseAcceptanceReceipt(root = repositoryRoot) {
  return resolvedDescendant(root, COMPUTER_USE_ACCEPTANCE_RECEIPT);
}

async function infoIfPresent(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function safeRoot(root) {
  const resolvedRoot = path.resolve(root);
  const info = await lstat(resolvedRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Package repository root must be a real directory: ${resolvedRoot}`);
  }
  return { resolvedRoot, canonicalRoot: await realpath(resolvedRoot) };
}

async function inspectDescendant(context, relative, { leaf = "directory", create = false } = {}) {
  const segments = relative.split(path.sep).filter(Boolean);
  let lexical = context.resolvedRoot;
  let canonical = context.canonicalRoot;
  for (let index = 0; index < segments.length; index += 1) {
    lexical = path.join(lexical, segments[index]);
    canonical = path.join(canonical, segments[index]);
    let info = await infoIfPresent(lexical);
    if (!info && create) {
      await mkdir(lexical);
      info = await lstat(lexical);
    }
    if (!info) return { path: lexical, exists: false, context };
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing package path with a symlink component: ${lexical}`);
    }
    const isLeaf = index === segments.length - 1;
    if ((!isLeaf || leaf === "directory") && !info.isDirectory()) {
      throw new Error(`Expected a package directory: ${lexical}`);
    }
    if (isLeaf && leaf === "file" && !info.isFile()) {
      throw new Error(`Expected a regular package evidence file: ${lexical}`);
    }
    const actualCanonical = await realpath(lexical);
    if (actualCanonical !== canonical) {
      throw new Error(`Package path escaped its canonical repository root: ${lexical}`);
    }
  }
  return { path: lexical, exists: true, context };
}

async function removeSafeDirectory(relative, root) {
  const context = await safeRoot(root);
  const inspected = await inspectDescendant(context, relative);
  if (inspected.exists) await rm(inspected.path, { recursive: true });
  return resolvedDescendant(root, relative);
}

async function createSafeDirectory(relative, root) {
  const context = await safeRoot(root);
  return (await inspectDescendant(context, relative, { create: true })).path;
}

export async function invalidateComputerUseAcceptanceReceipt(root = repositoryRoot) {
  const context = await safeRoot(root);
  const inspected = await inspectDescendant(context, COMPUTER_USE_ACCEPTANCE_RECEIPT, {
    leaf: "file",
  });
  if (inspected.exists) await rm(inspected.path);
}

export async function writeComputerUseAcceptanceReceipt(contents, root = repositoryRoot) {
  const context = await safeRoot(root);
  await inspectDescendant(context, path.dirname(COMPUTER_USE_ACCEPTANCE_RECEIPT), { create: true });
  const existing = await inspectDescendant(await safeRoot(root), COMPUTER_USE_ACCEPTANCE_RECEIPT, {
    leaf: "file",
  });
  if (existing.exists)
    throw new Error("Refusing to replace existing Computer Use acceptance evidence.");
  const receipt = resolveComputerUseAcceptanceReceipt(root);
  await writeFile(receipt, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await inspectDescendant(await safeRoot(root), COMPUTER_USE_ACCEPTANCE_RECEIPT, { leaf: "file" });
  return receipt;
}

export async function prepareMacPackageOutput(mode, root = repositoryRoot) {
  const relative = MAC_PACKAGE_OUTPUTS[mode];
  if (!relative) throw new Error("Package output mode must be development or distribution.");
  await removeSafeDirectory(relative, root);
  const output = await createSafeDirectory(relative, root);
  await invalidateComputerUseAcceptanceReceipt(root);
  return output;
}

export async function beginMacDistribution(root = repositoryRoot) {
  await removeSafeDirectory(MAC_PACKAGE_OUTPUTS.distribution, root);
  await removeSafeDirectory(MAC_DISTRIBUTION_STAGING_OUTPUT, root);
  await invalidateComputerUseAcceptanceReceipt(root);
  const staging = await createSafeDirectory(MAC_DISTRIBUTION_STAGING_OUTPUT, root);
  return {
    staging,
    distribution: resolveMacPackageOutput("distribution", root),
  };
}

export async function discardMacDistributionStaging(root = repositoryRoot) {
  await removeSafeDirectory(MAC_DISTRIBUTION_STAGING_OUTPUT, root);
}

export async function promoteMacDistribution(root = repositoryRoot) {
  const context = await safeRoot(root);
  const staging = await inspectDescendant(context, MAC_DISTRIBUTION_STAGING_OUTPUT);
  if (!staging.exists)
    throw new Error("The verified macOS distribution staging directory is missing.");
  const distribution = await inspectDescendant(context, MAC_PACKAGE_OUTPUTS.distribution);
  if (distribution.exists) {
    throw new Error("Refusing to replace a canonical macOS distribution during promotion.");
  }
  const destination = resolveMacPackageOutput("distribution", root);
  await rename(staging.path, destination);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const output = await prepareMacPackageOutput(process.argv[2]);
  console.log(`Prepared fresh macOS ${process.argv[2]} output: ${output}`);
}
