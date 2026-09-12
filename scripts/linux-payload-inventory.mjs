/**
 * Complete deterministic inventory of a trusted, quiescent staging tree.
 * This is NOT publisher authentication, immutable installation, or a TOCTOU
 * security boundary. The expected inventory needs an independent trust anchor.
 */
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

export const LINUX_PAYLOAD_INVENTORY_LIMITS = Object.freeze({
  entries: 100_000,
  depth: 64,
  pathBytes: 4096,
  fileBytes: 8 * 1024 ** 3,
  totalBytes: 64 * 1024 ** 3,
  manifestBytes: 32 * 1024 ** 2,
});
const CHUNK_BYTES = 1024 ** 2;
const stableFields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];

function fail(message) { throw new Error(`Linux payload inventory: ${message}`); }
function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail(`invalid ${label} fields`);
}
function controlCharacters(value) {
  return [...value].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}
function relativePath(value, rootAllowed = false) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > LINUX_PAYLOAD_INVENTORY_LIMITS.pathBytes ||
      controlCharacters(value) || /[\\\ufffd]/u.test(value)) fail("invalid entry path");
  if (rootAllowed && value === ".") return;
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..") ||
      parts.length > LINUX_PAYLOAD_INVENTORY_LIMITS.depth) fail("noncanonical or too-deep entry path");
}
function absolutePath(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > LINUX_PAYLOAD_INVENTORY_LIMITS.pathBytes || !path.isAbsolute(value) || path.resolve(value) !== value ||
      controlCharacters(value)) fail("use an absolute canonical filesystem path");
  return value;
}
async function directoryChain(value) {
  absolutePath(value);
  let current = path.parse(value).root;
  for (const component of ["", ...value.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) fail("directory path or ancestor is a link or non-directory");
  }
}
function regularFile(info) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) fail("expected a regular file with exactly one hard link");
}
function stable(before, after) {
  if (stableFields.some(field => before[field] !== after[field])) fail("entry changed during inventory; quiescent tree required");
}
async function readBoundedFile(file, maximum, consume) {
  const before = await lstat(file, { bigint: true });
  regularFile(before);
  if (before.size > BigInt(maximum)) fail("file exceeds size limit");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    regularFile(opened);
    stable(before, opened);
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maximum || BigInt(size) > before.size) fail("file grew during inventory or exceeds size limit");
      consume(buffer.subarray(0, bytesRead));
    }
    if (BigInt(size) !== before.size) fail("file changed size during inventory");
    stable(before, await handle.stat({ bigint: true }));
    stable(before, await lstat(file, { bigint: true }));
    return before;
  } finally { await handle.close(); }
}

export function validateLinuxPayloadInventory(value) {
  exactKeys(value, ["schemaVersion", "hashAlgorithm", "entries"], "inventory");
  if (value.schemaVersion !== 1 || value.hashAlgorithm !== "sha256" || !Array.isArray(value.entries) ||
      value.entries.length < 1 || value.entries.length > LINUX_PAYLOAD_INVENTORY_LIMITS.entries) fail("unsupported schema or entry count");
  const paths = new Map();
  let total = 0;
  let encodingBudget = 128;
  let previous;
  for (const [index, entry] of value.entries.entries()) {
    const file = entry?.type === "file";
    exactKeys(entry, file ? ["path", "type", "mode", "size", "sha256"] : ["path", "type", "mode"], "entry");
    if (!file && entry.type !== "directory") fail("unsupported entry type");
    relativePath(entry.path, index === 0);
    if (index === 0 && (entry.path !== "." || file)) fail("first entry must be the root directory");
    if (paths.has(entry.path) || (index > 1 && entry.path <= previous)) fail("duplicate or unsorted entry paths");
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) fail("invalid permission mode");
    if (index > 0) {
      const parent = path.posix.dirname(entry.path);
      if (paths.get(parent) !== "directory") fail("missing directory parent");
    }
    if (file) {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > LINUX_PAYLOAD_INVENTORY_LIMITS.fileBytes ||
          typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) fail("invalid file size or SHA-256");
      total += entry.size;
      if (total > LINUX_PAYLOAD_INVENTORY_LIMITS.totalBytes) fail("payload exceeds total size limit");
    }
    // Reserve bounded space before serializing the complete document. 64 bytes
    // per entry conservatively covers indentation and JSON separators.
    encodingBudget += Buffer.byteLength(JSON.stringify(entry)) + 64;
    if (encodingBudget > LINUX_PAYLOAD_INVENTORY_LIMITS.manifestBytes) fail("manifest exceeds size limit");
    previous = entry.path;
    paths.set(entry.path, entry.type);
  }
  return value;
}

