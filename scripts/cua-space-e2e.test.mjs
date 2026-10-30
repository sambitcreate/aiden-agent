import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const runner = fileURLToPath(new URL("./cua-space-e2e.sh", import.meta.url));

// A stand-in for the cua CLI: records every call, keeps files copied into the Space, and answers
// `sb ls` / `sb exec` from the environment.
const fakeCua = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_CUA_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(args) + "\\n");
const command = args[1];
if (command === "ls") {
  process.stdout.write(process.env.FAKE_CUA_LS ?? "[]");
} else if (command === "cp") {
  const [source, target] = args.slice(2);
  if (!target.startsWith("local:")) process.exit(1);
  fs.copyFileSync(source, path.join(dir, path.basename(target.slice(target.indexOf(":") + 1))));
} else if (command === "exec") {
  process.exit(Number(process.env.FAKE_CUA_EXEC_STATUS ?? 0));
}
`;

// Ignore the developer's git config (signing, hooks) and Space choice, so the fixture behaves the same anywhere.
const isolatedEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
delete isolatedEnv.CUA_SPACE;

async function git(cwd, ...args) {
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, env: isolatedEnv });
}

async function checkout() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-space-"));
  const repo = path.join(root, "repo");
  const fake = path.join(root, "fake");
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await mkdir(fake);
  await copyFile(runner, path.join(repo, "scripts", "cua-space-e2e.sh"));
  await writeFile(path.join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(path.join(repo, "tracked.ts"), "export {};\n");
  await writeFile(path.join(repo, "removed.ts"), "export {};\n");
  await writeFile(path.join(repo, ".gitignore"), "ignored.log\n");
  await git(repo, "init", "-q");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "init");
  await writeFile(path.join(fake, "cua"), fakeCua);
  await chmod(path.join(fake, "cua"), 0o755);
  return { root, repo, fake };
}

async function run({ repo, fake }, args, env = {}) {
  try {
    const { stdout } = await execFileAsync("bash", [path.join(repo, "scripts", "cua-space-e2e.sh"), ...args], {
      env: { ...isolatedEnv, CUA_BIN: path.join(fake, "cua"), FAKE_CUA_DIR: fake, ...env },
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.code, stdout: error.stdout };
  }
}

async function calls(fake) {
  return (await readFile(path.join(fake, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

test("syncs uncommitted work into the Space but keeps untracked secrets and deletions out", async (t) => {
  const space = await checkout();
  t.after(() => rm(space.root, { recursive: true, force: true }));
  const { repo, fake } = space;
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, "src", "new-feature.ts"), "export const added = true;\n");
  await writeFile(path.join(repo, "ignored.log"), "noise\n");
  await rm(path.join(repo, "removed.ts"));
  await mkdir(path.join(repo, "keys"));
  for (const secret of [".env.local", ".npmrc", "keys/AuthKey_ABC123.p8", "keys/dev.pem", "keys/release.jks", "keys/signing.p12", "keys/id_ed25519", "keys/id_rsa.pub", "keys/dev.mobileprovision", ".netrc", ".git-credentials"]) {
    await writeFile(path.join(repo, secret), "secret\n");
  }

  const result = await run(space, ["--run", "echo", "a b", "$HOME;x"], {
    FAKE_CUA_LS: '[{"id":"local:aiden-e2e","status":"ready"}]',
  });
  assert.equal(result.status, 0);

  const archive = (await readdir(fake)).find((name) => name.startsWith("aiden-src-"));
  assert.ok(archive, "the source archive was copied into the Space");
  const { stdout: listing } = await execFileAsync("tar", ["-tzf", path.join(fake, archive)]);
  const files = listing.trim().split("\n").map((name) => name.replace(/^\.\//, ""));
  assert.ok(files.includes("tracked.ts"));
  assert.ok(files.includes("src/new-feature.ts"));
  assert.ok(files.includes("scripts/cua-space-e2e.sh"));
  for (const excluded of ["removed.ts", "ignored.log", ".env.local", ".npmrc", "keys/AuthKey_ABC123.p8", "keys/dev.pem", "keys/release.jks", "keys/signing.p12", "keys/id_ed25519", "keys/id_rsa.pub", "keys/dev.mobileprovision", ".netrc", ".git-credentials"]) {
    assert.ok(!files.includes(excluded), `${excluded} stays on the host`);
  }

  const exec = (await calls(fake)).find((call) => call[1] === "exec");
  const runId = archive.slice("aiden-src-".length, -".tgz".length);
  const lockHash = createHash("sha256").update(await readFile(path.join(repo, "package-lock.json"))).digest("hex");
  assert.deepEqual(exec, [
    "sb", "exec", "-i", "local:aiden-e2e", "--",
    "bash", `/home/cua/aiden-run-${runId}.sh`, runId, lockHash, "--run", "echo", "a b", "$HOME;x",
  ]);
});

test("creates a missing Space and reports the guest's exit status", async (t) => {
  const space = await checkout();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const result = await run(space, ["tests/e2e/example.spec.ts"], { CUA_SPACE: "aiden-e2e-2", FAKE_CUA_EXEC_STATUS: "3" });
  assert.equal(result.status, 3);
  const recorded = await calls(space.fake);
  assert.deepEqual(recorded.find((call) => call[1] === "create"), [
    "sb", "create", "linux", "--on", "local", "--name", "aiden-e2e-2", "--cpu", "4", "--memory", "8GB", "--wait", "desktop",
  ]);
  assert.equal(recorded.find((call) => call[1] === "exec")[3], "local:aiden-e2e-2");
});

test("--reset succeeds on a clean Space and surfaces real failures", async (t) => {
  const space = await checkout();
  t.after(() => rm(space.root, { recursive: true, force: true }));
  const ready = { FAKE_CUA_LS: '[{"id":"local:aiden-e2e","status":"ready"}]' };

  const clean = await run(space, ["--reset"], { ...ready, FAKE_CUA_EXEC_STATUS: "1" });
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /No leftover e2e processes/);
  const stopped = await run(space, ["--reset"], { ...ready, FAKE_CUA_EXEC_STATUS: "0" });
  assert.equal(stopped.status, 0);
  assert.match(stopped.stdout, /Stopped leftover e2e processes/);
  assert.equal((await run(space, ["--reset"], { ...ready, FAKE_CUA_EXEC_STATUS: "2" })).status, 2);
  const recorded = await calls(space.fake);
  assert.ok(recorded.every((call) => call[1] !== "cp"), "--reset copies nothing into the Space");
  assert.deepEqual(recorded.find((call) => call[1] === "exec").slice(2, 6), ["-i", "local:aiden-e2e", "--", "bash"]);
});
