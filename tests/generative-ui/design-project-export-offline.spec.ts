import playwrightTest from "@playwright/test";
import type * as PlaywrightTestModule from "@playwright/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { buildDesignProjectExportBundle } from "../../main/services/design-project-export-core.js";
import { writeDesignProjectExport } from "../../main/services/design-project-export.js";

const { expect, test } = playwrightTest as unknown as typeof PlaywrightTestModule;

interface ExtractedEntry {
  path: string;
  bytes: Buffer;
  mode: number;
}

function extractStoredZip(zip: Buffer): ExtractedEntry[] {
  assert.ok(zip.byteLength >= 22);
  const endOffset = zip.byteLength - 22;
  assert.equal(zip.readUInt32LE(endOffset), 0x06054b50);
  const entryCount = zip.readUInt16LE(endOffset + 8);
  assert.equal(zip.readUInt16LE(endOffset + 10), entryCount);
  const centralSize = zip.readUInt32LE(endOffset + 12);
  const centralOffset = zip.readUInt32LE(endOffset + 16);
  assert.equal(centralOffset + centralSize, endOffset);

  const entries: ExtractedEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    assert.equal(zip.readUInt16LE(cursor + 8), 0x0800, "ZIP names must be UTF-8");
    assert.equal(zip.readUInt16LE(cursor + 10), 0, "acceptance fixture requires stored entries");
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const mode = zip.readUInt32LE(cursor + 38) >>> 16;
    const localOffset = zip.readUInt32LE(cursor + 42);
    const entryPath = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(compressedSize, uncompressedSize);
    assert.equal(extraLength, 0);
    assert.equal(commentLength, 0);
    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({
      path: entryPath,
      bytes: Buffer.from(zip.subarray(dataOffset, dataOffset + uncompressedSize)),
      mode,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, endOffset);
  return entries;
}

async function extractEntries(root: string, entries: readonly ExtractedEntry[]): Promise<void> {
  for (const entry of entries) {
    const destination = path.resolve(root, entry.path);
    const relative = path.relative(root, destination);
    assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`));
    assert.equal(path.isAbsolute(relative), false);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, entry.bytes, { mode: entry.mode & 0o777 });
  }
}

test("actual Design ZIP extracts, inspects, and executes offline without remote dependencies", async ({
  context,
  page,
}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-export-offline-"));
  try {
    const indexHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Offline Design acceptance</title></head>
  <body>
    <button id="increment" type="button">Increment</button>
    <output id="result">booting</output>
    <script>
      let count = 0;
      const result = document.querySelector('#result');
      result.textContent = 'ready';
      document.querySelector('#increment').addEventListener('click', () => {
        count += 1;
        result.textContent = 'count:' + count;
      });
    </script>
  </body>
</html>\n`;
    const contentHash = createHash("sha256").update(indexHtml, "utf8").digest("hex");
    const input = {
      projectId: "project:offline-acceptance",
      projectTitle: "Offline Acceptance",
      lineageId: "lineage:offline-acceptance",
      revision: 3,
      contentHash,
      sourceRevisionTimestamp: "2026-09-01T12:00:00.000Z",
      indexHtml,
      referenceAssets: [{ relativePath: "notes/context.txt", bytes: Buffer.from("local only\n") }],
    };
    const first = buildDesignProjectExportBundle(input);
    const second = buildDesignProjectExportBundle(input);
    assert.deepEqual(first.getZipBytes(), second.getZipBytes());

    const archivePath = path.join(root, first.fileName);
    await writeDesignProjectExport(archivePath, first.getZipBytes());
    const archiveBytes = await fs.readFile(archivePath);
    assert.deepEqual(archiveBytes, first.getZipBytes());
    const entries = extractStoredZip(archiveBytes);
    assert.deepEqual(
      entries.map(({ path: entryPath }) => entryPath),
      first.entryPaths,
    );
    assert.equal(
      entries.every(({ mode }) => mode === 0o100644),
      true,
    );
    const serializedArchive = Buffer.concat(entries.map(({ bytes }) => bytes)).toString("utf8");
    assert.doesNotMatch(serializedArchive, /(?:https?|wss?):\/\//iu);
    assert.doesNotMatch(serializedArchive, /file:\/\/|\/Users\/|[A-Za-z]:\\/u);
    assert.doesNotMatch(serializedArchive, /api[-_ ]?key|access[-_ ]?token|password/iu);

    const extractedRoot = path.join(root, "extracted");
    await extractEntries(extractedRoot, entries);
    const extractedIndex = path.join(extractedRoot, first.rootDirectory, "index.html");
    assert.equal(await fs.readFile(extractedIndex, "utf8"), indexHtml);
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(
          path.join(extractedRoot, first.rootDirectory, "design-project.json"),
          "utf8",
        ),
      ),
      first.manifest,
    );

    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await context.setOffline(true);
    await page.goto(pathToFileURL(extractedIndex).href);
    await expect(page).toHaveTitle("Offline Design acceptance");
    await expect(page.locator("#result")).toHaveText("ready");
    await page.getByRole("button", { name: "Increment" }).click();
    await expect(page.locator("#result")).toHaveText("count:1");
    assert.deepEqual(requests, [pathToFileURL(extractedIndex).href]);
  } finally {
    await context.setOffline(false);
    await fs.rm(root, { recursive: true, force: true });
  }
});
