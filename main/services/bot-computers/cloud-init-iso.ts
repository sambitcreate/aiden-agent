// Zero-external-tool ISO 9660 (ECMA-119) + Rock Ridge (SUSP/RRIP) writer for
// cloud-init's NoCloud seed disk (`CIDATA` volume label with `meta-data` and
// `user-data`). Runs cleanly on macOS and Linux without mkisofs/hdiutil.

import { createHash, randomBytes } from "node:crypto";
import { writeFileAtomic } from "../durable-fs.js";
import { BOT_COMPUTER_LINUX_APT_SNAPSHOT, BOT_COMPUTER_LINUX_IMAGE } from "./release.js";
import { BOT_COMPUTER_GUEST_USER, parsePublicKey } from "./ssh.js";
import { BotComputerError } from "./types.js";

const SECTOR_SIZE = 2048;
const SYSTEM_AREA_SECTORS = 16;
const PVD_SECTOR = SYSTEM_AREA_SECTORS; // 16
const TERMINATOR_SECTOR = PVD_SECTOR + 1; // 17
const L_PATH_TABLE_SECTOR = TERMINATOR_SECTOR + 1; // 18
const M_PATH_TABLE_SECTOR = L_PATH_TABLE_SECTOR + 1; // 19
const ROOT_DIR_SECTOR = M_PATH_TABLE_SECTOR + 1; // 20

const MODE_DIR = 0o040555;
const MODE_FILE = 0o100444;

export interface Iso9660FileEntry {
  name: string;
  content: Buffer | string;
}

export interface Iso9660ImageOptions {
  volumeLabel: string;
  files: readonly Iso9660FileEntry[];
  /** Fixed timestamp for deterministic builds (defaults to 2026-11-23T00:00:00Z). */
  timestamp?: Date;
}

const DEFAULT_ISO_TIMESTAMP = new Date("2026-11-23T00:00:00Z");

function writeBothUint16(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt16LE(value, offset);
  buf.writeUInt16BE(value, offset + 2);
}

function writeBothUint32(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt32LE(value, offset);
  buf.writeUInt32BE(value, offset + 4);
}

