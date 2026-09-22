import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  pinSubagentWorkspaceRoot,
  SubagentFileMutationPreparer,
} from "./subagent-file-mutation-core.js";
import {
  createSubagentFileMutatorClient,
  resolveSubagentFileMutatorBinary,
  SubagentFileMutatorError,
} from "./subagent-file-mutator-io.js";

const repositoryRoot = process.cwd();
const productionBinary = path.join(
  repositoryRoot,
  "build",
  "native",
  "aiden-subagent-file-mutator",
);
const testingBinary = path.join(
  repositoryRoot,
  "build",
  "native",
  "aiden-subagent-file-mutator-test",
);

async function workspace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-mutator-io-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("Timed out waiting for native helper test marker.");
}

test("resolves packaged and development helper locations", () => {
  assert.equal(
    resolveSubagentFileMutatorBinary({
      defaultApp: false,
      resourcesPath: "/Applications/Aiden.app/Contents/Resources",
      cwd: "/workspace",
    }),
    "/Applications/Aiden.app/Contents/Helpers/aiden-subagent-file-mutator",
  );
  assert.equal(
    resolveSubagentFileMutatorBinary({
      defaultApp: true,
      resourcesPath: "/ignored",
      cwd: "/workspace",
    }),
    "/workspace/build/native/aiden-subagent-file-mutator",
  );
});

test("inspect, prepare, commit, finalize, and cancel stay on one pinned helper", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const root = await pinSubagentWorkspaceRoot(rootPath);
  let child: ChildProcessWithoutNullStreams | undefined;
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: productionBinary,
    spawnProcess: (command, args, options) => {
      assert.deepEqual(options.env, {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C",
        LC_ALL: "C",
      });
      assert.equal(options.cwd, "/");
      assert.equal(options.detached, false);
      assert.equal(options.shell, false);
      child = spawn(command, [...args], options);
      return child;
    },
  });
  const preparer = new SubagentFileMutationPreparer({
    allocateEffectId: (() => {
      const ids = ["io-create", "io-edit", "io-cancel"];
      return () => ids.shift() ?? "unused";
    })(),
  });

  const createInspection = await client.inspect(
    preparer.createEffectId(),
    "file.txt",
  );
  assert.equal(createInspection.expectedRevision, "absent");
  const createEffect = preparer.prepareWrite({
    inspection: createInspection,
    content: "before target after\n",
  });
  await client.prepare(createEffect);
  const created = await client.commit(createEffect.effectId);
  assert.equal(created.effectDigest, createEffect.effectDigest);
  assert.equal(created.recoveryName, undefined);
  assert.equal(await readFile(path.join(rootPath, "file.txt"), "utf8"), createEffect.postimage.content);

  const editInspection = await client.inspect(preparer.createEffectId(), "file.txt");
  const editEffect = preparer.prepareEdit({
    inspection: editInspection,
    oldString: "target",
    newString: "replacement",
  });
  await client.prepare(editEffect);
  const edited = await client.commit(editEffect.effectId);
  assert.match(
    edited.recoveryName ?? "",
    /^\.aiden-subagent-file-io-edit-[a-f0-9-]{36}\.tmp$/u,
  );
  await client.finalize(editEffect.effectId);
  assert.equal(await readFile(path.join(rootPath, "file.txt"), "utf8"), "before replacement after\n");

  const cancelled = await client.inspect(preparer.createEffectId(), "cancelled.txt");
  await client.cancel(cancelled.effectId);
  await client.close();
  assert.equal(client.currentState, "closed");
  assert.ok(child);
  assert.equal(child.exitCode, 0);
});

test("HTML reads traverse beneath the pinned workspace root without following symlinks", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  await mkdir(path.join(rootPath, "nested"));
  await writeFile(path.join(rootPath, "nested", "chart.html"), "<p>workspace chart</p>");
  const root = await pinSubagentWorkspaceRoot(rootPath);
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: productionBinary,
  });

  assert.equal(
    await client.readHtml("html-read", "nested/chart.html"),
    "<p>workspace chart</p>",
  );
  await client.close();

  const outside = await workspace(t);
  await writeFile(path.join(outside, "secret.html"), "<p>outside secret</p>");
  await symlink(outside, path.join(rootPath, "redirect"));
  const rejectingClient = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: productionBinary,
  });
  await assert.rejects(
    rejectingClient.readHtml("html-symlink", "redirect/secret.html"),
    (error) => error instanceof SubagentFileMutatorError && error.failure === "conflict",
  );
  await rejectingClient.close();
});

