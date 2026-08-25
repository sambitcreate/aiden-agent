import { spawn } from "node:child_process";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { BotInboundAttachmentHomeLease } from "./bot-inbound-attachment-home.js";
import { MAX_TELEGRAM_DOWNLOAD_BYTES } from "./telegram/telegram-inbound.js";

const SAFE_PROFILE = /^[A-Za-z0-9._-]{1,120}$/u;
const SAFE_LEAF = /^[A-Za-z0-9._-]{1,200}$/u;
const DECIMAL_IDENTITY = /^(?:0|[1-9][0-9]*)$/u;
const MAX_DIAGNOSTIC_BYTES = 4_096;

export interface BotInboxWriterRuntimePaths {
  defaultApp: boolean;
  resourcesPath?: string;
  cwd: string;
}

export interface BotInboxWriterTestControl {
  readonly binary: string;
  afterInboxPinned(): void | Promise<void>;
  beforeExit(): void | Promise<void>;
}

export function resolveBotInboxWriterBinary(
  runtime: BotInboxWriterRuntimePaths = {
    defaultApp: process.defaultApp === true,
    resourcesPath:
      typeof process.resourcesPath === "string" ? process.resourcesPath : undefined,
    cwd: process.cwd(),
  },
): string {
  if (
    runtime.defaultApp !== true &&
    typeof runtime.resourcesPath === "string" &&
    runtime.resourcesPath.length > 0
  ) {
    return path.resolve(
      runtime.resourcesPath,
      "..",
      "Helpers",
      "aiden-bot-inbox-writer",
    );
  }
  return path.resolve(runtime.cwd, "build", "native", "aiden-bot-inbox-writer");
}

function safeComponent(value: string, pattern: RegExp): string {
  if (!pattern.test(value) || value === "." || value === "..") {
    throw new Error("This Bot's Telegram inbox has an unsafe path component.");
  }
  return value;
}

function boundedOutput(stream: Readable): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (value: Buffer | string) => {
      if (size >= MAX_DIAGNOSTIC_BYTES) return;
      const chunk = Buffer.from(value);
      const accepted = chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - size);
      chunks.push(accepted);
      size += accepted.byteLength;
    });
    stream.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function writeBytes(stream: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(Buffer.from(bytes), (error?: Error | null) => {
      stream.off("error", reject);
      if (error) reject(error);
      else resolve();
    });
  });
}

function oneByte(stream: Readable, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      cleanup();
      const bytes = Buffer.from(chunk);
      if (bytes.byteLength === 1 && bytes.toString("ascii") === expected) resolve();
      else reject(new Error("The Bot inbox writer test handshake failed."));
    };
    const onFailure = () => {
      cleanup();
      reject(new Error("The Bot inbox writer test handshake ended early."));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onFailure);
      stream.off("error", onFailure);
    };
    stream.once("data", onData);
    stream.once("end", onFailure);
    stream.once("error", onFailure);
  });
}

/**
 * Writes one Telegram download beneath the exact managed-home inode. Node does
 * not create or open any inbox pathname: the native helper performs the whole
 * traversal with mkdirat/openat relative to retained no-follow directory FDs.
 */
export async function writeBotInboundAttachment(input: {
  home: BotInboundAttachmentHomeLease;
  profile: string;
  leaf: string;
  bytes: Uint8Array;
  testControl?: BotInboxWriterTestControl;
}): Promise<string> {
  const profile = safeComponent(input.profile, SAFE_PROFILE);
  const leaf = safeComponent(input.leaf, SAFE_LEAF);
  if (
    !path.isAbsolute(input.home.homePath) ||
    !DECIMAL_IDENTITY.test(input.home.identity.device) ||
    !DECIMAL_IDENTITY.test(input.home.identity.inode) ||
    input.bytes.byteLength > MAX_TELEGRAM_DOWNLOAD_BYTES
  ) {
    throw new Error("This Bot's Telegram attachment cannot be stored safely.");
  }
  await input.home.revalidateBeforeEffect();

  const command = input.testControl?.binary ?? resolveBotInboxWriterBinary();
  const child = spawn(
    command,
    [
      "--home",
      input.home.homePath,
      "--device",
      input.home.identity.device,
      "--inode",
      input.home.identity.inode,
      "--profile",
      profile,
      "--leaf",
      leaf,
      "--size",
      String(input.bytes.byteLength),
    ],
    {
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C",
        LC_ALL: "C",
        ...(input.testControl
          ? { AIDEN_BOT_INBOX_WRITER_TEST_HANDSHAKE: "1" }
          : {}),
      },
      stdio: input.testControl
        ? ["pipe", "pipe", "pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
    },
  );
  const stdout = boundedOutput(child.stdout);
  const stderr = boundedOutput(child.stderr);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );

  try {
    const writing = writeBytes(child.stdin, input.bytes);
    if (input.testControl) {
      const ready = child.stdio[3];
      const resume = child.stdio[4];
      if (!ready || !resume || !("write" in resume)) {
        throw new Error("The Bot inbox writer test handshake is unavailable.");
      }
      await oneByte(ready as Readable, "R");
      await input.testControl.afterInboxPinned();
      (resume as Writable).write("R");
      await oneByte(ready as Readable, "D");
      await input.testControl.beforeExit();
      (resume as Writable).end("D");
    }
    await writing;
    const result = await closed;
    const [output, diagnostic] = await Promise.all([stdout, stderr]);
    if (result.code !== 0 || result.signal !== null || output !== "ok\n") {
      throw new Error(
        diagnostic.trim() || "This Bot's Telegram attachment could not be stored safely.",
      );
    }
    await input.home.revalidateBeforeEffect();
    return path.join(
      input.home.homePath,
      ".aiden",
      "telegram-inbox",
      profile,
      leaf,
    );
  } catch (cause) {
    child.kill("SIGKILL");
    await closed.catch(() => undefined);
    throw cause;
  }
}
