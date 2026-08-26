/* global Buffer, process, setTimeout */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const execFileAsync = promisify(execFile);

async function setLinuxUserXattr(target, value) {
  await execFileAsync("/usr/bin/python3", [
    "-c",
    "import os, sys; os.setxattr(sys.argv[1], b'user.aiden-test', sys.argv[2].encode())",
    target,
    value,
  ]);
}

async function readLinuxUserXattr(target) {
  const { stdout } = await execFileAsync("/usr/bin/python3", [
    "-c",
    "import os, sys; sys.stdout.write(os.getxattr(sys.argv[1], b'user.aiden-test').decode())",
    target,
  ]);
  return stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function encoded(value) {
  const result = Buffer.from(value, "utf8").toString("base64");
  return result || "-";
}

function prepareCommand(id, expected, relativePath, contents) {
  return `prepare ${id} ${expected} ${encoded(relativePath)} ${encoded(contents)}`;
}

function recoveryPattern(id) {
  return new RegExp(
    `^\\.aiden-subagent-file-${id}-[a-f0-9-]{36}\\.tmp$`,
    "u",
  );
}

async function rootIdentity(root) {
  const identity = await stat(root, { bigint: true });
  return { device: identity.dev.toString(), inode: identity.ino.toString() };
}

function startHelper(t, root, executable = productionBinary, environment = {}) {
  let child;
  let output = "";
  const lines = [];
  const waiters = [];
  const stderr = [];
  let failure;
  let closed = Promise.resolve({ code: null, signal: null });

  const started = rootIdentity(root).then(({ device, inode }) => {
    child = spawn(
      executable,
      ["serve", "--root", root, "--device", device, "--inode", inode],
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
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      for (;;) {
        const newline = output.indexOf("\n");
        if (newline < 0) break;
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(line);
        else lines.push(line);
      }
    });
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      failure = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    });
    closed = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        if ((code !== 0 || signal !== null) && !failure) {
          failure = new Error(
            detail || `File mutator exited with ${signal ?? code}.`,
          );
          for (const waiter of waiters.splice(0)) waiter.reject(failure);
        }
        resolve({ code, signal });
      });
    });
  });

  function nextLine() {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  const ready = started.then(() => nextLine()).then((line) => assert.equal(line, "ready"));
  t.after(async () => {
    await started;
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });

  return {
    async request(command) {
      await ready;
      await new Promise((resolve, reject) => {
        child.stdin.write(`${command}\n`, (error) => (error ? reject(error) : resolve()));
      });
      return nextLine();
    },
    async close() {
      assert.equal(await this.request("close"), "ok");
      child.stdin.end();
      await closed;
    },
    async kill() {
      await ready;
      child.kill("SIGKILL");
      return closed;
    },
  };
}

async function fixture(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
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
  throw new Error(`Timed out waiting for ${path.basename(file)}.`);
}

test("creates an absent file only after a matching prepare", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-create-");
  await mkdir(path.join(root, "src"));
  const helper = startHelper(t, root);
  const contents = "export const value = 1;\n";
  assert.equal(
    await helper.request(prepareCommand("create-1", "absent", "src/new.ts", contents)),
    `prepared create-1 ${sha256(contents)} ${Buffer.byteLength(contents)}`,
  );
  assert.equal(
    await helper.request("commit create-1"),
    `committed create-1 ${sha256(contents)} ${Buffer.byteLength(contents)} none`,
  );
  assert.equal(await readFile(path.join(root, "src", "new.ts"), "utf8"), contents);
  assert.deepEqual(
    (await readdir(path.join(root, "src"))).filter((name) => name.startsWith(".aiden-")),
    [],
  );
  await helper.close();
});

