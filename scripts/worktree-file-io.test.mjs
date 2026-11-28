/* global Buffer, process */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  link,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(root, "build", "native", "aiden-worktree-file-io-test");

async function directory(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), "aiden-worktree-file-io-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

async function identity(value) {
  const canonical = await realpath(value);
  const metadata = await stat(canonical, { bigint: true });
  return [canonical, String(metadata.dev), String(metadata.ino)];
}

async function runWithCheckpoints(args, onCheckpoint) {
  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, AIDEN_WORKTREE_FILE_IO_HANDSHAKE: "1" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  let checkpointError;
  child.stdio[3].setEncoding("utf8").on("data", (marker) => {
    void Promise.resolve(onCheckpoint(marker)).then(
      () => child.stdio[4].write(marker),
      (error) => {
        checkpointError = error;
        child.kill("SIGKILL");
      },
    );
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (checkpointError) throw checkpointError;
  assert.equal(code, 0, stderr);
  return stdout;
}

async function runEditor(args, input = Buffer.alloc(0), onCheckpoint = async () => {}) {
  const child = spawn(binary, args, {
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, AIDEN_WORKTREE_FILE_IO_HANDSHAKE: "1" },
  });
  const chunks = [];
  let stderr = "";
  let checkpointError;
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdio[3].setEncoding("utf8").on("data", (marker) => {
    void Promise.resolve(onCheckpoint(marker)).then(
      () => child.stdio[4].write(marker),
      (error) => {
        checkpointError = error;
        child.kill("SIGKILL");
      },
    );
  });
  // The editor can refuse its path and exit before reading stdin or the
  // checkpoint pipe; its exit status and stdout are what tests assert, so a
  // late EPIPE on those writes is contained here.
  child.stdin.on("error", () => undefined);
  child.stdio[4].on("error", () => undefined);
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (checkpointError) throw checkpointError;
  return { code, stderr, stdout: Buffer.concat(chunks) };
}

test("source read stays on an opened directory when its pathname becomes an outside symlink", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const destination = await directory(t);
  const outside = await directory(t);
  await mkdir(path.join(source, "inside"));
  await writeFile(path.join(source, "inside", "secret.txt"), "inside\n");
  await writeFile(path.join(outside, "secret.txt"), "outside\n");
  const args = [
    "copy",
    ...(await identity(source)),
    "inside/secret.txt",
    ...(await identity(destination)),
    "copied.txt",
    "4096",
    "-",
    "source",
  ];
  const result = await runWithCheckpoints(args, async (marker) => {
    if (marker === "S") {
      await rename(path.join(source, "inside"), path.join(source, "moved"));
      await symlink(outside, path.join(source, "inside"));
    }
  });
  assert.match(result, /^7 \d+ \d+ [0-9a-f]{64}\n$/u);
  assert.equal(await readFile(path.join(destination, "copied.txt"), "utf8"), "inside\n");
});

test("restore writes through its opened parent when the pathname becomes an outside symlink", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const destination = await directory(t);
  const outside = await directory(t);
  await mkdir(path.join(destination, "inside"));
  const bytes = Buffer.from("captured\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(source, "blob"), bytes);
  await writeFile(path.join(outside, "file.txt"), "outside\n");
  const args = [
    "restore",
    ...(await identity(source)),
    "blob",
    ...(await identity(destination)),
    "inside/file.txt",
    String(bytes.length),
    digest,
    "384",
  ];
  await runWithCheckpoints(args, async (marker) => {
    if (marker === "D") {
      await rename(path.join(destination, "inside"), path.join(destination, "moved"));
      await symlink(outside, path.join(destination, "inside"));
    }
  });
  assert.equal(await readFile(path.join(destination, "moved", "file.txt"), "utf8"), "captured\n");
  assert.equal(await readFile(path.join(outside, "file.txt"), "utf8"), "outside\n");
});

