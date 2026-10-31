import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { formatHarnessBytes } from "../../../renderer/shared/acp-harness.js";
import { BOT_COMPUTER_BASE_DISK_RESERVE_BYTES, BOT_COMPUTER_RESTORE_IMAGE } from "./release.js";
import { BotComputerError } from "./types.js";

export interface RestoreImagePin {
  version: string;
  build: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface RestoreImageProgress {
  phase: "downloading" | "verifying";
  receivedBytes: number;
  totalBytes: number;
}

export interface RestoreImageDownloaderOptions {
  /** `<userData>/bot-computers/restore-images`. */
  dir: string;
  image?: RestoreImagePin;
  fetchImpl?: typeof fetch;
  freeDiskBytes(dir: string): Promise<number>;
  /** Free space the base needs on top of the download. */
  reserveBytes?: number;
  connectTimeoutMs?: number;
  stallTimeoutMs?: number;
  /** Minimum gap between progress reports. */
  progressIntervalMs?: number;
}

export interface RestoreImageDownloader {
  readonly image: RestoreImagePin;
  paths(): { final: string; partial: string };
  /** Bytes already kept from an earlier, interrupted download. */
  partialBytes(): Promise<number>;
  /** Free disk Set up needs now: the rest of the download plus the base. */
  requiredFreeBytes(): Promise<number>;
  /** Download (resuming), verify and return the restore image. Concurrent calls share one download. */
  download(options?: { onProgress?(progress: RestoreImageProgress): void }): Promise<string>;
  /** Stop the download; the partial is kept for the next attempt. */
  cancel(): void;
  /** Stop and delete the restore image and any partial. */
  remove(): Promise<void>;
}

const CANCELLED = "Setting up Bot computers was cancelled.";

async function sizeOf(file: string): Promise<number> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

async function sha256(file: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    if (signal.aborted) throw new BotComputerError("cancelled", CANCELLED);
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/**
 * The pinned macOS restore image, fetched only from its fixed URL after the
 * person chose Set up or Update base. Redirects are refused, a `.part` file is
 * kept across launches and resumed with `Range`, the size is capped at the
 * pin, and nothing is used before its SHA-256 matches.
 */
export function createRestoreImageDownloader(options: RestoreImageDownloaderOptions): RestoreImageDownloader {
  const image = options.image ?? BOT_COMPUTER_RESTORE_IMAGE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const reserve = options.reserveBytes ?? BOT_COMPUTER_BASE_DISK_RESERVE_BYTES;
  const connectMs = options.connectTimeoutMs ?? 30_000;
  const stallMs = options.stallTimeoutMs ?? 60_000;
  const progressMs = options.progressIntervalMs ?? 250;
  if (!/^[A-Za-z0-9]+$/u.test(image.build)) throw new Error("The restore image build is malformed.");
  const final = path.join(options.dir, `UniversalMac_${image.build}_Restore.ipsw`);
  const partial = `${final}.part`;
  let active: { controller: AbortController; promise: Promise<string> } | undefined;

  async function requiredFreeBytes(): Promise<number> {
    if ((await sizeOf(final)) === image.bytes) return reserve;
    return Math.max(0, image.bytes - (await sizeOf(partial))) + reserve;
  }

  async function verify(file: string, signal: AbortSignal, emit: (progress: RestoreImageProgress) => void): Promise<boolean> {
    emit({ phase: "verifying", receivedBytes: image.bytes, totalBytes: image.bytes });
    if ((await sizeOf(file)) !== image.bytes) return false;
    return (await sha256(file, signal)) === image.sha256;
  }

  async function fetchInto(have: number, controller: AbortController, emit: (progress: RestoreImageProgress) => void): Promise<void> {
    let reason: "connect" | "stall" | "oversize" | undefined;
    const abortFor = (why: "connect" | "stall" | "oversize") => {
      reason ??= why;
      controller.abort(why);
    };
    const failure = (error: unknown): Error => {
      if (controller.signal.reason === CANCELLED) return new BotComputerError("cancelled", CANCELLED);
      if (reason === "connect") return new BotComputerError("download_failed", "Apple's download server didn't answer. Try again later.");
      if (reason === "stall") return new BotComputerError("download_failed", "The macOS download stalled. Choose Set up to resume it.");
      if (reason === "oversize") return new BotComputerError("download_failed", "The macOS download was larger than expected, so Aiden stopped it.");
      if (error instanceof BotComputerError) return error;
      return new BotComputerError("download_failed", "The macOS download was interrupted. Choose Set up to resume it.");
    };
    const connectTimer = setTimeout(() => abortFor("connect"), connectMs);
    let response: Response;
    try {
      response = await fetchImpl(image.url, {
        signal: controller.signal,
        // The pinned URL is the only source; a redirect is a reason to stop.
        redirect: "error",
        headers: have > 0 ? { Range: `bytes=${have}-` } : undefined,
      });
    } catch (error) {
      throw failure(error);
    } finally {
      clearTimeout(connectTimer);
    }
    let start = 0;
    if (response.status === 206) {
      const match = /^bytes (\d+)-/u.exec(response.headers.get("content-range") ?? "");
      if (!match || Number(match[1]) !== have) {
        await response.body?.cancel().catch(() => undefined);
        await rm(partial, { force: true });
        throw new BotComputerError("download_failed", "The download server resumed at the wrong place. Choose Set up to start again.");
      }
      start = have;
    } else if (response.status === 416) {
      // Nothing left to send: verification decides whether the partial is whole.
      await response.body?.cancel().catch(() => undefined);
      return;
    } else if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new BotComputerError("download_failed", `The macOS download failed (HTTP ${response.status}).`);
    }
    // A 200 answer to a Range request restarts from zero.
    if (!response.body) throw new BotComputerError("download_failed", "The macOS download returned nothing.");
    const file = createWriteStream(partial, { flags: start > 0 ? "a" : "w", mode: 0o600 });
    const fileError = new Promise<never>((_, reject) =>
      file.once("error", () => reject(new BotComputerError("download_failed", "Aiden couldn't write the macOS download to disk."))),
    );
    fileError.catch(() => undefined);
    const reader = response.body.getReader();
    let received = start;
    let lastEmit = 0;
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => abortFor("stall"), stallMs);
    };
    emit({ phase: "downloading", receivedBytes: received, totalBytes: image.bytes });
    try {
      armStall();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), fileError]);
        if (done) break;
        armStall();
        const chunk = Buffer.from(value);
        if (received + chunk.length > image.bytes) {
          abortFor("oversize");
          throw new BotComputerError("download_failed", "oversize");
        }
        if (!file.write(chunk)) await Promise.race([new Promise<void>((resolve) => file.once("drain", resolve)), fileError]);
        received += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= progressMs) {
          lastEmit = now;
          emit({ phase: "downloading", receivedBytes: received, totalBytes: image.bytes });
        }
      }
      clearTimeout(stallTimer);
      file.end();
      await Promise.race([finished(file), fileError]);
      emit({ phase: "downloading", receivedBytes: received, totalBytes: image.bytes });
      if (received < image.bytes) {
        // The server ended cleanly but early; the partial resumes next time.
        throw new BotComputerError("download_failed", "The macOS download ended early. Choose Set up to resume it.");
      }
    } catch (error) {
      throw failure(error);
    } finally {
      clearTimeout(stallTimer);
      await reader.cancel().catch(() => undefined);
      if (!file.closed) {
        file.end();
        await finished(file).catch(() => undefined);
      }
      if (reason === "oversize") await rm(partial, { force: true });
    }
  }

  async function perform(controller: AbortController, onProgress?: (progress: RestoreImageProgress) => void): Promise<string> {
    const emit = (progress: RestoreImageProgress) => {
      try {
        onProgress?.(progress);
      } catch {
        // Progress is advisory.
      }
    };
    await mkdir(options.dir, { recursive: true, mode: 0o700 });
    if ((await sizeOf(final)) === image.bytes) {
      if (await verify(final, controller.signal, emit)) return final;
      await rm(final, { force: true });
    }
    let have = await sizeOf(partial);
    if (have > image.bytes) {
      await rm(partial, { force: true });
      have = 0;
    }
    const required = Math.max(0, image.bytes - have) + reserve;
    const free = await options.freeDiskBytes(options.dir);
    if (free < required) {
      throw new BotComputerError(
        "low_disk",
        `Setting up Bot computers needs about ${formatHarnessBytes(required)} of free disk space; this Mac has ${formatHarnessBytes(free)}. Free up space and try again.`,
      );
    }
    if (controller.signal.aborted) throw new BotComputerError("cancelled", CANCELLED);
    if (have < image.bytes) await fetchInto(have, controller, emit);
    if (!(await verify(partial, controller.signal, emit))) {
      await rm(partial, { force: true });
      throw new BotComputerError(
        "download_failed",
        "The macOS download didn't match Aiden's pinned copy, so it was deleted. Choose Set up to download it again.",
      );
    }
    await rename(partial, final);
    return final;
  }

  return {
    image,
    paths: () => ({ final, partial }),
    partialBytes: () => sizeOf(partial),
    requiredFreeBytes,
    download(downloadOptions = {}) {
      if (active) return active.promise;
      const controller = new AbortController();
      const promise = perform(controller, downloadOptions.onProgress).finally(() => {
        if (active?.controller === controller) active = undefined;
      });
      active = { controller, promise };
      return promise;
    },
    cancel() {
      active?.controller.abort(CANCELLED);
    },
    async remove() {
      const current = active;
      current?.controller.abort(CANCELLED);
      await current?.promise.catch(() => undefined);
      await rm(final, { force: true });
      await rm(partial, { force: true });
    },
  };
}