function writeAsciiPadded(buf: Buffer, offset: number, length: number, text: string): void {
  buf.fill(0x20, offset, offset + length);
  const bytes = Buffer.from(text, "ascii");
  bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

function writeDirTimestamp(buf: Buffer, offset: number, date: Date): void {
  buf[offset] = Math.max(0, Math.min(255, date.getUTCFullYear() - 1900));
  buf[offset + 1] = date.getUTCMonth() + 1;
  buf[offset + 2] = date.getUTCDate();
  buf[offset + 3] = date.getUTCHours();
  buf[offset + 4] = date.getUTCMinutes();
  buf[offset + 5] = date.getUTCSeconds();
  buf[offset + 6] = 0; // UTC
}

function writePvdTimestamp(buf: Buffer, offset: number, date: Date | null): void {
  if (!date) {
    buf.write("0000000000000000", offset, 16, "ascii");
    buf[offset + 16] = 0;
    return;
  }
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const stamp =
    String(date.getUTCFullYear()).padStart(4, "0") +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    "00";
  buf.write(stamp, offset, 16, "ascii");
  buf[offset + 16] = 0;
}

/** SUSP SP entry identifying Rock Ridge system use entries on the root `.` record. */
function suspSpEntry(): Buffer {
  return Buffer.from([0x53, 0x50, 7, 1, 0xbe, 0xef, 0]);
}

/** Rock Ridge PX entry carrying POSIX permissions, links, uid, gid and inode. */
function rrPxEntry(mode: number, links: number, inode: number): Buffer {
  const buf = Buffer.alloc(44);
  buf[0] = 0x50; // 'P'
  buf[1] = 0x58; // 'X'
  buf[2] = 44;
  buf[3] = 1;
  writeBothUint32(buf, 4, mode);
  writeBothUint32(buf, 12, links);
  writeBothUint32(buf, 20, 0); // uid
  writeBothUint32(buf, 28, 0); // gid
  writeBothUint32(buf, 36, inode);
  return buf;
}

/** Rock Ridge NM entry carrying the exact case-sensitive filename. */
function rrNmEntry(name: string): Buffer {
  const raw = Buffer.from(name, "utf8");
  const buf = Buffer.alloc(5 + raw.length);
  buf[0] = 0x4e; // 'N'
  buf[1] = 0x4d; // 'M'
  buf[2] = buf.length;
  buf[3] = 1;
  buf[4] = 0; // flags (single complete name)
  raw.copy(buf, 5);
  return buf;
}

function buildDirectoryRecord(options: {
  identifier: Buffer;
  extentLba: number;
  dataLength: number;
  isDirectory: boolean;
  timestamp: Date;
  systemUse?: Buffer;
}): Buffer {
  const idLen = options.identifier.length;
  const padLen = idLen % 2 === 0 ? 1 : 0;
  const sysUse = options.systemUse ?? Buffer.alloc(0);
  const rawLen = 33 + idLen + padLen + sysUse.length;
  const recordLen = rawLen % 2 === 0 ? rawLen : rawLen + 1;
  if (recordLen > 254) {
    throw new BotComputerError("invalid", "ISO directory entry exceeds the 254-byte ISO 9660 limit.");
  }
  const rec = Buffer.alloc(recordLen);
  rec[0] = recordLen;
  rec[1] = 0; // extended attribute record length
  writeBothUint32(rec, 2, options.extentLba);
  writeBothUint32(rec, 10, options.dataLength);
  writeDirTimestamp(rec, 18, options.timestamp);
  rec[25] = options.isDirectory ? 0x02 : 0x00;
  rec[26] = 0; // file unit size
  rec[27] = 0; // interleave gap size
  writeBothUint16(rec, 28, 1); // volume sequence number
  rec[32] = idLen;
  options.identifier.copy(rec, 33);
  if (sysUse.length > 0) sysUse.copy(rec, 33 + idLen + padLen);
  return rec;
}

function packDirectoryRecords(records: readonly Buffer[]): Buffer {
  const sectors: Buffer[] = [];
  let current = Buffer.alloc(SECTOR_SIZE);
  let offset = 0;
  for (const record of records) {
    if (offset + record.length > SECTOR_SIZE) {
      sectors.push(current);
      current = Buffer.alloc(SECTOR_SIZE);
      offset = 0;
    }
    record.copy(current, offset);
    offset += record.length;
  }
  sectors.push(current);
  return Buffer.concat(sectors);
}

/**
 * Build a minimal, standards-compliant ISO 9660 + Rock Ridge disk image in
 * memory containing the given root-level files.
 */
export function buildIso9660Image(options: Iso9660ImageOptions): Buffer {
  const label = options.volumeLabel;
  if (!/^[A-Z0-9_-]{1,32}$/u.test(label)) {
    throw new BotComputerError("invalid", "ISO volume label must be 1–32 uppercase letters, digits, underscores, or hyphens.");
  }
  if (options.files.length === 0) {
    throw new BotComputerError("invalid", "An ISO image needs at least one file.");
  }
  const timestamp = options.timestamp ?? DEFAULT_ISO_TIMESTAMP;

  const seenIsoNames = new Set<string>();
  const normalized = options.files.map((entry) => {
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(entry.name) || entry.name === "." || entry.name === "..") {
      throw new BotComputerError("invalid", `Invalid ISO filename: ${entry.name}`);
    }
    const isoId = `${entry.name.toUpperCase()};1`;
    if (seenIsoNames.has(isoId)) {
      throw new BotComputerError("invalid", `Duplicate ISO filename: ${entry.name}`);
    }
    seenIsoNames.add(isoId);
    const data = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : Buffer.from(entry.content);
    return { name: entry.name, isoId, data };
  });
  // ECMA-119 requires directory entries sorted ascending by ISO file identifier.
  normalized.sort((left, right) => (left.isoId < right.isoId ? -1 : left.isoId > right.isoId ? 1 : 0));

  // Two-pass root directory sizing: compute how many sectors the root directory
  // takes before laying out file extents right after it.
  const dummyRecords = [
    buildDirectoryRecord({
      identifier: Buffer.from([0x00]),
      extentLba: ROOT_DIR_SECTOR,
      dataLength: SECTOR_SIZE,
      isDirectory: true,
      timestamp,
      systemUse: Buffer.concat([suspSpEntry(), rrPxEntry(MODE_DIR, 2, 1)]),
    }),
    buildDirectoryRecord({
      identifier: Buffer.from([0x01]),
      extentLba: ROOT_DIR_SECTOR,
      dataLength: SECTOR_SIZE,
      isDirectory: true,
      timestamp,
      systemUse: rrPxEntry(MODE_DIR, 2, 1),
    }),
    ...normalized.map((entry, index) =>
      buildDirectoryRecord({
        identifier: Buffer.from(entry.isoId, "ascii"),
        extentLba: ROOT_DIR_SECTOR + 1,
        dataLength: entry.data.length,
        isDirectory: false,
        timestamp,
        systemUse: Buffer.concat([rrPxEntry(MODE_FILE, 1, index + 2), rrNmEntry(entry.name)]),
      }),
    ),
  ];
  const rootDirByteLength = packDirectoryRecords(dummyRecords).length;
  const rootDirSectors = rootDirByteLength / SECTOR_SIZE;

  let nextLba = ROOT_DIR_SECTOR + rootDirSectors;
  const placed = normalized.map((entry) => {
    const extentLba = nextLba;
    const sectors = Math.ceil(entry.data.length / SECTOR_SIZE);
    nextLba += sectors;
    return { ...entry, extentLba, sectors };
  });
  const totalSectors = nextLba;

  const rootDirBuffer = packDirectoryRecords([
    buildDirectoryRecord({
      identifier: Buffer.from([0x00]),
      extentLba: ROOT_DIR_SECTOR,
      dataLength: rootDirByteLength,
      isDirectory: true,
      timestamp,
      systemUse: Buffer.concat([suspSpEntry(), rrPxEntry(MODE_DIR, 2, 1)]),
    }),
    buildDirectoryRecord({
      identifier: Buffer.from([0x01]),
      extentLba: ROOT_DIR_SECTOR,
      dataLength: rootDirByteLength,
      isDirectory: true,
      timestamp,
      systemUse: rrPxEntry(MODE_DIR, 2, 1),
    }),
    ...placed.map((entry, index) =>
      buildDirectoryRecord({
        identifier: Buffer.from(entry.isoId, "ascii"),
        extentLba: entry.extentLba,
        dataLength: entry.data.length,
        isDirectory: false,
        timestamp,
        systemUse: Buffer.concat([rrPxEntry(MODE_FILE, 1, index + 2), rrNmEntry(entry.name)]),
      }),
    ),
  ]);

  const image = Buffer.alloc(totalSectors * SECTOR_SIZE);

  // Primary Volume Descriptor (sector 16).
  const pvdOffset = PVD_SECTOR * SECTOR_SIZE;
  image[pvdOffset] = 0x01;
  image.write("CD001", pvdOffset + 1, 5, "ascii");
  image[pvdOffset + 6] = 0x01;
  writeAsciiPadded(image, pvdOffset + 8, 32, "LINUX");
  writeAsciiPadded(image, pvdOffset + 40, 32, label);
  writeBothUint32(image, pvdOffset + 80, totalSectors);
  writeBothUint16(image, pvdOffset + 120, 1); // volume set size
  writeBothUint16(image, pvdOffset + 124, 1); // volume sequence number
  writeBothUint16(image, pvdOffset + 128, SECTOR_SIZE);
  writeBothUint32(image, pvdOffset + 132, 10); // path table size (root entry only)
  image.writeUInt32LE(L_PATH_TABLE_SECTOR, pvdOffset + 140);
  image.writeUInt32BE(M_PATH_TABLE_SECTOR, pvdOffset + 148);
  const pvdRootRecord = buildDirectoryRecord({
    identifier: Buffer.from([0x00]),
    extentLba: ROOT_DIR_SECTOR,
    dataLength: rootDirByteLength,
    isDirectory: true,
    timestamp,
  });
  pvdRootRecord.copy(image, pvdOffset + 156);
  writeAsciiPadded(image, pvdOffset + 190, 128, "");
  writeAsciiPadded(image, pvdOffset + 318, 128, "AIDEN");
  writeAsciiPadded(image, pvdOffset + 446, 128, "AIDEN");
  writeAsciiPadded(image, pvdOffset + 574, 128, "AIDEN CLOUD-INIT SEED");
  writeAsciiPadded(image, pvdOffset + 702, 37, "");
  writeAsciiPadded(image, pvdOffset + 739, 37, "");
  writeAsciiPadded(image, pvdOffset + 776, 37, "");
  writePvdTimestamp(image, pvdOffset + 813, timestamp);
  writePvdTimestamp(image, pvdOffset + 830, timestamp);
  writePvdTimestamp(image, pvdOffset + 847, null);
  writePvdTimestamp(image, pvdOffset + 864, timestamp);
  image[pvdOffset + 881] = 0x01; // file structure version

  // Volume Descriptor Set Terminator (sector 17).
  const termOffset = TERMINATOR_SECTOR * SECTOR_SIZE;
  image[termOffset] = 0xff;
  image.write("CD001", termOffset + 1, 5, "ascii");
  image[termOffset + 6] = 0x01;

  // Type-L Path Table (sector 18, little-endian).
  const lptOffset = L_PATH_TABLE_SECTOR * SECTOR_SIZE;
  image[lptOffset] = 1;
  image[lptOffset + 1] = 0;
  image.writeUInt32LE(ROOT_DIR_SECTOR, lptOffset + 2);
  image.writeUInt16LE(1, lptOffset + 6);
  image[lptOffset + 8] = 0x00;

  // Type-M Path Table (sector 19, big-endian).
  const mptOffset = M_PATH_TABLE_SECTOR * SECTOR_SIZE;
  image[mptOffset] = 1;
  image[mptOffset + 1] = 0;
  image.writeUInt32BE(ROOT_DIR_SECTOR, mptOffset + 2);
  image.writeUInt16BE(1, mptOffset + 6);
  image[mptOffset + 8] = 0x00;

  // Root Directory (sector 20+).
  rootDirBuffer.copy(image, ROOT_DIR_SECTOR * SECTOR_SIZE);

  // File payload extents.
  for (const entry of placed) {
    entry.data.copy(image, entry.extentLba * SECTOR_SIZE);
  }

  return image;
}