test("inspect pins descriptor-relative content before preparing a postimage", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-inspect-");
  const target = path.join(root, "file.txt");
  await writeFile(target, "original\n");
  const helper = startHelper(t, root);
  assert.equal(
    await helper.request(`inspect inspect-1 ${encoded("file.txt")}`),
    `inspected inspect-1 ${sha256("original\n")} 9 ${encoded("original\n")}`,
  );
  assert.equal(
    await helper.request(
      `prepare-inspected inspect-1 ${sha256("original\n")} ${encoded("replacement\n")}`,
    ),
    `prepared inspect-1 ${sha256("replacement\n")} 12`,
  );
  assert.match(await helper.request("commit inspect-1"), /^committed inspect-1 /u);
  assert.equal(await helper.request("finalize inspect-1"), "finalized inspect-1");
  assert.equal(await readFile(target, "utf8"), "replacement\n");
  assert.equal(
    await helper.request(`inspect inspect-create ${encoded("new.txt")}`),
    "inspected inspect-create absent",
  );
  assert.equal(
    await helper.request(
      `prepare-inspected inspect-create absent ${encoded("created\n")}`,
    ),
    `prepared inspect-create ${sha256("created\n")} 8`,
  );
  assert.match(
    await helper.request("commit inspect-create"),
    /^committed inspect-create /u,
  );
  assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "created\n");
  await helper.close();
});

test("inspect refuses to prepare after the pinned path is replaced", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-inspect-race-");
  const target = path.join(root, "file.txt");
  await writeFile(target, "original\n");
  const helper = startHelper(t, root);
  assert.match(
    await helper.request(`inspect inspect-race ${encoded("file.txt")}`),
    /^inspected inspect-race /u,
  );
  await rename(target, path.join(root, "moved.txt"));
  await writeFile(target, "external\n");
  assert.equal(
    await helper.request(
      `prepare-inspected inspect-race ${sha256("original\n")} ${encoded("replacement\n")}`,
    ),
    "error conflict",
  );
  assert.equal(await helper.request("cancel inspect-race"), "cancelled inspect-race");
  assert.equal(await readFile(target, "utf8"), "external\n");
  await helper.close();
});

test("atomically replaces an expected revision and retains recovery until finalize", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-replace-");
  const target = path.join(root, "file.txt");
  const original = "original\n";
  const replacement = "replacement\n";
  await writeFile(target, original, { mode: 0o640 });
  await chmod(target, 0o640);
  const helper = startHelper(t, root);
  assert.equal(
    await helper.request(prepareCommand("replace-1", sha256(original), "file.txt", replacement)),
    `prepared replace-1 ${sha256(replacement)} ${Buffer.byteLength(replacement)}`,
  );
  const committed = await helper.request("commit replace-1");
  const match = new RegExp(
    `^committed replace-1 ${sha256(replacement)} ${Buffer.byteLength(replacement)} (\\.aiden-subagent-file-replace-1-[a-f0-9-]{36}\\.tmp)$`,
    "u",
  ).exec(committed);
  assert.ok(match);
  const recovery = path.join(root, match[1]);
  assert.equal(await readFile(target, "utf8"), replacement);
  assert.equal(await readFile(recovery, "utf8"), original);
  assert.equal((await stat(target)).mode & 0o777, 0o640);
  assert.equal(await helper.request("finalize replace-1"), "finalized replace-1");
  await assert.rejects(readFile(recovery), { code: "ENOENT" });
  await helper.close();
});

test("preserve revalidates and retains the exact displaced inode", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-preserve-");
  await writeFile(path.join(root, "file.txt"), "original\n");
  const helper = startHelper(t, root);
  assert.match(
    await helper.request(
      prepareCommand("preserve-1", sha256("original\n"), "file.txt", "replacement\n"),
    ),
    /^prepared preserve-1 /u,
  );
  const committed = await helper.request("commit preserve-1");
  const recoveryName = committed.split(" ").at(-1);
  assert.match(recoveryName, recoveryPattern("preserve-1"));
  assert.equal(await helper.request("preserve preserve-1"), "preserved preserve-1");
  assert.equal(await readFile(path.join(root, recoveryName), "utf8"), "original\n");
  assert.match(
    await helper.request(prepareCommand("after-preserve", "absent", "next.txt", "next\n")),
    /^prepared after-preserve /u,
  );
  assert.equal(await helper.request("cancel after-preserve"), "cancelled after-preserve");
  await helper.close();
});

test("preserve and finalize reject a modified recovery", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-recovery-tamper-");
  await writeFile(path.join(root, "file.txt"), "original\n");
  const helper = startHelper(t, root);
  assert.match(
    await helper.request(
      prepareCommand("tamper-1", sha256("original\n"), "file.txt", "replacement\n"),
    ),
    /^prepared tamper-1 /u,
  );
  const recoveryName = (await helper.request("commit tamper-1")).split(" ").at(-1);
  assert.ok(recoveryName);
  await writeFile(path.join(root, recoveryName), "tampered\n");
  assert.equal(await helper.request("preserve tamper-1"), "error conflict");
  assert.equal(await helper.request("finalize tamper-1"), "error conflict");
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "replacement\n");
  assert.equal(await readFile(path.join(root, recoveryName), "utf8"), "tampered\n");
  await helper.close();
});

