/* global process */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";
import { waitForBoundedChild } from "./bounded-child.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_WEBP_BASE64 = "UklGRh4AAABXRUJQVlA4TBEAAAAvD8ACAAfQwL70vv+BiOh/AAA=";

function crc32(bytes) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function u32(value) {
  return Buffer.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const checksum = Buffer.concat([typeBytes, payload]);
  return Buffer.concat([u32(payload.byteLength), checksum, u32(crc32(checksum))]);
}

function nearLimitStaticPng(width = 4_000, height = 4_000) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rowBytes = width * 4 + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row += 1) pixels[row * rowBytes] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.alloc(20 * 1024 * 1024)),
    pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function staticTiff(width = 2, height = 2) {
  const entryCount = 10;
  const ifdOffset = 8;
  const bitsOffset = ifdOffset + 2 + entryCount * 12 + 4;
  const pixelsOffset = bitsOffset + 6;
  const bytes = Buffer.alloc(pixelsOffset + width * height * 3);
  bytes.write("II", 0, "ascii");
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(ifdOffset, 4);
  bytes.writeUInt16LE(entryCount, ifdOffset);
  const entries = [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 3, bitsOffset],
    [259, 3, 1, 1],
    [262, 3, 1, 2],
    [273, 4, 1, pixelsOffset],
    [277, 3, 1, 3],
    [278, 4, 1, height],
    [279, 4, 1, width * height * 3],
    [284, 3, 1, 1],
  ];
  entries.forEach(([tag, type, count, value], index) => {
    const offset = ifdOffset + 2 + index * 12;
    bytes.writeUInt16LE(tag, offset);
    bytes.writeUInt16LE(type, offset + 2);
    bytes.writeUInt32LE(count, offset + 4);
    if (type === 3 && count === 1) bytes.writeUInt16LE(value, offset + 8);
    else bytes.writeUInt32LE(value, offset + 8);
  });
  bytes.writeUInt32LE(0, ifdOffset + 2 + entryCount * 12);
  bytes.writeUInt16LE(8, bitsOffset);
  bytes.writeUInt16LE(8, bitsOffset + 2);
  bytes.writeUInt16LE(8, bitsOffset + 4);
  for (let offset = pixelsOffset; offset < bytes.byteLength; offset += 3) {
    bytes[offset] = 0x33;
    bytes[offset + 1] = 0x99;
    bytes[offset + 2] = 0xee;
  }
  return bytes;
}

test("a disposable sandboxed renderer decodes a 16 MP, 20 MB static PNG", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-native-image-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const imagePath = path.join(temporary, "large-reference.png");
  const thumbnailPath = path.join(temporary, "thumbnail.png");
  await fs.writeFile(imagePath, nearLimitStaticPng(), { flag: "wx", mode: 0o600 });
  const entry = path.join(
    repositoryRoot,
    "scripts",
    "fixtures",
    "create-images-native-image-entry.ts",
  );
  const bundle = path.join(temporary, "native-image-entry.cjs");
  const decoderPreload = path.join(temporary, "create-images-image-decoder.cjs");
  await Promise.all([
    build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron"],
      logLevel: "silent",
    }),
    build({
      entryPoints: [
        path.join(repositoryRoot, "renderer", "preload-create-images-image-decoder.ts"),
      ],
      outfile: decoderPreload,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron"],
      logLevel: "silent",
    }),
  ]);
  const electron = path.join(repositoryRoot, "node_modules", ".bin", "electron");
  const child = spawn(electron, [bundle, imagePath, thumbnailPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      AIDEN_CREATE_IMAGES_DECODER_PRELOAD: decoderPreload,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const outcome = await waitForBoundedChild(child, {
    label: "Create Images native decoder canary",
    timeoutMs: 30_000,
  });
  assert.equal(outcome.code, 0, stderr || stdout);
  assert.equal(outcome.signal, null, stderr || stdout);
  const line = stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("AIDEN_CREATE_IMAGES_NATIVE_IMAGE="));
  assert.ok(line, stderr || stdout);
  const result = JSON.parse(line.slice("AIDEN_CREATE_IMAGES_NATIVE_IMAGE=".length));
  assert.ok(result.inputBytes > 20 * 1024 * 1024);
  assert.equal(result.width, 4_000);
  assert.equal(result.height, 4_000);
  assert.ok(result.thumbnailBytes > 0 && result.thumbnailBytes < 4 * 1024 * 1024);
  assert.ok(result.thumbnailWidth <= 512 && result.thumbnailHeight <= 512);
  t.diagnostic(
    `20 MiB / 16 MP decode kept main private-memory growth to ${result.privateMemoryGrowthKb} KiB`,
  );
  assert.ok(
    result.privateMemoryGrowthKb < 96 * 1024,
    `main-process growth was ${result.privateMemoryGrowthKb} KiB`,
  );
});