test("directory listing stays on its held descriptor through a swap and swap-back", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const outside = await directory(t);
  const inside = path.join(source, "inside");
  await mkdir(inside);
  await writeFile(path.join(inside, "allowed.txt"), "allowed");
  await writeFile(path.join(outside, "secret-one.txt"), "outside");
  await writeFile(path.join(outside, "secret-two.txt"), "outside");
  const insideIdentity = await identity(inside);
  const result = await runWithCheckpoints(
    ["list", ...(await identity(source)), "inside", ...insideIdentity.slice(1)],
    async (marker) => {
      if (marker === "L") {
        await rename(inside, path.join(source, "moved"));
        await symlink(outside, inside);
      } else {
        assert.equal(marker, "E");
        await rm(inside);
        await rename(path.join(source, "moved"), inside);
      }
    },
  );
  const allowed = await identity(path.join(inside, "allowed.txt"));
  assert.equal(
    result,
    `f ${allowed[1]} ${allowed[2]} ${Buffer.from("allowed.txt").toString("hex")}\nc\n`,
  );
});

test("directory listing never follows a directory symlink", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const outside = await directory(t);
  await symlink(outside, path.join(source, "linked"));
  const outsideIdentity = await identity(outside);
  const child = spawn(binary, [
    "list",
    ...(await identity(source)),
    "linked",
    ...outsideIdentity.slice(1),
  ]);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.notEqual(code, 0);
  assert.equal(output, "");
});

test("editor read binds file identity and opened parent through a symlink swap", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const outside = await directory(t);
  await mkdir(path.join(source, "inside"));
  const file = path.join(source, "inside", "file.txt");
  await writeFile(file, "inside\n");
  await writeFile(path.join(outside, "file.txt"), "outside\n");
  const args = [
    "read",
    ...(await identity(source)),
    "inside/file.txt",
    ...(await identity(file)).slice(1),
  ];
  const result = await runEditor(args, Buffer.alloc(0), async (marker) => {
    if (marker === "B") return;
    assert.equal(marker, "R");
    await rename(path.join(source, "inside"), path.join(source, "moved"));
    await symlink(outside, path.join(source, "inside"));
  });
  assert.equal(result.code, 0, result.stderr);
  const divider = result.stdout.indexOf(10);
  assert.match(result.stdout.subarray(0, divider).toString(), /^r 7 \d+ -?\d+ \d+ [0-9a-f]{64}$/u);
  assert.equal(result.stdout.subarray(divider + 1).toString(), "inside\n");
  assert.equal(await readFile(path.join(outside, "file.txt"), "utf8"), "outside\n");
  const wrong = await runEditor(["read", ...(await identity(source)), "moved/file.txt", "0", "0"]);
  assert.notEqual(wrong.code, 0);
  assert.equal(wrong.stdout.length, 0);
});

test("editor save stays in held parent and retains the original as recovery", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const outside = await directory(t);
  await mkdir(path.join(source, "inside"));
  const file = path.join(source, "inside", "file.txt");
  await writeFile(file, "before\n");
  await writeFile(path.join(outside, "file.txt"), "outside\n");
  const expected = createHash("sha256").update("before\n").digest("hex");
  const input = Buffer.from("after\n");
  const args = [
    "edit",
    ...(await identity(source)),
    "inside/file.txt",
    ...(await identity(file)).slice(1),
    expected,
    String(input.length),
  ];
  const result = await runEditor(args, input, async (marker) => {
    if (marker === "E") return;
    if (marker === "B") return;
    assert.equal(marker, "D");
    await rename(path.join(source, "inside"), path.join(source, "moved"));
    await symlink(outside, path.join(source, "inside"));
  });
  assert.equal(result.code, 0, result.stderr);
  const header = result.stdout.toString();
  assert.match(header, /^w \d+ \d+ \d+ -?\d+ \d+ [0-9a-f]{64} [0-9a-f]+\n$/u);
  const recovery = Buffer.from(header.trim().split(" ").at(-1), "hex").toString();
  assert.equal(await readFile(path.join(source, "moved", "file.txt"), "utf8"), "after\n");
  assert.equal(await readFile(path.join(source, "moved", recovery), "utf8"), "before\n");
  assert.equal(await readFile(path.join(outside, "file.txt"), "utf8"), "outside\n");
});

