import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SOURCE_DESIGNER_MULTIFILE_JOURNAL_LIMIT,
  SOURCE_DESIGNER_MULTIFILE_MAX_FILES,
  createSourceDesignerMultifileImage,
  sourceDesignerMultifileSha256,
} from "./source-designer-multifile-contract.js";
import {
  type PrepareSourceDesignerMultifileInput,
  type SourceDesignerMultifileFilePort,
  type SourceDesignerMultifileObservation,
  createSourceDesignerMultifileCoordinator,
} from "./source-designer-multifile-coordinator.js";
import {
  SOURCE_DESIGNER_MULTIFILE_JOURNAL_FILENAME,
  SourceDesignerMultifileJournalConflictError,
  type SourceDesignerMultifileJournalPort,
  SourceDesignerMultifileJournalStore,
} from "./source-designer-multifile-journal.js";

class SimulatedCrash extends Error {}

class MemoryFilePort implements SourceDesignerMultifileFilePort {
  rootFingerprint = "a".repeat(64);
  readonly values = new Map<string, Buffer>();
  readonly writes: Array<{ path: string; effectId: string }> = [];
  readonly completedEffects = new Map<string, { path: string; sha256: string }>();
  readonly failBeforeEffects = new Set<string>();
  readonly failAfterEffects = new Set<string>();
  inspectHook?: (path: string, port: MemoryFilePort) => void;

  constructor(initial: Record<string, string>) {
    for (const [filePath, value] of Object.entries(initial)) {
      this.values.set(filePath, Buffer.from(value));
    }
  }

  mutate(filePath: string, value: string): void {
    this.values.set(filePath, Buffer.from(value));
  }

  text(filePath: string): string {
    return this.values.get(filePath)?.toString("utf8") ?? "";
  }

  private observation(filePath: string): SourceDesignerMultifileObservation {
    const bytes = this.values.get(filePath);
    if (!bytes) throw new Error(`Missing fake file ${filePath}.`);
    return {
      path: filePath,
      noFollow: true,
      contained: true,
      kind: "regular-file",
      bytes: Buffer.from(bytes),
      byteSize: bytes.byteLength,
      sha256: sourceDesignerMultifileSha256(bytes),
      rootFingerprint: this.rootFingerprint,
    };
  }

  async inspect(input: {
    workspaceId: string;
    path: string;
    expectedRootFingerprint?: string;
  }): Promise<SourceDesignerMultifileObservation> {
    assert.equal(input.workspaceId, "workspace:test");
    if (input.expectedRootFingerprint && input.expectedRootFingerprint !== this.rootFingerprint) {
      throw new Error("Fake workspace root changed.");
    }
    this.inspectHook?.(input.path, this);
    return this.observation(input.path);
  }

  async write(input: {
    workspaceId: string;
    path: string;
    effectId: string;
    expectedSha256: string;
    bytes: Uint8Array;
    expectedRootFingerprint?: string;
  }): Promise<SourceDesignerMultifileObservation> {
    assert.equal(input.workspaceId, "workspace:test");
    if (input.expectedRootFingerprint && input.expectedRootFingerprint !== this.rootFingerprint) {
      throw new Error("Fake workspace root changed.");
    }
    if (this.failBeforeEffects.delete(input.effectId)) {
      throw new Error("Authorized adapter failed before replacement.");
    }
    const completed = this.completedEffects.get(input.effectId);
    if (completed) {
      const current = this.observation(input.path);
      if (completed.path !== input.path || completed.sha256 !== current.sha256) {
        throw new Error("Idempotent fake effect no longer owns its exact postimage.");
      }
      return current;
    }
    const current = this.observation(input.path);
    if (current.sha256 !== input.expectedSha256) throw new Error("Fake write CAS conflict.");
    const next = Buffer.from(input.bytes);
    this.values.set(input.path, next);
    const after = this.observation(input.path);
    this.completedEffects.set(input.effectId, { path: input.path, sha256: after.sha256 });
    this.writes.push({ path: input.path, effectId: input.effectId });
    if (this.failAfterEffects.delete(input.effectId)) {
      throw new Error("Authorized adapter lost its response after replacement.");
    }
    return after;
  }
}