test("the production ingest path normalizes a static WebP to canonical PNG", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-native-webp-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const imagePath = path.join(temporary, "reference.webp");
  const assetRoot = path.join(temporary, "assets");
  const workspacePath = path.join(temporary, "workspace");
  await fs.mkdir(workspacePath);
  await fs.writeFile(imagePath, Buffer.from(STATIC_WEBP_BASE64, "base64"), {
    flag: "wx",
    mode: 0o600,
  });
  const entry = path.join(
    repositoryRoot,
    "scripts",
    "fixtures",
    "create-images-native-import-entry.ts",
  );
  const bundle = path.join(temporary, "native-import-entry.cjs");
  const decoderPreload = path.join(temporary, "create-images-image-decoder.cjs");
  await Promise.all([
    build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron"],
      logLevel: "silent",
    }),
    build({
      entryPoints: [
        path.join(repositoryRoot, "renderer", "preload-create-images-image-decoder.ts"),
      ],
      outfile: decoderPreload,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron"],
      logLevel: "silent",
    }),
  ]);
  const electron = path.join(repositoryRoot, "node_modules", ".bin", "electron");
  const child = spawn(electron, [bundle, imagePath, assetRoot, workspacePath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      AIDEN_CREATE_IMAGES_DECODER_PRELOAD: decoderPreload,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const outcome = await waitForBoundedChild(child, {
    label: "Create Images native WebP import canary",
    timeoutMs: 30_000,
  });
  assert.equal(outcome.code, 0, stderr || stdout);
  assert.equal(outcome.signal, null, stderr || stdout);
  const line = stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("AIDEN_CREATE_IMAGES_NATIVE_IMPORT="));
  assert.ok(line, stderr || stdout);
  assert.deepEqual(JSON.parse(line.slice("AIDEN_CREATE_IMAGES_NATIVE_IMPORT=".length)), {
    mediaType: "image/png",
    width: 16,
    height: 12,
    displayName: "reference.webp",
    workspaceState: "ready",
    importedCount: 1,
  });
  const mirrored = await fs.readdir(path.join(workspacePath, "Imports"));
  assert.equal(mirrored.length, 1);
  assert.match(mirrored[0], /^reference-[a-f0-9]{64}\.png$/u);
});

test("the production ingest path uses the bounded macOS fallback for TIFF", async (t) => {
  if (process.platform !== "darwin") return t.skip("The ImageIO fallback is macOS-only.");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-native-tiff-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const imagePath = path.join(temporary, "scan.tiff");
  const assetRoot = path.join(temporary, "assets");
  const workspacePath = path.join(temporary, "workspace");
  await fs.mkdir(workspacePath);
  await fs.writeFile(imagePath, staticTiff(), { flag: "wx", mode: 0o600 });
  const bundle = path.join(temporary, "native-import-entry.cjs");
  const decoderPreload = path.join(temporary, "create-images-image-decoder.cjs");
  await Promise.all([
    build({
      entryPoints: [
        path.join(repositoryRoot, "scripts", "fixtures", "create-images-native-import-entry.ts"),
      ],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron"],
      logLevel: "silent",
    }),
    build({
      entryPoints: [
        path.join(repositoryRoot, "renderer", "preload-create-images-image-decoder.ts"),
      ],
      outfile: decoderPreload,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron"],
      logLevel: "silent",
    }),
  ]);
  const child = spawn(
    path.join(repositoryRoot, "node_modules", ".bin", "electron"),
    [bundle, imagePath, assetRoot, workspacePath],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        AIDEN_CREATE_IMAGES_DECODER_PRELOAD: decoderPreload,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const outcome = await waitForBoundedChild(child, {
    label: "Create Images native TIFF import canary",
    timeoutMs: 30_000,
  });
  assert.equal(outcome.code, 0, stderr || stdout);
  const line = stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("AIDEN_CREATE_IMAGES_NATIVE_IMPORT="));
  assert.ok(line, stderr || stdout);
  assert.deepEqual(JSON.parse(line.slice("AIDEN_CREATE_IMAGES_NATIVE_IMPORT=".length)), {
    mediaType: "image/png",
    width: 2,
    height: 2,
    displayName: "scan.tiff",
    workspaceState: "ready",
    importedCount: 1,
  });
});