test("editor operations reject a symlinked ancestor even when the root inode matches", async (t) => {
  if (process.platform !== "darwin") return;
  const base = await directory(t);
  const ancestor = path.join(base, "ancestor");
  const source = path.join(ancestor, "root");
  await mkdir(source, { recursive: true });
  const file = path.join(source, "file.txt");
  await writeFile(file, "secret\n");
  const rootIdentity = await identity(source);
  const fileIdentity = await identity(file);
  const moved = path.join(base, "moved");
  await rename(ancestor, moved);
  await symlink(moved, ancestor);
  const readResult = await runEditor([
    "read",
    ...rootIdentity,
    "file.txt",
    ...fileIdentity.slice(1),
  ]);
  assert.notEqual(readResult.code, 0);
  assert.equal(readResult.stdout.length, 0);
  const listChild = spawn(binary, ["list", ...rootIdentity, "", ...rootIdentity.slice(1)]);
  const listChunks = [];
  listChild.stdout.on("data", (chunk) => listChunks.push(chunk));
  const listCode = await new Promise((resolve, reject) => {
    listChild.once("error", reject);
    listChild.once("close", resolve);
  });
  assert.notEqual(listCode, 0);
  assert.equal(Buffer.concat(listChunks).length, 0);
});

test("editor save rejects stale identity and version without creating recovery", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const file = path.join(source, "file.txt");
  await writeFile(file, "current\n");
  const current = await identity(file);
  const input = Buffer.from("replacement\n");
  const hash = createHash("sha256").update("current\n").digest("hex");
  for (const [device, inode, expected] of [
    ["0", "0", hash],
    [current[1], current[2], "0".repeat(64)],
  ]) {
    const result = await runEditor(
      [
        "edit",
        ...(await identity(source)),
        "file.txt",
        device,
        inode,
        expected,
        String(input.length),
      ],
      input,
    );
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.length, 0);
    assert.equal(await readFile(file, "utf8"), "current\n");
  }
  assert.deepEqual(await readdir(source), ["file.txt"]);
});

test("editor refuses a seventeenth retained recovery before changing the source", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const file = path.join(source, "file.txt");
  await writeFile(file, "current\n");
  for (let index = 0; index < 16; index++) {
    await writeFile(path.join(source, `.aiden-recovery-${index}`), `prior-${index}\n`);
  }
  const before = (await readdir(source)).sort();
  const input = Buffer.from("replacement\n");
  const expected = createHash("sha256").update("current\n").digest("hex");
  const result = await runEditor(
    [
      "edit",
      ...(await identity(source)),
      "file.txt",
      ...(await identity(file)).slice(1),
      expected,
      String(input.length),
    ],
    input,
  );
  assert.notEqual(result.code, 0);
  assert.equal(result.stderr.trim(), "recovery_limit");
  assert.equal(result.stdout.length, 0);
  assert.equal(await readFile(file, "utf8"), "current\n");
  assert.deepEqual((await readdir(source)).sort(), before);
});

test("transfers reject root and ancestor substitutions after path canonicalization", async (t) => {
  if (process.platform !== "darwin") return;
  for (const operation of ["copy", "restore"]) {
    for (const replacement of ["root", "ancestor"]) {
      const base = await directory(t);
      const parent = path.join(base, "parent");
      const target = path.join(parent, "root");
      const other = await directory(t);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "file"), "original");
      await writeFile(path.join(other, "file"), "original");
      // Identity paths are canonicalized before the local actor swaps them.
      const targetIdentity = await identity(target);
      const otherIdentity = await identity(other);
      const args =
        operation === "copy"
          ? [operation, ...targetIdentity, "file", ...otherIdentity, "result", "4096", "-", "384"]
          : [
              operation,
              ...otherIdentity,
              "file",
              ...targetIdentity,
              "result",
              "8",
              createHash("sha256").update("original").digest("hex"),
              "384",
            ];
      if (replacement === "root") {
        await rename(target, path.join(parent, "held"));
        await mkdir(target);
        await writeFile(path.join(target, "file"), "outside");
      } else {
        await rename(parent, path.join(base, "held"));
        await symlink(path.join(base, "held"), parent);
      }
      const child = spawn(binary, args);
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (data) => {
        stderr += data;
      });
      const code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      assert.notEqual(code, 0);
      assert.equal(stderr.trim(), operation === "copy" ? "unsafe_source" : "unsafe_destination");
      assert.equal((await readdir(target)).includes("result"), false);
      assert.equal((await readdir(other)).includes("result"), false);
    }
  }
});

