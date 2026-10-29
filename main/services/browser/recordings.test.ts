import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  browserRecordingsFolder,
  findBrowserRecording,
  readBrowserRecording,
} from "./recordings.js";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x24]), Buffer.from("ftypisom", "ascii"), Buffer.alloc(24, 1)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28, 2)]);
const MP4_ID = "recording-0f1e2d3c-4b5a-4678-9abc-def012345678";
const WEBM_ID = "recording-11111111-2222-4333-8444-555555555555";

async function store() {
  const userData = await mkdtemp(path.join(tmpdir(), "aiden-recordings-"));
  const folder = browserRecordingsFolder(userData);
  await mkdir(folder, { recursive: true });
  return { userData, folder, cleanup: () => rm(userData, { recursive: true, force: true }) };
}

test("a recording is read back by its id after a relaunch, as MP4 or WebM", async () => {
  const { userData, folder, cleanup } = await store();
  try {
    await writeFile(path.join(folder, `${MP4_ID}.mp4`), MP4);
    await writeFile(path.join(folder, `${WEBM_ID}.webm`), WEBM);
    assert.deepEqual(await readBrowserRecording(userData, MP4_ID), { mimeType: "video/mp4", data: MP4 });
    assert.deepEqual(await readBrowserRecording(userData, WEBM_ID), { mimeType: "video/webm", data: WEBM });
    assert.equal((await findBrowserRecording(userData, MP4_ID))?.path, path.join(folder, `${MP4_ID}.mp4`));
    assert.equal(await readBrowserRecording(userData, "recording-99999999-2222-4333-8444-555555555555"), undefined);
  } finally {
    await cleanup();
  }
});

test("only the recorder's own ids, files and video bytes are ever opened", async () => {
  const { userData, folder, cleanup } = await store();
  try {
    const outside = path.join(userData, "secret.mp4");
    await writeFile(outside, MP4);
    for (const id of ["../secret", "recording-../../secret", `${MP4_ID}/..`, "secret", ""]) {
      assert.equal(await findBrowserRecording(userData, id), undefined, id);
    }
    // A link planted under a recording's name is not followed.
    await symlink(outside, path.join(folder, `${MP4_ID}.mp4`));
    assert.equal(await readBrowserRecording(userData, MP4_ID), undefined);
    // Bytes that aren't the video their name says are refused.
    await writeFile(path.join(folder, `${WEBM_ID}.webm`), MP4);
    assert.equal(await readBrowserRecording(userData, WEBM_ID), undefined);
  } finally {
    await cleanup();
  }
});
