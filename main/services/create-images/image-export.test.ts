import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { OutputRef } from "../../../renderer/shared/images/run-types.js";
import {
  CreateImagesExports,
  exportDayFolder,
  exportFileName,
  writeUniqueFile,
  type CreateImagesExportsOptions,
  type ExportFileSystem,
} from "./image-export.js";

const ASSET = "ab12cd34".padEnd(64, "0");
const OTHER = "ef56ab78".padEnd(64, "1");
const ref = (assetId = ASSET, mediaType: OutputRef["mediaType"] = "image/png") => ({ assetId, mediaType });
/** 31 October 2026, 07:05:09 local time. */
const AT = new Date(2026, 9, 31, 7, 5, 9).getTime();

async function directory(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-image-export-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name))).sort();
}

function exporter(root: string | null, overrides: Partial<CreateImagesExportsOptions> = {}) {
  const recorded = new Map<string, string>();
  const reads: string[] = [];
  const issues: string[] = [];
  const exports = new CreateImagesExports({
    root: root === null ? null : () => root,
    ledger: {
      exportPath: (assetId) => recorded.get(assetId),
      exportPaths: () => new Map(recorded),
      recordExport: (assetId, file) => void recorded.set(assetId, file),
    },
    assets: {
      read: async (assetId) => {
        reads.push(assetId);
        return { record: {} as never, bytes: Buffer.from(`bytes of ${assetId.slice(0, 8)}`) };
      },
    },
    now: () => AT,
    reportIssue: (message) => void issues.push(message),
    ...overrides,
  });
  return { exports, recorded, reads, issues };
}

test("names use the local day folder, local time, a safe workflow title and the hash prefix", () => {
  assert.equal(exportDayFolder(AT), "2026-10-31");
  assert.equal(exportFileName({ at: AT, workflowTitle: "Bikes", assetId: ASSET, mediaType: "image/png" }), "070509 Bikes ab12cd34.png");
  assert.equal(exportFileName({ at: AT, workflowTitle: "Spring/Summer: v1.2", assetId: ASSET, mediaType: "image/jpeg" }), "070509 Spring Summer v1.2 ab12cd34.jpg");
  // A title that cleans to nothing, or no title at all, falls back to "Image".
  assert.equal(exportFileName({ at: AT, workflowTitle: "..//", assetId: ASSET, mediaType: "image/webp" }), "070509 Image ab12cd34.webp");
  assert.equal(exportFileName({ at: AT, assetId: ASSET, mediaType: "image/png" }), "070509 Image ab12cd34.png");
  // Right-to-left overrides could disguise the extension in a file manager.
  assert.equal(exportFileName({ at: AT, workflowTitle: "evil‮gnp.exe", assetId: ASSET, mediaType: "image/png" }), "070509 evil gnp.exe ab12cd34.png");
  const long = exportFileName({ at: AT, workflowTitle: "é".repeat(500), assetId: ASSET, mediaType: "image/png" });
  assert.ok(Buffer.byteLength(long) < 255, `${Buffer.byteLength(long)} bytes`);
});