test("preserve and finalize reject a missing recovery", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-recovery-delete-");
  await writeFile(path.join(root, "file.txt"), "original\n");
  const helper = startHelper(t, root);
  assert.match(
    await helper.request(
      prepareCommand("delete-1", sha256("original\n"), "file.txt", "replacement\n"),
    ),
    /^prepared delete-1 /u,
  );
  const recoveryName = (await helper.request("commit delete-1")).split(" ").at(-1);
  assert.ok(recoveryName);
  await rm(path.join(root, recoveryName));
  assert.equal(await helper.request("preserve delete-1"), "error conflict");
  assert.equal(await helper.request("finalize delete-1"), "error conflict");
  await helper.close();
});

test("preserve and finalize reject recovery metadata drift", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const variants =
    process.platform === "linux"
      ? ["mode", "user-xattr"]
      : ["mode", "provenance", "unknown-xattr", "acl"];
  for (const variant of variants) {
    const root = await fixture(t, `aiden-file-mutator-recovery-${variant}-`);
    await writeFile(path.join(root, "file.txt"), "original\n", { mode: 0o640 });
    const helper = startHelper(t, root);
    assert.match(
      await helper.request(
        prepareCommand(
          `recovery-${variant}`,
          sha256("original\n"),
          "file.txt",
          "replacement\n",
        ),
      ),
      new RegExp(`^prepared recovery-${variant} `, "u"),
    );
    const recoveryName = (
      await helper.request(`commit recovery-${variant}`)
    ).split(" ").at(-1);
    assert.ok(recoveryName);
    const recovery = path.join(root, recoveryName);
    if (variant === "mode") {
      await chmod(recovery, 0o777);
    } else if (variant === "user-xattr") {
      await setLinuxUserXattr(recovery, "changed");
    } else if (variant === "provenance") {
      await execFileAsync("/usr/bin/xattr", [
        "-w",
        "com.apple.provenance",
        "changed",
        recovery,
      ]);
    } else if (variant === "unknown-xattr") {
      await execFileAsync("/usr/bin/xattr", [
        "-w",
        "user.aiden-test",
        "value",
        recovery,
      ]);
    } else {
      await execFileAsync("/bin/chmod", ["+a", "everyone deny delete", recovery]);
    }
    assert.equal(
      await helper.request(`preserve recovery-${variant}`),
      "error conflict",
    );
    assert.equal(
      await helper.request(`finalize recovery-${variant}`),
      "error conflict",
    );
    if (variant === "acl") {
      await execFileAsync("/bin/chmod", ["-N", recovery]);
    }
    await helper.close();
  }
});

test("finalize fsync failure stays indeterminate and can be reconciled", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-finalize-fsync-");
  const marker = path.join(root, "finalize-fsync-failed.marker");
  await writeFile(path.join(root, "file.txt"), "original\n");
  const helper = startHelper(t, root, testingBinary, {
    AIDEN_SUBAGENT_FILE_MUTATOR_TEST_FAIL_FINALIZE_FSYNC_ONCE: marker,
  });
  assert.match(
    await helper.request(
      prepareCommand("fsync-1", sha256("original\n"), "file.txt", "replacement\n"),
    ),
    /^prepared fsync-1 /u,
  );
  const recoveryName = (await helper.request("commit fsync-1")).split(" ").at(-1);
  assert.ok(recoveryName);
  assert.equal(await helper.request("finalize fsync-1"), "error indeterminate");
  await assert.rejects(readFile(path.join(root, recoveryName)), { code: "ENOENT" });
  assert.equal(await helper.request("preserve fsync-1"), "error indeterminate");
  assert.equal(await helper.request("finalize fsync-1"), "finalized fsync-1");
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "replacement\n");
  await helper.close();
});

