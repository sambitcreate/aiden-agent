import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeRfbServer } from "./rfb-fake-server.js";
import { createRfbScreenFactory } from "./rfb-screen-main.js";
import type { BotComputerImageEncoder } from "./rfb-screen.js";
import type { BotComputerConnection } from "./types.js";

const encode: BotComputerImageEncoder = async (bgra, width, height) => ({ image: Buffer.from(bgra.subarray(0, 4)), width, height });

const connectionTo = (port: number, password: string, host = "127.0.0.1"): BotComputerConnection => ({
  vmName: "aiden-bot-0123456789abcdef",
  ip: "192.168.64.9",
  vnc: { host: host as "127.0.0.1", port, password },
  ssh: { host: "192.168.64.9", user: "lume" },
});

test("each run's screen signs in to its loopback VNC server with that run's password", async () => {
  const server = new FakeRfbServer({ width: 16, height: 12, password: "run-pass-2" });
  const port = await server.listen();
  try {
    const factory = createRfbScreenFactory({ encode });
    await assert.rejects(factory(connectionTo(port, "stale-pass")), /password|auth/iu);
    server.paint({ x: 0, y: 0, width: 16, height: 12 }, [9, 8, 7]);
    const screen = await factory(connectionTo(port, "run-pass-2"));
    const shot = await screen.capture({ format: "png", maxWidth: 16 });
    assert.deepEqual([...shot.image], [7, 8, 9, 255], "the server's pixel, as BGRA");
    assert.deepEqual([shot.framebufferWidth, shot.framebufferHeight], [16, 12]);
    await screen.close();
  } finally {
    await server.close();
  }
});

test("a VNC address off loopback is refused before any connection", async () => {
  const server = new FakeRfbServer({ password: "run-pass-2" });
  const port = await server.listen();
  try {
    const factory = createRfbScreenFactory({ encode });
    await assert.rejects(factory(connectionTo(port, "run-pass-2", "192.168.64.9")), /loopback/u);
    assert.equal(server.connections.length, 0);
  } finally {
    await server.close();
  }
});

test("an owner-Mac recording holds only what the server sent, in a file only this user can read", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiden-rfb-recordings-"));
  const server = new FakeRfbServer({ width: 16, height: 12, password: "run-pass-2", version: "3.8" });
  const port = await server.listen();
  try {
    const factory = createRfbScreenFactory({ encode, recordingsDir: path.join(dir, "rfb-recordings"), now: () => Date.UTC(2026, 9, 21, 9, 30) });
    const screen = await factory(connectionTo(port, "run-pass-2"));
    await screen.capture({ format: "jpeg", maxWidth: 16 });
    await screen.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [file] = await readdir(path.join(dir, "rfb-recordings"));
    assert.equal(file, "aiden-bot-0123456789abcdef-2026-10-21T09-30-00-000Z.bin");
    const recorded = await readFile(path.join(dir, "rfb-recordings", file));
    assert.equal(recorded.subarray(0, 12).toString("latin1"), "RFB 003.008\n");
    assert.equal(recorded.includes(Buffer.from("run-pass-2")), false, "no password in a recording");
    assert.equal((await stat(path.join(dir, "rfb-recordings", file))).mode & 0o777, 0o600);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