test("names of long CJK and emoji titles stay under the 255-byte name limit, with a suffix, and never split a character", async (t) => {
  const titles = {
    cjk: "東京の夜景".repeat(16), // 80 three-byte characters
    emoji: "🚲".repeat(60), // 60 four-byte characters, two UTF-16 units each
    family: "👨‍👩‍👧‍👦".repeat(30), // 25-byte graphemes made of joined code points
    flags: "🇯🇵".repeat(60),
    accents: "e\u0301".repeat(150), // a letter plus a combining accent
  };
  const root = await directory(t);
  for (const [kind, workflowTitle] of Object.entries(titles)) {
    const name = exportFileName({ at: AT, workflowTitle, assetId: ASSET, mediaType: "image/webp" });
    const suffixed = name.replace(/\.webp$/u, " (999).webp");
    assert.ok(Buffer.byteLength(suffixed) <= 255, `${kind}: ${Buffer.byteLength(suffixed)} bytes`);
    assert.match(name, /^070509 .+ ab12cd34\.webp$/u, kind);
    // The kept title is a whole-grapheme prefix of the original: nothing cut mid-character.
    const title = name.slice("070509 ".length, -" ab12cd34.webp".length);
    assert.ok(title.length > 0 && workflowTitle.startsWith(title), kind);
    const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(workflowTitle)].map((part) => part.segment);
    assert.ok(segments.some((_, count) => segments.slice(0, count + 1).join("") === title), `${kind} ends between graphemes`);
    assert.equal(title.includes("\uFFFD"), false);
    // The real file system accepts the name and its numbered sibling.
    const first = await writeUniqueFile(fs as unknown as ExportFileSystem, root, name, Buffer.from(kind));
    const second = await writeUniqueFile(fs as unknown as ExportFileSystem, root, name, Buffer.from(kind));
    assert.equal(path.basename(second), name.replace(/\.webp$/u, " (1).webp"));
    assert.equal(await fs.readFile(first, "utf8"), kind);
  }
});

test("a write cut short leaves no file under the image's name, and folders without hard links still save", async (t) => {
  const root = await directory(t);
  const real = fs as unknown as ExportFileSystem;
  // Mid-write (where a forced quit could stop it) only a hidden staging file exists.
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let halfway = false;
  const slow: ExportFileSystem = {
    ...real,
    open: async (target, flags, mode) => {
      const handle = await real.open(target, flags, mode);
      return {
        writeFile: async (data: Uint8Array) => {
          await handle.writeFile(data.subarray(0, 3));
          halfway = true;
          await paused;
          await handle.writeFile(data.subarray(3));
        },
        close: () => handle.close(),
      };
    },
  };
  const writing = writeUniqueFile(slow, root, "slow.png", Buffer.from("complete bytes"));
  while (!halfway) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await fs.readdir(root)).filter((name) => !name.startsWith(".")), []);
  resume();
  assert.equal(await fs.readFile(await writing, "utf8"), "complete bytes");
  assert.deepEqual(await fs.readdir(root), ["slow.png"]);
  await fs.rm(path.join(root, "slow.png"));

  // The disk fills mid-write: the staging file is removed and the visible name never appears.
  const full: ExportFileSystem = {
    ...real,
    open: async (target, flags, mode) => {
      const handle = await real.open(target, flags, mode);
      return {
        writeFile: async (data: Uint8Array) => {
          await handle.writeFile(data.subarray(0, 3));
          throw Object.assign(new Error(`ENOSPC: no space left on device, write '${target}'`), { code: "ENOSPC" });
        },
        close: () => handle.close(),
      };
    },
  };
  await assert.rejects(writeUniqueFile(full, root, "cut.png", Buffer.from("complete bytes")), /ENOSPC/u);
  assert.deepEqual(await fs.readdir(root), []);

  // A volume that refuses hard links (some external and network drives) gets the file written in place.
  const noLinks: ExportFileSystem = {
    ...real,
    link: async () => {
      throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
    },
  };
  const first = await writeUniqueFile(noLinks, root, "x.png", Buffer.from("one"));
  const second = await writeUniqueFile(noLinks, root, "x.png", Buffer.from("two"));
  assert.deepEqual((await fs.readdir(root)).sort(), ["x (1).png", "x.png"]);
  assert.deepEqual([await fs.readFile(first, "utf8"), await fs.readFile(second, "utf8")], ["one", "two"]);
});

test("a taken name gets a numbered suffix and nothing is overwritten", async (t) => {
  const root = await directory(t);
  const folder = path.join(root, "a", "b");
  const first = await writeUniqueFile(fs as unknown as ExportFileSystem, folder, "x.png", Buffer.from("one"));
  const second = await writeUniqueFile(fs as unknown as ExportFileSystem, folder, "x.png", Buffer.from("two"));
  assert.deepEqual([path.basename(first), path.basename(second)], ["x.png", "x (1).png"]);
  assert.equal(await fs.readFile(first, "utf8"), "one");
  assert.equal(await fs.readFile(second, "utf8"), "two");
});

