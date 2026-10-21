// Production side of the Bot computer screen (plan §8.5): Electron's
// `nativeImage` encodes frames (passed in by `bot-computers-main.ts`, so this
// module loads without Electron), and each run's screen is a VNC connection
// to the loopback port Lume reports. Main keeps the password and the socket;
// the renderer only ever sees JPEG frames through the viewer hub.
//
// `AIDEN_BOT_COMPUTERS_RECORD_RFB=1` (owner-Mac fixture recording only) also
// writes the first 32 MiB the VNC server sends on each connection to
// `<userData>/bot-computers/rfb-recordings/<vm>-<time>.bin`, mode 0600. Server
// bytes carry no password; they do show the guest's screen.

import * as nodeFs from "node:fs";
import { connect, type Socket } from "node:net";
import path from "node:path";

import type { NativeImage } from "electron";

import { connectRfb, type RfbClient } from "./rfb-client.js";
import { createRfbScreen, type BotComputerImageEncoder } from "./rfb-screen.js";
import { BotComputerError, type BotComputerConnection, type BotComputerScreenFactory } from "./types.js";

/** BGRA pixels to PNG or JPEG with Electron's `nativeImage`, scaled down to at most `maxWidth` wide. */
export function nativeImageEncoder(native: {
  createFromBitmap(buffer: Buffer, options: { width: number; height: number }): NativeImage;
}): BotComputerImageEncoder {
  return async (bgra, width, height, format, quality, maxWidth) => {
    let image = native.createFromBitmap(bgra, { width, height });
    if (width > maxWidth) image = image.resize({ width: maxWidth, quality: "good" });
    const size = image.getSize();
    return { image: format === "png" ? image.toPNG() : image.toJPEG(quality), width: size.width, height: size.height };
  };
}

const RECORDING_LIMIT_BYTES = 32 * 1_048_576;

/** The file calls a recording makes; tests stand in a disk that fills up. */
export type RfbRecordingFs = Pick<typeof nodeFs, "mkdirSync" | "openSync" | "writeSync" | "closeSync">;

/**
 * Tees what the server sends into a 0600 file, up to the limit. A write the
 * disk refuses (full, or an I/O error) ends the recording, never the screen:
 * it runs inside the socket's data handler, where a throw would be uncaught.
 */
function recordServerBytes(socket: Socket, file: string, fs: RfbRecordingFs, log: (message: string, error?: unknown) => void): void {
  let fd: number | undefined;
  let written = 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    log("Could not open an RFB recording.", error);
    return;
  }
  const finish = () => {
    if (fd === undefined) return;
    const open = fd;
    fd = undefined;
    try {
      fs.closeSync(open);
    } catch (error) {
      log("Could not close an RFB recording.", error);
    }
  };
  socket.on("data", (chunk: Buffer) => {
    if (fd === undefined) return;
    const slice = chunk.subarray(0, Math.max(0, RECORDING_LIMIT_BYTES - written));
    if (slice.length > 0) {
      try {
        fs.writeSync(fd, slice);
      } catch (error) {
        log("The RFB recording stopped: the disk refused a write.", error);
        finish();
        return;
      }
      written += slice.length;
    }
    if (written >= RECORDING_LIMIT_BYTES) finish();
  });
  socket.once("close", finish);
}

export interface RfbScreenFactoryOptions {
  encode: BotComputerImageEncoder;
  /** Where owner-Mac recordings go; recording is off without it. */
  recordingsDir?: string;
  /** The recording's file calls (node:fs by default). */
  recordingFs?: RfbRecordingFs;
  log?(message: string, error?: unknown): void;
  now?(): number;
}

/** Opens one VNC connection to this run's loopback server. */
function openVnc(connection: BotComputerConnection, options: RfbScreenFactoryOptions, signal?: AbortSignal): Promise<RfbClient> {
  // Lume reports loopback; the host already refused a VM whose port answers anywhere else.
  if (connection.vnc.host !== "127.0.0.1") {
    return Promise.reject(new BotComputerError("vnc_not_loopback", "The computer's screen isn't on this Mac's loopback address."));
  }
  const socket = connect({ host: "127.0.0.1", port: connection.vnc.port });
  socket.setNoDelay(true);
  if (options.recordingsDir) {
    const stamp = new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/gu, "-");
    recordServerBytes(
      socket,
      path.join(options.recordingsDir, `${connection.vmName}-${stamp}.bin`),
      options.recordingFs ?? nodeFs,
      options.log ?? (() => undefined),
    );
  }
  return connectRfb(socket, { password: connection.vnc.password, signal });
}

/** The screen factory P8's sessions call once per computer run. */
export function createRfbScreenFactory(options: RfbScreenFactoryOptions): BotComputerScreenFactory {
  return (connection, signal) =>
    createRfbScreen({ connect: (connectSignal) => openVnc(connection, options, connectSignal), encode: options.encode }, signal);
}
