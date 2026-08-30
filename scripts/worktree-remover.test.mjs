/* global Buffer, process, setTimeout */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(repositoryRoot, "build", "native", "aiden-worktree-remover-test");
const productionBinary = path.join(repositoryRoot, "build", "native", "aiden-worktree-remover");

async function fixture(t, name) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-remover-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const target = path.join(root, `.aiden-removing-${name}`);
  const authorizationTarget = path.join(root, `.aiden-authorizing-${name}`);
  await mkdir(target);
  const identity = await lstat(target);
  return { root, target, authorizationTarget, identity };
}

function runRemover(
  { root, target, authorizationTarget, identity },
  environment = {},
  executable = binary,
  handshake = "continue\n",
) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        "remove",
        "--parent",
        root,
        "--name",
        path.basename(target),
        "--device",
        String(identity.dev),
        "--inode",
        String(identity.ino),
        "--manifest-mode",
        handshake === "resume" ? "resume" : "fresh",
      ],
      {
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "C",
          LC_ALL: "C",
          ...environment,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stderr = [];
    const stdout = [];
    let authorized = false;
    const expectedReady = new RegExp(
      `^ready:${path.basename(authorizationTarget)}:([0-9a-f]{64})\\n$`,
      "u",
    );
    child.stdout.on("data", (chunk) => {
      stdout.push(Buffer.from(chunk));
      const output = Buffer.concat(stdout).toString("utf8");
      const ready = expectedReady.exec(output);
      if (!authorized && ready) {
        authorized = true;
        child.stdin.end(handshake === "resume" ? `resume:${ready[1]}\n` : handshake);
      }
    });
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code, stderr: Buffer.concat(stderr).toString("utf8").trim() }),
    );
  });
}

function runManifestFinalizer(root, token, digest, environment = {}, executable = binary) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["finalize-manifest", "--parent", root, "--token", token, "--digest", digest],
      {
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "C",
          LC_ALL: "C",
          ...environment,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      }),
    );
  });
}