test("lazy operations reject hard links and link-count changes during reads and saves", async (t) => {
  if (process.platform !== "darwin") return;
  const root = await directory(t);
  const outside = await directory(t);
  await writeFile(path.join(outside, "secret"), "secret");
  await link(path.join(outside, "secret"), path.join(root, "linked"));
  const rootId = await identity(root);
  const linkedId = await identity(path.join(root, "linked"));
  const listing = await runWithCheckpoints(
    ["list", ...rootId, "", ...rootId.slice(1)],
    async () => {},
  );
  assert.equal(listing, "c\n");
  for (const operation of ["read", "edit"]) {
    const args = [operation, ...rootId, "linked", ...linkedId.slice(1)];
    if (operation === "edit") args.push(createHash("sha256").update("secret").digest("hex"), "3");
    const result = await runEditor(
      args,
      operation === "edit" ? Buffer.from("new") : Buffer.alloc(0),
    );
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.length, 0);
  }
  // Capture an exclusive file identity, then add another link at each boundary.
  for (const [operation, marker] of [
    ["read", "R"],
    ["read", "B"],
    ["edit", "E"],
    ["edit", "B"],
    ["edit", "D"],
  ]) {
    const name = `${operation}-${marker}`;
    await writeFile(path.join(root, name), "original");
    const fileId = await identity(path.join(root, name));
    const args = [operation, ...rootId, name, ...fileId.slice(1)];
    if (operation === "edit") args.push(createHash("sha256").update("original").digest("hex"), "3");
    const result = await runEditor(
      args,
      operation === "edit" ? Buffer.from("new") : Buffer.alloc(0),
      async (checkpoint) => {
        if (checkpoint === marker) await link(path.join(root, name), path.join(outside, name));
      },
    );
    assert.notEqual(result.code, 0, name);
    assert.equal(result.stdout.length, 0, name);
    assert.equal(await readFile(path.join(root, name), "utf8"), "original");
    assert.equal(await readFile(path.join(outside, name), "utf8"), "original");
  }
  assert.equal(await readFile(path.join(outside, "secret"), "utf8"), "secret");
});

