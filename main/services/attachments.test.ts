import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  attachmentIngestionRepresentationBytes,
  AttachmentIngestionAdmission,
  imageBytesMatchMime,
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_ATTACHMENT_INGESTION_REPRESENTATION_BYTES,
  MAX_CLIPBOARD_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS,
  MAX_TEXT_READ_BYTES,
  readClipboardAttachments,
  readPickedAttachments,
} from "./attachments.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../renderer/shared/attachment-contract.js";

const temporaryDirectories: string[] = [];
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
const ONE_PIXEL_PNG = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
const ONE_PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

function paddedPngBytes(size: number): Buffer {
  assert.ok(size >= ONE_PIXEL_PNG.byteLength);
  const bytes = Buffer.alloc(size);
  ONE_PIXEL_PNG.copy(bytes);
  return bytes;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryFile(name: string, contents: Uint8Array): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-attachments-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, contents);
  return filePath;
}

test("picked text files are read through a bounded prefix and truncated", async () => {
  const filePath = await temporaryFile("large.txt", Buffer.alloc(MAX_TEXT_READ_BYTES, "a"));
  const sparseSize = 512 * 1024 * 1024;
  const handle = await fs.open(filePath, "r+");
  await handle.truncate(sparseSize);
  await handle.close();

  const [attachment] = await readPickedAttachments([filePath]);
  assert.equal(attachment.kind, "text");
  assert.equal(attachment.size, sparseSize);
  assert.ok((attachment.text?.length ?? 0) <= MAX_TEXT_CHARS);
  assert.match(attachment.text ?? "", /\[truncated\]$/);
});

test("a bounded text prefix drops only an incomplete trailing UTF-8 code point", async () => {
  const prefix = Buffer.alloc(MAX_TEXT_READ_BYTES - 1, "a");
  const filePath = await temporaryFile(
    "multibyte.txt",
    Buffer.concat([prefix, Buffer.from("€tail", "utf8")]),
  );
  const [attachment] = await readPickedAttachments([filePath]);
  assert.equal(attachment.kind, "text");
  assert.match(attachment.text ?? "", /\[truncated\]$/);
});

test("picked binary-looking text is rejected without returning bytes", async () => {
  const filePath = await temporaryFile("secret.bin", Buffer.from([97, 0, 98]));
  await assert.rejects(readPickedAttachments([filePath]), /isn't a supported text or image file/);
});

test("empty images are rejected before they can create an unsendable composer chip", async () => {
  const filePath = await temporaryFile("empty.png", Buffer.alloc(0));
  await assert.rejects(readPickedAttachments([filePath]), /empty/);
});

test("unreadable picker selections fail the batch instead of disappearing silently", async () => {
  await assert.rejects(
    readPickedAttachments([path.join(os.tmpdir(), "aiden-missing-attachment")]),
    /couldn't be read/,
  );
});

test("picked attachment reads enforce count and owner lifetime", async () => {
  await assert.rejects(
    readPickedAttachments(
      Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => "/not-read"),
    ),
    /Up to 20 files/,
  );

  const filePath = await temporaryFile("note.txt", Buffer.from("hello"));
  await assert.rejects(
    readPickedAttachments([filePath], { isActive: () => false }),
    /no longer active/,
  );
});

test("picked attachment reads enforce one aggregate byte budget sequentially", async () => {
  const first = await temporaryFile("first.png", ONE_PIXEL_PNG);
  const second = await temporaryFile("second.png", ONE_PIXEL_PNG);
  await assert.rejects(
    readPickedAttachments([first, second], {
      maxBatchBytes: ONE_PIXEL_PNG.byteLength * 2 - 1,
    }),
    /batch limit/,
  );
});

test("picked attachment reads reject a file that grows after the bounded read", async () => {
  const filePath = await temporaryFile("growing.png", ONE_PIXEL_PNG);
  await assert.rejects(
    readPickedAttachments([filePath], {
      beforeConsistencyCheck: async (selectedPath) => {
        await fs.appendFile(selectedPath, Buffer.from([4]));
      },
    }),
    /changed while it was being attached/,
  );
});