test("HTML reads retain opened ancestors during a mid-walk symlink swap", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const selected = path.join(rootPath, "selected");
  const displaced = path.join(rootPath, "selected-original");
  const attacker = await workspace(t);
  const marker = path.join(rootPath, "html-read-pause.marker");
  await mkdir(path.join(selected, "nested"), { recursive: true });
  await mkdir(path.join(attacker, "nested"), { recursive: true });
  await writeFile(path.join(selected, "nested", "chart.html"), "WORKSPACE_CONTENT");
  await writeFile(path.join(attacker, "nested", "chart.html"), "OUTSIDE_SECRET");
  const root = await pinSubagentWorkspaceRoot(rootPath);
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: testingBinary,
    spawnProcess: (command, args, options) =>
      spawn(command, [...args], {
        ...options,
        env: {
          ...options.env,
          AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_DURING_HTML_READ: marker,
        },
      }),
  });

  const reading = client.readHtml("html-race", "selected/nested/chart.html");
  await waitForFile(marker);
  await rename(selected, displaced);
  await symlink(attacker, selected);
  await writeFile(`${marker}.continue`, "continue");

  assert.equal(await reading, "WORKSPACE_CONTENT");
  await client.close();
});

test("stale prepare errors are fixed and do not expose path or content", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const target = path.join(rootPath, "private-name.txt");
  await writeFile(target, "secret-current\n");
  const root = await pinSubagentWorkspaceRoot(rootPath);
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: productionBinary,
  });
  const preparer = new SubagentFileMutationPreparer({
    allocateEffectId: () => "stale-effect",
  });
  const inspection = await client.inspect(preparer.createEffectId(), "private-name.txt");
  const effect = preparer.prepareWrite({
    inspection,
    content: "secret-postimage\n",
  });
  await writeFile(target, "external\n");
  await assert.rejects(
    client.prepare(effect),
    (error) => {
      assert.ok(error instanceof SubagentFileMutatorError);
      assert.equal(error.failure, "conflict");
      assert.doesNotMatch(error.message, /private-name|secret/u);
      return true;
    },
  );
  await client.cancel(effect.effectId);
  await client.close();
});

test("an aborted unsent commit remains cancellable", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const root = await pinSubagentWorkspaceRoot(rootPath);
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: productionBinary,
  });
  const preparer = new SubagentFileMutationPreparer({
    allocateEffectId: () => "abort-effect",
  });
  const inspection = await client.inspect(preparer.createEffectId(), "file.txt");
  const effect = preparer.prepareWrite({ inspection, content: "value\n" });
  await client.prepare(effect);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.commit(effect.effectId, controller.signal),
    (error) =>
      error instanceof SubagentFileMutatorError && error.failure === "cancelled",
  );
  assert.equal(client.currentState, "prepared");
  await client.cancel(effect.effectId);
  await client.close();
});

test("an effectful timeout is indeterminate and kills the helper", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const target = path.join(rootPath, "file.txt");
  const marker = path.join(rootPath, "pause.marker");
  await writeFile(target, "original\n");
  const root = await pinSubagentWorkspaceRoot(rootPath);
  let child: ChildProcessWithoutNullStreams | undefined;
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: testingBinary,
    requestTimeoutMs: 5_000,
    effectfulRequestTimeoutMs: 2_000,
    spawnProcess: (command, args, options) => {
      child = spawn(command, [...args], {
        ...options,
        env: {
          ...options.env,
          AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_BEFORE_INSTALL: marker,
        },
      });
      return child;
    },
  });
  const preparer = new SubagentFileMutationPreparer({
    allocateEffectId: () => "timeout-effect",
  });
  const inspection = await client.inspect(preparer.createEffectId(), "file.txt");
  const effect = preparer.prepareWrite({ inspection, content: "replacement\n" });
  await client.prepare(effect);
  await assert.rejects(
    client.commit(effect.effectId),
    (error) =>
      error instanceof SubagentFileMutatorError && error.failure === "indeterminate",
  );
  assert.equal(client.currentState, "indeterminate");
  await access(marker);
  await client.close();
  assert.equal(client.currentState, "closed");
  assert.ok(child);
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(await readFile(target, "utf8"), "original\n");
});

