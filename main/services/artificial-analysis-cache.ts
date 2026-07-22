import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseArtificialAnalysisUserCache,
  type ArtificialAnalysisUserCache,
} from "./artificial-analysis-catalog-core.js";
import type { ArtificialAnalysisCacheStore } from "./artificial-analysis-runtime-core.js";

const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

interface FileArtificialAnalysisCacheStoreOptions {
  filePath(): string | Promise<string>;
  maxBytes?: number;
  onInvalid?(error: Error): void;
  onDurabilityWarning?(error: Error): void;
  syncDirectory?(directory: string): Promise<void>;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBoundedFile(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(file, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error("Artificial Analysis cache exceeds Aiden's local size limit.");
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Atomic device-local cache containing normalized public model data, never credentials. */
export class FileArtificialAnalysisCacheStore implements ArtificialAnalysisCacheStore {
  constructor(private readonly options: FileArtificialAnalysisCacheStoreOptions) {}

  private async resolvedFilePath(): Promise<string> {
    return path.resolve(await this.options.filePath());
  }

  private maxBytes(): number {
    const maxBytes = this.options.maxBytes ?? MAX_CACHE_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("Artificial Analysis cache size limit must be positive.");
    }
    return maxBytes;
  }

  async read(): Promise<ArtificialAnalysisUserCache | null> {
    try {
      const value = JSON.parse(
        await readBoundedFile(await this.resolvedFilePath(), this.maxBytes()),
      ) as unknown;
      return parseArtificialAnalysisUserCache(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (!(error as NodeJS.ErrnoException).code && error instanceof Error) {
        this.options.onInvalid?.(error);
        return null;
      }
      throw error;
    }
  }

  async write(cache: ArtificialAnalysisUserCache): Promise<void> {
    const validated = parseArtificialAnalysisUserCache(cache);
    const serialized = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(serialized) > this.maxBytes()) {
      throw new Error("Artificial Analysis cache exceeds Aiden's local size limit.");
    }
    const destination = await this.resolvedFilePath();
    const directory = path.dirname(destination);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await (this.options.syncDirectory ?? syncDirectory)(directory);
    } catch (error) {
      try {
        this.options.onDurabilityWarning?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      } catch {
        // The file is already committed. Diagnostics must not turn success into failure.
      }
    }
  }

  async delete(): Promise<void> {
    await fs.rm(await this.resolvedFilePath(), { force: true });
  }
}