test("save replaces through its held parent when the pathname becomes an outside symlink", async (t) => {
  if (process.platform !== "darwin") return;
  const root = await directory(t);
  const outside = await directory(t);
  await writeFile(path.join(outside, "shot.png"), "outside");
  const input = Buffer.from("after");
  // Swap after the parent is opened, then (second round) after the temporary
  // is written, just before it is renamed over the leaf.
  for (const [moved, marker] of [
    ["moved-p", "P"],
    ["moved-w", "W"],
  ]) {
    await mkdir(path.join(root, "shots"));
    await writeFile(path.join(root, "shots", "shot.png"), "before");
    const result = await runEditor(
      ["save", ...(await identity(root)), "shots/shot.png", String(input.length)],
      input,
      async (checkpoint) => {
        if (checkpoint !== marker) return;
        await rename(path.join(root, "shots"), path.join(root, moved));
        await symlink(outside, path.join(root, "shots"));
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout.toString(), /^c \d+ \d+\n$/u);
    assert.equal(await readFile(path.join(root, moved, "shot.png"), "utf8"), "after");
    assert.deepEqual(await readdir(path.join(root, moved)), ["shot.png"]);
    assert.equal(await readFile(path.join(outside, "shot.png"), "utf8"), "outside");
    assert.deepEqual(await readdir(outside), ["shot.png"]);
    await rm(path.join(root, "shots"));
  }
});

test("save refuses a symlinked ancestor or leaf and never writes through a hard link", async (t) => {
  if (process.platform !== "darwin") return;
  const root = await directory(t);
  const outside = await directory(t);
  await writeFile(path.join(outside, "shot.png"), "outside");
  await symlink(outside, path.join(root, "linked"));
  await symlink(path.join(outside, "shot.png"), path.join(root, "leaf.png"));
  const rootId = await identity(root);
  const input = Buffer.from("new");
  for (const relative of ["linked/shot.png", "leaf.png"]) {
    const result = await runEditor(["save", ...rootId, relative, String(input.length)], input);
    assert.notEqual(result.code, 0, relative);
    assert.equal(result.stderr.trim(), "unsafe_destination", relative);
  }
  await link(path.join(outside, "shot.png"), path.join(root, "hard.png"));
  const replaced = await runEditor(["save", ...rootId, "hard.png", String(input.length)], input);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.equal(await readFile(path.join(root, "hard.png"), "utf8"), "new");
  assert.equal(await readFile(path.join(outside, "shot.png"), "utf8"), "outside");
  assert.deepEqual(await readdir(outside), ["shot.png"]);
});

test("private file creation uses mode 0600 and refuses an existing environment file", async (t) => {
  if (process.platform !== "darwin") return;
  const folder = await directory(t);
  const rootId = await identity(folder);
  const input = Buffer.from("KEY=synthetic");
  const created = await runEditor(
    ["create-private", ...rootId, ".env", String(input.length)],
    input,
  );
  assert.equal(created.code, 0, created.stderr);
  assert.equal((await stat(path.join(folder, ".env"))).mode & 0o777, 0o600);
  const existing = await runEditor(["create-private", ...rootId, ".env", "3"], Buffer.from("new"));
  assert.notEqual(existing.code, 0);
  assert.equal(await readFile(path.join(folder, ".env"), "utf8"), input.toString());
});

test("provision batch copies nested files, preserves rwx modes, strips setuid/sticky and BSD uchg flags", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const destination = await directory(t);
  await mkdir(path.join(source, "config", "nested"), { recursive: true });
  await writeFile(path.join(source, ".env"), "SECRET=1\n");
  await chmod(path.join(source, ".env"), 0o600);
  await writeFile(path.join(source, "config", "nested", "run.sh"), "#!/bin/sh\necho ok\n");
  await chmod(path.join(source, "config", "nested", "run.sh"), 0o4755);
  await writeFile(path.join(source, "locked.txt"), "immutable-source\n");
  execFileSync("/usr/bin/chflags", ["uchg", path.join(source, "locked.txt")]);
  try {
    const payload = Buffer.from(".env\0config/nested/run.sh\0locked.txt\0", "utf8");
    const result = await runEditor(
      [
        "provision",
        ...(await identity(source)),
        ...(await identity(destination)),
        String(1024 * 1024),
      ],
      payload,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.toString(), "p 0 9\np 1 18\np 2 17\ndone\n");
    assert.equal(await readFile(path.join(destination, ".env"), "utf8"), "SECRET=1\n");
    assert.equal((await stat(path.join(destination, ".env"))).mode & 0o7777, 0o600);
    const scriptStat = await stat(path.join(destination, "config", "nested", "run.sh"));
    assert.equal(scriptStat.mode & 0o7777, 0o755, "setuid bit must be stripped");
    assert.equal(
      await readFile(path.join(destination, "locked.txt"), "utf8"),
      "immutable-source\n",
    );
    // Destination copy must NOT inherit UF_IMMUTABLE — verify it can be removed cleanly.
    await rm(path.join(destination, "locked.txt"));
  } finally {
    try {
      execFileSync("/usr/bin/chflags", ["nouchg", path.join(source, "locked.txt")]);
    } catch {
      /* ignore */
    }
  }
});

test("provision enforces cumulative byte limits and emits progress for files installed before failure", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const destination = await directory(t);
  await writeFile(path.join(source, "a.txt"), "12345");
  await writeFile(path.join(source, "b.txt"), "12345");
  await writeFile(path.join(source, "c.txt"), "12345");

  const payload = Buffer.from("a.txt\0b.txt\0c.txt\0", "utf8");
  const result = await runEditor(
    ["provision", ...(await identity(source)), ...(await identity(destination)), "10"],
    payload,
  );
  assert.notEqual(result.code, 0);
  assert.equal(result.stderr.trim(), "too_many_bytes");
  assert.equal(result.stdout.toString(), "p 0 5\np 1 5\n");
  assert.equal(await readFile(path.join(destination, "a.txt"), "utf8"), "12345");
  assert.equal(await readFile(path.join(destination, "b.txt"), "utf8"), "12345");
  await assert.rejects(() => stat(path.join(destination, "c.txt")));
});

