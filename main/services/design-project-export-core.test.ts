import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MAX_DESIGN_EXPORT_ENTRIES,
  MAX_DESIGN_EXPORT_ENTRY_BYTES,
  MAX_DESIGN_EXPORT_TOTAL_BYTES,
  assertPortableDesignExportHtml,
  buildDesignProjectExportBundle,
  encodeDeterministicZip,
  normalizeDesignExportRelativePath,
  safeDesignExportSlug,
} from "./design-project-export-core.js";

interface ParsedZipEntry {
  path: string;
  bytes: Buffer;
  crc32: number;
  mode: number;
  dosTime: number;
  dosDate: number;
}

function independentCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const carry = crc & 1;
      crc >>>= 1;
      if (carry) crc ^= 0xedb88320;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseAndValidateZip(zip: Buffer): ParsedZipEntry[] {
  assert.ok(zip.byteLength >= 22);
  const endOffset = zip.byteLength - 22;
  assert.equal(zip.readUInt32LE(endOffset), 0x06054b50);
  assert.equal(zip.readUInt16LE(endOffset + 4), 0);
  assert.equal(zip.readUInt16LE(endOffset + 6), 0);
  const entryCount = zip.readUInt16LE(endOffset + 8);
  assert.equal(zip.readUInt16LE(endOffset + 10), entryCount);
  const centralSize = zip.readUInt32LE(endOffset + 12);
  const centralOffset = zip.readUInt32LE(endOffset + 16);
  assert.equal(zip.readUInt16LE(endOffset + 20), 0);
  assert.equal(centralOffset + centralSize, endOffset);

  const entries: ParsedZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    assert.equal(zip.readUInt16LE(cursor + 4), 0x0314);
    assert.equal(zip.readUInt16LE(cursor + 6), 20);
    assert.equal(zip.readUInt16LE(cursor + 8), 0x0800);
    assert.equal(zip.readUInt16LE(cursor + 10), 0);
    const dosTime = zip.readUInt16LE(cursor + 12);
    const dosDate = zip.readUInt16LE(cursor + 14);
    const expectedCrc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    assert.equal(zip.readUInt16LE(cursor + 34), 0);
    assert.equal(zip.readUInt16LE(cursor + 36), 0);
    const mode = zip.readUInt32LE(cursor + 38) >>> 16;
    const localOffset = zip.readUInt32LE(cursor + 42);
    const path = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(extraLength, 0);
    assert.equal(commentLength, 0);
    assert.equal(compressedSize, uncompressedSize);

    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(zip.readUInt16LE(localOffset + 4), 20);
    assert.equal(zip.readUInt16LE(localOffset + 6), 0x0800);
    assert.equal(zip.readUInt16LE(localOffset + 8), 0);
    assert.equal(zip.readUInt16LE(localOffset + 10), dosTime);
    assert.equal(zip.readUInt16LE(localOffset + 12), dosDate);
    assert.equal(zip.readUInt32LE(localOffset + 14), expectedCrc);
    assert.equal(zip.readUInt32LE(localOffset + 18), compressedSize);
    assert.equal(zip.readUInt32LE(localOffset + 22), uncompressedSize);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    assert.equal(localNameLength, nameLength);
    assert.equal(localExtraLength, 0);
    assert.equal(
      zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8"),
      path,
    );
    const dataOffset = localOffset + 30 + localNameLength;
    const bytes = zip.subarray(dataOffset, dataOffset + uncompressedSize);
    assert.equal(independentCrc32(bytes), expectedCrc);
    entries.push({ path, bytes: Buffer.from(bytes), crc32: expectedCrc, mode, dosTime, dosDate });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, endOffset);
  return entries;
}

const indexHtml =
  '<!doctype html><html><head><meta charset="utf-8"></head><body>café</body></html>\n';
const contentHash = createHash("sha256").update(indexHtml, "utf8").digest("hex");
const baseInput = {
  projectId: "design:project-1",
  projectTitle: "Café Launch",
  lineageId: "lineage:hero-1",
  revision: 7,
  contentHash,
  sourceRevisionTimestamp: "2026-08-31T12:34:56.789Z",
  indexHtml,
};

test("deterministic bundle round-trips canonical files, CRCs, modes, and timestamps", () => {
  const firstBytes = Buffer.from([1, 2, 3, 4]);
  const bundle = buildDesignProjectExportBundle({
    ...baseInput,
    referenceAssets: [
      { relativePath: "zeta/photo.png", bytes: Buffer.from("image-z") },
      { relativePath: "équipe.png", bytes: firstBytes },
    ],
  });
  firstBytes[0] = 99;

  assert.equal(bundle.fileName, "café-launch.zip");
  assert.equal(bundle.rootDirectory, "café-launch");
  assert.ok(Object.isFrozen(bundle));
  assert.ok(Object.isFrozen(bundle.manifest));
  assert.deepEqual(bundle.entryPaths, [
    "café-launch/README.md",
    "café-launch/design-project.json",
    "café-launch/index.html",
    "café-launch/references/zeta/photo.png",
    "café-launch/references/équipe.png",
  ]);

  const entries = parseAndValidateZip(bundle.getZipBytes());
  assert.deepEqual(
    entries.map((entry) => entry.path),
    bundle.entryPaths,
  );
  for (const entry of entries) {
    assert.equal(entry.mode, 0o100644);
    assert.equal(entry.dosTime, 0);
    assert.equal(entry.dosDate, 33);
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get("café-launch/index.html")?.bytes.toString("utf8"), indexHtml);
  assert.deepEqual(
    byPath.get("café-launch/references/équipe.png")?.bytes,
    Buffer.from([1, 2, 3, 4]),
  );
  const manifestBytes = byPath.get("café-launch/design-project.json")?.bytes;
  assert.ok(manifestBytes);
  assert.equal(manifestBytes.toString("utf8"), bundle.manifestJson);
  assert.equal(JSON.parse(bundle.manifestJson).source.contentHash, contentHash);
  assert.match(bundle.readmeMarkdown, /2026-08-31T12:34:56\.789Z/u);
  assert.doesNotMatch(bundle.readmeMarkdown, /exportedAt|generatedAt/iu);
});

