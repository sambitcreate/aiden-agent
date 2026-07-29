import assert from "node:assert/strict";
import test from "node:test";
import type { IPty, spawn } from "node-pty";
import { TerminalService } from "./terminal.js";
import type { RendererDocumentOwner } from "./renderer-document-owner.js";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function ownerState(documentId = "document-1") {
  let destroyed = false;
  const listeners = new Set<() => void>();
  const owner: RendererDocumentOwner = {
    id: 42,
    documentId,
    isDestroyed: () => destroyed,
    send: () => undefined,
    onInvalidated: (listener) => {
      listeners.add(listener);
      if (destroyed) listener();
      return () => listeners.delete(listener);
    },
  };
  return {
    owner,
    destroy: () => {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

function fakePty() {
  let killed = false;
  const pty = {
    pid: 999_999,
    kill: () => {
      killed = true;
    },
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    resize: () => undefined,
    write: () => undefined,
  } as unknown as IPty;
  return { pty, killed: () => killed };
}

test("renderer destruction during terminal revalidation prevents spawn", async () => {
  const owner = ownerState();
  const revalidation = deferred();
  let spawnCount = 0;
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    spawnPty: (() => {
      spawnCount += 1;
      return fakePty().pty;
    }) as typeof spawn,
  });

  const creating = service.create(
    "workspace-1",
    "/tmp",
    owner.owner,
    undefined,
    () => revalidation.promise,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  owner.destroy();
  revalidation.resolve();

  await assert.rejects(creating, /workspace changed before the terminal could start/u);
  assert.equal(spawnCount, 0);
});

test("renderer destruction at the synchronous spawn boundary kills the new PTY", async () => {
  const owner = ownerState();
  const child = fakePty();
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    spawnPty: (() => {
      owner.destroy();
      return child.pty;
    }) as typeof spawn,
  });

  await assert.rejects(
    service.create("workspace-1", "/tmp", owner.owner),
    /workspace changed before the terminal could start/u,
  );
  assert.equal(child.killed(), true);
  assert.throws(() => service.workspaceId("missing", owner.owner), /unavailable/u);
});

test("renderer reload invalidates a pending terminal before helper preparation can spawn", async () => {
  const owner = ownerState();
  const helper = deferred();
  let spawnCount = 0;
  const service = new TerminalService({
    prepareSpawnHelper: () => helper.promise,
    spawnPty: (() => {
      spawnCount += 1;
      return fakePty().pty;
    }) as typeof spawn,
  });

  const creating = service.create("workspace-1", "/tmp", owner.owner);
  await new Promise<void>((resolve) => setImmediate(resolve));
  service.closeForWebContents(owner.owner.id);
  helper.resolve();

  await assert.rejects(creating, /workspace changed before the terminal could start/u);
  assert.equal(spawnCount, 0);
});

test("a replacement renderer document cannot inherit an existing terminal", async () => {
  const original = ownerState("document-1");
  const replacement = ownerState("document-2");
  const child = fakePty();
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    spawnPty: (() => child.pty) as typeof spawn,
  });
  const session = await service.create("workspace-1", "/tmp", original.owner);

  assert.equal(service.workspaceId(session.id, original.owner), "workspace-1");
  assert.throws(() => service.workspaceId(session.id, replacement.owner), /unavailable/u);
  original.destroy();
  assert.equal(child.killed(), true);
  assert.throws(() => service.workspaceId(session.id, original.owner), /unavailable/u);
});

test("a throwing PTY kill cannot escape renderer-document teardown", async () => {
  const original = ownerState("document-1");
  let killAttempted = false;
  const child = fakePty();
  child.pty.kill = () => {
    killAttempted = true;
    throw new Error("simulated PTY kill failure");
  };
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    spawnPty: (() => child.pty) as typeof spawn,
  });
  const session = await service.create("workspace-1", "/tmp", original.owner);

  assert.doesNotThrow(original.destroy);
  assert.equal(killAttempted, true);
  assert.throws(() => service.workspaceId(session.id, original.owner), /unavailable/u);
});