class CrashAfterRevisionJournal implements SourceDesignerMultifileJournalPort {
  private crashed = false;

  constructor(
    private readonly inner: SourceDesignerMultifileJournalPort,
    private readonly revision: number,
  ) {}

  get(actionId: string) {
    return this.inner.get(actionId);
  }

  create(record: Parameters<SourceDesignerMultifileJournalPort["create"]>[0]) {
    return this.inner.create(record);
  }

  async replace(
    actionId: string,
    expectedRevision: number,
    next: Parameters<SourceDesignerMultifileJournalPort["replace"]>[2],
  ) {
    const saved = await this.inner.replace(actionId, expectedRevision, next);
    if (!this.crashed && saved.revision === this.revision) {
      this.crashed = true;
      throw new SimulatedCrash(`Crash after journal revision ${this.revision}.`);
    }
    return saved;
  }

  listInterrupted() {
    return this.inner.listInterrupted();
  }
}

class CrashBeforeRevisionJournal implements SourceDesignerMultifileJournalPort {
  private crashed = false;

  constructor(
    private readonly inner: SourceDesignerMultifileJournalPort,
    private readonly revision: number,
  ) {}

  get(actionId: string) {
    return this.inner.get(actionId);
  }

  create(record: Parameters<SourceDesignerMultifileJournalPort["create"]>[0]) {
    return this.inner.create(record);
  }

  async replace(
    actionId: string,
    expectedRevision: number,
    next: Parameters<SourceDesignerMultifileJournalPort["replace"]>[2],
  ) {
    if (!this.crashed && next.revision === this.revision) {
      this.crashed = true;
      throw new SimulatedCrash(`Crash before journal revision ${this.revision}.`);
    }
    return this.inner.replace(actionId, expectedRevision, next);
  }

  listInterrupted() {
    return this.inner.listInterrupted();
  }
}

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-designer-multifile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function input(
  port: MemoryFilePort,
  actionId = "action:test",
): PrepareSourceDesignerMultifileInput {
  return {
    actionId,
    workspaceId: "workspace:test",
    label: "Update the selected component",
    files: ["src/a.tsx", "src/b.tsx", "src/c.tsx"].map((filePath, index) => ({
      path: filePath,
      expectedBeforeSha256: sourceDesignerMultifileSha256(port.values.get(filePath)!),
      afterBytes: Buffer.from(`after-${index + 1}\n`),
    })),
  };
}

function initialFiles(): Record<string, string> {
  return {
    "src/a.tsx": "before-a\n",
    "src/b.tsx": "before-b\n",
    "src/c.tsx": "before-c\n",
  };
}

async function prepare(root: string, port: MemoryFilePort, actionId = "action:test") {
  const journal = new SourceDesignerMultifileJournalStore(() => root);
  const coordinator = createSourceDesignerMultifileCoordinator({
    journal,
    files: port,
    now: () => 1_000,
  });
  const record = await coordinator.prepare(input(port, actionId));
  return { journal, coordinator, record };
}

test("journal is owner-only, exact, bounded, and rejects stale CAS", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { journal, record } = await prepare(root, port);
  assert.equal(record.files[0]!.before.base64, Buffer.from("before-a\n").toString("base64"));
  assert.equal(
    record.files[0]!.after.sha256,
    sourceDesignerMultifileSha256(Buffer.from("after-1\n")),
  );

  const mode =
    (await stat(path.join(root, SOURCE_DESIGNER_MULTIFILE_JOURNAL_FILENAME))).mode & 0o777;
  assert.equal(mode, 0o600);
  const document = JSON.parse(
    await readFile(path.join(root, SOURCE_DESIGNER_MULTIFILE_JOURNAL_FILENAME), "utf8"),
  ) as { actions: unknown[] };
  assert.equal(document.actions.length, 1);
  assert.ok(SOURCE_DESIGNER_MULTIFILE_JOURNAL_LIMIT >= 1);

  await assert.rejects(
    journal.replace(record.actionId, 99, { ...record, revision: 100, stage: "applying" }),
    SourceDesignerMultifileJournalConflictError,
  );
});

