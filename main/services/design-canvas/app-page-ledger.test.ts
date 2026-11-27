// The page-file ledger (design mode v2 Phase 3c, S97): undo and redo of the
// person's Duplicate page as variant and Move page file to Trash, read from
// committed saves, with every file dependency faked.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { appRouteKey, emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "../../../renderer/shared/design-canvas/schema.js";
import { PAGE_LEDGER_LIMIT, PageFileLedger, pageDigest, type PageFileOutcome, type PageLedgerDeps, type PageLedgerRecord } from "./app-page-ledger.js";

const ROOT = "/work";

/** A fake workspace: a map of absolute path to bytes, a Trash, and a log of what ran inside which lock. */
function harness(options: { canAct?: () => boolean } = {}) {
  const files = new Map<string, Buffer>();
  const trashed: string[] = [];
  const written: string[] = [];
  const outcomes: PageFileOutcome[] = [];
  const log: string[] = [];
  const deps: PageLedgerDeps = {
    lock: async (absolute, task) => {
      log.push(`lock ${absolute}`);
      try {
        return await task();
      } finally {
        log.push(`unlock ${absolute}`);
      }
    },
    canAct: async () => options.canAct?.() ?? true,
    target: async (root, file) => ({ ok: true, absolute: path.resolve(root, file) }),
    read: async (absolute) => {
      const bytes = files.get(absolute);
      return bytes ? { ok: true, bytes, mode: 0o644 } : { ok: false, reason: "missing" };
    },
    trash: async (absolute) => {
      log.push(`trash ${absolute}`);
      files.delete(absolute);
      trashed.push(absolute);
    },
    write: async (root, file, bytes) => {
      const absolute = path.resolve(root, file);
      log.push(`write ${absolute}`);
      if (files.has(absolute)) return { ok: false, reason: "exists" };
      files.set(absolute, bytes);
      written.push(absolute);
      return { ok: true, absolute };
    },
    removeEmptyFolder: async () => undefined,
    notify: (outcome) => outcomes.push(outcome),
  };
  return { ledger: new PageFileLedger(deps), files, trashed, written, outcomes, log };
}

const bytes = (text: string) => Buffer.from(text, "utf8");

function copyRecord(overrides: Partial<PageLedgerRecord> = {}): PageLedgerRecord {
  const data = bytes("export default function Pricing() {}\n");
  return {
    kind: "copy",
    chatId: "chat-1",
    workspaceId: "ws-1",
    workspaceRoot: ROOT,
    appRoot: ".",
    route: "/pricing-v2",
    file: "src/routes/pricing-v2.tsx",
    bytes: data,
    mode: 0o644,
    digest: pageDigest(data),
    frameId: "copy-frame",
    state: "present",
    ...overrides,
  } as PageLedgerRecord;
}

function trashRecord(overrides: Partial<PageLedgerRecord> = {}): PageLedgerRecord {
  const data = bytes("export default function About() {}\n");
  return {
    kind: "trash",
    chatId: "chat-1",
    workspaceId: "ws-1",
    workspaceRoot: ROOT,
    appRoot: ".",
    route: "/about",
    file: "src/routes/about.tsx",
    bytes: data,
    mode: 0o644,
    digest: pageDigest(data),
    frameIds: ["about-1", "about-2"],
    state: "trashed",
    ...overrides,
  } as PageLedgerRecord;
}

function docWith(...ids: string[]): DesignCanvas {
  const frames: DesignFrame[] = ids.map((id) => ({ id, kind: "note", title: id, text: id, x: 0, y: 0, w: 10, h: 10, pageId: "page-1", createdBy: "person" }));
  return { ...emptyDesignCanvas(), frames };
}

const COPY_FILE = path.resolve(ROOT, "src/routes/pricing-v2.tsx");
const TRASH_FILE = path.resolve(ROOT, "src/routes/about.tsx");
const COPY_KEY = appRouteKey(".", "/pricing-v2");

