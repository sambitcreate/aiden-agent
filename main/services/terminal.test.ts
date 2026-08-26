import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IPty, spawn } from "node-pty";
import {
  resolveNodePtyDiskPackageDir,
  resolveNodePtySpawnHelperPaths,
} from "./terminal-spawn-helper.js";
import { TerminalService } from "./terminal.js";
import type { RendererDocumentOwner } from "./renderer-document-owner.js";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function ownerState(documentId = "document-1", id = 42) {
  let destroyed = false;
  const listeners = new Set<() => void>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const owner: RendererDocumentOwner = {
    id,
    documentId,
    isDestroyed: () => destroyed,
    send: (channel, payload) => {
      sent.push({ channel, payload });
    },
    onInvalidated: (listener) => {
      listeners.add(listener);
      if (destroyed) listener();
      return () => listeners.delete(listener);
    },
  };
  return {
    owner,
    sent,
    destroy: () => {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

function fakePty() {
  let killed = false;
  let dataListener: ((data: string) => void) | undefined;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const pty = {
    pid: 999_999,
    kill: () => {
      killed = true;
    },
    onData: (listener: (data: string) => void) => {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    resize: (cols: number, rows: number) => {
      resizes.push({ cols, rows });
    },
    write: (data: string) => {
      writes.push(data);
    },
  } as unknown as IPty;
  return {
    pty,
    killed: () => killed,
    writes,
    resizes,
    emitData: (data: string) => dataListener?.(data),
    emitExit: (exitCode = 0, signal?: number) => exitListener?.({ exitCode, signal }),
  };
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

test("shell resolution falls back to the first executable candidate", async () => {
  const owner = ownerState();
  let spawnedShell = "";
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    // A missing first choice and a real executable second choice; the second
    // must win without surfacing the missing one as an error.
    shellCandidates: () => ["/definitely/not/a/shell", "/bin/sh"],
    spawnPty: ((file: string) => {
      spawnedShell = file;
      return fakePty().pty;
    }) as typeof spawn,
  });

  await service.create("workspace-1", "/tmp", owner.owner);
  assert.equal(spawnedShell, "/bin/sh");
});

test("shell resolution rejects descriptively when no candidate is executable", async () => {
  const owner = ownerState();
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    shellCandidates: () => ["/definitely/not/a/shell", "/also/not/real"],
    spawnPty: (() => fakePty().pty) as typeof spawn,
  });

  await assert.rejects(
    service.create("workspace-1", "/tmp", owner.owner),
    /No executable shell found/u,
  );
});

test("a non-executable spawn-helper is chmod'd and verified before spawn", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pty-helper-"));
  const helper = path.join(dir, "spawn-helper");
  // Create the helper without its execute bit, exactly as npm's prebuilt
  // archive restores it. open() defaults to 0o666 masked by umask.
  const handle = await open(helper, "w", 0o644);
  await handle.close();

  const owner = ownerState();
  const service = new TerminalService({
    spawnHelperPaths: async () => [helper],
    spawnPty: (() => fakePty().pty) as typeof spawn,
  });

  await service.create("workspace-1", "/tmp", owner.owner);
  const { mode } = await stat(helper);
  assert.notEqual(mode & 0o111, 0, "spawn-helper should have been made executable");

  await rm(dir, { recursive: true, force: true });
});

test("a missing prebuilds directory is a no-op (node-pty picks its own path)", async () => {
  const owner = ownerState();
  // A non-existent helper path: the guard must not throw, because some layouts
  // legitimately have no separate helper. node-pty then surfaces any real
  // failure with its own error.
  const service = new TerminalService({
    spawnHelperPaths: async () => [path.join(tmpdir(), "definitely-missing-pty-helper")],
    spawnPty: (() => fakePty().pty) as typeof spawn,
  });

  const session = await service.create("workspace-1", "/tmp", owner.owner);
  // Reaching here without throwing is the assertion: a missing helper path must
  // not break terminal creation, since the guard treats it as "not present".
  assert.equal(typeof session.id, "string");
});