test("apply refuses a workspace ID repointed to another canonical root identity", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { coordinator, record } = await prepare(root, port, "action:root-swap");
  assert.equal(record.rootFingerprint, "a".repeat(64));
  port.rootFingerprint = "b".repeat(64);
  const result = await coordinator.apply(record.actionId);
  assert.equal(result.status, "recoverable");
  assert.equal(result.record.recovery?.kind, "inspection-unavailable");
  assert.deepEqual(
    [port.text("src/a.tsx"), port.text("src/b.tsx"), port.text("src/c.tsx")],
    ["before-a\n", "before-b\n", "before-c\n"],
  );
});

test("journal rejects forged effect identities and out-of-order file progress", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { journal, record } = await prepare(root, port);
  await assert.rejects(
    journal.replace(record.actionId, 0, {
      ...record,
      revision: 1,
      stage: "applying",
      files: record.files.map((file, index) =>
        index === 0 ? { ...file, apply: { ...file.apply, effectId: "0".repeat(64) } } : file,
      ),
    }),
    /effect identity/u,
  );
  const applying = await journal.replace(record.actionId, 0, {
    ...record,
    revision: 1,
    stage: "applying",
  });
  await assert.rejects(
    journal.replace(record.actionId, 1, {
      ...applying,
      revision: 2,
      files: applying.files.map((file, index) =>
        index === 1 ? { ...file, apply: { ...file.apply, phase: "write-intent" as const } } : file,
      ),
    }),
    SourceDesignerMultifileJournalConflictError,
  );
});

test("startup recovery never auto-applies a prepared review", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { journal, coordinator, record } = await prepare(root, port);
  assert.deepEqual(await journal.listInterrupted(), []);
  await assert.rejects(coordinator.resume(record.actionId), /explicit Apply approval/u);
  assert.deepEqual(port.writes, []);
});

test("apply resumes after a crash following every journal checkpoint", async (t) => {
  // Three files produce revisions 1..11: start, three phases per file, global
  // verification, and commit. A crash after any durable checkpoint must resume.
  for (let crashRevision = 1; crashRevision <= 12; crashRevision += 1) {
    const root = await temporaryRoot(t);
    const port = new MemoryFilePort(initialFiles());
    const base = new SourceDesignerMultifileJournalStore(() => root);
    const prepared = createSourceDesignerMultifileCoordinator({ journal: base, files: port });
    await prepared.prepare(input(port, `action:revision-${crashRevision}`));
    const crashing = createSourceDesignerMultifileCoordinator({
      journal: new CrashAfterRevisionJournal(base, crashRevision),
      files: port,
    });
    const first = crashing.apply(`action:revision-${crashRevision}`);
    if (crashRevision <= 12) await assert.rejects(first, SimulatedCrash);

    const restarted = createSourceDesignerMultifileCoordinator({ journal: base, files: port });
    const resumed = await restarted.resume(`action:revision-${crashRevision}`);
    assert.equal(resumed.status, "committed", `revision ${crashRevision}`);
    assert.deepEqual(
      [port.text("src/a.tsx"), port.text("src/b.tsx"), port.text("src/c.tsx")],
      ["after-1\n", "after-2\n", "after-3\n"],
      `revision ${crashRevision}`,
    );
  }
});