export function serializeLinuxPayloadInventory(inventory) {
  validateLinuxPayloadInventory(inventory);
  const entries = inventory.entries.map(entry => entry.type === "directory"
    ? { path: entry.path, type: entry.type, mode: entry.mode }
    : { path: entry.path, type: entry.type, mode: entry.mode, size: entry.size, sha256: entry.sha256 });
  const serialized = `${JSON.stringify({ schemaVersion: 1, hashAlgorithm: "sha256", entries }, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > LINUX_PAYLOAD_INVENTORY_LIMITS.manifestBytes) fail("manifest exceeds size limit");
  return serialized;
}

export async function computeLinuxPayloadInventory(root) {
  absolutePath(root);
  await directoryChain(root);
  const entries = [];
  let total = 0;
  let encodingBudget = 128;
  const addEntry = entry => {
    encodingBudget += Buffer.byteLength(JSON.stringify(entry)) + 64;
    if (encodingBudget > LINUX_PAYLOAD_INVENTORY_LIMITS.manifestBytes) fail("manifest exceeds size limit");
    entries.push(entry);
  };
  const visit = async relative => {
    relativePath(relative, relative === ".");
    if (entries.length >= LINUX_PAYLOAD_INVENTORY_LIMITS.entries) fail("too many entries");
    const file = relative === "." ? root : path.join(root, relative);
    const before = await lstat(file, { bigint: true });
    const mode = Number(before.mode & 0o7777n);
    if (before.isSymbolicLink()) fail("symbolic links are not supported");
    if (before.isDirectory()) {
      addEntry({ path: relative, type: "directory", mode });
      const directory = await opendir(file);
      // opendir iteration bounds the directory listing instead of loading it all.
      for await (const child of directory) {
        await visit(relative === "." ? child.name : `${relative}/${child.name}`);
      }
      stable(before, await lstat(file, { bigint: true }));
    } else {
      regularFile(before);
      if (before.size > BigInt(LINUX_PAYLOAD_INVENTORY_LIMITS.fileBytes)) fail("file exceeds size limit");
      total += Number(before.size);
      if (total > LINUX_PAYLOAD_INVENTORY_LIMITS.totalBytes) fail("payload exceeds total size limit");
      const hash = createHash("sha256");
      const readInfo = await readBoundedFile(file, LINUX_PAYLOAD_INVENTORY_LIMITS.fileBytes, chunk => hash.update(chunk));
      stable(before, readInfo);
      addEntry({ path: relative, type: "file", mode, size: Number(before.size), sha256: hash.digest("hex") });
    }
  };
  await visit(".");
  const [rootEntry, ...children] = entries;
  children.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const inventory = { schemaVersion: 1, hashAlgorithm: "sha256", entries: [rootEntry, ...children] };
  serializeLinuxPayloadInventory(inventory); // Validate all bounds, including encoded size.
  return inventory;
}

export async function verifyLinuxPayloadInventory(root, expected) {
  const serialized = serializeLinuxPayloadInventory(expected);
  const actual = await computeLinuxPayloadInventory(root);
  if (serializeLinuxPayloadInventory(actual) !== serialized) fail("payload does not match the expected inventory");
  return actual;
}

async function externalManifestPath(root, manifest) {
  absolutePath(root); absolutePath(manifest);
  await directoryChain(root);
  await directoryChain(path.dirname(manifest));
  const relative = path.relative(root, manifest);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) fail("manifest must be outside the payload tree");
}
export async function writeLinuxPayloadInventory(root, manifest) {
  await externalManifestPath(root, manifest);
  const inventory = await computeLinuxPayloadInventory(root);
  const bytes = serializeLinuxPayloadInventory(inventory);
  // Exclusive creation refuses both existing files and links; never overwrite.
  const output = await open(manifest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await output.writeFile(bytes); await output.sync(); }
  finally { await output.close(); }
  return inventory;
}
export async function verifyLinuxPayloadInventoryFile(root, manifest) {
  await externalManifestPath(root, manifest);
  const chunks = [];
  await readBoundedFile(manifest, LINUX_PAYLOAD_INVENTORY_LIMITS.manifestBytes, chunk => chunks.push(Buffer.from(chunk)));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return verifyLinuxPayloadInventory(root, JSON.parse(text));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root, manifest, ...extra] = process.argv.slice(2);
  if (extra.length || !root || !manifest || !["compute", "verify"].includes(command)) {
    process.stderr.write("Usage: node scripts/linux-payload-inventory.mjs compute|verify /absolute/payload /absolute/external.json\n");
    process.exitCode = 2;
  } else {
    try {
      if (command === "compute") await writeLinuxPayloadInventory(root, manifest);
      else await verifyLinuxPayloadInventoryFile(root, manifest);
      process.stdout.write(`${command === "compute" ? "Computed" : "Matched"} payload inventory; authenticity and immutable installation are not established.\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
