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
const guest = fileURLToPath(new URL("./cua-space-e2e-guest.sh", import.meta.url));

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
  if (!target.startsWith("local:")) {
    // A download from the Space: hand back FAKE_CUA_RESULTS as the run's artifact archive, if set.
    if (!process.env.FAKE_CUA_RESULTS) process.exit(1);
    fs.copyFileSync(process.env.FAKE_CUA_RESULTS, target);
    process.exit(0);
  }
  fs.copyFileSync(source, path.join(dir, path.basename(target.slice(target.indexOf(":") + 1))));
} else if (command === "exec") {
  process.exit(Number(process.env.FAKE_CUA_EXEC_STATUS ?? 0));
}
`;

// Ignore the developer's git config (signing, hooks) and Space choice and sizing, so the fixture behaves the same anywhere.
const isolatedEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
for (const name of ["CUA_SPACE", "CUA_SPACE_CPUS", "CUA_SPACE_MEMORY"]) delete isolatedEnv[name];

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
  await copyFile(guest, path.join(repo, "scripts", "cua-space-e2e-guest.sh"));
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
    const { stdout, stderr } = await execFileAsync("bash", [path.join(repo, "scripts", "cua-space-e2e.sh"), ...args], {
      env: { ...isolatedEnv, CUA_BIN: path.join(fake, "cua"), FAKE_CUA_DIR: fake, ...env },
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
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

  assert.equal(
    await readFile(path.join(fake, `aiden-run-${archive.slice("aiden-src-".length, -".tgz".length)}.sh`), "utf8"),
    await readFile(guest, "utf8"),
    "the guest script copied into the Space is scripts/cua-space-e2e-guest.sh",
  );
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

test("resumes a stopped Space instead of creating another", async (t) => {
  const space = await checkout();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const result = await run(space, ["--run", "true"], { FAKE_CUA_LS: '[{"id":"local:aiden-e2e","status":"stopped"}]' });
  assert.equal(result.status, 0);
  const recorded = await calls(space.fake);
  assert.deepEqual(recorded.find((call) => call[1] === "resume"), ["sb", "resume", "local:aiden-e2e"]);
  assert.ok(recorded.every((call) => call[1] !== "create"));
  assert.ok(recorded.some((call) => call[1] === "exec"), "the run continues in the resumed Space");
});

test("--reset leaves a missing or stopped Space alone", async (t) => {
  const space = await checkout();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  for (const listing of ["[]", '[{"id":"local:aiden-e2e","status":"stopped"}]']) {
    const result = await run(space, ["--reset"], { FAKE_CUA_LS: listing });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /nothing to reset/);
  }
  assert.deepEqual([...new Set((await calls(space.fake)).map((call) => call[1]))], ["ls"]);
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

test("brings the run's artifacts back and keeps the previous ones when an archive is unreadable, empty or missing", async (t) => {
  const space = await checkout();
  t.after(() => rm(space.root, { recursive: true, force: true }));
  const { root, repo } = space;
  const ready = { FAKE_CUA_LS: '[{"id":"local:aiden-e2e","status":"ready"}]' };
  const out = path.join(repo, "test-results", "cua-space-aiden-e2e");

  const staged = path.join(root, "staged");
  await mkdir(path.join(staged, "playwright-report", "e2e"), { recursive: true });
  await writeFile(path.join(staged, "playwright-report", "e2e", "index.html"), "<p>report</p>\n");
  const archive = path.join(root, "results.tgz");
  await execFileAsync("tar", ["-czf", archive, "-C", staged, "playwright-report"]);
  const good = await run(space, ["--run", "true"], { ...ready, FAKE_CUA_RESULTS: archive });
  assert.equal(good.status, 0);
  assert.match(good.stdout, /Artifacts copied to/);
  assert.equal(await readFile(path.join(out, "playwright-report", "e2e", "index.html"), "utf8"), "<p>report</p>\n");

  const corrupt = path.join(root, "corrupt.tgz");
  await writeFile(corrupt, "not a gzip archive");
  const bad = await run(space, ["--run", "true"], { ...ready, FAKE_CUA_RESULTS: corrupt });
  assert.equal(bad.status, 0, "the tests' own result still decides the exit status");
  assert.doesNotMatch(bad.stdout, /Artifacts copied to/);
  assert.match(bad.stderr, /artifacts were unreadable or empty/);
  assert.equal(await readFile(path.join(out, "playwright-report", "e2e", "index.html"), "utf8"), "<p>report</p>\n");

  // A guest that found nothing to pack still writes a valid, empty archive.
  const empty = path.join(root, "empty.tgz");
  await execFileAsync("tar", ["-czf", empty, "--files-from", "/dev/null"]);
  const hollow = await run(space, ["--run", "true"], { ...ready, FAKE_CUA_RESULTS: empty });
  assert.doesNotMatch(hollow.stdout, /Artifacts copied to/);
  assert.match(hollow.stderr, /artifacts were unreadable or empty/);
  assert.equal(await readFile(path.join(out, "playwright-report", "e2e", "index.html"), "utf8"), "<p>report</p>\n");

  // No archive at all: a Playwright run warns, while --run (which never writes one) stays quiet.
  const missing = await run(space, ["tests/e2e/example.spec.ts"], ready);
  assert.equal(missing.status, 0);
  assert.match(missing.stderr, /This run left no artifacts/);
  assert.doesNotMatch((await run(space, ["--run", "true"], ready)).stderr, /artifacts/);
  assert.equal(await readFile(path.join(out, "playwright-report", "e2e", "index.html"), "utf8"), "<p>report</p>\n");
});

// The guest half runs inside the Space; these run it on the host with stand-ins for the Space's tools. Node is looked
// up under an empty prefix and sudo/apt-get fail loudly, so the tests never depend on or provision the host.
async function guestRun({ flockStatus, curlStatus = 22 }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-guest-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await mkdir(home);
  await mkdir(bin);
  await writeFile(path.join(bin, "flock"), `#!/bin/sh\nexit ${flockStatus}\n`);
  await writeFile(path.join(bin, "curl"), `#!/bin/sh\nexit ${curlStatus}\n`);
  for (const tool of ["sudo", "apt-get"]) {
    await writeFile(path.join(bin, tool), `#!/bin/sh\necho "UNEXPECTED_${tool}" >> "${path.join(root, "provisioning.log")}"\nexit 97\n`);
  }
  for (const tool of ["flock", "curl", "sudo", "apt-get"]) await chmod(path.join(bin, tool), 0o755);
  const script = path.join(home, "aiden-run-test.sh");
  const source = path.join(home, "aiden-src-test.tgz");
  await copyFile(guest, script);
  await writeFile(source, "");
  let result;
  try {
    const { stdout } = await execFileAsync("bash", [script, "test", "lockhash", "--run", "true"], {
      env: { ...isolatedEnv, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, AIDEN_E2E_LOCK: path.join(root, "lock"),
        AIDEN_E2E_NODE_PREFIX: path.join(root, "node") },
    });
    result = { status: 0, stdout };
  } catch (error) {
    result = { status: error.code, stdout: error.stdout };
  }
  const provisioning = await readFile(path.join(root, "provisioning.log"), "utf8").catch(() => "");
  return { root, home, ...result, leftovers: await readdir(home), provisioning };
}

test("the guest refuses a busy Space and cleans up its copied files", async (t) => {
  const busy = await guestRun({ flockStatus: 1 });
  t.after(() => rm(busy.root, { recursive: true, force: true }));
  assert.equal(busy.status, 75);
  assert.match(busy.stdout, /SPACE_BUSY/);
  assert.deepEqual(busy.leftovers, [], "the run script and source archive are removed");
  assert.equal(busy.provisioning, "", "no sudo or apt-get ran");
});

test("the guest stops at a failed Node install instead of running on", async (t) => {
  const failed = await guestRun({ flockStatus: 0 });
  t.after(() => rm(failed.root, { recursive: true, force: true }));
  assert.equal(failed.status, 2);
  assert.match(failed.stdout, /NODE_INSTALL_FAILED/);
  assert.doesNotMatch(failed.stdout, /APT_|NPM_|E2E_BUILD/);
  assert.deepEqual(failed.leftovers, [], "the run script and source archive are removed");
  assert.equal(failed.provisioning, "", "no sudo or apt-get ran");
});