test("replacement commit fsync failure requires a successful preserve sync", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-commit-fsync-");
  const marker = path.join(root, "commit-fsync-failed.marker");
  await writeFile(path.join(root, "file.txt"), "original\n");
  const helper = startHelper(t, root, testingBinary, {
    AIDEN_SUBAGENT_FILE_MUTATOR_TEST_FAIL_COMMIT_FSYNC_ONCE: marker,
  });
  assert.match(
    await helper.request(
      prepareCommand(
        "commit-fsync-1",
        sha256("original\n"),
        "file.txt",
        "replacement\n",
      ),
    ),
    /^prepared commit-fsync-1 /u,
  );
  assert.equal(await helper.request("commit commit-fsync-1"), "error indeterminate");
  const recoveryName = (await readdir(root)).find((name) =>
    recoveryPattern("commit-fsync-1").test(name),
  );
  assert.ok(recoveryName);
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "replacement\n");
  assert.equal(await readFile(path.join(root, recoveryName), "utf8"), "original\n");
  assert.equal(await helper.request("preserve commit-fsync-1"), "preserved commit-fsync-1");
  assert.equal(await readFile(path.join(root, recoveryName), "utf8"), "original\n");
  assert.match(
    await helper.request(
      prepareCommand("after-commit-fsync", "absent", "next.txt", "next\n"),
    ),
    /^prepared after-commit-fsync /u,
  );
  assert.equal(
    await helper.request("cancel after-commit-fsync"),
    "cancelled after-commit-fsync",
  );
  await helper.close();
});

test("active, cancel, replay, and double-effect transitions fail closed", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-state-");
  const helper = startHelper(t, root);
  assert.match(
    await helper.request(prepareCommand("state-1", "absent", "first.txt", "first\n")),
    /^prepared state-1 /u,
  );
  assert.equal(
    await helper.request(prepareCommand("state-2", "absent", "second.txt", "second\n")),
    "error conflict",
  );
  assert.equal(await helper.request("cancel state-1"), "cancelled state-1");
  assert.equal(await helper.request("cancel state-1"), "error invalid_input");
  assert.equal(await helper.request("commit state-1"), "error invalid_input");
  assert.match(
    await helper.request(prepareCommand("state-2", "absent", "second.txt", "second\n")),
    /^prepared state-2 /u,
  );
  assert.match(await helper.request("commit state-2"), /^committed state-2 /u);
  assert.equal(await helper.request("commit state-2"), "error invalid_input");
  assert.equal(await helper.request("cancel state-2"), "error invalid_input");
  await helper.close();
});

test("a replayed replacement commit cannot clear its recovery transaction", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-commit-replay-");
  await writeFile(path.join(root, "file.txt"), "original\n");
  const helper = startHelper(t, root);
  assert.match(
    await helper.request(
      prepareCommand(
        "replay-replace",
        sha256("original\n"),
        "file.txt",
        "replacement\n",
      ),
    ),
    /^prepared replay-replace /u,
  );
  assert.match(
    await helper.request("commit replay-replace"),
    /^committed replay-replace /u,
  );
  assert.equal(
    await helper.request("commit replay-replace"),
    "error invalid_input",
  );
  assert.equal(
    await helper.request("finalize replay-replace"),
    "finalized replay-replace",
  );
  await helper.close();
});

test("rejects stale revisions, symlinks, and multiply-linked targets", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-links-");
  await mkdir(path.join(root, "real"));
  await writeFile(path.join(root, "real", "file.txt"), "current\n");
  await link(path.join(root, "real", "file.txt"), path.join(root, "hardlink.txt"));
  await symlink(path.join(root, "real"), path.join(root, "linked-directory"));
  await symlink(path.join(root, "real", "file.txt"), path.join(root, "linked-file"));
  const helper = startHelper(t, root);
  assert.equal(
    await helper.request(prepareCommand("stale", sha256("old\n"), "real/file.txt", "new\n")),
    "error conflict",
  );
  assert.equal(
    await helper.request(prepareCommand("parent-link", sha256("current\n"), "linked-directory/file.txt", "new\n")),
    "error conflict",
  );
  assert.equal(
    await helper.request(prepareCommand("leaf-link", sha256("current\n"), "linked-file", "new\n")),
    "error conflict",
  );
  assert.equal(
    await helper.request(prepareCommand("hard-link", sha256("current\n"), "hardlink.txt", "new\n")),
    "error conflict",
  );
  assert.equal(await readFile(path.join(root, "real", "file.txt"), "utf8"), "current\n");
  await helper.close();
});