test("packaged spawn-helper checks target the unpacked filesystem path", () => {
  const packaged = path.join(
    "/Applications",
    "Aiden Agent.app",
    "Contents",
    "Resources",
    "app.asar",
    "node_modules",
    "node-pty",
  );
  const unpacked = resolveNodePtyDiskPackageDir(packaged);

  assert.equal(
    unpacked,
    path.join(
      "/Applications",
      "Aiden Agent.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
    ),
  );
  assert.equal(resolveNodePtyDiskPackageDir(unpacked), unpacked, "rewrite must be idempotent");
});

test("production spawn-helper discovery reads only the unpacked ASAR directory", async () => {
  const packaged = path.join(
    "/Applications",
    "Aiden Agent.app",
    "Contents",
    "Resources",
    "app.asar",
    "node_modules",
    "node-pty",
  );
  const reads: string[] = [];
  const helpers = await resolveNodePtySpawnHelperPaths(packaged, async (directory) => {
    reads.push(directory);
    return ["darwin-arm64", "darwin-x64"];
  });
  const unpackedPrebuilds = path.join(
    "/Applications",
    "Aiden Agent.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
  );

  assert.deepEqual(reads, [unpackedPrebuilds]);
  assert.deepEqual(helpers, [
    path.join(
      "/Applications",
      "Aiden Agent.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
      "build",
      "Release",
      "spawn-helper",
    ),
    path.join(unpackedPrebuilds, "darwin-arm64", "spawn-helper"),
    path.join(unpackedPrebuilds, "darwin-x64", "spawn-helper"),
  ]);
  assert.equal(
    helpers.some((helper) => /app\.asar[/\\]/u.test(helper)),
    false,
  );
});

test("spawn-helper discovery handles node_modules.asar and absent prebuilds", async () => {
  const packaged = path.join(
    "/Applications",
    "Aiden Agent.app",
    "Contents",
    "Resources",
    "node_modules.asar",
    "node-pty",
  );
  const reads: string[] = [];
  const helpers = await resolveNodePtySpawnHelperPaths(packaged, async (directory) => {
    reads.push(directory);
    throw new Error("missing");
  });

  assert.deepEqual(helpers, [
    path.join(
      "/Applications",
      "Aiden Agent.app",
      "Contents",
      "Resources",
      "node_modules.asar.unpacked",
      "node-pty",
      "build",
      "Release",
      "spawn-helper",
    ),
  ]);
  assert.deepEqual(reads, [
    path.join(
      "/Applications",
      "Aiden Agent.app",
      "Contents",
      "Resources",
      "node_modules.asar.unpacked",
      "node-pty",
      "prebuilds",
    ),
  ]);
});

test("a spawn-helper that is already executable is left untouched", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pty-helper-ok-"));
  const helper = path.join(dir, "spawn-helper");
  const handle = await open(helper, "w", 0o755);
  await handle.close();
  const before = (await stat(helper)).mode;

  const owner = ownerState();
  const service = new TerminalService({
    spawnHelperPaths: async () => [helper],
    spawnPty: (() => fakePty().pty) as typeof spawn,
  });

  await service.create("workspace-1", "/tmp", owner.owner);
  const after = (await stat(helper)).mode;
  // An already-executable helper must not be needlessly rewritten (avoids
  // touching read-only packaged copies on every terminal open).
  assert.equal(after, before);

  await rm(dir, { recursive: true, force: true });
});

test("shell retry loop falls back when the preferred shell fails to spawn", async () => {
  const owner = ownerState();
  let spawnedShell = "";
  // The first candidate throws the exact retryable error; the second wins.
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    // Both candidates must be "executable" so they enter the spawn loop; the
    // spawn itself is what throws here.
    shellCandidates: () => ["/bin/zsh", "/bin/sh"],
    shellIsExecutable: () => true,
    spawnPty: ((file: string) => {
      if (file === "/bin/zsh") throw new Error("posix_spawnp failed.");
      spawnedShell = file;
      return fakePty().pty;
    }) as typeof spawn,
  });

  const session = await service.create("workspace-1", "/tmp", owner.owner);
  assert.equal(spawnedShell, "/bin/sh");
  assert.equal(session.resolvedShell, "/bin/sh");
  assert.equal(session.preferredShellSkipped, true);
});