test("picked images must match the raster type selected by their extension", async () => {
  const filePath = await temporaryFile("mislabeled.png", ONE_PIXEL_GIF);
  await assert.rejects(readPickedAttachments([filePath]), /doesn't match its image file type/u);
});

test("picked attachment reads reject an ancestor redirected before open", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-attachment-ancestor-"));
  temporaryDirectories.push(directory);
  const selectedDirectory = path.join(directory, "selected");
  const displacedDirectory = path.join(directory, "selected-original");
  const attackerDirectory = path.join(directory, "attacker");
  await fs.mkdir(selectedDirectory);
  await fs.mkdir(attackerDirectory);
  const selectedPath = path.join(selectedDirectory, "note.txt");
  await fs.writeFile(selectedPath, "USER_SELECTED");
  await fs.writeFile(path.join(attackerDirectory, "note.txt"), "ATTACKER_REDIRECTED_SECRET");

  await assert.rejects(
    readPickedAttachments([selectedPath], {
      beforeOpen: async () => {
        await fs.rename(selectedDirectory, displacedDirectory);
        await fs.symlink(attackerDirectory, selectedDirectory);
      },
    }),
    /couldn't be read|path changed/u,
  );
});

test("picked attachment reads reject an ancestor directory replaced during identity capture", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-attachment-capture-race-"));
  temporaryDirectories.push(directory);
  const selectedDirectory = path.join(directory, "selected");
  const displacedDirectory = path.join(directory, "selected-original");
  await fs.mkdir(selectedDirectory);
  const selectedPath = path.join(selectedDirectory, "note.txt");
  await fs.writeFile(selectedPath, "USER_SELECTED");

  await assert.rejects(
    readPickedAttachments([selectedPath], {
      afterLexicalCapture: async () => {
        await fs.rename(selectedDirectory, displacedDirectory);
        await fs.mkdir(selectedDirectory);
        await fs.writeFile(selectedPath, "ATTACKER_REPLACEMENT_SECRET");
      },
    }),
    /couldn't be read safely|path changed/u,
  );
});

test("picked attachment reads reject same-inode content replacement before open", async () => {
  const selectedPath = await temporaryFile("same-inode.txt", Buffer.from("USER_SELECTED"));
  const before = await fs.stat(selectedPath);
  await assert.rejects(
    readPickedAttachments([selectedPath], {
      beforeOpen: async () => {
        await fs.writeFile(selectedPath, "ATTACKER_DATA");
      },
    }),
    /path changed/u,
  );
  const after = await fs.stat(selectedPath);
  assert.equal(after.ino, before.ino);
});

test("picked attachment reads reject a picker path already redirected through an ancestor", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-attachment-preopen-"));
  temporaryDirectories.push(directory);
  const selectedDirectory = path.join(directory, "selected");
  const displacedDirectory = path.join(directory, "selected-original");
  const attackerDirectory = path.join(directory, "attacker");
  await fs.mkdir(selectedDirectory);
  await fs.mkdir(attackerDirectory);
  const selectedPath = path.join(selectedDirectory, "note.txt");
  await fs.writeFile(selectedPath, "USER_SELECTED");
  await fs.writeFile(path.join(attackerDirectory, "note.txt"), "ATTACKER_REDIRECTED_SECRET");
  await fs.rename(selectedDirectory, displacedDirectory);
  await fs.symlink(attackerDirectory, selectedDirectory);

  await assert.rejects(readPickedAttachments([selectedPath]), /couldn't be read safely/u);
});