test("a path replacement after prepare is reported as a conflict and preserved", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-race-");
  const target = path.join(root, "file.txt");
  const moved = path.join(root, "prepared-original.txt");
  await writeFile(target, "original\n");
  const helper = startHelper(t, root);
  assert.match(
    await helper.request(
      prepareCommand("race-1", sha256("original\n"), "file.txt", "authorized\n"),
    ),
    /^prepared race-1 /u,
  );
  await rename(target, moved);
  await writeFile(target, "external\n");
  assert.equal(await helper.request("commit race-1"), "error conflict");
  assert.equal(await readFile(target, "utf8"), "external\n");
  assert.equal(await readFile(moved, "utf8"), "original\n");
  await helper.close();
});

test("a replacement in the final install race is atomically rolled back", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-install-race-");
  const target = path.join(root, "file.txt");
  const moved = path.join(root, "prepared-original.txt");
  const marker = path.join(root, "before-install.marker");
  await writeFile(target, "original\n");
  const helper = startHelper(t, root, testingBinary, {
    AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_BEFORE_INSTALL: marker,
  });
  assert.match(
    await helper.request(
      prepareCommand("race-final", sha256("original\n"), "file.txt", "authorized\n"),
    ),
    /^prepared race-final /u,
  );
  const pendingCommit = helper.request("commit race-final");
  await waitForFile(marker);
  await rename(target, moved);
  await writeFile(target, "external\n");
  await writeFile(`${marker}.continue`, "continue\n");
  assert.equal(await pendingCommit, "error conflict");
  assert.equal(await readFile(target, "utf8"), "external\n");
  assert.equal(await readFile(moved, "utf8"), "original\n");
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith(".aiden-subagent-file-")),
    [],
  );
  await helper.close();
});

test("a late mode change to the staged inode is rejected before install", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-stage-mode-race-");
  const target = path.join(root, "file.txt");
  const marker = path.join(root, "stage-mode-before-install.marker");
  await writeFile(target, "original\n", { mode: 0o640 });
  const helper = startHelper(t, root, testingBinary, {
    AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_BEFORE_INSTALL: marker,
  });
  assert.match(
    await helper.request(
      prepareCommand(
        "mode-race",
        sha256("original\n"),
        "file.txt",
        "replacement\n",
      ),
    ),
    /^prepared mode-race /u,
  );
  const pendingCommit = helper.request("commit mode-race");
  await waitForFile(marker);
  const stageName = (await readdir(root)).find((name) =>
    recoveryPattern("mode-race").test(name),
  );
  assert.ok(stageName);
  await chmod(path.join(root, stageName), 0o777);
  await writeFile(`${marker}.continue`, "continue\n");
  assert.equal(await pendingCommit, "error conflict");
  assert.equal(await readFile(target, "utf8"), "original\n");
  assert.equal((await stat(target)).mode & 0o777, 0o640);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith(".aiden-subagent-file-")),
    [],
  );
  await helper.close();
});

test("a late target mode change is rejected before staging", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-target-mode-race-");
  const target = path.join(root, "file.txt");
  const marker = path.join(root, "target-mode-before-stage.marker");
  await writeFile(target, "original\n", { mode: 0o640 });
  const helper = startHelper(t, root, testingBinary, {
    AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_BEFORE_STAGE: marker,
  });
  assert.match(
    await helper.request(
      prepareCommand(
        "target-mode-race",
        sha256("original\n"),
        "file.txt",
        "replacement\n",
      ),
    ),
    /^prepared target-mode-race /u,
  );
  const pendingCommit = helper.request("commit target-mode-race");
  await waitForFile(marker);
  await chmod(target, 0o600);
  await writeFile(`${marker}.continue`, "continue\n");
  assert.equal(await pendingCommit, "error conflict");
  assert.equal(await readFile(target, "utf8"), "original\n");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  await helper.close();
});