test("a non-retryable spawn error surfaces immediately instead of falling back", async () => {
  const owner = ownerState();
  let attempts = 0;
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    shellCandidates: () => ["/bin/zsh", "/bin/sh"],
    shellIsExecutable: () => true,
    spawnPty: (() => {
      attempts += 1;
      // EINVAL is NOT a "missing shell" error — it must not be masked.
      const error = new Error("EINVAL");
      (error as Error & { code?: string }).code = "EINVAL";
      throw error;
    }) as typeof spawn,
  });

  await assert.rejects(service.create("workspace-1", "/tmp", owner.owner), /EINVAL/u);
  // Only the first candidate was tried; no fallback.
  assert.equal(attempts, 1);
});

test("all shells failing to spawn throws a descriptive error listing attempts", async () => {
  const owner = ownerState();
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    shellCandidates: () => ["/bin/zsh", "/bin/bash"],
    shellIsExecutable: () => true,
    spawnPty: (() => {
      throw new Error("posix_spawnp failed.");
    }) as typeof spawn,
  });

  await assert.rejects(
    service.create("workspace-1", "/tmp", owner.owner),
    /Could not launch any shell.*\/bin\/zsh.*\/bin\/bash/u,
  );
});

test("the first candidate succeeding reports preferredShellSkipped false", async () => {
  const owner = ownerState();
  let spawnedShell = "";
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    shellCandidates: () => ["/bin/zsh", "/bin/sh"],
    shellIsExecutable: () => true,
    spawnPty: ((file: string) => {
      spawnedShell = file;
      return fakePty().pty;
    }) as typeof spawn,
  });

  const session = await service.create("workspace-1", "/tmp", owner.owner);
  assert.equal(spawnedShell, "/bin/zsh");
  assert.equal(session.resolvedShell, "/bin/zsh");
  assert.equal(session.preferredShellSkipped, false);
});

test("persisted history seeds a reopened terminal buffer", async () => {
  const owner = ownerState();
  let history = "prior output\n";
  let flushAllCount = 0;
  // A minimal in-memory history store stub.
  const historyStore = {
    read: async () => history,
    append: (_ws: string, data: string) => {
      history += data;
    },
    flush: async () => undefined,
    flushAll: async () => {
      flushAllCount += 1;
    },
  };
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    spawnPty: (() => fakePty().pty) as typeof spawn,
  });
  service.installHistoryStore(historyStore);
  assert.throws(() => service.installHistoryStore(historyStore), /already initialized/u);

  const session = await service.create("workspace-1", "/tmp", owner.owner);
  // The restored history is available via snapshot, so the renderer can
  // re-hydrate xterm with the prior session's output.
  const snapshot = service.snapshot(session.id, owner.owner);
  assert.equal(snapshot.buffer, "prior output\n");
  await service.flushHistory();
  assert.equal(flushAllCount, 1);
});

test("terminal sessions cover input, resize, output, snapshot, history, and natural exit", async () => {
  const owner = ownerState();
  const child = fakePty();
  const appended: Array<{ workspaceId: string; data: string }> = [];
  let flushCount = 0;
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    spawnPty: (() => child.pty) as typeof spawn,
    historyStore: {
      read: async () => "restored\n",
      append: (workspaceId, data) => appended.push({ workspaceId, data }),
      flush: async () => {
        flushCount += 1;
      },
    },
  });
  const session = await service.create("workspace-1", "/tmp", owner.owner);

  assert.deepEqual(service.snapshot(session.id, owner.owner), {
    buffer: "restored\n",
    sequence: 1,
  });
  service.write(session.id, "printf ready\\n", owner.owner);
  assert.deepEqual(child.writes, ["printf ready\\n"]);
  assert.throws(() => service.write(session.id, "", owner.owner), /non-empty message/u);
  assert.throws(
    () => service.write(session.id, "x".repeat(64_001), owner.owner),
    /smaller than 64 KB/u,
  );
  service.resize(session.id, 999, "invalid", owner.owner);
  assert.deepEqual(child.resizes, [{ cols: 500, rows: 30 }]);

  child.emitData("live output\n");
  assert.deepEqual(service.snapshot(session.id, owner.owner), {
    buffer: "restored\nlive output\n",
    sequence: 2,
  });
  assert.deepEqual(appended, [{ workspaceId: "workspace-1", data: "live output\n" }]);
  assert.deepEqual(owner.sent[owner.sent.length - 1], {
    channel: "terminal:data",
    payload: { sessionId: session.id, sequence: 2, data: "live output\n" },
  });

  child.emitExit(7, 15);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(flushCount, 1);
  assert.deepEqual(owner.sent[owner.sent.length - 1], {
    channel: "terminal:exit",
    payload: { sessionId: session.id, exitCode: 7, signal: 15 },
  });
  assert.throws(() => service.workspaceId(session.id, owner.owner), /unavailable/u);
});

