import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesignAppRecords, DESIGN_APP_RECORD_CAPS } from "./app-records.js";

async function recordsFile(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiden-design-records-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "design-apps.json");
}

test("approveShown stores the consent with installShown only when the shown fingerprint still matches", async (t) => {
  const file = await recordsFile(t);
  const records = createDesignAppRecords(() => file);
  assert.equal(await records.consentOf("ws", "apps/web"), undefined);
  assert.equal(await records.approveShown("ws", "apps/web", { script: "dev", installShown: true }, "F1", "F2"), false, "the repo changed after the card was shown");
  assert.equal(await records.consentOf("ws", "apps/web"), undefined);
  assert.equal(await records.approveShown("ws", "apps/web", { script: "dev", installShown: true }, "F1", "F1"), true);
  const consent = await records.consentOf("ws", "apps/web");
  assert.equal(consent?.fingerprint, "F1");
  assert.equal(consent?.script, "dev");
  assert.equal(consent?.installShown, true);
  assert.equal(typeof consent?.at, "number");
  // A reread from disk sees the same.
  assert.equal((await createDesignAppRecords(() => file).consentOf("ws", "apps/web"))?.fingerprint, "F1");
});

test("an unreadable or invalid records file means no consent, no stamp and no port", async (t) => {
  for (const content of ["{not json", JSON.stringify({ version: 2, workspaces: {} }), "folder"]) {
    const file = await recordsFile(t);
    const good = createDesignAppRecords(() => file);
    await good.approveShown("ws", ".", { script: "dev", installShown: false }, "F", "F");
    await good.setPort("ws", ".", 5173);
    await good.markInstall("ws", ".", { state: "done", manager: "npm", lockHash: "L" });
    if (content === "folder") {
      await rm(file);
      await mkdir(file);
    } else {
      await writeFile(file, content);
    }
    const records = createDesignAppRecords(() => file);
    assert.equal(await records.consentOf("ws", "."), undefined, content);
    assert.equal(await records.installOf("ws", "."), undefined, content);
    assert.equal(await records.portOf("ws", "."), undefined, content);
  }
});

test("install records go started, then done with the lock hash", async (t) => {
  const records = createDesignAppRecords(await recordsFile(t).then((file) => () => file));
  await records.markInstall("ws", ".", { state: "started", manager: "pnpm", lockHash: "L1" });
  assert.deepEqual(
    { ...(await records.installOf("ws", "."))!, at: 0 },
    { state: "started", manager: "pnpm", lockHash: "L1", at: 0 },
  );
  await records.markInstall("ws", ".", { state: "done", manager: "pnpm", lockHash: "L1" });
  assert.equal((await records.installOf("ws", "."))?.state, "done");
  assert.equal(await records.installOf("ws", "apps/web"), undefined, "keyed by install root");
});

test("forgetWorkspace removes consents, stamps and ports for that workspace only", async (t) => {
  const records = createDesignAppRecords(await recordsFile(t).then((file) => () => file));
  for (const ws of ["a", "b"]) {
    await records.approveShown(ws, ".", { script: "dev", installShown: false }, "F", "F");
    await records.setPort(ws, ".", 3000);
    await records.markInstall(ws, ".", { state: "done", manager: "npm", lockHash: "L" });
  }
  await records.forgetWorkspace("a");
  assert.equal(await records.consentOf("a", "."), undefined);
  assert.equal(await records.portOf("a", "."), undefined);
  assert.equal(await records.installOf("a", "."), undefined);
  assert.equal((await records.consentOf("b", "."))?.fingerprint, "F");
  assert.equal(await records.portOf("b", "."), 3000);
  assert.equal((await records.installOf("b", "."))?.state, "done");
});

test("concurrent writes all land", async (t) => {
  const file = await recordsFile(t);
  const records = createDesignAppRecords(() => file);
  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      index % 2 === 0
        ? records.setPort(`ws-${index}`, ".", 4000 + index)
        : records.markInstall(`ws-${index}`, ".", { state: "done", manager: "npm", lockHash: `L${index}` }),
    ),
  );
  const reread = createDesignAppRecords(() => file);
  for (let index = 0; index < 50; index += 1) {
    if (index % 2 === 0) assert.equal(await reread.portOf(`ws-${index}`, "."), 4000 + index, `port ${index}`);
    else assert.equal((await reread.installOf(`ws-${index}`, "."))?.lockHash, `L${index}`, `install ${index}`);
  }
});

test("the file is written with mode 0600", { skip: process.platform === "win32" }, async (t) => {
  const file = await recordsFile(t);
  await createDesignAppRecords(() => file).setPort("ws", ".", 5173);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);
});

test("caps evict the oldest workspace and app root", async (t) => {
  const file = await recordsFile(t);
  let clock = 0;
  const records = createDesignAppRecords(() => file, { now: () => (clock += 1) });
  for (let index = 0; index <= DESIGN_APP_RECORD_CAPS.appRoots; index += 1) await records.setPort("ws-0", `apps/a${index}`, 4000 + index);
  assert.equal(await records.portOf("ws-0", "apps/a0"), undefined, "the oldest app root is evicted");
  assert.equal(await records.portOf("ws-0", `apps/a${DESIGN_APP_RECORD_CAPS.appRoots}`), 4000 + DESIGN_APP_RECORD_CAPS.appRoots);
  for (let index = 1; index <= DESIGN_APP_RECORD_CAPS.workspaces; index += 1) await records.setPort(`ws-${index}`, ".", 5000);
  assert.equal(await records.portOf("ws-0", `apps/a${DESIGN_APP_RECORD_CAPS.appRoots}`), undefined, "the oldest workspace is evicted");
  assert.equal(await records.portOf(`ws-${DESIGN_APP_RECORD_CAPS.workspaces}`, "."), 5000);
  assert.deepEqual(DESIGN_APP_RECORD_CAPS, { workspaces: 256, appRoots: 16 });
});