test("provision stays on held descriptors through source and destination symlink swaps", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const destination = await directory(t);
  const outside = await directory(t);
  await mkdir(path.join(source, "sub"));
  await mkdir(path.join(destination, "sub"));
  await writeFile(path.join(source, "sub", "a.txt"), "inside-source");
  await writeFile(path.join(outside, "a.txt"), "outside-secret");

  const result = await runEditor(
    ["provision", ...(await identity(source)), ...(await identity(destination)), "4096"],
    Buffer.from("sub/a.txt\0", "utf8"),
    async (marker) => {
      if (marker === "S") {
        await rename(path.join(source, "sub"), path.join(source, "moved-src"));
        await symlink(outside, path.join(source, "sub"));
      } else if (marker === "D") {
        await rename(path.join(destination, "sub"), path.join(destination, "moved-dst"));
        await symlink(outside, path.join(destination, "sub"));
      }
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await readFile(path.join(destination, "moved-dst", "a.txt"), "utf8"),
    "inside-source",
  );
  assert.equal(await readFile(path.join(outside, "a.txt"), "utf8"), "outside-secret");
});

test("provision refuses existing destination, symlinks, self-copy, and malformed stdin", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const destination = await directory(t);
  await writeFile(path.join(source, "a.txt"), "aaa");
  await writeFile(path.join(destination, "a.txt"), "existing");
  await symlink(path.join(source, "a.txt"), path.join(source, "link.txt"));

  const existsRes = await runEditor(
    ["provision", ...(await identity(source)), ...(await identity(destination)), "4096"],
    Buffer.from("a.txt\0", "utf8"),
  );
  assert.notEqual(existsRes.code, 0);
  assert.equal(existsRes.stderr.trim(), "destination_exists");
  assert.equal(await readFile(path.join(destination, "a.txt"), "utf8"), "existing");

  const symlinkRes = await runEditor(
    ["provision", ...(await identity(source)), ...(await identity(destination)), "4096"],
    Buffer.from("link.txt\0", "utf8"),
  );
  assert.notEqual(symlinkRes.code, 0);
  assert.equal(symlinkRes.stderr.trim(), "unsafe_source");

  const selfRes = await runEditor(
    ["provision", ...(await identity(source)), ...(await identity(source)), "4096"],
    Buffer.from("a.txt\0", "utf8"),
  );
  assert.notEqual(selfRes.code, 0);
  assert.equal(selfRes.stderr.trim(), "unsafe_source");

  const unterminatedRes = await runEditor(
    ["provision", ...(await identity(source)), ...(await identity(destination)), "4096"],
    Buffer.from("a.txt", "utf8"),
  );
  assert.notEqual(unterminatedRes.code, 0);
  assert.equal(unterminatedRes.stderr.trim(), "invalid_input");

  const escapeRes = await runEditor(
    ["provision", ...(await identity(source)), ...(await identity(destination)), "4096"],
    Buffer.from("../a.txt\0", "utf8"),
  );
  assert.notEqual(escapeRes.code, 0);
  assert.equal(escapeRes.stderr.trim(), "invalid_input");

  const emptyEntryRes = await runEditor(
    ["provision", ...(await identity(source)), ...(await identity(destination)), "4096"],
    Buffer.from("a.txt\0\0a.txt\0", "utf8"),
  );
  assert.notEqual(emptyEntryRes.code, 0);
  assert.equal(emptyEntryRes.stderr.trim(), "invalid_input");
});

test("provision handles >64 unique parent directories without leaking FDs", async (t) => {
  if (process.platform !== "darwin") return;
  const source = await directory(t);
  const destination = await directory(t);
  const paths = [];
  for (let i = 0; i < 70; i += 1) {
    const dir = `d${String(i).padStart(2, "0")}`;
    await mkdir(path.join(source, dir));
    await writeFile(path.join(source, dir, "f.txt"), `v${i}`);
    paths.push(`${dir}/f.txt`);
  }
  const result = await runEditor(
    [
      "provision",
      ...(await identity(source)),
      ...(await identity(destination)),
      String(1024 * 1024),
    ],
    Buffer.from(`${paths.join("\0")}\0`, "utf8"),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(path.join(destination, "d00", "f.txt"), "utf8"), "v0");
  assert.equal(await readFile(path.join(destination, "d69", "f.txt"), "utf8"), "v69");
});