test("a same-process project retry rolls ambiguous writes back before rechecking authority", async (t) => {
  for (const crashRevision of [3, 6, 9, 11]) {
    const root = await temporaryRoot(t);
    const port = new MemoryFilePort(initialFiles());
    const base = new SourceDesignerMultifileJournalStore(() => root);
    const prepared = createSourceDesignerMultifileCoordinator({ journal: base, files: port });
    const request = input(port, `action:project-retry-${crashRevision}`);
    await prepared.prepare({
      ...request,
      projectId: "project:test",
      chatId: "chat:test",
      projectRevision: 1,
      sourceNodeId: "source:test",
    });
    const coordinator = createSourceDesignerMultifileCoordinator({
      journal: new CrashAfterRevisionJournal(base, crashRevision),
      files: port,
    });
    const guards = {
      before: async () => true,
      after: async () => true,
    };

    await assert.rejects(
      coordinator.apply(`action:project-retry-${crashRevision}`, guards),
      SimulatedCrash,
    );
    const retried = await coordinator.apply(`action:project-retry-${crashRevision}`, guards);

    assert.equal(retried.status, "rolled-back", `revision ${crashRevision}`);
    assert.deepEqual(
      [port.text("src/a.tsx"), port.text("src/b.tsx"), port.text("src/c.tsx")],
      ["before-a\n", "before-b\n", "before-c\n"],
      `revision ${crashRevision}`,
    );
  }
});

test("apply resumes after process loss at every file write boundary", async (t) => {
  for (let fileIndex = 0; fileIndex < 3; fileIndex += 1) {
    const root = await temporaryRoot(t);
    const port = new MemoryFilePort(initialFiles());
    const base = new SourceDesignerMultifileJournalStore(() => root);
    const actionId = `action:write-${fileIndex}`;
    await createSourceDesignerMultifileCoordinator({ journal: base, files: port }).prepare(
      input(port, actionId),
    );
    const first = createSourceDesignerMultifileCoordinator({
      journal: new CrashBeforeRevisionJournal(base, 3 + fileIndex * 3),
      files: port,
    });
    await assert.rejects(first.apply(actionId), SimulatedCrash);
    const restarted = createSourceDesignerMultifileCoordinator({ journal: base, files: port });
    assert.equal((await restarted.resume(actionId)).status, "committed");
    assert.deepEqual(
      [port.text("src/a.tsx"), port.text("src/b.tsx"), port.text("src/c.tsx")],
      ["after-1\n", "after-2\n", "after-3\n"],
    );
  }
});

test("a stale preimage performs no write and remains reviewable", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { coordinator, record } = await prepare(root, port);
  port.mutate("src/a.tsx", "external-before-apply\n");
  const applied = await coordinator.apply(record.actionId);
  assert.equal(applied.status, "recoverable");
  assert.equal(applied.record.recovery?.kind, "stale-preimage");
  assert.deepEqual(port.writes, []);
  assert.equal(port.text("src/a.tsx"), "external-before-apply\n");
});

test("partial external mutation preserves explicit recovery and never claims rollback", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { coordinator, record } = await prepare(root, port);
  let injected = false;
  port.inspectHook = (filePath, target) => {
    if (!injected && filePath === "src/c.tsx" && target.text(filePath) === "before-c\n") {
      injected = true;
      target.mutate("src/b.tsx", "external-b\n");
      target.mutate("src/c.tsx", "external-c\n");
    }
  };
  const applied = await coordinator.apply(record.actionId);
  assert.equal(applied.status, "recoverable");
  assert.equal(applied.record.stage, "recoverable");
  assert.deepEqual(
    applied.record.recovery?.conflicts.map(({ path: conflictPath }) => conflictPath),
    ["src/b.tsx", "src/c.tsx"],
  );
  assert.equal(port.text("src/a.tsx"), "after-1\n");
  assert.equal(port.text("src/b.tsx"), "external-b\n");
  assert.equal(port.text("src/c.tsx"), "external-c\n");
});

