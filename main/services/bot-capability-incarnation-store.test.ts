import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createBotCapabilityIncarnationStore } from "./bot-capability-incarnation-store.js";
import { createBotCapabilityStore } from "./bot-capability-store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function incarnationStore(root: string, counter: { value: number }) {
  const protectedStore = createBotCapabilityStore({
    root: () => root,
    mintRevision: (kind, sequence) => `revision:${kind}:${sequence}`,
    mintIncarnation: () => Buffer.alloc(32, ++counter.value).toString("base64url"),
  });
  await protectedStore.initialize();
  return createBotCapabilityIncarnationStore(protectedStore);
}

test("incarnations survive restart, rotate with credentials, and change after observed remove/re-add", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-incarnations-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const counter = { value: 0 };
  const firstStore = await incarnationStore(root, counter);
  const [first] = await firstStore.reconcileNamespace("provider", [
    { sourceId: "provider-one", credentialSignature: hash("key-a") },
  ]);
  const restarted = await incarnationStore(root, counter);
  const [same] = await restarted.reconcileNamespace("provider", [
    { sourceId: "provider-one", credentialSignature: hash("key-a") },
  ]);
  assert.deepEqual(same, first);

  const [rotated] = await restarted.reconcileNamespace("provider", [
    { sourceId: "provider-one", credentialSignature: hash("key-b") },
  ]);
  assert.equal(rotated?.resourceIncarnation, first?.resourceIncarnation);
  assert.notEqual(rotated?.credentialIncarnation, first?.credentialIncarnation);

  await restarted.reconcileNamespace("provider", []);
  const [readded] = await restarted.reconcileNamespace("provider", [
    { sourceId: "provider-one", credentialSignature: hash("key-b") },
  ]);
  assert.notEqual(readded?.resourceIncarnation, rotated?.resourceIncarnation);
  assert.notEqual(readded?.credentialIncarnation, rotated?.credentialIncarnation);
  await assert.rejects(
    fs.stat(path.join(root, "bot-capability-incarnations.json")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("namespaces and target partitions reconcile independently", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-incarnations-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await incarnationStore(root, { value: 0 });
  const [provider] = await store.reconcileNamespace("provider", [
    { sourceId: "same-id", credentialSignature: hash("none") },
  ]);
  const [skillA] = await store.reconcileNamespace("skill", [
    { sourceId: "same-id", credentialSignature: hash("none") },
  ], { partition: "bot:a" });
  const [skillB] = await store.reconcileNamespace("skill", [
    { sourceId: "same-id", credentialSignature: hash("none") },
  ], { partition: "bot:b" });
  assert.notEqual(provider?.resourceIncarnation, skillA?.resourceIncarnation);
  assert.notEqual(skillA?.resourceIncarnation, skillB?.resourceIncarnation);

  await store.reconcileNamespace("skill", [], { partition: "bot:a" });
  const [skillBAgain] = await store.reconcileNamespace("skill", [
    { sourceId: "same-id", credentialSignature: hash("none") },
  ], { partition: "bot:b" });
  assert.deepEqual(skillBAgain, skillB);
});
