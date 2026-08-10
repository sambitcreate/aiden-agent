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

export async function readRegularFile(filePath: string, maxBytes?: number): Promise<Buffer> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      const error = new Error(`Refusing to read a non-regular file at ${filePath}.`);
      Object.assign(error, { code: "EFTYPE" });
      throw error;
    }
    if (maxBytes !== undefined) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || info.size > maxBytes) {
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
    return handle.readFile();
  } finally {
    await handle.close();
  }
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