test("auto-save writes each image once into the dated folder and records where it went", async (t) => {
  const root = await directory(t);
  const env = exporter(root);
  env.exports.autoSave([ref(), ref(OTHER, "image/jpeg")], "Bikes");
  await env.exports.whenIdle();
  assert.deepEqual(await filesUnder(root), ["2026-10-31/070509 Bikes ab12cd34.png", "2026-10-31/070509 Bikes ef56ab78.jpg"]);
  assert.equal(env.recorded.get(ASSET), path.join(root, "2026-10-31", "070509 Bikes ab12cd34.png"));
  assert.equal(await fs.readFile(env.recorded.get(ASSET)!, "utf8"), "bytes of ab12cd34");

  // Already exported and still there: no second copy, no second read.
  env.exports.autoSave([ref()], "Bikes");
  await env.exports.whenIdle();
  assert.equal(await env.exports.ensureExported(ref(), "Bikes"), env.recorded.get(ASSET));
  assert.deepEqual(env.reads.filter((assetId) => assetId === ASSET).length, 1);
  assert.deepEqual([...(await env.exports.savedAssetIds([ASSET, OTHER, "f".repeat(64)]))].sort(), [ASSET, OTHER]);
  assert.deepEqual(env.issues, []);
});

test("a moved or deleted copy counts as unsaved and is written again on demand", async (t) => {
  const root = await directory(t);
  const env = exporter(root);
  const first = await env.exports.ensureExported(ref(), "Bikes");
  await fs.rm(first);
  assert.equal(await env.exports.savedPath(ASSET), undefined);
  assert.deepEqual([...(await env.exports.savedAssetIds([ASSET]))], []);
  const again = await env.exports.ensureExported(ref(), "Bikes");
  assert.equal(await fs.readFile(again, "utf8"), "bytes of ab12cd34");
  assert.equal(await env.exports.savedPath(ASSET), again);
});

test("concurrent requests for the same image write one copy", async (t) => {
  const root = await directory(t);
  const env = exporter(root);
  const [left, right] = await Promise.all([env.exports.ensureExported(ref(), "A"), env.exports.ensureExported(ref(), "A")]);
  assert.equal(left, right);
  assert.equal((await filesUnder(root)).length, 1);
});

test("a failing auto-save is reported by error code only, never thrown, and records nothing", async (t) => {
  const root = await directory(t);
  const denied: ExportFileSystem = {
    ...(fs as unknown as ExportFileSystem),
    open: async (target) => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${target}'`), { code: "EACCES" });
    },
  };
  const reported: unknown[] = [];
  const env = exporter(root, { fs: denied, reportIssue: (message, error) => void reported.push(message, error) });
  assert.doesNotThrow(() => env.exports.autoSave([ref()], "Secret Bikes"));
  await env.exports.whenIdle();
  assert.equal(env.recorded.size, 0);
  // The fs message names the path, and so the workflow title; the log gets the code alone.
  assert.deepEqual(reported, ["Could not auto-save a generated image to the Pictures folder.", "EACCES"]);
  await assert.rejects(env.exports.ensureExported(ref(), "Bikes"), /EACCES/u);
});

test("without a save folder nothing is written and folder access is refused", async () => {
  const env = exporter(null);
  assert.equal(env.exports.available(), false);
  env.exports.autoSave([ref()], "Bikes");
  await env.exports.whenIdle();
  assert.deepEqual([env.reads, env.recorded.size], [[], 0]);
  assert.throws(() => env.exports.folder(), /isn't available/u);
  assert.equal(env.exports.folderLabel, "Pictures › Aiden › Create Images");
});