test("clipboard images are bounded, raster-only, and detached from renderer bytes", () => {
  const source = new Uint8Array(ONE_PIXEL_PNG);
  const [attachment] = readClipboardAttachments(
    [{ mimeType: "image/png", bytes: source }],
    1,
    MAX_ATTACHMENT_BATCH_BYTES,
  );
  assert.deepEqual(
    {
      name: attachment.name,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
      size: attachment.size,
      data: attachment.data,
    },
    {
      name: "Pasted image.png",
      mimeType: "image/png",
      kind: "image",
      size: ONE_PIXEL_PNG.byteLength,
      data: ONE_PIXEL_PNG_BASE64,
    },
  );
  source.fill(9);
  assert.equal(attachment.data, ONE_PIXEL_PNG_BASE64);

  assert.throws(
    () =>
      readClipboardAttachments(
        [{ mimeType: "image/svg+xml", bytes: new Uint8Array([1]) }],
        1,
        MAX_ATTACHMENT_BATCH_BYTES,
      ),
    /Invalid clipboard/u,
  );
  assert.throws(
    () =>
      readClipboardAttachments(
        Array.from({ length: MAX_CLIPBOARD_IMAGES + 1 }, () => ({
          mimeType: "image/png",
          bytes: new Uint8Array(ONE_PIXEL_PNG),
        })),
        MAX_CLIPBOARD_IMAGES,
        MAX_ATTACHMENT_BATCH_BYTES,
      ),
    /Invalid clipboard/u,
  );
  assert.throws(
    () =>
      readClipboardAttachments(
        [{ mimeType: "image/png", bytes: new Uint8Array(paddedPngBytes(MAX_IMAGE_BYTES)) }],
        1,
        MAX_IMAGE_BYTES - 1,
      ),
    /remaining attachment data limit/u,
  );
  assert.throws(
    () =>
      readClipboardAttachments(
        [{ mimeType: "image/png", bytes: new Uint8Array(ONE_PIXEL_GIF) }],
        1,
        MAX_ATTACHMENT_BATCH_BYTES,
      ),
    /do not match the declared image type/u,
  );
});

test("canonical raster signatures match only their declared MIME", () => {
  const signatures = [
    [ONE_PIXEL_PNG, "image/png"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [ONE_PIXEL_GIF, "image/gif"],
    [Buffer.from("RIFF\x00\x00\x00\x00WEBP", "binary"), "image/webp"],
    [Buffer.from("BM", "ascii"), "image/bmp"],
    [Buffer.from("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heic", "binary"), "image/heic"],
    [Buffer.from("\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00mif1", "binary"), "image/heif"],
  ] as const;
  for (const [bytes, mimeType] of signatures) {
    assert.equal(imageBytesMatchMime(bytes, mimeType), true, mimeType);
  }
  assert.equal(imageBytesMatchMime(ONE_PIXEL_GIF, "image/png"), false);
  assert.equal(imageBytesMatchMime(ONE_PIXEL_PNG, "image/jpeg"), false);
});

test("attachment admission rejects concurrent work from one document until final release", () => {
  const admission = new AttachmentIngestionAdmission();
  const representationBytes = attachmentIngestionRepresentationBytes(1024, 1);
  const first = admission.acquire("document-a", 1, representationBytes);

  assert.throws(
    () => admission.acquire("document-a", 1, representationBytes),
    /already running for this window/u,
  );
  first.cancel();
  assert.equal(first.isActive(), false);
  assert.throws(
    () => admission.acquire("document-a", 1, representationBytes),
    /already running for this window/u,
    "owner cancellation must not free accounting before the operation's finally block",
  );

  first.release();
  first.release();
  const replacement = admission.acquire("document-a", 1, representationBytes);
  assert.equal(replacement.isActive(), true);
  replacement.release();
});

test("attachment admission enforces global concurrent count and representation budgets", () => {
  const representationBytes = attachmentIngestionRepresentationBytes(1024, 1);
  const countAdmission = new AttachmentIngestionAdmission({
    maxGlobalActive: 4,
    maxGlobalAttachments: 2,
  });
  const first = countAdmission.acquire("document-a", 1, representationBytes);
  const second = countAdmission.acquire("document-b", 1, representationBytes);
  assert.throws(
    () => countAdmission.acquire("document-c", 1, representationBytes),
    /Too many attachment requests/u,
  );
  first.release();
  const replacement = countAdmission.acquire("document-c", 1, representationBytes);
  replacement.release();
  second.release();

  const byteAdmission = new AttachmentIngestionAdmission({
    maxGlobalActive: 4,
    maxGlobalAttachments: 4,
    maxGlobalRepresentationBytes: representationBytes * 2 - 1,
  });
  const retained = byteAdmission.acquire("document-a", 1, representationBytes);
  assert.throws(
    () => byteAdmission.acquire("document-b", 1, representationBytes),
    /Too many attachment requests/u,
  );
  retained.release();
  const afterRelease = byteAdmission.acquire("document-b", 1, representationBytes);
  afterRelease.release();

  assert.throws(
    () =>
      countAdmission.acquire("document-d", 1, MAX_ATTACHMENT_INGESTION_REPRESENTATION_BYTES + 1),
    /Invalid attachment ingestion reservation/u,
  );
});