async function manifestFixture(t, name, stage = "manifest") {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-manifest-finalizer-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const token = `finalize-${name}`;
  const manifest = path.join(root, `.aiden-removal-manifest-${token}`);
  const paths = {
    manifest,
    finalizing: `${manifest}.finalizing`,
    deleting: `${manifest}.deleting`,
  };
  const content = Buffer.from(`authorized manifest ${name}\n`, "utf8");
  const digest = createHash("sha256").update(content).digest("hex");
  await writeFile(paths[stage], content, { mode: 0o600 });
  return { root, token, paths, content, digest };
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(file);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for test barrier: ${path.basename(file)}`);
}

async function interruptAfterDirectoryIsolation(value, directoryName, markerName) {
  const marker = path.join(value.root, markerName);
  const interrupted = runRemover(value, {
    AIDEN_REMOVER_TEST_PAUSE_AFTER_DIRECTORY_ISOLATION: marker,
    AIDEN_REMOVER_TEST_PAUSE_AFTER_DIRECTORY_ISOLATION_NAME: directoryName,
  });
  await waitForFile(marker);
  const helperPid = Number.parseInt(await readFile(marker, "utf8"), 10);
  assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
  const isolatedNames = (await readdir(value.authorizationTarget)).filter((name) =>
    name.startsWith(".aiden-isolated-"),
  );
  assert.equal(isolatedNames.length, 1);
  assert.match(isolatedNames[0], /^\.aiden-isolated-[0-9a-f]{64}$/u);
  process.kill(helperPid, "SIGKILL");
  assert.deepEqual(await interrupted, { code: null, stderr: "" });
  return isolatedNames[0];
}

test("main test lifecycle builds the native worktree remover before GitService tests", async () => {
  const packageManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.match(packageManifest.scripts?.pretest ?? "", /^npm run build:worktree-remover(?: &&|$)/u);
});

test("descriptor remover deletes nested owned entries without following symlinks", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "owned");
  const outside = path.join(value.root, "outside");
  await mkdir(path.join(value.target, "nested"));
  await writeFile(path.join(value.target, "nested", "file"), "owned\n");
  await writeFile(outside, "must survive\n");
  await symlink(outside, path.join(value.target, "outside-link"));

  assert.deepEqual(await runRemover(value), { code: 0, stderr: "" });
  await assert.rejects(access(value.target));
  assert.equal((await lstat(outside)).isFile(), true);
});

test("descriptor remover preserves a file created after its stable scan", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "late-file");
  await writeFile(path.join(value.target, "original"), "owned\n");
  const marker = path.join(value.root, "after-scan");
  const result = runRemover(value, {
    AIDEN_REMOVER_TEST_PAUSE_AFTER_SCAN: marker,
  });
  await waitForFile(marker);
  await writeFile(path.join(value.authorizationTarget, "late-user-file"), "must survive\n");
  await writeFile(`${marker}.continue`, "continue\n");

  assert.deepEqual(await result, { code: 21, stderr: "mutation_detected" });
  assert.equal((await lstat(value.target)).isDirectory(), true);
  assert.equal((await lstat(path.join(value.target, "late-user-file"))).isFile(), true);
});

test("descriptor remover preserves a nested file created after its full-tree scan", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "late-nested-file");
  const nested = path.join(value.target, "nested");
  await mkdir(nested);
  await writeFile(path.join(nested, "original"), "owned\n");
  const marker = path.join(value.root, "after-full-tree-scan");
  const result = runRemover(value, {
    AIDEN_REMOVER_TEST_PAUSE_AFTER_SCAN: marker,
  });
  await waitForFile(marker);
  await writeFile(
    path.join(value.authorizationTarget, "nested", "late-user-file"),
    "must survive\n",
  );
  await writeFile(`${marker}.continue`, "continue\n");

  assert.deepEqual(await result, { code: 21, stderr: "mutation_detected" });
  assert.equal((await lstat(value.target)).isDirectory(), true);
  assert.equal((await lstat(path.join(value.target, "nested", "late-user-file"))).isFile(), true);
});

test("entry isolation preserves replacements at the exact removal boundary", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  for (const kind of ["file", "symlink", "directory"]) {
    await t.test(kind, async (subtest) => {
      const value = await fixture(subtest, `entry-swap-${kind}`);
      const originalVictim = path.join(value.target, "victim");
      const originalLinkTarget = path.join(value.root, "original-link-target");
      const replacementLinkTarget = path.join(value.root, "replacement-link-target");
      if (kind === "file") {
        await writeFile(originalVictim, "owned original\n");
      } else if (kind === "symlink") {
        await writeFile(originalLinkTarget, "original target\n");
        await writeFile(replacementLinkTarget, "replacement target\n");
        await symlink(originalLinkTarget, originalVictim);
      } else {
        await mkdir(originalVictim);
        await writeFile(path.join(originalVictim, "owned"), "owned original\n");
      }

      const marker = path.join(value.root, `before-entry-${kind}`);
      const result = runRemover(value, {
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_ENTRY_ISOLATION: marker,
      });
      await waitForFile(marker);
      const victim = path.join(value.authorizationTarget, "victim");
      const moved = path.join(value.authorizationTarget, `moved-${kind}`);
      await rename(victim, moved);
      if (kind === "file") {
        await writeFile(victim, "unrelated replacement\n");
      } else if (kind === "symlink") {
        await symlink(replacementLinkTarget, victim);
      } else {
        await mkdir(victim);
        await writeFile(path.join(victim, "replacement"), "unrelated replacement\n");
      }
      await writeFile(`${marker}.continue`, "continue\n");

      assert.deepEqual(await result, { code: 21, stderr: "mutation_detected" });
      const restoredVictim = path.join(value.target, "victim");
      const restoredMoved = path.join(value.target, `moved-${kind}`);
      if (kind === "file") {
        assert.equal(await readFile(restoredMoved, "utf8"), "owned original\n");
        assert.equal(await readFile(restoredVictim, "utf8"), "unrelated replacement\n");
      } else if (kind === "symlink") {
        assert.equal(await readlink(restoredMoved), originalLinkTarget);
        assert.equal(await readlink(restoredVictim), replacementLinkTarget);
      } else {
        assert.equal(await readFile(path.join(restoredMoved, "owned"), "utf8"), "owned original\n");
        assert.equal(
          await readFile(path.join(restoredVictim, "replacement"), "utf8"),
          "unrelated replacement\n",
        );
      }
      assert.deepEqual(
        (await readdir(value.target)).filter((name) => name.startsWith(".aiden-isolated-")),
        [],
      );
    });
  }
});

test("descriptor remover never traverses a replacement swapped in before root isolation", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "root-swap");
  await writeFile(path.join(value.target, "owned"), "owned\n");
  const marker = path.join(value.root, "before-root");
  const result = runRemover(value, {
    AIDEN_REMOVER_TEST_PAUSE_BEFORE_ROOT: marker,
  });
  await waitForFile(marker);
  const moved = path.join(value.root, "moved-owned");
  await rename(value.target, moved);
  await mkdir(value.target);
  const sentinel = path.join(value.target, "replacement-sentinel");
  await writeFile(sentinel, "must survive\n");
  await writeFile(`${marker}.continue`, "continue\n");

  assert.deepEqual(await result, { code: 20, stderr: "identity_changed" });
  assert.equal((await lstat(moved)).isDirectory(), true);
  assert.equal((await lstat(sentinel)).isFile(), true);
});

test("descriptor remover authorizes its isolated root and preserves a replacement at the original path", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "root-authorization-swap");
  await writeFile(path.join(value.target, "owned"), "owned\n");
  const marker = path.join(value.root, "after-root-scan");
  const result = runRemover(value, {
    AIDEN_REMOVER_TEST_PAUSE_AFTER_SCAN: marker,
  });
  await waitForFile(marker);
  await mkdir(value.target);
  const sentinel = path.join(value.target, "replacement-sentinel");
  await writeFile(sentinel, "must survive\n");
  await writeFile(`${marker}.continue`, "continue\n");

  assert.deepEqual(await result, { code: 20, stderr: "identity_changed" });
  assert.equal((await lstat(value.target)).isDirectory(), true);
  assert.equal(await readFile(sentinel, "utf8"), "must survive\n");
  await assert.rejects(access(value.authorizationTarget));
});

test("descriptor remover restores its quarantine when authorization aborts", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "authorization-abort");
  await writeFile(path.join(value.target, "owned"), "owned\n");

  assert.deepEqual(await runRemover(value, {}, binary, "abort\n"), {
    code: 23,
    stderr: "",
  });
  assert.equal(await readFile(path.join(value.target, "owned"), "utf8"), "owned\n");
  await assert.rejects(access(value.authorizationTarget));
});

test("descriptor remover restores its quarantine after a malformed authorization", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "authorization-malformed");
  await writeFile(path.join(value.target, "owned"), "owned\n");

  assert.deepEqual(await runRemover(value, {}, binary, "malformed\n"), {
    code: 22,
    stderr: "io_failed",
  });
  assert.equal(await readFile(path.join(value.target, "owned"), "utf8"), "owned\n");
  await assert.rejects(access(value.authorizationTarget));
});

test("descriptor remover resumes an already isolated authorization root", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "authorization-recovery");
  await writeFile(path.join(value.target, "owned"), "owned\n");
  await rename(value.target, value.authorizationTarget);

  assert.deepEqual(await runRemover({ ...value, target: value.authorizationTarget }), {
    code: 0,
    stderr: "",
  });
  await assert.rejects(access(value.target));
  await assert.rejects(access(value.authorizationTarget));
});

test("descriptor remover resumes only the remaining entries from its durable manifest", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "partial-manifest-recovery");
  await writeFile(path.join(value.target, "a-tracked"), "first\n");
  await writeFile(path.join(value.target, "b-tracked"), "second\n");
  const marker = path.join(value.root, "after-first-tracked-unlink");
  const interrupted = runRemover(value, {
    AIDEN_REMOVER_TEST_PAUSE_AFTER_UNLINK: marker,
    AIDEN_REMOVER_TEST_PAUSE_AFTER_UNLINK_NAME: "a-tracked",
  });
  await waitForFile(marker);
  const helperPid = Number.parseInt(await readFile(marker, "utf8"), 10);
  assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
  process.kill(helperPid, "SIGKILL");
  assert.deepEqual(await interrupted, { code: null, stderr: "" });
  await assert.rejects(access(path.join(value.authorizationTarget, "a-tracked")));
  assert.equal(
    await readFile(path.join(value.authorizationTarget, "b-tracked"), "utf8"),
    "second\n",
  );

  assert.deepEqual(
    await runRemover({ ...value, target: value.authorizationTarget }, {}, binary, "resume"),
    { code: 0, stderr: "" },
  );
  await assert.rejects(access(value.target));
  await assert.rejects(access(value.authorizationTarget));
});

test("descriptor remover resumes a crash-durable isolated non-empty directory", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "isolated-directory-recovery");
  const nested = path.join(value.target, "a-nested");
  await mkdir(path.join(nested, "deeper"), { recursive: true });
  await writeFile(path.join(nested, "a-owned"), "first\n");
  await writeFile(path.join(nested, "deeper", "b-owned"), "second\n");
  await writeFile(path.join(value.target, "z-sibling"), "sibling\n");

  const isolatedName = await interruptAfterDirectoryIsolation(
    value,
    "a-nested",
    "after-directory-isolation",
  );
  assert.equal(
    await readFile(path.join(value.authorizationTarget, isolatedName, "a-owned"), "utf8"),
    "first\n",
  );
  assert.equal(
    await readFile(path.join(value.authorizationTarget, "z-sibling"), "utf8"),
    "sibling\n",
  );

  assert.deepEqual(
    await runRemover({ ...value, target: value.authorizationTarget }, {}, binary, "resume"),
    { code: 0, stderr: "" },
  );
  await assert.rejects(access(value.target));
  await assert.rejects(access(value.authorizationTarget));
});

test("descriptor remover rejects and preserves data injected into an isolated directory", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "isolated-directory-injection");
  const nested = path.join(value.target, "a-nested");
  await mkdir(nested);
  await writeFile(path.join(nested, "owned"), "owned\n");
  const isolatedName = await interruptAfterDirectoryIsolation(
    value,
    "a-nested",
    "after-directory-isolation-injection",
  );
  const injected = path.join(value.authorizationTarget, isolatedName, "late-user-data");
  await writeFile(injected, "must survive\n");

  assert.deepEqual(
    await runRemover({ ...value, target: value.authorizationTarget }, {}, binary, "resume"),
    { code: 21, stderr: "mutation_detected" },
  );
  const restoredIsolated = path.join(value.target, isolatedName);
  assert.equal(
    await readFile(path.join(restoredIsolated, "late-user-data"), "utf8"),
    "must survive\n",
  );
  assert.equal(await readFile(path.join(restoredIsolated, "owned"), "utf8"), "owned\n");

  await rm(path.join(restoredIsolated, "late-user-data"));
  assert.deepEqual(await runRemover(value, {}, binary, "resume"), { code: 0, stderr: "" });
  await assert.rejects(access(value.target));
});

test("descriptor remover rejects and preserves replacements inside an isolated directory", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "isolated-directory-replacement");
  const nested = path.join(value.target, "a-nested");
  await mkdir(nested);
  await writeFile(path.join(nested, "owned"), "owned\n");
  const isolatedName = await interruptAfterDirectoryIsolation(
    value,
    "a-nested",
    "after-directory-isolation-replacement",
  );
  const isolatedDirectory = path.join(value.authorizationTarget, isolatedName);
  await rename(path.join(isolatedDirectory, "owned"), path.join(isolatedDirectory, "moved-owned"));
  await writeFile(path.join(isolatedDirectory, "owned"), "replacement\n");

  assert.deepEqual(
    await runRemover({ ...value, target: value.authorizationTarget }, {}, binary, "resume"),
    { code: 21, stderr: "mutation_detected" },
  );
  const restoredIsolated = path.join(value.target, isolatedName);
  assert.equal(await readFile(path.join(restoredIsolated, "owned"), "utf8"), "replacement\n");
  assert.equal(await readFile(path.join(restoredIsolated, "moved-owned"), "utf8"), "owned\n");
});

test("isolated entry deletion preserves source replacements at its atomic capture boundary", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  for (const kind of ["file", "directory"]) {
    await t.test(kind, async (subtest) => {
      const value = await fixture(subtest, `isolated-delete-capture-${kind}`);
      const victim = path.join(value.target, "victim");
      if (kind === "file") await writeFile(victim, "authorized original\n");
      else await mkdir(victim);

      const marker = path.join(value.root, `before-isolated-delete-capture-${kind}`);
      const result = runRemover(value, {
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_ISOLATED_CAPTURE: marker,
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_ISOLATED_CAPTURE_NAME: "victim",
      });
      await waitForFile(marker);
      const isolatedNames = (await readdir(value.authorizationTarget)).filter((name) =>
        name.startsWith(".aiden-isolated-"),
      );
      assert.equal(isolatedNames.length, 1);
      const isolated = path.join(value.authorizationTarget, isolatedNames[0]);
      const movedOriginal = path.join(value.authorizationTarget, `moved-original-${kind}`);
      await rename(isolated, movedOriginal);
      if (kind === "file") {
        await writeFile(isolated, "unrelated replacement\n");
      } else {
        await mkdir(isolated);
        await writeFile(path.join(isolated, "must-survive"), "unrelated replacement\n");
      }
      await writeFile(`${marker}.continue`, "continue\n");

      assert.deepEqual(await result, { code: 21, stderr: "mutation_detected" });
      if (kind === "file") {
        assert.equal(
          await readFile(path.join(value.target, "victim"), "utf8"),
          "unrelated replacement\n",
        );
        assert.equal(
          await readFile(path.join(value.target, `moved-original-${kind}`), "utf8"),
          "authorized original\n",
        );
      } else {
        assert.equal(
          await readFile(path.join(value.target, "victim", "must-survive"), "utf8"),
          "unrelated replacement\n",
        );
        assert.equal(
          (await lstat(path.join(value.target, `moved-original-${kind}`))).isDirectory(),
          true,
        );
      }
      assert.deepEqual(
        (await readdir(value.target)).filter((name) => name.startsWith(".aiden-capture-")),
        [],
      );
    });
  }
});

test("root deletion preserves a replacement at its final atomic capture boundary", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "root-delete-capture");
  await writeFile(path.join(value.target, "authorized"), "authorized original\n");
  const marker = path.join(value.root, "before-root-delete-capture");
  const result = runRemover(value, {
    AIDEN_REMOVER_TEST_PAUSE_BEFORE_ROOT_CAPTURE: marker,
  });
  await waitForFile(marker);
  const movedOriginal = path.join(value.root, "moved-authorized-root");
  await rename(value.authorizationTarget, movedOriginal);
  await mkdir(value.authorizationTarget);
  await writeFile(path.join(value.authorizationTarget, "must-survive"), "unrelated replacement\n");
  await writeFile(`${marker}.continue`, "continue\n");

  assert.deepEqual(await result, { code: 21, stderr: "mutation_detected" });
  assert.equal(
    await readFile(path.join(value.target, "must-survive"), "utf8"),
    "unrelated replacement\n",
  );
  assert.equal((await lstat(movedOriginal)).isDirectory(), true);
});

test("descriptor remover rejects the wrong root identity without changing contents", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "wrong-identity");
  const sentinel = path.join(value.target, "sentinel");
  await writeFile(sentinel, "must survive\n");

  assert.deepEqual(
    await runRemover({ ...value, identity: { ...value.identity, ino: value.identity.ino + 1 } }),
    { code: 20, stderr: "identity_changed" },
  );
  assert.equal((await lstat(sentinel)).isFile(), true);
});

test("descriptor remover rejects non-canonical or overflowing identity numbers", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "malformed-identity");
  const sentinel = path.join(value.target, "sentinel");
  await writeFile(sentinel, "must survive\n");

  for (const invalidDevice of ["+1", " 1", "18446744073709551616"]) {
    assert.deepEqual(
      await runRemover({
        ...value,
        identity: { ...value.identity, dev: invalidDevice },
      }),
      { code: 64, stderr: "invalid_input" },
    );
  }
  assert.equal((await lstat(sentinel)).isFile(), true);
});

test("manifest finalizer resumes every singleton capture stage", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  for (const stage of ["manifest", "finalizing", "deleting"]) {
    await t.test(stage, async (subtest) => {
      const value = await manifestFixture(subtest, `singleton-${stage}`, stage);
      assert.deepEqual(await runManifestFinalizer(value.root, value.token, value.digest), {
        code: 0,
        stdout: "",
        stderr: "",
      });
      await Promise.all(
        Object.values(value.paths).map((candidate) => assert.rejects(access(candidate))),
      );
    });
  }
});

test("manifest finalizer treats an already absent sidecar as durably complete", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await manifestFixture(t, "absent");
  await rm(value.paths.manifest);

  assert.deepEqual(await runManifestFinalizer(value.root, value.token, value.digest), {
    code: 0,
    stdout: "",
    stderr: "",
  });
});

test("manifest finalizer preserves conflicting capture stages", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await manifestFixture(t, "conflict");
  await writeFile(value.paths.finalizing, value.content, { mode: 0o600 });

  assert.deepEqual(await runManifestFinalizer(value.root, value.token, value.digest), {
    code: 21,
    stdout: "",
    stderr: "mutation_detected",
  });
  assert.deepEqual(await readFile(value.paths.manifest), value.content);
  assert.deepEqual(await readFile(value.paths.finalizing), value.content);
});

test("manifest finalizer preserves a destination collision", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await manifestFixture(t, "destination-collision");
  const marker = path.join(value.root, "before-finalizing");
  const result = runManifestFinalizer(value.root, value.token, value.digest, {
    AIDEN_REMOVER_TEST_PAUSE_BEFORE_MANIFEST_TO_FINALIZING: marker,
  });
  await waitForFile(marker);
  await writeFile(value.paths.finalizing, "unrelated destination\n", { mode: 0o600 });
  await writeFile(`${marker}.continue`, "continue\n");

  assert.deepEqual(await result, {
    code: 21,
    stdout: "",
    stderr: "mutation_detected",
  });
  assert.deepEqual(await readFile(value.paths.manifest), value.content);
  assert.equal(await readFile(value.paths.finalizing, "utf8"), "unrelated destination\n");
});

test("manifest finalizer preserves a replacement captured after verification", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await manifestFixture(t, "source-replacement");
  const marker = path.join(value.root, "before-source-capture");
  const result = runManifestFinalizer(value.root, value.token, value.digest, {
    AIDEN_REMOVER_TEST_PAUSE_BEFORE_MANIFEST_TO_FINALIZING: marker,
  });
  await waitForFile(marker);
  const movedOriginal = path.join(value.root, "moved-original");
  await rename(value.paths.manifest, movedOriginal);
  await writeFile(value.paths.manifest, "replacement\n", { mode: 0o600 });
  await writeFile(`${marker}.continue`, "continue\n");

  assert.deepEqual(await result, {
    code: 21,
    stdout: "",
    stderr: "mutation_detected",
  });
  assert.deepEqual(await readFile(movedOriginal), value.content);
  assert.equal(await readFile(value.paths.finalizing, "utf8"), "replacement\n");
});

test("manifest finalizer preserves a deleting-stage replacement at its atomic capture boundary", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await manifestFixture(t, "delete-source-replacement", "deleting");
  const marker = path.join(value.root, "before-delete-source-capture");
  const result = runManifestFinalizer(value.root, value.token, value.digest, {
    AIDEN_REMOVER_TEST_PAUSE_BEFORE_MANIFEST_DELETE_CAPTURE: marker,
  });
  await waitForFile(marker);
  const movedOriginal = path.join(value.root, "moved-deleting-original");
  await rename(value.paths.deleting, movedOriginal);
  await writeFile(value.paths.deleting, "replacement\n", { mode: 0o600 });
  await writeFile(`${marker}.continue`, "continue\n");

  assert.deepEqual(await result, {
    code: 21,
    stdout: "",
    stderr: "mutation_detected",
  });
  assert.deepEqual(await readFile(movedOriginal), value.content);
  assert.equal(await readFile(value.paths.deleting, "utf8"), "replacement\n");
  assert.deepEqual(
    (await readdir(value.root)).filter((name) => name.startsWith(".aiden-capture-")),
    [],
  );
});

test("production remover ignores test-only pause controls", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await fixture(t, "production");
  await writeFile(path.join(value.target, "owned"), "owned\n");
  const marker = path.join(value.root, "must-not-exist");

  assert.deepEqual(
    await runRemover(
      value,
      {
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_ROOT: marker,
        AIDEN_REMOVER_TEST_PAUSE_AFTER_SCAN: marker,
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_ENTRY_ISOLATION: marker,
        AIDEN_REMOVER_TEST_PAUSE_AFTER_DIRECTORY_ISOLATION: marker,
        AIDEN_REMOVER_TEST_PAUSE_AFTER_DIRECTORY_ISOLATION_NAME: "nested",
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_ISOLATED_CAPTURE: marker,
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_ISOLATED_CAPTURE_NAME: "owned",
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_ROOT_CAPTURE: marker,
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_MANIFEST_TO_FINALIZING: marker,
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_MANIFEST_TO_DELETING: marker,
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_MANIFEST_DELETE_CAPTURE: marker,
      },
      productionBinary,
    ),
    { code: 0, stderr: "" },
  );
  await assert.rejects(access(marker));
  await assert.rejects(access(value.target));
});

test("production manifest finalizer ignores test-only pause controls", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const value = await manifestFixture(t, "production-controls");
  const marker = path.join(value.root, "must-not-exist");

  assert.deepEqual(
    await runManifestFinalizer(
      value.root,
      value.token,
      value.digest,
      {
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_MANIFEST_TO_FINALIZING: marker,
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_MANIFEST_TO_DELETING: marker,
        AIDEN_REMOVER_TEST_PAUSE_BEFORE_MANIFEST_DELETE_CAPTURE: marker,
      },
      productionBinary,
    ),
    { code: 0, stdout: "", stderr: "" },
  );
  await assert.rejects(access(marker));
});
