import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCloudInitSeedIso,
  buildIso9660Image,
  CLOUD_INIT_VOLUME_LABEL,
  renderCloudInitMetaData,
  renderCloudInitUserData,
  sha512Crypt,
  writeCloudInitSeedIso,
} from "./cloud-init-iso.js";
import { BOT_COMPUTER_LINUX_APT_SNAPSHOT } from "./release.js";
import { BotComputerError } from "./types.js";

const SECTOR = 2048;
const TEST_SSH_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAidenKeyForBotComputerLinuxBaseTests0123456789";

interface ParsedIsoRecord {
  isoId: string;
  isDirectory: boolean;
  extentLba: number;
  dataLength: number;
  rockRidgeName?: string;
  posixMode?: number;
  hasSuspSp?: boolean;
}

/** Independent ECMA-119 + Rock Ridge reader for verifying generated seed ISOs. */
function parseIso9660Root(iso: Buffer): {
  volumeLabel: string;
  blockSize: number;
  volumeSpaceSectors: number;
  records: ParsedIsoRecord[];
  readFile(name: string): Buffer;
} {
  assert.equal(iso.length % SECTOR, 0, "ISO size is a multiple of 2048-byte sectors");
  // First 16 sectors (system area) are zeroed.
  assert.ok(iso.subarray(0, 16 * SECTOR).every((byte) => byte === 0));

  const pvd = iso.subarray(16 * SECTOR, 17 * SECTOR);
  assert.equal(pvd[0], 0x01, "Primary Volume Descriptor type");
  assert.equal(pvd.subarray(1, 6).toString("ascii"), "CD001");
  assert.equal(pvd[6], 0x01, "PVD version");
  assert.equal(pvd[881], 0x01, "file structure version");

  const volumeLabel = pvd.subarray(40, 72).toString("ascii").trimEnd();
  const volumeSpaceSectors = pvd.readUInt32LE(80);
  assert.equal(pvd.readUInt32BE(84), volumeSpaceSectors, "volume space size both-endian matches");
  assert.equal(volumeSpaceSectors * SECTOR, iso.length);

  const blockSize = pvd.readUInt16LE(128);
  assert.equal(pvd.readUInt16BE(130), blockSize, "logical block size both-endian matches");
  assert.equal(blockSize, SECTOR);

  // Volume Descriptor Set Terminator at sector 17.
  const term = iso.subarray(17 * SECTOR, 18 * SECTOR);
  assert.equal(term[0], 0xff, "Terminator type");
  assert.equal(term.subarray(1, 6).toString("ascii"), "CD001");
  assert.equal(term[6], 0x01);

  // Root directory record inside PVD (offset 156, length 34).
  assert.equal(pvd[156], 34);
  const rootLba = pvd.readUInt32LE(156 + 2);
  assert.equal(pvd.readUInt32BE(156 + 6), rootLba);
  const rootLength = pvd.readUInt32LE(156 + 10);
  assert.equal(pvd.readUInt32BE(156 + 14), rootLength);

  // Path tables match root LBA.
  const lPathLba = pvd.readUInt32LE(140);
  const mPathLba = pvd.readUInt32BE(148);
  assert.equal(iso.readUInt32LE(lPathLba * SECTOR + 2), rootLba);
  assert.equal(iso.readUInt32BE(mPathLba * SECTOR + 2), rootLba);

  const records: ParsedIsoRecord[] = [];
  const rootBuf = iso.subarray(rootLba * SECTOR, rootLba * SECTOR + rootLength);
  for (let sectorStart = 0; sectorStart < rootBuf.length; sectorStart += SECTOR) {
    let cursor = sectorStart;
    while (cursor < sectorStart + SECTOR) {
      const len = rootBuf[cursor] ?? 0;
      if (len === 0) break;
      assert.ok(cursor + len <= sectorStart + SECTOR, "directory record never crosses a sector boundary");
      const extentLba = rootBuf.readUInt32LE(cursor + 2);
      assert.equal(rootBuf.readUInt32BE(cursor + 6), extentLba);
      const dataLength = rootBuf.readUInt32LE(cursor + 10);
      assert.equal(rootBuf.readUInt32BE(cursor + 14), dataLength);
      const flags = rootBuf[cursor + 25] ?? 0;
      const idLen = rootBuf[cursor + 32] ?? 0;
      const idBytes = rootBuf.subarray(cursor + 33, cursor + 33 + idLen);
      const isoId = idLen === 1 && idBytes[0] === 0 ? "." : idLen === 1 && idBytes[0] === 1 ? ".." : idBytes.toString("ascii");

      let sysCursor = cursor + 33 + idLen + (idLen % 2 === 0 ? 1 : 0);
      let rockRidgeName: string | undefined;
      let posixMode: number | undefined;
      let hasSuspSp = false;
      while (sysCursor + 4 <= cursor + len) {
        const sig = rootBuf.subarray(sysCursor, sysCursor + 2).toString("ascii");
        const entryLen = rootBuf[sysCursor + 2] ?? 0;
        if (entryLen < 4 || sysCursor + entryLen > cursor + len) break;
        if (sig === "SP" && rootBuf[sysCursor + 4] === 0xbe && rootBuf[sysCursor + 5] === 0xef) {
          hasSuspSp = true;
        } else if (sig === "PX" && entryLen >= 12) {
          posixMode = rootBuf.readUInt32LE(sysCursor + 4);
        } else if (sig === "NM" && entryLen >= 5) {
          rockRidgeName = rootBuf.subarray(sysCursor + 5, sysCursor + entryLen).toString("utf8");
        }
        sysCursor += entryLen;
      }

      records.push({
        isoId,
        isDirectory: (flags & 0x02) !== 0,
        extentLba,
        dataLength,
        ...(rockRidgeName !== undefined ? { rockRidgeName } : {}),
        ...(posixMode !== undefined ? { posixMode } : {}),
        ...(hasSuspSp ? { hasSuspSp } : {}),
      });
      cursor += len;
    }
  }

  return {
    volumeLabel,
    blockSize,
    volumeSpaceSectors,
    records,
    readFile(name: string) {
      const match = records.find((entry) => !entry.isDirectory && (entry.rockRidgeName === name || entry.isoId === `${name.toUpperCase()};1`));
      assert.ok(match, `file ${name} exists in ISO root`);
      return iso.subarray(match.extentLba * SECTOR, match.extentLba * SECTOR + match.dataLength);
    },
  };
}

