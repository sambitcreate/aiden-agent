import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AidenLiveThreadStore } from "./aiden-live-thread-store.js";

test("Aiden Live stores one metadata-only thread per session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-live-threads-"));
  const times = [new Date("2026-09-16T12:00:00.000Z"), new Date("2026-09-16T12:03:00.000Z")];
  const store = new AidenLiveThreadStore(
    () => root,
    () => times.shift()!,
  );
  try {
    await store.begin({
      id: "session-1",
      model: "gemini-3.8-live",
      computerUseEnabled: true,
    });
    await store.finish("session-1", "stopped");
    const record = JSON.parse(
      await readFile(path.join(root, "threads", "session-1", "thread.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(record, {
      schemaVersion: 1,
      id: "session-1",
      startedAt: "2026-09-16T12:00:00.000Z",
      endedAt: "2026-09-16T12:03:00.000Z",
      outcome: "stopped",
      model: "gemini-3.8-live",
      computerUseEnabled: true,
    });
    for (const forbidden of ["audio", "caption", "transcript", "prompt", "screenshot", "tool"]) {
      assert.equal(forbidden in record, false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Aiden Live rejects path-like thread ids", async () => {
  const store = new AidenLiveThreadStore(() => os.tmpdir());
  await assert.rejects(
    store.begin({
      id: "../escape",
      model: "gemini-3.8-live",
      computerUseEnabled: false,
    }),
    /Invalid Aiden Live thread id/u,
  );
});

test("Aiden Live never creates a phantom record while finishing an unknown id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-live-threads-"));
  const store = new AidenLiveThreadStore(() => root);
  try {
    await store.finish("unknown-session", "failed");
    await assert.rejects(
      readFile(path.join(root, "threads", "unknown-session", "thread.json"), "utf8"),
      /ENOENT/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Aiden Live reconciles active crash remnants without touching corrupt records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-live-threads-"));
  const activeDir = path.join(root, "threads", "active-session");
  const corruptDir = path.join(root, "threads", "corrupt-session");
  await mkdir(activeDir, { recursive: true });
  await mkdir(corruptDir, { recursive: true });
  await writeFile(
    path.join(activeDir, "thread.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "active-session",
      startedAt: "2026-09-16T12:00:00.000Z",
      outcome: "active",
      model: "gemini-3.8-live",
      computerUseEnabled: false,
    }),
  );
  await writeFile(path.join(corruptDir, "thread.json"), "not-json");
  const store = new AidenLiveThreadStore(
    () => root,
    () => new Date("2026-09-16T12:05:00.000Z"),
  );
  try {
    assert.equal(await store.reconcileActive(), 1);
    const record = JSON.parse(
      await readFile(path.join(activeDir, "thread.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(record.outcome, "disconnected");
    assert.equal(record.endedAt, "2026-09-16T12:05:00.000Z");
    assert.equal(await readFile(path.join(corruptDir, "thread.json"), "utf8"), "not-json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Aiden Live prunes terminal thread stores from process memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-live-threads-"));
  const store = new AidenLiveThreadStore(() => root);
  try {
    for (let index = 0; index < 25; index += 1) {
      const id = `session-${index}`;
      await store.begin({ id, model: "gemini-3.8-live", computerUseEnabled: false });
      await store.finish(id, "stopped");
    }
    const internals = store as unknown as {
      stores: Map<string, unknown>;
      begun: Set<string>;
    };
    assert.equal(internals.stores.size, 0);
    assert.equal(internals.begun.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Aiden Live recovery processes more than one thousand active records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-live-threads-"));
  const threadsRoot = path.join(root, "threads");
  const record = (id: string) =>
    JSON.stringify({
      schemaVersion: 1,
      id,
      startedAt: "2026-09-16T12:00:00.000Z",
      outcome: "active",
      model: "gemini-3.8-live",
      computerUseEnabled: false,
    });
  try {
    await Promise.all(
      Array.from({ length: 1_001 }, async (_, index) => {
        const id = `session-${String(index).padStart(4, "0")}`;
        const directory = path.join(threadsRoot, id);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "thread.json"), record(id));
      }),
    );
    const store = new AidenLiveThreadStore(() => root);
    assert.equal(await store.reconcileActive(), 1_001);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
