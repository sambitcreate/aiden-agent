import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_TEXT_CHARS,
  MAX_TEXT_READ_BYTES,
  readPickedAttachments,
} from "./attachments.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../renderer/shared/attachment-contract.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
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
  await assert.rejects(
    readPickedAttachments([filePath]),
    /isn't a supported text or image file/,
  );
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
  const first = await temporaryFile("first.png", Buffer.from([1, 2, 3]));
  const second = await temporaryFile("second.png", Buffer.from([4, 5, 6]));
  await assert.rejects(
    readPickedAttachments([first, second], { maxBatchBytes: 5 }),
    /batch limit/,
  );
});

test("picked attachment reads reject a file that grows after the bounded read", async () => {
  const filePath = await temporaryFile("growing.png", Buffer.from([1, 2, 3]));
  await assert.rejects(
    readPickedAttachments([filePath], {
      beforeConsistencyCheck: async (selectedPath) => {
        await fs.appendFile(selectedPath, Buffer.from([4]));
      },
    }),
    /changed while it was being attached/,
  );
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
