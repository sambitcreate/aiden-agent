import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareLinuxBaseDisk } from "./linux-base.js";
import { BOT_COMPUTER_LINUX_DISK_BYTES } from "./release.js";
import { BotComputerError } from "./types.js";
import { BOT_COMPUTER_BASE_VM } from "./vm-names.js";

test("prepareLinuxBaseDisk copies the verified raw image and grows it sparsely to 24 GiB", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-linux-disk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "debian-13-generic-arm64.raw");
  const target = path.join(dir, "vms", BOT_COMPUTER_BASE_VM, "disk.img");
  const header = Buffer.from("DEBIAN-13-RAW-GPT-HEADER");
  writeFileSync(source, header);

  const result = await prepareLinuxBaseDisk({ sourceImagePath: source, targetDiskPath: target });
  assert.equal(result.bytes, BOT_COMPUTER_LINUX_DISK_BYTES);
  const info = statSync(target);
  assert.equal(info.size, BOT_COMPUTER_LINUX_DISK_BYTES);
  const prefix = Buffer.alloc(header.length);
  const { openSync, readSync, closeSync } = await import("node:fs");
  const fd = openSync(target, "r");
  try {
    readSync(fd, prefix, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  assert.deepEqual(prefix, header, "the original raw disk bytes remain intact at offset 0");

  await assert.rejects(
    prepareLinuxBaseDisk({ sourceImagePath: source, targetDiskPath: target, targetBytes: 4 }),
    (error: unknown) => error instanceof BotComputerError && error.code === "invalid",
  );
});