// ── SHA-512 crypt ($6$) for Linux /etc/shadow (Ulrich Drepper specification) ─

const CRYPT_B64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SHA512_CRYPT_ROUNDS = 5000;
const SHA512_PERMUTATION: readonly (readonly [number, number, number])[] = [
  [0, 21, 42],
  [22, 43, 1],
  [44, 2, 23],
  [3, 24, 45],
  [25, 46, 4],
  [47, 5, 26],
  [6, 27, 48],
  [28, 49, 7],
  [50, 8, 29],
  [9, 30, 51],
  [31, 52, 10],
  [53, 11, 32],
  [12, 33, 54],
  [34, 55, 13],
  [56, 14, 35],
  [15, 36, 57],
  [37, 58, 16],
  [59, 17, 38],
  [18, 39, 60],
  [40, 61, 19],
  [62, 20, 41],
];

function b64From24Bit(b2: number, b1: number, b0: number, count: number): string {
  let value = (b2 << 16) | (b1 << 8) | b0;
  let out = "";
  for (let index = 0; index < count; index += 1) {
    out += CRYPT_B64[value & 0x3f];
    value >>>= 6;
  }
  return out;
}

function repeatBytes(source: Buffer, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += source.length) {
    source.copy(out, offset, 0, Math.min(source.length, length - offset));
  }
  return out;
}