test("close kills and drains a helper when recovery reconciliation conflicts", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const target = path.join(rootPath, "file.txt");
  await writeFile(target, "original\n", { mode: 0o640 });
  const root = await pinSubagentWorkspaceRoot(rootPath);
  let child: ChildProcessWithoutNullStreams | undefined;
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: productionBinary,
    spawnProcess: (command, args, options) => {
      child = spawn(command, [...args], options);
      return child;
    },
  });
  const preparer = new SubagentFileMutationPreparer({
    allocateEffectId: () => "close-conflict",
  });
  const inspection = await client.inspect(preparer.createEffectId(), "file.txt");
  const effect = preparer.prepareWrite({ inspection, content: "replacement\n" });
  await client.prepare(effect);
  const committed = await client.commit(effect.effectId);
  assert.ok(committed.recoveryName);
  await chmod(path.join(rootPath, committed.recoveryName), 0o777);
  await assert.rejects(
    client.close(),
    (error) =>
      error instanceof SubagentFileMutatorError && error.failure === "conflict",
  );
  assert.equal(client.currentState, "closed");
  assert.ok(child);
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(await readFile(target, "utf8"), "replacement\n");
});

test("public transaction transitions serialize concurrent replay and cleanup", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const target = path.join(rootPath, "file.txt");
  await writeFile(target, "original\n");
  const root = await pinSubagentWorkspaceRoot(rootPath);
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: productionBinary,
  });
  const preparer = new SubagentFileMutationPreparer({
    allocateEffectId: () => "serialized-effect",
  });
  const inspection = await client.inspect(preparer.createEffectId(), "file.txt");
  const effect = preparer.prepareWrite({ inspection, content: "replacement\n" });
  await client.prepare(effect);
  const commits = await Promise.allSettled([
    client.commit(effect.effectId),
    client.commit(effect.effectId),
  ]);
  assert.equal(commits.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(commits.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(client.currentState, "committed");
  const settlements = await Promise.allSettled([
    client.finalize(effect.effectId),
    client.preserve(effect.effectId),
  ]);
  assert.equal(settlements[0].status, "fulfilled");
  assert.equal(settlements[1].status, "rejected");
  assert.equal(client.currentState, "idle");

  const cancelInspection = await client.inspect("serialized-cancel", "next.txt");
  const cancellations = await Promise.allSettled([
    client.cancel(cancelInspection.effectId),
    client.cancel(cancelInspection.effectId),
  ]);
  assert.equal(cancellations.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(cancellations.filter(({ status }) => status === "rejected").length, 1);
  const closeInspection = await client.inspect("serialized-close", "created.txt");
  const closeEffect = new SubagentFileMutationPreparer().prepareWrite({
    inspection: closeInspection,
    content: "created\n",
  });
  await client.prepare(closeEffect);
  const commitAndClose = await Promise.allSettled([
    client.commit(closeEffect.effectId),
    client.close(),
  ]);
  assert.equal(commitAndClose[0].status, "fulfilled");
  assert.equal(commitAndClose[1].status, "fulfilled");
  assert.equal(client.currentState, "closed");
});

test("prepare snapshots a hostile mutable effect before awaiting native confirmation", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const marker = path.join(rootPath, "prepared.marker");
  const root = await pinSubagentWorkspaceRoot(rootPath);
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: testingBinary,
    spawnProcess: (command, args, options) =>
      spawn(command, [...args], {
        ...options,
        env: {
          ...options.env,
          AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_AFTER_PREPARE: marker,
        },
      }),
  });
  const preparer = new SubagentFileMutationPreparer({
    allocateEffectId: () => "mutable-effect",
  });
  const inspection = await client.inspect(preparer.createEffectId(), "file.txt");
  const prepared = preparer.prepareWrite({ inspection, content: "authorized\n" });
  const hostile = {
    ...prepared,
    workspaceRoot: { ...prepared.workspaceRoot },
    postimage: { ...prepared.postimage },
  };
  const pending = client.prepare(hostile);
  await waitForFile(marker);
  hostile.effectDigest = "0".repeat(64);
  hostile.postimage.content = "tampered\n";
  hostile.postimage.sha256 = "0".repeat(64);
  await writeFile(`${marker}.continue`, "continue\n");
  await pending;
  const committed = await client.commit(prepared.effectId);
  assert.equal(committed.effectDigest, prepared.effectDigest);
  assert.equal(await readFile(path.join(rootPath, "file.txt"), "utf8"), "authorized\n");
  await client.close();
});