test("a final-verification conflict can roll back terminally with its audit retained", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { coordinator, record } = await prepare(root, port);
  let cInspections = 0;
  port.inspectHook = (filePath, target) => {
    if (filePath !== "src/c.tsx") return;
    cInspections += 1;
    if (cInspections === 4) target.mutate(filePath, "external-at-final-verification\n");
    if (cInspections === 5) target.mutate(filePath, "after-3\n");
  };
  const applied = await coordinator.apply(record.actionId);
  assert.equal(applied.status, "rolled-back");
  assert.equal(applied.record.recovery?.kind, "apply-conflict");
  assert.deepEqual(
    [port.text("src/a.tsx"), port.text("src/b.tsx"), port.text("src/c.tsx")],
    ["before-a\n", "before-b\n", "before-c\n"],
  );
});

test("a catchable adapter failure after an earlier write enters durable rollback", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { coordinator, record } = await prepare(root, port);
  port.failBeforeEffects.add(record.files[1]!.apply.effectId);
  const applied = await coordinator.apply(record.actionId);
  assert.equal(applied.status, "rolled-back");
  assert.equal(applied.record.recovery?.kind, "inspection-unavailable");
  assert.deepEqual(
    [port.text("src/a.tsx"), port.text("src/b.tsx"), port.text("src/c.tsx")],
    ["before-a\n", "before-b\n", "before-c\n"],
  );
});

test("an uncertain inspection failure after earlier writes is explicitly recoverable", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { coordinator, record } = await prepare(root, port);
  let failed = false;
  port.inspectHook = (filePath) => {
    if (!failed && filePath === "src/c.tsx") {
      failed = true;
      throw new Error("Authorized adapter inspection failed.");
    }
  };
  const applied = await coordinator.apply(record.actionId);
  assert.equal(applied.status, "recoverable");
  assert.equal(applied.record.recovery?.kind, "inspection-unavailable");
  assert.equal(applied.record.stage, "recoverable");
  assert.equal(port.text("src/a.tsx"), "after-1\n");
  assert.equal(port.text("src/b.tsx"), "after-2\n");
  assert.equal(port.text("src/c.tsx"), "before-c\n");
});

test("undo reconciles a lost adapter response and remains exact and reverse ordered", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { journal, coordinator, record } = await prepare(root, port);
  assert.equal((await coordinator.apply(record.actionId)).status, "committed");
  const committed = (await journal.get(record.actionId))!;
  port.failAfterEffects.add(committed.files[1]!.undo.effectId);
  assert.equal((await coordinator.undo(record.actionId)).status, "undone");
  assert.deepEqual(
    [port.text("src/a.tsx"), port.text("src/b.tsx"), port.text("src/c.tsx")],
    ["before-a\n", "before-b\n", "before-c\n"],
  );
  assert.deepEqual(
    port.writes.slice(-3).map(({ path: filePath }) => filePath),
    ["src/c.tsx", "src/b.tsx", "src/a.tsx"],
  );
});

test("undo resumes after process loss at every reverse write boundary", async (t) => {
  for (let fileIndex = 0; fileIndex < 3; fileIndex += 1) {
    const root = await temporaryRoot(t);
    const port = new MemoryFilePort(initialFiles());
    const { journal, coordinator, record } = await prepare(root, port, `action:undo-${fileIndex}`);
    assert.equal((await coordinator.apply(record.actionId)).status, "committed");
    const crashing = createSourceDesignerMultifileCoordinator({
      journal: new CrashBeforeRevisionJournal(journal, 15 + (2 - fileIndex) * 3),
      files: port,
    });
    await assert.rejects(crashing.undo(record.actionId), SimulatedCrash);
    const restarted = createSourceDesignerMultifileCoordinator({ journal, files: port });
    assert.equal((await restarted.resume(record.actionId)).status, "undone");
    assert.deepEqual(
      [port.text("src/a.tsx"), port.text("src/b.tsx"), port.text("src/c.tsx")],
      ["before-a\n", "before-b\n", "before-c\n"],
    );
  }
});