test("terminal teardown is scoped by workspace and renderer web contents", async () => {
  const firstOwner = ownerState("document-1", 41);
  const secondOwner = ownerState("document-2", 42);
  const children = [fakePty(), fakePty(), fakePty()];
  let spawnIndex = 0;
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    spawnPty: (() => children[spawnIndex++]!.pty) as typeof spawn,
  });
  const first = await service.create("workspace-a", "/tmp", firstOwner.owner);
  const second = await service.create("workspace-b", "/tmp", firstOwner.owner);
  const third = await service.create("workspace-b", "/tmp", secondOwner.owner);

  service.closeForWorkspace("workspace-a");
  assert.equal(children[0]!.killed(), true);
  assert.equal(children[1]!.killed(), false);
  assert.equal(children[2]!.killed(), false);
  assert.throws(() => service.snapshot(first.id, firstOwner.owner), /unavailable/u);
  assert.equal(service.workspaceId(second.id, firstOwner.owner), "workspace-b");
  assert.equal(service.workspaceId(third.id, secondOwner.owner), "workspace-b");

  service.closeForWebContents(firstOwner.owner.id);
  assert.equal(children[1]!.killed(), true);
  assert.equal(children[2]!.killed(), false);
  service.close(third.id, secondOwner.owner);
  assert.equal(children[2]!.killed(), true);
  assert.deepEqual(secondOwner.sent[secondOwner.sent.length - 1], {
    channel: "terminal:exit",
    payload: { sessionId: third.id, exitCode: null, signal: "SIGHUP" },
  });
});

test("terminal enforces the per-document session cap and history initialization order", async () => {
  const owner = ownerState();
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    spawnPty: (() => fakePty().pty) as typeof spawn,
  });
  for (let index = 0; index < 8; index += 1) {
    await service.create(`workspace-${index}`, "/tmp", owner.owner);
  }
  await assert.rejects(
    service.create("workspace-over-limit", "/tmp", owner.owner),
    /maximum of 8 terminal sessions/u,
  );
  assert.throws(
    () =>
      service.installHistoryStore({
        read: async () => "",
        append: () => undefined,
        flush: async () => undefined,
      }),
    /before opening a terminal/u,
  );
});

test("history flush falls back to one flush per active workspace", async () => {
  const owner = ownerState();
  const flushed: string[] = [];
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
    spawnPty: (() => fakePty().pty) as typeof spawn,
    historyStore: {
      read: async () => "",
      append: () => undefined,
      flush: async (workspaceId) => {
        flushed.push(workspaceId);
      },
    },
  });
  await service.create("workspace-1", "/tmp", owner.owner);
  await service.create("workspace-1", "/tmp", owner.owner);
  await service.create("workspace-2", "/tmp", owner.owner);

  await service.flushHistory();
  assert.deepEqual(flushed.sort(), ["workspace-1", "workspace-2"]);
});

test("history flush is a no-op before a history store is installed", async () => {
  const service = new TerminalService({
    prepareSpawnHelper: async () => undefined,
  });

  await assert.doesNotReject(service.flushHistory());
});