test("metadata policy preserves provenance and rejects drift, unknown xattrs, and ACLs", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS metadata semantics are covered only on Darwin.");
    return;
  }
  const root = await fixture(t, "aiden-file-mutator-metadata-");
  const ordinary = path.join(root, "ordinary.txt");
  await writeFile(ordinary, "original\n");
  await execFileAsync("/usr/bin/xattr", [
    "-w",
    "com.apple.provenance",
    "fixture-provenance",
    ordinary,
  ]);
  const before = (
    await execFileAsync("/usr/bin/xattr", ["-px", "com.apple.provenance", ordinary])
  ).stdout.trim();
  assert.notEqual(before, "");
  const ordinaryHelper = startHelper(t, root);
  assert.match(
    await ordinaryHelper.request(
      prepareCommand(
        "metadata-ordinary",
        sha256("original\n"),
        "ordinary.txt",
        "replacement\n",
      ),
    ),
    /^prepared metadata-ordinary /u,
  );
  assert.match(
    await ordinaryHelper.request("commit metadata-ordinary"),
    /^committed metadata-ordinary /u,
  );
  assert.equal(
    await ordinaryHelper.request("finalize metadata-ordinary"),
    "finalized metadata-ordinary",
  );
  const after = (
    await execFileAsync("/usr/bin/xattr", ["-px", "com.apple.provenance", ordinary])
  ).stdout.trim();
  assert.equal(after, before);
  await ordinaryHelper.close();

  const drift = path.join(root, "drift.txt");
  const marker = path.join(root, "metadata-before-stage.marker");
  await writeFile(drift, "original\n");
  const driftHelper = startHelper(t, root, testingBinary, {
    AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_BEFORE_STAGE: marker,
  });
  assert.match(
    await driftHelper.request(
      prepareCommand(
        "metadata-drift",
        sha256("original\n"),
        "drift.txt",
        "replacement\n",
      ),
    ),
    /^prepared metadata-drift /u,
  );
  const driftCommit = driftHelper.request("commit metadata-drift");
  await waitForFile(marker);
  await execFileAsync("/usr/bin/xattr", [
    "-w",
    "com.apple.provenance",
    "changed",
    drift,
  ]);
  await writeFile(`${marker}.continue`, "continue\n");
  assert.equal(await driftCommit, "error conflict");
  await driftHelper.close();

  const unknown = path.join(root, "unknown.txt");
  await writeFile(unknown, "original\n");
  await execFileAsync("/usr/bin/xattr", ["-w", "user.aiden-test", "value", unknown]);
  const unknownHelper = startHelper(t, root);
  assert.equal(
    await unknownHelper.request(
      prepareCommand(
        "metadata-unknown",
        sha256("original\n"),
        "unknown.txt",
        "replacement\n",
      ),
    ),
    "error conflict",
  );
  await unknownHelper.close();

  const acl = path.join(root, "acl.txt");
  await writeFile(acl, "original\n");
  await execFileAsync("/bin/chmod", ["+a", "everyone deny delete", acl]);
  try {
    const aclHelper = startHelper(t, root);
    assert.equal(
      await aclHelper.request(
        prepareCommand(
          "metadata-acl",
          sha256("original\n"),
          "acl.txt",
          "replacement\n",
        ),
      ),
      "error conflict",
    );
    await aclHelper.close();
  } finally {
    await execFileAsync("/bin/chmod", ["-N", acl]);
  }
});

test("Linux metadata policy preserves user xattrs and rejects xattr drift", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Linux xattr semantics are covered only on Linux.");
    return;
  }
  const root = await fixture(t, "aiden-file-mutator-linux-metadata-");
  const ordinary = path.join(root, "ordinary.txt");
  await writeFile(ordinary, "original\n");
  await setLinuxUserXattr(ordinary, "fixture-value");

  const ordinaryHelper = startHelper(t, root);
  assert.match(
    await ordinaryHelper.request(
      prepareCommand(
        "linux-metadata-ordinary",
        sha256("original\n"),
        "ordinary.txt",
        "replacement\n",
      ),
    ),
    /^prepared linux-metadata-ordinary /u,
  );
  assert.match(
    await ordinaryHelper.request("commit linux-metadata-ordinary"),
    /^committed linux-metadata-ordinary /u,
  );
  assert.equal(
    await ordinaryHelper.request("finalize linux-metadata-ordinary"),
    "finalized linux-metadata-ordinary",
  );
  assert.equal(await readLinuxUserXattr(ordinary), "fixture-value");
  await ordinaryHelper.close();

  const drift = path.join(root, "drift.txt");
  const marker = path.join(root, "linux-metadata-before-stage.marker");
  await writeFile(drift, "original\n");
  await setLinuxUserXattr(drift, "before");
  const driftHelper = startHelper(t, root, testingBinary, {
    AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_BEFORE_STAGE: marker,
  });
  assert.match(
    await driftHelper.request(
      prepareCommand(
        "linux-metadata-drift",
        sha256("original\n"),
        "drift.txt",
        "replacement\n",
      ),
    ),
    /^prepared linux-metadata-drift /u,
  );
  const pendingCommit = driftHelper.request("commit linux-metadata-drift");
  await waitForFile(marker);
  await setLinuxUserXattr(drift, "changed");
  await writeFile(`${marker}.continue`, "continue\n");
  assert.equal(await pendingCommit, "error conflict");
  assert.equal(await readFile(drift, "utf8"), "original\n");
  assert.equal(await readLinuxUserXattr(drift), "changed");
  await driftHelper.close();
});