test("undo performs a complete final preimage proof before claiming success", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { coordinator, record } = await prepare(root, port);
  assert.equal((await coordinator.apply(record.actionId)).status, "committed");
  let aInspections = 0;
  port.inspectHook = (filePath, target) => {
    if (filePath === "src/a.tsx" && ++aInspections === 4) {
      target.mutate("src/c.tsx", "external-during-final-undo-proof\n");
    }
  };
  const undone = await coordinator.undo(record.actionId);
  assert.equal(undone.status, "recoverable");
  assert.equal(undone.record.recovery?.kind, "stale-postimage");
  assert.equal(port.text("src/c.tsx"), "external-during-final-undo-proof\n");
});

test("concurrent Apply then Undo requests serialize as two logical actions", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { coordinator, record } = await prepare(root, port);
  const applying = coordinator.apply(record.actionId);
  const undoing = coordinator.undo(record.actionId);
  assert.equal((await applying).status, "committed");
  assert.equal((await undoing).status, "undone");
  assert.deepEqual(
    [port.text("src/a.tsx"), port.text("src/b.tsx"), port.text("src/c.tsx")],
    ["before-a\n", "before-b\n", "before-c\n"],
  );
});

test("stale postimages preserve external bytes and report review conflicts", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { coordinator, record } = await prepare(root, port);
  assert.equal((await coordinator.apply(record.actionId)).status, "committed");
  port.mutate("src/b.tsx", "external-after-commit\n");
  const undone = await coordinator.undo(record.actionId);
  assert.equal(undone.status, "recoverable");
  assert.equal(undone.record.recovery?.kind, "stale-postimage");
  assert.deepEqual(
    undone.record.recovery?.conflicts.map(({ path: filePath }) => filePath),
    ["src/b.tsx"],
  );
  assert.equal(port.text("src/a.tsx"), "after-1\n");
  assert.equal(port.text("src/b.tsx"), "external-after-commit\n");
  assert.equal(port.text("src/c.tsx"), "before-c\n");
});

test("a post-write ownership guard rolls every edited file back before commit", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const { coordinator, record } = await prepare(root, port);
  let proofChecks = 0;
  const applied = await coordinator.apply(record.actionId, {
    before: async () => {
      proofChecks += 1;
      return true;
    },
    after: async () => {
      proofChecks += 1;
      return false;
    },
  });
  assert.equal(applied.status, "rolled-back");
  assert.equal(proofChecks, 2);
  assert.deepEqual(
    [port.text("src/a.tsx"), port.text("src/b.tsx"), port.text("src/c.tsx")],
    ["before-a\n", "before-b\n", "before-c\n"],
  );
});

test("prepare rejects duplicate, case, Unicode, and file-count collisions before inspection", async (t) => {
  const root = await temporaryRoot(t);
  const port = new MemoryFilePort(initialFiles());
  const journal = new SourceDesignerMultifileJournalStore(() => root);
  const coordinator = createSourceDesignerMultifileCoordinator({ journal, files: port });
  const digest = sourceDesignerMultifileSha256(Buffer.from("before-a\n"));
  const base = {
    actionId: "action:collision",
    workspaceId: "workspace:test",
    label: "Collision test",
  };
  const file = (filePath: string) => ({
    path: filePath,
    expectedBeforeSha256: digest,
    afterBytes: Buffer.from("after\n"),
  });
  await assert.rejects(
    coordinator.prepare({ ...base, files: [file("src/a.tsx"), file("src/A.tsx")] }),
    /collide/u,
  );
  await assert.rejects(
    coordinator.prepare({
      ...base,
      files: [file("src/caf\u00e9.tsx"), file("src/cafe\u0301.tsx")],
    }),
    /canonical|collide/u,
  );
  await assert.rejects(
    coordinator.prepare({
      ...base,
      files: Array.from({ length: SOURCE_DESIGNER_MULTIFILE_MAX_FILES + 1 }, (_, index) =>
        file(`src/${index}.tsx`),
      ),
    }),
    /count/u,
  );
  assert.equal(createSourceDesignerMultifileImage(Buffer.from("after\n")).byteSize, 6);
});