/**
 * Standard glibc SHA-512 crypt (`$6$<salt>$<hash>`) so cloud-init never writes
 * a plaintext guest password into the seed ISO.
 */
export function sha512Crypt(password: string, salt?: string): string {
  if (password.length === 0 || password.includes("\0")) {
    throw new BotComputerError("invalid", "A guest password is required.");
  }
  const resolvedSalt =
    salt ??
    Array.from(randomBytes(16), (byte) => CRYPT_B64[byte % CRYPT_B64.length]).join("");
  if (!/^[./0-9A-Za-z]{1,16}$/u.test(resolvedSalt)) {
    throw new BotComputerError("invalid", "SHA-512 crypt salt must be 1–16 base64-crypt characters.");
  }

  const key = Buffer.from(password, "utf8");
  const saltBytes = Buffer.from(resolvedSalt, "ascii");

  // Digest B
  const digestB = createHash("sha512").update(key).update(saltBytes).update(key).digest();

  // Digest A
  const hashA = createHash("sha512").update(key).update(saltBytes);
  for (let remaining = key.length; remaining > 0; remaining -= 64) {
    hashA.update(digestB.subarray(0, Math.min(64, remaining)));
  }
  for (let bits = key.length; bits > 0; bits >>>= 1) {
    hashA.update((bits & 1) !== 0 ? digestB : key);
  }
  let digestC = hashA.digest();

  // Sequence P
  const hashDP = createHash("sha512");
  for (let index = 0; index < key.length; index += 1) hashDP.update(key);
  const seqP = repeatBytes(hashDP.digest(), key.length);

  // Sequence S
  const hashDS = createHash("sha512");
  for (let index = 0; index < 16 + (digestC[0] ?? 0); index += 1) hashDS.update(saltBytes);
  const seqS = repeatBytes(hashDS.digest(), saltBytes.length);

  for (let round = 0; round < SHA512_CRYPT_ROUNDS; round += 1) {
    const hashC = createHash("sha512");
    if ((round & 1) !== 0) hashC.update(seqP);
    else hashC.update(digestC);
    if (round % 3 !== 0) hashC.update(seqS);
    if (round % 7 !== 0) hashC.update(seqP);
    if ((round & 1) !== 0) hashC.update(digestC);
    else hashC.update(seqP);
    digestC = hashC.digest();
  }

  let encoded = "";
  for (const [b2, b1, b0] of SHA512_PERMUTATION) {
    encoded += b64From24Bit(digestC[b2] ?? 0, digestC[b1] ?? 0, digestC[b0] ?? 0, 4);
  }
  encoded += b64From24Bit(0, 0, digestC[63] ?? 0, 2);
  return `$6$${resolvedSalt}$${encoded}`;
}