test("sha512Crypt matches Ulrich Drepper's glibc SHA-512 crypt reference vectors", () => {
  assert.equal(
    sha512Crypt("Hello world!", "saltstring"),
    "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1",
  );
  // 16-character salt + >16-byte password reference vector from Drepper's SHA-crypt spec.
  assert.equal(
    sha512Crypt("This is just a test", "toolongsaltstrin"),
    "$6$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0",
  );
  assert.equal(
    sha512Crypt("a very much longer text to encrypt.  This one even stretches over morethan one line.", "anotherlongsalts"),
    "$6$anotherlongsalts$zCB2J77iwc/56nB80mcnR6gCDELuiqcwDzPCm3OZnzRQyxT9pVMJ2vfOf0YI0AvrvfVu.AqASga4nxwhEPO7Z0",
  );
});

test("buildCloudInitSeedIso produces a valid CIDATA ISO 9660 + Rock Ridge image with meta-data and user-data", (t) => {
  const secretPassword = "SuperSecretGuestPassword9911";
  const iso = buildCloudInitSeedIso({
    instanceId: "aiden-base-20261123",
    hostname: "aiden-base",
    sshAuthorizedKey: TEST_SSH_KEY,
    password: secretPassword,
  });

  // Only a few KB (20 system+dir sectors + 2 payload sectors = 44 KiB).
  assert.ok(iso.length <= 64 * 1024, `expected compact seed ISO, got ${iso.length} bytes`);

  const parsed = parseIso9660Root(iso);
  assert.equal(parsed.volumeLabel, CLOUD_INIT_VOLUME_LABEL);
  assert.equal(parsed.blockSize, 2048);

  const dot = parsed.records.find((record) => record.isoId === ".");
  assert.equal(dot?.isDirectory, true);
  assert.equal(dot?.hasSuspSp, true);
  assert.equal(dot?.posixMode, 0o040555);

  const files = parsed.records.filter((record) => !record.isDirectory);
  assert.deepEqual(
    files.map((file) => ({ isoId: file.isoId, rr: file.rockRidgeName, mode: file.posixMode })),
    [
      { isoId: "META-DATA;1", rr: "meta-data", mode: 0o100444 },
      { isoId: "USER-DATA;1", rr: "user-data", mode: 0o100444 },
    ],
  );

  const metaData = parsed.readFile("meta-data").toString("utf8");
  assert.equal(metaData, renderCloudInitMetaData({ instanceId: "aiden-base-20261123", hostname: "aiden-base" }));
  assert.match(metaData, /^instance-id: "aiden-base-20261123"$/mu);
  assert.match(metaData, /^local-hostname: "aiden-base"$/mu);

  const userData = parsed.readFile("user-data").toString("utf8");
  assert.ok(userData.startsWith("#cloud-config\n"));
  assert.match(userData, /^ssh_pwauth: false$/mu);
  assert.match(userData, /^disable_root: true$/mu);
  assert.ok(userData.includes(TEST_SSH_KEY));
  assert.ok(userData.includes(BOT_COMPUTER_LINUX_APT_SNAPSHOT.archiveUrl));
  assert.ok(userData.includes(BOT_COMPUTER_LINUX_APT_SNAPSHOT.securityUrl));
  assert.match(userData, /passwd: "\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}"/u);
  assert.equal(userData.includes(secretPassword), false, "plaintext guest password must never appear in the ISO");

  // On Linux hosts with blkid/file, verify OS-level ISO9660 + CIDATA detection.
  if (existsSync("/usr/sbin/blkid")) {
    const dir = mkdtempSync(path.join(tmpdir(), "aiden-cidata-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, "seed.iso");
    const written = execFileSync("/bin/sh", ["-c", "cat > \"$1\"", "--", filePath], { input: iso });
    assert.ok(written);
    const blkid = execFileSync("/usr/sbin/blkid", ["-p", "-o", "export", filePath], { encoding: "utf8" });
    assert.match(blkid, /^LABEL=CIDATA$/mu);
    assert.match(blkid, /^TYPE=iso9660$/mu);
  }
});

test("writeCloudInitSeedIso writes an owner-only 0600 file and multi-sector root directories stay valid", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-iso-write-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const isoPath = path.join(dir, "nested", "seed.iso");
  const iso = await writeCloudInitSeedIso(isoPath, {
    instanceId: "aiden-base-1",
    hostname: "aiden-base",
    sshAuthorizedKey: TEST_SSH_KEY,
    passwordHash: sha512Crypt("pw", "saltstring"),
  });
  assert.equal(statSync(isoPath).size, iso.length);
  assert.equal(statSync(isoPath).mode & 0o777, 0o600);

  // 30 files forces the root directory to span more than one 2048-byte sector.
  const many = Array.from({ length: 30 }, (_, index) => ({
    name: `file-${String(index).padStart(2, "0")}.txt`,
    content: `payload-${index}`,
  }));
  const bigIso = buildIso9660Image({ volumeLabel: "CIDATA", files: many });
  const parsed = parseIso9660Root(bigIso);
  assert.equal(parsed.records.filter((record) => !record.isDirectory).length, 30);
  assert.equal(parsed.readFile("file-00.txt").toString("utf8"), "payload-0");
  assert.equal(parsed.readFile("file-29.txt").toString("utf8"), "payload-29");
});

test("ISO and cloud-init writers reject invalid labels, filenames, keys, URLs, and package names", () => {
  const invalid = (fn: () => unknown) =>
    assert.throws(fn, (error: unknown) => error instanceof BotComputerError && error.code === "invalid");

  invalid(() => buildIso9660Image({ volumeLabel: "bad label!", files: [{ name: "a", content: "x" }] }));
  invalid(() => buildIso9660Image({ volumeLabel: "CIDATA", files: [] }));
  invalid(() => buildIso9660Image({ volumeLabel: "CIDATA", files: [{ name: "../escape", content: "x" }] }));
  invalid(() =>
    buildIso9660Image({
      volumeLabel: "CIDATA",
      files: [
        { name: "meta-data", content: "a" },
        { name: "META-DATA", content: "b" },
      ],
    }),
  );
  invalid(() => renderCloudInitMetaData({ instanceId: "bad id\n", hostname: "ok" }));
  invalid(() =>
    renderCloudInitUserData({
      sshAuthorizedKey: TEST_SSH_KEY,
      snapshot: { codename: "trixie", archiveUrl: "http://insecure.example/debian", securityUrl: "https://snapshot.debian.org/s" },
    }),
  );
  // WHATWG `new URL()` silently strips \r/\n/\t and percent-encodes spaces; we must reject them to prevent YAML injection.
  for (const badUrl of [
    "https://snapshot.debian.org/a\n  runcmd:\n    - id",
    "https://snapshot.debian.org/a\r\n  runcmd:",
    "https://snapshot.debian.org/a b",
    "https://user:pass@snapshot.debian.org/debian",
    "https://snapshot.debian.org/debian?q=1",
  ]) {
    invalid(() =>
      renderCloudInitUserData({
        sshAuthorizedKey: TEST_SSH_KEY,
        snapshot: { codename: "trixie", archiveUrl: badUrl, securityUrl: "https://snapshot.debian.org/s" },
      }),
    );
  }
  invalid(() => renderCloudInitUserData({ sshAuthorizedKey: TEST_SSH_KEY, packages: ["valid-pkg", "bad;rm -rf /"] }));
  invalid(() => renderCloudInitUserData({ sshAuthorizedKey: TEST_SSH_KEY, username: "Root!" }));
});