test("undo of a copy moves the unchanged copy to the Trash, and its redo writes it again", async () => {
  const { ledger, files, trashed, written, outcomes } = harness();
  const record = copyRecord();
  files.set(COPY_FILE, record.bytes);
  ledger.record(record);
  await ledger.reconcile("ws-1", "chat-1", docWith(), [COPY_KEY]);
  assert.deepEqual(trashed, [COPY_FILE]);
  assert.deepEqual(outcomes, [{ chatId: "chat-1", file: "src/routes/pricing-v2.tsx", done: "trash" }]);
  assert.equal(ledger.list("ws-1")[0]?.state, "trashed");

  await ledger.reconcile("ws-1", "chat-1", docWith("copy-frame"), []);
  assert.deepEqual(written, [COPY_FILE]);
  assert.deepEqual(files.get(COPY_FILE), record.bytes);
  assert.equal(ledger.list("ws-1")[0]?.state, "present");
});

test("undo of a changed copy keeps the file and forgets the record", async () => {
  const { ledger, files, trashed, written, outcomes } = harness();
  ledger.record(copyRecord());
  files.set(COPY_FILE, bytes("edited since"));
  await ledger.reconcile("ws-1", "chat-1", docWith(), [COPY_KEY]);
  assert.deepEqual(trashed, []);
  assert.deepEqual(outcomes, [{ chatId: "chat-1", file: "src/routes/pricing-v2.tsx", failed: "trash", reason: "changed" }]);
  assert.deepEqual(ledger.list("ws-1"), []);
  await ledger.reconcile("ws-1", "chat-1", docWith("copy-frame"), []);
  assert.deepEqual(written, [], "a later redo writes nothing");
});

test("removing a copy's frame without undo keeps the file and forgets the record", async () => {
  const { ledger, files, trashed } = harness();
  const record = copyRecord();
  files.set(COPY_FILE, record.bytes);
  ledger.record(record);
  await ledger.reconcile("ws-1", "chat-1", docWith(), [appRouteKey(".", "/somewhere-else")]);
  assert.deepEqual(trashed, []);
  assert.deepEqual(ledger.list("ws-1"), []);
  assert.ok(files.has(COPY_FILE));
});

test("redo of a copy never writes over a file: exists drops the record", async () => {
  const { ledger, files, outcomes } = harness();
  ledger.record(copyRecord({ state: "trashed" }));
  files.set(COPY_FILE, bytes("someone else's"));
  await ledger.reconcile("ws-1", "chat-1", docWith("copy-frame"), []);
  assert.deepEqual(files.get(COPY_FILE), bytes("someone else's"));
  assert.deepEqual(outcomes, [{ chatId: "chat-1", file: "src/routes/pricing-v2.tsx", failed: "restore", reason: "exists" }]);
  assert.deepEqual(ledger.list("ws-1"), []);
});

test("undo of a trash restores the bytes with wx; an existing file refuses and drops the record", async () => {
  const { ledger, files, outcomes } = harness();
  const record = trashRecord();
  ledger.record(record);
  await ledger.reconcile("ws-1", "chat-1", docWith("about-2"), []);
  assert.deepEqual(files.get(TRASH_FILE), record.bytes);
  assert.deepEqual(outcomes, [{ chatId: "chat-1", file: "src/routes/about.tsx", done: "restore" }]);
  assert.equal(ledger.list("ws-1")[0]?.state, "restored");

  const other = harness();
  other.ledger.record(trashRecord());
  other.files.set(TRASH_FILE, bytes("made again meanwhile"));
  await other.ledger.reconcile("ws-1", "chat-1", docWith("about-1"), []);
  assert.deepEqual(other.files.get(TRASH_FILE), bytes("made again meanwhile"));
  assert.deepEqual(other.outcomes, [{ chatId: "chat-1", file: "src/routes/about.tsx", failed: "restore", reason: "exists" }]);
  assert.deepEqual(other.ledger.list("ws-1"), []);
});

test("redo of a trash removes nothing and forgets the record", async () => {
  const { ledger, files, trashed } = harness();
  ledger.record(trashRecord());
  await ledger.reconcile("ws-1", "chat-1", docWith("about-1", "about-2"), []);
  assert.ok(files.has(TRASH_FILE));
  await ledger.reconcile("ws-1", "chat-1", docWith(), []);
  assert.deepEqual(trashed, []);
  assert.ok(files.has(TRASH_FILE), "the file stays");
  assert.deepEqual(ledger.list("ws-1"), []);
});