test("moving a prepared parent directory makes commit roll back", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-parent-race-");
  const directory = path.join(root, "src");
  const moved = path.join(root, "moved-src");
  const marker = path.join(root, "parent-before-install.marker");
  await mkdir(directory);
  await writeFile(path.join(directory, "file.txt"), "original\n");
  const helper = startHelper(t, root, testingBinary, {
    AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_BEFORE_INSTALL: marker,
  });
  assert.match(
    await helper.request(
      prepareCommand(
        "parent-race",
        sha256("original\n"),
        "src/file.txt",
        "authorized\n",
      ),
    ),
    /^prepared parent-race /u,
  );
  const pendingCommit = helper.request("commit parent-race");
  await waitForFile(marker);
  await rename(directory, moved);
  await writeFile(`${marker}.continue`, "continue\n");
  assert.equal(await pendingCommit, "error conflict");
  assert.equal(await readFile(path.join(moved, "file.txt"), "utf8"), "original\n");
  await assert.rejects(readFile(path.join(directory, "file.txt")), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(moved)).filter((name) => name.startsWith(".aiden-subagent-file-")),
    [],
  );
  await helper.close();
});

test("replacing the pinned workspace root invalidates commit", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const outer = await fixture(t, "aiden-file-mutator-root-race-");
  const root = path.join(outer, "workspace");
  const moved = path.join(outer, "moved-workspace");
  await mkdir(root);
  await writeFile(path.join(root, "file.txt"), "original\n");
  const helper = startHelper(t, root);
  assert.match(
    await helper.request(
      prepareCommand("root-race", sha256("original\n"), "file.txt", "authorized\n"),
    ),
    /^prepared root-race /u,
  );
  await rename(root, moved);
  await mkdir(root);
  await writeFile(path.join(root, "file.txt"), "external\n");
  assert.equal(await helper.request("commit root-race"), "error conflict");
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "external\n");
  assert.equal(await readFile(path.join(moved, "file.txt"), "utf8"), "original\n");
  await helper.close();
});

test("two absent prepares cannot overwrite the winning create", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-create-race-");
  const first = startHelper(t, root);
  const second = startHelper(t, root);
  assert.match(
    await first.request(prepareCommand("first", "absent", "new.txt", "first\n")),
    /^prepared first /u,
  );
  assert.match(
    await second.request(prepareCommand("second", "absent", "new.txt", "second\n")),
    /^prepared second /u,
  );
  assert.match(await first.request("commit first"), /^committed first /u);
  assert.equal(await second.request("commit second"), "error conflict");
  assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "first\n");
  await first.close();
  await second.close();
});

test("a crash after replacement leaves the new target and old recovery intact", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-crash-");
  const target = path.join(root, "file.txt");
  const marker = path.join(root, "installed.marker");
  await writeFile(target, "original\n");
  const helper = startHelper(t, root, testingBinary, {
    AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_AFTER_INSTALL: marker,
  });
  assert.match(
    await helper.request(
      prepareCommand("crash-1", sha256("original\n"), "file.txt", "replacement\n"),
    ),
    /^prepared crash-1 /u,
  );
  const pendingCommit = helper.request("commit crash-1").catch(() => undefined);
  await waitForFile(marker);
  await helper.kill();
  await pendingCommit;
  assert.equal(await readFile(target, "utf8"), "replacement\n");
  const recoveryNames = (await readdir(root)).filter((name) =>
    name.startsWith(".aiden-subagent-file-"),
  );
  assert.equal(recoveryNames.length, 1);
  assert.match(recoveryNames[0], recoveryPattern("crash-1"));
  assert.equal(await readFile(path.join(root, recoveryNames[0]), "utf8"), "original\n");
});