test("semantically identical inputs produce byte-identical ZIPs regardless of reference order", () => {
  const references = [
    { relativePath: "b.png", bytes: Buffer.from("b") },
    { relativePath: "a.png", bytes: Buffer.from("a") },
  ];
  const first = buildDesignProjectExportBundle({ ...baseInput, referenceAssets: references });
  const second = buildDesignProjectExportBundle({
    ...baseInput,
    referenceAssets: [...references].reverse(),
  });
  assert.deepEqual(first.getZipBytes(), second.getZipBytes());

  const exposed = first.getZipBytes();
  exposed.fill(0);
  assert.deepEqual(first.getZipBytes(), second.getZipBytes());
});

test("ZIP CRC uses the interoperable IEEE value and central offsets remain valid", () => {
  const zip = encodeDeterministicZip([
    { path: "known.txt", bytes: Buffer.from("123456789") },
    { path: "empty.txt", bytes: Buffer.alloc(0) },
  ]);
  const entries = parseAndValidateZip(zip);
  assert.equal(entries.find((entry) => entry.path === "known.txt")?.crc32, 0xcbf43926);
  assert.equal(entries.find((entry) => entry.path === "empty.txt")?.crc32, 0);
});

test("path helpers preserve safe Unicode and reject traversal, aliases, and unsafe names", () => {
  assert.equal(safeDesignExportSlug("  Démo / 日本  "), "démo-日本");
  assert.equal(safeDesignExportSlug("<>"), "design-project");
  assert.equal(normalizeDesignExportRelativePath("screens/e\u0301quipe.png"), "screens/équipe.png");
  for (const path of [
    "../secret",
    "a/../../secret",
    "/absolute",
    "C:\\secret",
    "safe\\secret",
    "a//b",
    "CON.txt",
    "trailing. ",
    "bad\0name",
    "bad\ud800name",
  ]) {
    assert.throws(() => normalizeDesignExportRelativePath(path), /Design export paths/u);
  }
  assert.throws(
    () =>
      encodeDeterministicZip([
        { path: "A.txt", bytes: Buffer.alloc(0) },
        { path: "a.txt", bytes: Buffer.alloc(0) },
      ]),
    /unique/u,
  );
  assert.throws(
    () =>
      encodeDeterministicZip([
        { path: "e\u0301.txt", bytes: Buffer.alloc(0) },
        { path: "é.txt", bytes: Buffer.alloc(0) },
      ]),
    /unique/u,
  );
});

test("builders reject budget violations, stale hashes, timestamps, and unsafe HTML", () => {
  assert.throws(
    () =>
      encodeDeterministicZip(
        Array.from({ length: MAX_DESIGN_EXPORT_ENTRIES + 1 }, (_, index) => ({
          path: `${index}.txt`,
          bytes: Buffer.alloc(0),
        })),
      ),
    /1-103/u,
  );
  assert.throws(
    () =>
      encodeDeterministicZip([
        { path: "large", bytes: new Uint8Array(MAX_DESIGN_EXPORT_ENTRY_BYTES + 1) },
      ]),
    /per-file/u,
  );
  const sharedBudgetBytes = new Uint8Array(MAX_DESIGN_EXPORT_ENTRY_BYTES);
  const overBudgetCount =
    Math.floor(MAX_DESIGN_EXPORT_TOTAL_BYTES / sharedBudgetBytes.byteLength) + 1;
  assert.throws(
    () =>
      encodeDeterministicZip(
        Array.from({ length: overBudgetCount }, (_, index) => ({
          path: `budget-${index}`,
          bytes: sharedBudgetBytes,
        })),
      ),
    /total byte limit/u,
  );
  assert.throws(
    () => buildDesignProjectExportBundle({ ...baseInput, contentHash: "0".repeat(64) }),
    /does not match/u,
  );
  assert.throws(
    () =>
      buildDesignProjectExportBundle({
        ...baseInput,
        sourceRevisionTimestamp: "2026-08-31T12:34:56Z",
      }),
    /canonical UTC/u,
  );
  for (const unsafe of [
    '<!doctype html><html><script src="https://cdn.example/app.js"></script></html>',
    "<!doctype html><html><style>@import '//cdn.example/app.css';</style></html>",
    "<!doctype html><html><script>fetch('https://api.example/data')</script></html>",
    "<!doctype html><html><script>new WebSocket('wss://example.test')</script></html>",
    "<!doctype html><html><body>file:///Users/person/private.js</body></html>",
    "<!doctype html><html><script>const api_key = 'private-secret-value'</script></html>",
  ]) {
    assert.throws(
      () => assertPortableDesignExportHtml(unsafe),
      /remote URLs|absolute paths|credentials/u,
    );
  }
  assert.doesNotThrow(() =>
    assertPortableDesignExportHtml(
      "<!doctype html><html><script>//compact-comment\nconst label = 'https://example.test is text';</script></html>",
    ),
  );
});
