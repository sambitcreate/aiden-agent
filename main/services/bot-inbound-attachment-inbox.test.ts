import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  resolveBotInboxWriterBinary,
  writeBotInboundAttachment,
} from "./bot-inbound-attachment-inbox.js";
import type { BotInboundAttachmentHomeLease } from "./bot-inbound-attachment-home.js";
import { MAX_TELEGRAM_DOWNLOAD_BYTES } from "./telegram/telegram-inbound.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const testingBinary = path.join(
  repositoryRoot,
  "build",
  "native",
  "aiden-bot-inbox-writer-test",
);

async function homeLease(homePath: string): Promise<BotInboundAttachmentHomeLease> {
  const expected = await fs.stat(homePath, { bigint: true });
  return {
    homePath,
    identity: {
      device: expected.dev.toString(),
      inode: expected.ino.toString(),
    },
    async revalidateBeforeEffect() {
      const [canonical, current] = await Promise.all([
        fs.realpath(homePath),
        fs.stat(homePath, { bigint: true }),
      ]);
      if (
        canonical !== homePath ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino
      ) {
        throw new Error("managed home changed");
      }
    },
  };
}

test("resolves the Bot inbox writer in development and packaged layouts", () => {
  assert.equal(
    resolveBotInboxWriterBinary({ defaultApp: true, cwd: "/repo" }),
    path.resolve("/repo/build/native/aiden-bot-inbox-writer"),
  );
  assert.equal(
    resolveBotInboxWriterBinary({
      defaultApp: false,
      cwd: "/ignored",
      resourcesPath: "/Applications/Aiden Agent.app/Contents/Resources",
    }),
    "/Applications/Aiden Agent.app/Contents/Helpers/aiden-bot-inbox-writer",
  );
});

test("Bot inbox stores binary bytes through the descriptor-relative native helper", async (t) => {
  if (process.platform !== "darwin") return;
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-inbox-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const home = await fs.realpath(parent);
  const bytes = Buffer.from([0, 255, 10, 13, 0, 42]);
  const destination = await writeBotInboundAttachment({
    home: await homeLease(home),
    profile: "default",
    leaf: "fixed-file.bin",
    bytes,
  });
  assert.deepEqual(await fs.readFile(destination), bytes);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
});

test("swap-and-restore after the final inbox pin cannot create anything outside", async (t) => {
  if (process.platform !== "darwin") return;
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-inbox-swap-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "home");
  const parked = path.join(home, ".aiden-pinned");
  const outside = path.join(parent, "outside");
  await Promise.all([fs.mkdir(home), fs.mkdir(outside)]);
  const canonicalHome = await fs.realpath(home);
  const destination = await writeBotInboundAttachment({
    home: await homeLease(canonicalHome),
    profile: "default",
    leaf: "must-not-escape.bin",
    bytes: Buffer.from([0, 1, 2, 255]),
    testControl: {
      binary: testingBinary,
      async afterInboxPinned() {
        await fs.rename(path.join(canonicalHome, ".aiden"), parked);
        await fs.symlink(outside, path.join(canonicalHome, ".aiden"), "dir");
      },
      async beforeExit() {
        await fs.unlink(path.join(canonicalHome, ".aiden"));
        await fs.rename(parked, path.join(canonicalHome, ".aiden"));
      },
    },
  });
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readFile(destination), Buffer.from([0, 1, 2, 255]));
});

test("a pre-existing symlinked inbox parent fails closed without outside creation", async (t) => {
  if (process.platform !== "darwin") return;
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-inbox-link-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "home");
  const outside = path.join(parent, "outside");
  await Promise.all([fs.mkdir(home), fs.mkdir(outside)]);
  const canonicalHome = await fs.realpath(home);
  await fs.symlink(outside, path.join(canonicalHome, ".aiden"), "dir");
  await assert.rejects(
    writeBotInboundAttachment({
      home: await homeLease(canonicalHome),
      profile: "default",
      leaf: "must-not-exist.bin",
      bytes: Buffer.from("secret", "utf8"),
    }),
    /Bot inbox write failed/u,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("rejects unsafe components and bytes above Telegram's existing ceiling", async () => {
  const home = {
    homePath: "/private/aiden/home",
    identity: { device: "1", inode: "2" },
    async revalidateBeforeEffect() {},
  };
  await assert.rejects(
    writeBotInboundAttachment({
      home,
      profile: "../outside",
      leaf: "file.bin",
      bytes: Buffer.alloc(0),
    }),
    /unsafe path component/u,
  );
  await assert.rejects(
    writeBotInboundAttachment({
      home,
      profile: "default",
      leaf: "file.bin",
      bytes: Buffer.alloc(MAX_TELEGRAM_DOWNLOAD_BYTES + 1),
    }),
    /cannot be stored safely/u,
  );
});