test("multiple crash recoveries remain attributable to request and parent path", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-multi-crash-");
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "beta");
  await mkdir(alpha);
  await mkdir(beta);
  await writeFile(path.join(alpha, "file.txt"), "alpha-original\n");
  await writeFile(path.join(beta, "file.txt"), "beta-original\n");
  const alphaMarker = path.join(root, "alpha-installed.marker");
  const betaMarker = path.join(root, "beta-installed.marker");
  const alphaHelper = startHelper(t, root, testingBinary, {
    AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_AFTER_INSTALL: alphaMarker,
  });
  const betaHelper = startHelper(t, root, testingBinary, {
    AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_AFTER_INSTALL: betaMarker,
  });
  assert.match(
    await alphaHelper.request(
      prepareCommand(
        "orphan-alpha",
        sha256("alpha-original\n"),
        "alpha/file.txt",
        "alpha-replacement\n",
      ),
    ),
    /^prepared orphan-alpha /u,
  );
  assert.match(
    await betaHelper.request(
      prepareCommand(
        "orphan-beta",
        sha256("beta-original\n"),
        "beta/file.txt",
        "beta-replacement\n",
      ),
    ),
    /^prepared orphan-beta /u,
  );
  const alphaCommit = alphaHelper.request("commit orphan-alpha").catch(() => undefined);
  const betaCommit = betaHelper.request("commit orphan-beta").catch(() => undefined);
  await Promise.all([waitForFile(alphaMarker), waitForFile(betaMarker)]);
  await Promise.all([alphaHelper.kill(), betaHelper.kill()]);
  await Promise.all([alphaCommit, betaCommit]);
  const alphaRecovery = (await readdir(alpha)).find((name) =>
    recoveryPattern("orphan-alpha").test(name),
  );
  const betaRecovery = (await readdir(beta)).find((name) =>
    recoveryPattern("orphan-beta").test(name),
  );
  assert.ok(alphaRecovery);
  assert.ok(betaRecovery);
  assert.equal(await readFile(path.join(alpha, alphaRecovery), "utf8"), "alpha-original\n");
  assert.equal(await readFile(path.join(beta, betaRecovery), "utf8"), "beta-original\n");
  assert.equal(await readFile(path.join(alpha, "file.txt"), "utf8"), "alpha-replacement\n");
  assert.equal(await readFile(path.join(beta, "file.txt"), "utf8"), "beta-replacement\n");
});

test("fixed input bounds reject oversized content and non-normal paths", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-bounds-");
  const helper = startHelper(t, root);
  assert.equal(
    await helper.request(prepareCommand("dotdot", "absent", "a/../b", "value")),
    "error invalid_input",
  );
  assert.equal(
    await helper.request(prepareCommand("empty-part", "absent", "a//b", "value")),
    "error invalid_input",
  );
  assert.equal(
    await helper.request(prepareCommand("too-large", "absent", "large.txt", "x".repeat(200_001))),
    "error invalid_input",
  );
  const response = await helper.request("x".repeat(275_001));
  assert.equal(response, "error invalid_input");
  assert.ok(Buffer.byteLength(response) < 64);
  await helper.close();
});

test("startup refuses a root whose pinned identity does not match", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-root-");
  const identity = await rootIdentity(root);
  const child = spawn(
    productionBinary,
    [
      "serve",
      "--root",
      root,
      "--device",
      identity.device,
      "--inode",
      (BigInt(identity.inode) + 1n).toString(),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  const result = await new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(stdout, "");
});

test("startup rejects non-canonical or overflowing identity numbers", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await fixture(t, "aiden-file-mutator-invalid-identity-");
  const identity = await rootIdentity(root);

  for (const invalidDevice of ["+1", " 1", "18446744073709551616"]) {
    const child = spawn(
      productionBinary,
      [
        "serve",
        "--root",
        root,
        "--device",
        invalidDevice,
        "--inode",
        identity.inode,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    const result = await new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    assert.notEqual(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(stdout, "");
  }
});