test("prepare snapshots before a caller can synchronously replace a valid alias", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const root = await pinSubagentWorkspaceRoot(rootPath);
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: productionBinary,
  });
  const preparer = new SubagentFileMutationPreparer({
    allocateEffectId: () => "immediate-alias",
  });
  const inspection = await client.inspect(preparer.createEffectId(), "file.txt");
  const original = preparer.prepareWrite({ inspection, content: "authorized\n" });
  const alternate = preparer.prepareWrite({ inspection, content: "self-consistent-tamper\n" });
  const hostile = {
    ...original,
    workspaceRoot: { ...original.workspaceRoot },
    postimage: { ...original.postimage },
  };
  const pending = client.prepare(hostile);
  Object.assign(hostile, alternate, {
    workspaceRoot: { ...alternate.workspaceRoot },
    postimage: { ...alternate.postimage },
  });
  await pending;
  const committed = await client.commit(original.effectId);
  assert.equal(committed.effectDigest, original.effectDigest);
  assert.equal(await readFile(path.join(rootPath, "file.txt"), "utf8"), "authorized\n");
  await client.close();
});

test("a pre-aborted first request does not poison startup or close", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const root = await pinSubagentWorkspaceRoot(rootPath);
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: productionBinary,
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.inspect("retry-start", "file.txt", controller.signal),
    (error) =>
      error instanceof SubagentFileMutatorError && error.failure === "cancelled",
  );
  const inspection = await client.inspect("retry-start", "file.txt");
  assert.equal(inspection.expectedRevision, "absent");
  await client.cancel(inspection.effectId);
  await client.close();
  assert.equal(client.currentState, "closed");
});

test("prepare validation remains a rejected Promise after synchronous snapshotting", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const root = await pinSubagentWorkspaceRoot(rootPath);
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    binary: productionBinary,
  });
  const preparer = new SubagentFileMutationPreparer({
    allocateEffectId: () => "rejected-promise",
  });
  const inspection = await client.inspect(preparer.createEffectId(), "file.txt");
  const effect = preparer.prepareWrite({ inspection, content: "value\n" });
  const invalid = { ...effect, effectDigest: "0".repeat(64) };
  let rejection: Promise<void> | undefined;
  assert.doesNotThrow(() => {
    rejection = client.prepare(invalid);
  });
  assert.ok(rejection);
  await assert.rejects(
    rejection,
    (error: unknown) =>
      error instanceof SubagentFileMutatorError && error.failure === "invalid_input",
  );
  await client.cancel(effect.effectId);
  await client.close();
});

test("chunked unsolicited response lines fail before the queue can grow", async (t) => {
  const rootPath = await workspace(t);
  const root = await pinSubagentWorkspaceRoot(rootPath);
  let killed = false;
  const client = createSubagentFileMutatorClient({
    workspaceRoot: root,
    spawnProcess: () => {
      const processEmitter = new EventEmitter() as EventEmitter &
        Partial<ChildProcessWithoutNullStreams>;
      const stdout = {
        on(event: string, listener: (chunk: Buffer) => void) {
          if (event === "data") {
            listener(Buffer.from("ready\nqueued-one\n"));
            listener(Buffer.from("queued-two\n"));
          }
          return stdout;
        },
        ref() {},
        unref() {},
      };
      Object.assign(processEmitter, {
        stdin: { write() {}, end() {}, ref() {}, unref() {} },
        stdout,
        stderr: { resume() {}, ref() {}, unref() {} },
        exitCode: null,
        signalCode: null,
        ref() {},
        unref() {},
        kill() {
          killed = true;
          Object.defineProperty(processEmitter, "signalCode", {
            configurable: true,
            value: "SIGKILL",
          });
          queueMicrotask(() => processEmitter.emit("close", null, "SIGKILL"));
          return true;
        },
      });
      return processEmitter as ChildProcessWithoutNullStreams;
    },
  });
  await assert.rejects(
    client.inspect("flood-effect", "file.txt"),
    (error) =>
      error instanceof SubagentFileMutatorError && error.failure === "io_failed",
  );
  assert.equal(killed, true);
  await client.close();
});
