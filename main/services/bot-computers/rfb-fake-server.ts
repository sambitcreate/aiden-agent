/**
 * A loopback RFB server for tests (P9's viewer and screen tests, and the
 * Bot-computers integration test). It speaks just enough RFB 3.3/3.7/3.8 to
 * stand in for a Bot computer's VNC server:
 *
 * - None or VNC auth, checking the response with OpenSSL's DES (an oracle
 *   independent of `vnc-des.ts`);
 * - ServerInit in a chosen native pixel format, honouring SetPixelFormat for
 *   any 32-bit true-colour format;
 * - Raw full updates on request, held incremental updates answered by
 *   `paint`, CopyRect through `copy`, and DesktopSize through `resize`;
 * - pointer and key events recorded in order.
 *
 * Not production code: nothing outside tests imports it.
 */

import { createCipheriv, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

export interface FakeRfbPixelFormat {
  bigEndian: boolean;
  redShift: number;
  greenShift: number;
  blueShift: number;
}

export interface FakeRfbServerOptions {
  width?: number;
  height?: number;
  /**
   * Set: VNC auth with this password, or with what the function returns when a
   * client connects (a computer run's password). Unset: security None.
   */
  password?: string | (() => string | undefined);
  version?: "3.3" | "3.7" | "3.8";
  name?: string;
  /** The pixel format ServerInit announces; default BGRX little-endian. */
  nativeFormat?: FakeRfbPixelFormat;
}

export interface FakeRfbConnection {
  /** Every SetPixelFormat, SetEncodings and update request, in order. */
  setPixelFormats: FakeRfbPixelFormat[];
  encodings: number[][];
  /** `at` is when the request arrived (ms since the epoch). */
  updateRequests: { incremental: boolean; at: number }[];
  pointer: { x: number; y: number; buttons: number }[];
  keys: { keysym: number; down: boolean }[];
  authenticated: boolean;
  socket: Socket;
}

type Rgb = readonly [number, number, number];

const DEFAULT_FORMAT: FakeRfbPixelFormat = { bigEndian: false, redShift: 16, greenShift: 8, blueShift: 0 };

function opensslDesKey(password: string): Buffer {
  const bytes = Buffer.from(password, "utf8");
  const key = Buffer.alloc(8);
  for (let index = 0; index < 8 && index < bytes.length; index += 1) {
    key[index] = parseInt(bytes[index].toString(2).padStart(8, "0").split("").reverse().join(""), 2);
  }
  return key;
}

function expectedResponse(password: string, challenge: Buffer): Buffer {
  const key = opensslDesKey(password);
  const cipher = createCipheriv("des-ede3-ecb", Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

export class FakeRfbServer {
  readonly connections: FakeRfbConnection[] = [];
  /** Packed RGB per pixel, the truth the client's framebuffer must match. */
  private pixels: Rgb[];
  private width: number;
  private height: number;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly formats = new Map<Socket, FakeRfbPixelFormat>();
  private readonly encodingsBySocket = new Map<Socket, number[]>();
  private readonly pendingIncremental = new Set<Socket>();
  /** Areas changed since a client's last update, sent with its next incremental request. */
  private readonly dirty = new Map<Socket, { x: number; y: number; width: number; height: number }[]>();
  private readonly options: Required<Omit<FakeRfbServerOptions, "password">> & Pick<FakeRfbServerOptions, "password">;

  constructor(options: FakeRfbServerOptions = {}) {
    this.options = {
      width: options.width ?? 64,
      height: options.height ?? 48,
      version: options.version ?? "3.8",
      name: options.name ?? "aiden-fake",
      nativeFormat: options.nativeFormat ?? DEFAULT_FORMAT,
      ...(options.password !== undefined ? { password: options.password } : {}),
    };
    this.width = this.options.width;
    this.height = this.options.height;
    this.pixels = Array.from({ length: this.width * this.height }, () => [0, 0, 0] as const);
  }

  async listen(): Promise<number> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  /** The colour the server holds at a pixel. */
  pixel(x: number, y: number): Rgb {
    return this.pixels[y * this.width + x];
  }

  /**
   * Paints a rectangle. A client with an incremental request waiting gets it
   * at once as Raw; any other client gets it with its next incremental request,
   * as a real server remembers what changed in between.
   */
  paint(rect: { x: number; y: number; width: number; height: number }, rgb: Rgb): void {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) this.pixels[y * this.width + x] = rgb;
    }
    this.changed(rect);
  }

  /** Copies a block on the server: a CopyRect to clients waiting now, the copied pixels to the rest later. */
  copy(source: { x: number; y: number }, rect: { x: number; y: number; width: number; height: number }): void {
    const block = [];
    for (let y = 0; y < rect.height; y += 1) {
      for (let x = 0; x < rect.width; x += 1) block.push(this.pixels[(source.y + y) * this.width + source.x + x]);
    }
    for (let y = 0; y < rect.height; y += 1) {
      for (let x = 0; x < rect.width; x += 1) this.pixels[(rect.y + y) * this.width + rect.x + x] = block[y * rect.width + x];
    }
    for (const socket of this.sockets) {
      if (this.pendingIncremental.delete(socket)) this.sendRects(socket, [{ kind: "copy", rect, source }]);
      else this.dirty.set(socket, [...(this.dirty.get(socket) ?? []), rect]);
    }
  }

  private changed(rect: { x: number; y: number; width: number; height: number }): void {
    for (const socket of this.sockets) {
      if (this.pendingIncremental.delete(socket)) this.sendRects(socket, [{ kind: "raw", rect }]);
      else this.dirty.set(socket, [...(this.dirty.get(socket) ?? []), rect]);
    }
  }

  /** Resizes the screen (to black) and tells clients that asked for DesktopSize. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.pixels = Array.from({ length: width * height }, () => [0, 0, 0] as const);
    for (const socket of this.sockets) {
      this.dirty.delete(socket);
      if (!this.encodingsBySocket.get(socket)?.includes(-223)) continue;
      this.pendingIncremental.delete(socket);
      this.sendRects(socket, [{ kind: "size", rect: { x: 0, y: 0, width, height } }]);
    }
  }

  /** Sends raw bytes to every client, for malformed-input tests. */
  sendRaw(bytes: Buffer): void {
    for (const socket of this.sockets) socket.write(bytes);
  }

  /** Drops every client connection, as a stopping VM does. */
  dropClients(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async close(): Promise<void> {
    this.dropClients();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.pendingIncremental.delete(socket);
      this.dirty.delete(socket);
    });
    socket.on("error", () => undefined);
    const connection: FakeRfbConnection = {
      setPixelFormats: [],
      encodings: [],
      updateRequests: [],
      pointer: [],
      keys: [],
      authenticated: false,
      socket,
    };
    this.connections.push(connection);
    this.formats.set(socket, this.options.nativeFormat);
    let buffer = Buffer.alloc(0);
    let stage: "version" | "security" | "auth" | "init" | "messages" = "version";
    const minor = this.options.version === "3.3" ? 3 : this.options.version === "3.7" ? 7 : 8;
    const challenge = randomBytes(16);
    const password = typeof this.options.password === "function" ? this.options.password() : this.options.password;
    const securityType = password === undefined ? 1 : 2;
    socket.write(`RFB 003.00${minor}\n`);

    const ok = () => {
      connection.authenticated = true;
      stage = "init";
    };
    const refuse = (reason: string) => {
      const result = Buffer.alloc(4);
      result.writeUInt32BE(1, 0);
      const parts = [result];
      if (minor === 8) {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(Buffer.byteLength(reason), 0);
        parts.push(length, Buffer.from(reason));
      }
      socket.end(Buffer.concat(parts));
    };
    const afterSecurityChosen = () => {
      if (securityType === 2) {
        socket.write(challenge);
        stage = "auth";
        return;
      }
      if (minor === 8) socket.write(Buffer.from([0, 0, 0, 0]));
      ok();
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === "version") {
          if (buffer.length < 12) return;
          buffer = buffer.subarray(12);
          if (minor === 3) {
            const type = Buffer.alloc(4);
            type.writeUInt32BE(securityType, 0);
            socket.write(type);
            afterSecurityChosen();
          } else {
            socket.write(Buffer.from([1, securityType]));
            stage = "security";
          }
          continue;
        }
        if (stage === "security") {
          if (buffer.length < 1) return;
          const chosen = buffer[0];
          buffer = buffer.subarray(1);
          if (chosen !== securityType) {
            socket.destroy();
            return;
          }
          afterSecurityChosen();
          continue;
        }
        if (stage === "auth") {
          if (buffer.length < 16) return;
          const response = buffer.subarray(0, 16);
          buffer = buffer.subarray(16);
          if (!response.equals(expectedResponse(password!, challenge))) {
            refuse("Authentication failed");
            return;
          }
          socket.write(Buffer.from([0, 0, 0, 0]));
          ok();
          continue;
        }
        if (stage === "init") {
          if (buffer.length < 1) return;
          buffer = buffer.subarray(1);
          socket.write(this.serverInit());
          stage = "messages";
          continue;
        }
        const consumed = this.message(socket, connection, buffer);
        if (consumed === 0) return;
        buffer = buffer.subarray(consumed);
      }
    });
  }

  private serverInit(): Buffer {
    const name = Buffer.from(this.options.name);
    const init = Buffer.alloc(24);
    init.writeUInt16BE(this.width, 0);
    init.writeUInt16BE(this.height, 2);
    const format = this.options.nativeFormat;
    init[4] = 32;
    init[5] = 24;
    init[6] = format.bigEndian ? 1 : 0;
    init[7] = 1;
    init.writeUInt16BE(255, 8);
    init.writeUInt16BE(255, 10);
    init.writeUInt16BE(255, 12);
    init[14] = format.redShift;
    init[15] = format.greenShift;
    init[16] = format.blueShift;
    init.writeUInt32BE(name.length, 20);
    return Buffer.concat([init, name]);
  }

  /** Bytes consumed by one client message, or 0 when it is incomplete. */
  private message(socket: Socket, connection: FakeRfbConnection, buffer: Buffer): number {
    if (buffer.length < 1) return 0;
    switch (buffer[0]) {
      case 0: {
        if (buffer.length < 20) return 0;
        const format: FakeRfbPixelFormat = {
          bigEndian: buffer[6] !== 0,
          redShift: buffer[14],
          greenShift: buffer[15],
          blueShift: buffer[16],
        };
        this.formats.set(socket, format);
        connection.setPixelFormats.push(format);
        return 20;
      }
      case 2: {
        if (buffer.length < 4) return 0;
        const count = buffer.readUInt16BE(2);
        if (buffer.length < 4 + count * 4) return 0;
        const encodings = Array.from({ length: count }, (_, index) => buffer.readInt32BE(4 + index * 4));
        this.encodingsBySocket.set(socket, encodings);
        connection.encodings.push(encodings);
        return 4 + count * 4;
      }
      case 3: {
        if (buffer.length < 10) return 0;
        const incremental = buffer[1] !== 0;
        connection.updateRequests.push({ incremental, at: Date.now() });
        const dirty = this.dirty.get(socket) ?? [];
        this.dirty.delete(socket);
        if (!incremental) this.sendRects(socket, [{ kind: "raw", rect: { x: 0, y: 0, width: this.width, height: this.height } }]);
        else if (dirty.length > 0) this.sendRects(socket, dirty.map((rect) => ({ kind: "raw" as const, rect })));
        else this.pendingIncremental.add(socket);
        return 10;
      }
      case 4: {
        if (buffer.length < 8) return 0;
        connection.keys.push({ keysym: buffer.readUInt32BE(4), down: buffer[1] !== 0 });
        return 8;
      }
      case 5: {
        if (buffer.length < 6) return 0;
        connection.pointer.push({ x: buffer.readUInt16BE(2), y: buffer.readUInt16BE(4), buttons: buffer[1] });
        return 6;
      }
      default:
        socket.destroy();
        return buffer.length;
    }
  }

  private sendRects(
    socket: Socket,
    rects: (
      | { kind: "raw"; rect: { x: number; y: number; width: number; height: number } }
      | { kind: "copy"; rect: { x: number; y: number; width: number; height: number }; source: { x: number; y: number } }
      | { kind: "size"; rect: { x: number; y: number; width: number; height: number } }
    )[],
  ): void {
    const format = this.formats.get(socket) ?? this.options.nativeFormat;
    const header = Buffer.alloc(4);
    header.writeUInt16BE(rects.length, 2);
    const parts = [header];
    for (const entry of rects) {
      const rectHeader = Buffer.alloc(12);
      rectHeader.writeUInt16BE(entry.rect.x, 0);
      rectHeader.writeUInt16BE(entry.rect.y, 2);
      rectHeader.writeUInt16BE(entry.rect.width, 4);
      rectHeader.writeUInt16BE(entry.rect.height, 6);
      rectHeader.writeInt32BE(entry.kind === "raw" ? 0 : entry.kind === "copy" ? 1 : -223, 8);
      parts.push(rectHeader);
      if (entry.kind === "copy") {
        const source = Buffer.alloc(4);
        source.writeUInt16BE(entry.source.x, 0);
        source.writeUInt16BE(entry.source.y, 2);
        parts.push(source);
      } else if (entry.kind === "raw") {
        const pixels = Buffer.alloc(entry.rect.width * entry.rect.height * 4);
        let offset = 0;
        for (let y = entry.rect.y; y < entry.rect.y + entry.rect.height; y += 1) {
          for (let x = entry.rect.x; x < entry.rect.x + entry.rect.width; x += 1) {
            const [r, g, b] = this.pixels[y * this.width + x];
            const value = ((r << format.redShift) | (g << format.greenShift) | (b << format.blueShift)) >>> 0;
            if (format.bigEndian) pixels.writeUInt32BE(value, offset);
            else pixels.writeUInt32LE(value, offset);
            offset += 4;
          }
        }
        parts.push(pixels);
      }
    }
    socket.write(Buffer.concat(parts));
  }
}