// ── Cloud-init NoCloud seed (`meta-data` + `user-data`) ─────────────────────

export interface CloudInitAptSnapshot {
  codename: string;
  archiveUrl: string;
  securityUrl: string;
}

export interface CloudInitSeedOptions {
  instanceId: string;
  hostname: string;
  /** Guest login account (defaults to `lume`). */
  username?: string;
  /** Aiden's `ssh-ed25519 …` public key. */
  sshAuthorizedKey: string;
  /**
   * Pre-hashed Linux shadow password (e.g. from `sha512Crypt`). Prefer this
   * over `password` when reusing a stored hash; if `password` is passed
   * instead, it is hashed with `sha512Crypt` so plaintext never lands on disk.
   */
  passwordHash?: string;
  password?: string;
  /** Pinned Debian snapshot mirrors (defaults to `BOT_COMPUTER_LINUX_APT_SNAPSHOT`). */
  snapshot?: CloudInitAptSnapshot;
  /** Debian packages to install on first boot (e.g. desktop + browser). */
  packages?: readonly string[];
  timestamp?: Date;
}

/** Minimal desktop package set installed on the hidden Linux base in F1. */
export const LINUX_BASE_DEFAULT_PACKAGES: readonly string[] = Object.freeze([
  "openssh-server",
  "xfce4",
  "xfce4-terminal",
  "lightdm",
  "dbus-x11",
  "xserver-xorg",
  "at-spi2-core",
  "fonts-dejavu-core",
  "fonts-noto-core",
]);

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function validateIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(value)) {
    throw new BotComputerError("invalid", `${label} has an unexpected shape.`);
  }
  return value;
}

export function renderCloudInitMetaData(options: { instanceId: string; hostname: string }): string {
  const instanceId = validateIdentifier(options.instanceId, "The cloud-init instance id");
  const hostname = validateIdentifier(options.hostname, "The guest hostname");
  return `instance-id: ${yamlString(instanceId)}\nlocal-hostname: ${yamlString(hostname)}\n`;
}

