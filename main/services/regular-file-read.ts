import * as fs from "fs/promises";
import { constants } from "node:fs";

/**
 * Read through an already-open descriptor so a pathname swap cannot turn a
 * validated config/credential file into a blocking FIFO or followed symlink.
 */
function fileTooLarge(filePath: string): Error {
  const error = new Error(`Refusing to read an oversized file at ${filePath}.`);
  Object.assign(error, { code: "EFBIG" });
  return error;
}

export interface RegularFileIdentity {
  device: string;
  inode: string;
}

function identityChanged(filePath: string): Error {
  const error = new Error(`Refusing to read ${filePath}: it is not the expected single-link file.`);
  Object.assign(error, { code: "EIDENTITY" });
  return error;
}

/**
 * With `exclusiveIdentity`, the bytes must come from exactly that inode while
 * it has one link, checked on the opened descriptor before and after reading.
 * Another link could name the inode outside a confined root.
 */
export async function readRegularFile(
  filePath: string,
  maxBytes?: number,
  options: { exclusiveIdentity?: RegularFileIdentity } = {},
): Promise<Buffer> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const expected = options.exclusiveIdentity;
  const verify = async (): Promise<void> => {
    if (!expected) return;
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 ||
        String(current.dev) !== expected.device || String(current.ino) !== expected.inode) {
      throw identityChanged(filePath);
    }
  };
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      const error = new Error(`Refusing to read a non-regular file at ${filePath}.`);
      Object.assign(error, { code: "EFTYPE" });
      throw error;
    }
    await verify();
    const bytes = await readOpenedFile(handle, filePath, info.size, maxBytes);
    await verify();
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readOpenedFile(
  handle: fs.FileHandle,
  filePath: string,
  size: number,
  maxBytes: number | undefined,
): Promise<Buffer> {
  if (maxBytes === undefined) return handle.readFile();
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || size > maxBytes) {
    throw fileTooLarge(filePath);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) throw fileTooLarge(filePath);
  return Buffer.concat(chunks, total);
}

export function decodeUtf8(bytes: Uint8Array): string {
  // Buffer.toString("utf-8") replaces malformed byte sequences with U+FFFD.
  // Config and credential files must instead fail closed so a later write can
  // never turn invalid source bytes into a different, apparently valid file.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export async function readRegularUtf8File(filePath: string): Promise<string> {
  return decodeUtf8(await readRegularFile(filePath));
}
