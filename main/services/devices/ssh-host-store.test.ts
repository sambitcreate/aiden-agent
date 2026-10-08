import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseStoredSshHosts, readSshHosts, sshHostsPath, writeSshHosts } from "./ssh-host-store.js";

const MINI = { id: "ssh-mini01", label: "Mac mini", target: "me@mini.local", port: 2222 };

test("hosts and their install approvals round-trip, and approvals for removed hosts are dropped", async (t) => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "aiden-ssh-store-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  assert.deepEqual(await readSshHosts(baseDir), { hosts: [], toolConsent: {} }, "no file means no hosts");
  await writeSshHosts(baseDir, {
    hosts: [MINI],
    toolConsent: { [MINI.id]: { hub: true, agent: true }, "ssh-gone00": { hub: true, agent: false } },
  });
  assert.deepEqual(await readSshHosts(baseDir), { hosts: [MINI], toolConsent: { [MINI.id]: { hub: true, agent: true } } });
  assert.equal(JSON.parse(await readFile(sshHostsPath(baseDir), "utf8")).version, 1);
  assert.ok((await stat(sshHostsPath(baseDir))).isFile());
});

test("a damaged or foreign file loads as no hosts rather than partial ones", async (t) => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "aiden-ssh-store-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  await writeFile(sshHostsPath(baseDir), "{not json");
  assert.deepEqual(await readSshHosts(baseDir), { hosts: [], toolConsent: {} });
  const empty = { hosts: [], toolConsent: {} };
  assert.deepEqual(parseStoredSshHosts(JSON.stringify({ version: 2, hosts: [MINI] })), empty);
  assert.deepEqual(
    parseStoredSshHosts(JSON.stringify({ version: 1, hosts: [MINI, { ...MINI, id: "ssh-other1", target: "-oX" }] })),
    empty,
  );
});

test("agent install approval never survives without hub approval", () => {
  const stored = parseStoredSshHosts(
    JSON.stringify({ version: 1, hosts: [MINI], toolConsent: { [MINI.id]: { hub: false, agent: true } } }),
  );
  assert.deepEqual(stored.toolConsent, { [MINI.id]: { hub: false, agent: false } });
});