test("a newer record for the same file replaces the older", async () => {
  const { ledger, files, trashed } = harness();
  const copy = copyRecord({ file: "src/routes/about.tsx", route: "/about", frameId: "copy-frame" });
  ledger.record(copy);
  const trash = trashRecord({ bytes: bytes("trashed bytes"), digest: pageDigest(bytes("trashed bytes")), frameIds: ["about-1"] });
  ledger.record(trash);
  assert.deepEqual(ledger.list("ws-1").map((record) => record.kind), ["trash"]);
  // The copy's frame gone by undo: the copy record is gone, so nothing is trashed.
  await ledger.reconcile("ws-1", "chat-1", docWith("about-1"), [appRouteKey(".", "/about")]);
  assert.deepEqual(trashed, []);
  assert.deepEqual(files.get(TRASH_FILE), bytes("trashed bytes"), "the trash record's bytes came back");
});

test("a refused gate does nothing and drops the record", async () => {
  let allowed = false;
  const { ledger, files, trashed, written, outcomes } = harness({ canAct: () => allowed });
  const record = copyRecord();
  files.set(COPY_FILE, record.bytes);
  ledger.record(record);
  ledger.record(trashRecord());
  await ledger.reconcile("ws-1", "chat-1", docWith("about-1"), [COPY_KEY]);
  assert.deepEqual([trashed, written, outcomes], [[], [], []]);
  assert.deepEqual(ledger.list("ws-1"), []);
  allowed = true;
  await ledger.reconcile("ws-1", "chat-1", docWith("about-1"), [COPY_KEY]);
  assert.deepEqual([trashed, written], [[], []], "forgotten for good");
});

test("records are per workspace and chat, and at most 16 are kept", async () => {
  const { ledger, files, trashed } = harness();
  const record = copyRecord();
  files.set(COPY_FILE, record.bytes);
  ledger.record(record);
  await ledger.reconcile("ws-2", "chat-1", docWith(), [COPY_KEY]);
  await ledger.reconcile("ws-1", "chat-2", docWith(), [COPY_KEY]);
  assert.deepEqual(trashed, [], "another workspace's or chat's save acts on nothing");
  assert.equal(ledger.list("ws-1").length, 1);

  for (let index = 0; index < PAGE_LEDGER_LIMIT + 3; index += 1) {
    ledger.record(copyRecord({ file: `src/routes/p${index}.tsx`, frameId: `f${index}` }));
  }
  const kept = ledger.list("ws-1");
  assert.equal(kept.length, PAGE_LEDGER_LIMIT);
  assert.equal(kept[kept.length - 1]?.file, `src/routes/p${PAGE_LEDGER_LIMIT + 2}.tsx`, "the newest kept");
  assert.equal(kept.some((entry) => entry.file === record.file), false, "the oldest went first");
});

test("each action runs inside the file's lock, keyed on its resolved path", async () => {
  const { ledger, files, log } = harness();
  const record = copyRecord();
  files.set(COPY_FILE, record.bytes);
  ledger.record(record);
  await ledger.reconcile("ws-1", "chat-1", docWith(), [COPY_KEY]);
  await ledger.reconcile("ws-1", "chat-1", docWith("copy-frame"), []);
  assert.deepEqual(log, [`lock ${COPY_FILE}`, `trash ${COPY_FILE}`, `unlock ${COPY_FILE}`, `lock ${COPY_FILE}`, `write ${COPY_FILE}`, `unlock ${COPY_FILE}`]);
});

test("saves reconcile in the order they committed", async () => {
  const { ledger, files, log } = harness();
  const record = copyRecord();
  files.set(COPY_FILE, record.bytes);
  ledger.record(record);
  // Undo, then redo, queued back to back without waiting.
  const first = ledger.reconcile("ws-1", "chat-1", docWith(), [COPY_KEY]);
  const second = ledger.reconcile("ws-1", "chat-1", docWith("copy-frame"), []);
  await Promise.all([first, second]);
  assert.deepEqual(log.filter((line) => !line.startsWith("lock") && !line.startsWith("unlock")), [`trash ${COPY_FILE}`, `write ${COPY_FILE}`]);
  assert.ok(files.has(COPY_FILE));
});