export function renderCloudInitUserData(options: Omit<CloudInitSeedOptions, "instanceId" | "hostname" | "timestamp">): string {
  const username = options.username ?? BOT_COMPUTER_GUEST_USER;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(username)) {
    throw new BotComputerError("invalid", "The guest username has an unexpected shape.");
  }
  const authorizedKey = parsePublicKey(options.sshAuthorizedKey);
  const passwordHash =
    options.passwordHash !== undefined
      ? options.passwordHash
      : options.password !== undefined
        ? sha512Crypt(options.password)
        : undefined;
  if (passwordHash !== undefined && !/^\$[0-9a-z]+\$[^\s]+$/u.test(passwordHash)) {
    throw new BotComputerError("invalid", "The guest password hash is malformed.");
  }

  const snapshot = options.snapshot ?? {
    codename: BOT_COMPUTER_LINUX_IMAGE.codename,
    archiveUrl: BOT_COMPUTER_LINUX_APT_SNAPSHOT.archiveUrl,
    securityUrl: BOT_COMPUTER_LINUX_APT_SNAPSHOT.securityUrl,
  };
  const validateSnapshotUrl = (candidate: string): string => {
    if (candidate.length === 0 || !/^[!-~]+$/u.test(candidate)) {
      throw new BotComputerError("invalid", "APT snapshot URLs must not contain whitespace or control characters.");
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new BotComputerError("invalid", "APT snapshot URL is malformed.");
    }
    if (parsed.protocol !== "https:") {
      throw new BotComputerError("invalid", "APT snapshot URLs must use https.");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new BotComputerError("invalid", "APT snapshot URLs must not contain credentials, query strings, or fragments.");
    }
    return parsed.href.replace(/\/+$/u, "");
  };
  const archiveUrl = validateSnapshotUrl(snapshot.archiveUrl);
  const securityUrl = validateSnapshotUrl(snapshot.securityUrl);
  if (!/^[a-z0-9-]+$/u.test(snapshot.codename)) {
    throw new BotComputerError("invalid", "The Debian codename is malformed.");
  }

  const packages = options.packages ?? LINUX_BASE_DEFAULT_PACKAGES;
  for (const pkg of packages) {
    if (!/^[a-z0-9][a-z0-9+.-]{0,127}$/u.test(pkg)) {
      throw new BotComputerError("invalid", `Invalid Debian package name: ${pkg}`);
    }
  }

  const lines: string[] = [
    "#cloud-config",
    "ssh_pwauth: false",
    "disable_root: true",
    "package_update: true",
    "package_upgrade: false",
    "users:",
    `  - name: ${yamlString(username)}`,
    "    groups: [sudo]",
    "    shell: /bin/bash",
    `    sudo: ${yamlString("ALL=(ALL) ALL")}`,
    `    lock_passwd: ${passwordHash ? "false" : "true"}`,
    ...(passwordHash ? [`    passwd: ${yamlString(passwordHash)}`] : []),
    "    ssh_authorized_keys:",
    `      - ${yamlString(authorizedKey)}`,
    "apt:",
    "  preserve_sources_list: false",
    "  conf: |",
    '    Acquire::Check-Valid-Until "false";',
    "  sources_list: |",
    `    deb ${archiveUrl} ${snapshot.codename} main contrib non-free-firmware`,
    `    deb ${securityUrl} ${snapshot.codename}-security main contrib non-free-firmware`,
  ];

  if (packages.length > 0) {
    lines.push("packages:");
    for (const pkg of packages) lines.push(`  - ${yamlString(pkg)}`);
  }

  return `${lines.join("\n")}\n`;
}

export const CLOUD_INIT_VOLUME_LABEL = "CIDATA";

/**
 * Cloud-init NoCloud `network-config` (Netplan v2) so Debian 13 sends its raw
 * Ethernet MAC address (`dhcp-identifier: mac`) on first boot instead of an
 * RFC 4361 DUID, allowing macOS's `bootpd` lease table and `lume get` to
 * resolve the VM's IP deterministically without waiting for ARP.
 */
export function renderCloudInitNetworkConfig(): string {
  return [
    "version: 2",
    "ethernets:",
    "  aiden-virtio:",
    "    match:",
    '      name: "en*"',
    "    dhcp4: true",
    "    dhcp-identifier: mac",
    "",
  ].join("\n");
}

export function buildCloudInitSeedIso(options: CloudInitSeedOptions): Buffer {
  const metaData = renderCloudInitMetaData({ instanceId: options.instanceId, hostname: options.hostname });
  const userData = renderCloudInitUserData(options);
  const networkConfig = renderCloudInitNetworkConfig();
  return buildIso9660Image({
    volumeLabel: CLOUD_INIT_VOLUME_LABEL,
    files: [
      { name: "meta-data", content: metaData },
      { name: "network-config", content: networkConfig },
      { name: "user-data", content: userData },
    ],
    timestamp: options.timestamp,
  });
}

export async function writeCloudInitSeedIso(filePath: string, options: CloudInitSeedOptions): Promise<Buffer> {
  const iso = buildCloudInitSeedIso(options);
  await writeFileAtomic(filePath, iso, { mode: 0o600, mkdirMode: 0o700 });
  return iso;
}
