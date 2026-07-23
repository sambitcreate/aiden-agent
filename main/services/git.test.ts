import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  GitService,
  GitServiceError,
  parseGitNameStatus,
  parseGitNumstat,
  parseGitReviewStatus,
  parseGitStatus,
  parseRemoteRefs,
} from "./git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" },
  });
  return String(result.stdout).trim();
}

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-git-test-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
}

async function createRepository(t: test.TestContext): Promise<string> {
  const root = await temporaryDirectory(t);
  const repository = path.join(root, "repository");
  await fs.mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.email", "aiden@example.test"]);
  await git(repository, ["config", "user.name", "Aiden Test"]);
  await fs.writeFile(path.join(repository, "README.md"), "initial\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "Initial commit"]);
  return repository;
}

test("parseGitStatus handles NUL-delimited paths and rename pairs", () => {
  const raw = [
    "# branch.oid 1234567890abcdef",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -3",
    "1 .M N... 100644 100644 100644 a a tab\tname.txt",
    "2 R. N... 100644 100644 100644 a b R100 new\nname.txt",
    "old\nname.txt",
    "? untracked\nfile.txt",
    "",
  ].join("\u0000");

  assert.deepEqual(parseGitStatus(raw), {
    branch: "main",
    detached: false,
    unborn: false,
    uncommitted: 3,
    upstream: "origin/main",
    ahead: 2,
    behind: 3,
  });
});

test("parseRemoteRefs resolves a non-origin default and omits symbolic HEAD refs", () => {
  const raw = [
    "refs/remotes/upstream/HEAD",
    "refs/remotes/upstream/main",
    "\nrefs/remotes/upstream/main",
    "",
    "\nrefs/remotes/upstream/topic",
    "",
    "\n",
  ].join("\u0000");
  assert.deepEqual(parseRemoteRefs(raw), {
    branches: ["upstream/main", "upstream/topic"],
    defaultBranch: "main",
  });
});

test("review parsers preserve unusual paths, staged state, and rename statistics", () => {
  const status = [
    "# branch.head main",
    "1 MM N... 100644 100644 100644 a b tab\tname.txt",
    "2 R. N... 100644 100644 100644 a b R100 new\nname.txt",
    "old\nname.txt",
    "? untracked.txt",
    "",
  ].join("\u0000");
  assert.deepEqual(parseGitReviewStatus(status), [
    {
      path: "new\nname.txt",
      previousPath: "old\nname.txt",
      status: "renamed",
      staged: true,
      unstaged: false,
    },
    {
      path: "tab\tname.txt",
      status: "modified",
      staged: true,
      unstaged: true,
    },
    {
      path: "untracked.txt",
      status: "untracked",
      staged: false,
      unstaged: true,
    },
  ]);

  assert.deepEqual(
    parseGitNumstat("2\t1\tplain.txt\u00003\t0\t\u0000old.txt\u0000new.txt\u0000"),
    [
      { path: "plain.txt", additions: 2, deletions: 1, binary: false },
      { path: "new.txt", additions: 3, deletions: 0, binary: false },
    ],
  );
  assert.deepEqual(
    parseGitNameStatus("M\u0000plain.txt\u0000R100\u0000old name.txt\u0000new name.txt\u0000D\u0000gone.txt\u0000"),
    [
      { path: "gone.txt", status: "deleted", staged: false, unstaged: false },
      { path: "new name.txt", previousPath: "old name.txt", status: "renamed", staged: false, unstaged: false },
      { path: "plain.txt", status: "modified", staged: false, unstaged: false },
    ],
  );
});

test("GitService reads NUL-safe status and executes unusual branch names without a shell", async (t) => {
  const repository = await createRepository(t);
  const service = new GitService({ cacheTtlMs: 0 });
  await fs.writeFile(path.join(repository, "tab\tname.txt"), "tab\n", "utf8");
  await fs.writeFile(path.join(repository, "line\nbreak.txt"), "line\n", "utf8");

  const status = await service.info(repository);
  assert.equal(status.isRepo, true);
  assert.equal(status.branch, "main");
  assert.equal(status.uncommitted, 2);

  const marker = path.join(repository, "SHOULD_NOT_EXIST");
  const unusualBranch = "feature/safe;touch-SHOULD_NOT_EXIST";
  await service.createBranch(repository, unusualBranch);
  assert.equal(await git(repository, ["branch", "--show-current"]), unusualBranch);
  await assert.rejects(fs.access(marker));

  await service.checkout(repository, "main");
  assert.equal(await git(repository, ["branch", "--show-current"]), "main");
  await git(repository, ["update-ref", "refs/remotes/origin/remote-only", "HEAD"]);
  await assert.rejects(
    service.checkout(repository, "remote-only"),
    (error) => error instanceof GitServiceError && error.code === "invalid_ref",
  );
  assert.equal(await git(repository, ["show-ref", "--verify", "--quiet", "refs/heads/remote-only"]).catch(() => "missing"), "missing");

  await assert.rejects(
    service.createBranch(repository, "-invalid"),
    (error) => error instanceof GitServiceError && error.code === "invalid_ref",
  );
});

test("GitService reports remotes, upstream divergence, default branch, and remote refs", async (t) => {
  const root = await temporaryDirectory(t);
  const remote = path.join(root, "remote.git");
  const repository = path.join(root, "primary");
  const peer = path.join(root, "peer");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await fs.mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.email", "aiden@example.test"]);
  await git(repository, ["config", "user.name", "Aiden Test"]);
  await fs.writeFile(path.join(repository, "base.txt"), "base\n", "utf8");
  await git(repository, ["add", "base.txt"]);
  await git(repository, ["commit", "-m", "Base"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(repository, ["push", "-u", "origin", "main"]);
  await git(repository, ["remote", "set-head", "origin", "--auto"]);

  await fs.writeFile(path.join(repository, "local.txt"), "local\n", "utf8");
  await git(repository, ["add", "local.txt"]);
  await git(repository, ["commit", "-m", "Local"]);

  await git(root, ["clone", remote, peer]);
  await git(peer, ["config", "user.email", "peer@example.test"]);
  await git(peer, ["config", "user.name", "Peer Test"]);
  await fs.writeFile(path.join(peer, "remote.txt"), "remote\n", "utf8");
  await git(peer, ["add", "remote.txt"]);
  await git(peer, ["commit", "-m", "Remote"]);
  await git(peer, ["push", "origin", "main"]);
  await git(repository, ["fetch", "origin"]);

  const service = new GitService({ cacheTtlMs: 0 });
  const info = await service.info(repository);
  assert.equal(info.upstream, "origin/main");
  assert.equal(info.ahead, 1);
  assert.equal(info.behind, 1);
  assert.equal(info.defaultBranch, "main");
  assert.equal(info.hasRemote, true);

  const branches = await service.branches(repository);
  assert.deepEqual(branches.branches, ["main"]);
  assert.deepEqual(branches.remoteBranches, ["origin/main"]);
});

test("GitService pushes an immutable reviewed head to an explicit remote branch without fetching", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  const logPath = path.join(root, "git-commands.log");
  const wrapper = path.join(root, "git-log-wrapper.mjs");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "upstream", remote]);
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(' ') + '\\n');`,
      "const result = spawnSync('git', process.argv.slice(2), { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await git(repository, ["config", "push.recurseSubmodules", "only"]);
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper });
  const capability = await service.pushCapability(repository);
  assert.equal(capability.allowed, true);
  assert.equal(capability.suggestedRemote, "upstream");
  assert.equal(capability.destinationBranch, "main");

  const result = await service.push(repository, {
    destinationBranch: "review/main",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.upstream!,
    remote: "upstream",
    setUpstream: false,
  });
  assert.equal(result.remote, "upstream");
  assert.equal(result.destinationBranch, "review/main");
  assert.equal(
    await git(remote, ["show-ref", "--verify", "--hash", "refs/heads/review/main"]),
    capability.expectedHead,
  );
  await git(repository, ["config", "push.recurseSubmodules", "on-demand"]);
  await service.push(repository, {
    destinationBranch: "review/on-demand",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.upstream!,
    remote: "upstream",
    setUpstream: false,
  });
  assert.equal(
    await git(remote, ["show-ref", "--verify", "--hash", "refs/heads/review/on-demand"]),
    capability.expectedHead,
  );
  const commands = await fs.readFile(logPath, "utf8");
  assert.match(commands, /push --porcelain --no-force --no-mirror --no-prune --no-follow-tags --no-recurse-submodules -- aiden-reviewed-[0-9a-f-]+ [0-9a-f]+:refs\/heads\/review\/main/);
  assert.doesNotMatch(commands, /(^|\s)fetch(\s|$)/m);
  assert.doesNotMatch(commands, /\+[0-9a-f]+:refs\/heads\/review\/main/);
});

test("GitService runs pre-push once with the reviewed remote name, URL, and ref update", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  const hookLog = path.join(root, "pre-push.json");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  const service = new GitService({ cacheTtlMs: 0 });
  const capability = await service.pushCapability(repository);
  const destinationRef = "refs/heads/review/hook";
  const expectedStdin = [
    capability.expectedHead,
    capability.expectedHead,
    destinationRef,
    "0".repeat(capability.expectedHead!.length),
  ].join(" ") + "\n";
  const expectedRecord = {
    args: ["origin", remote],
    stdin: expectedStdin,
  };
  await fs.writeFile(
    path.join(repository, ".git", "hooks", "pre-push"),
    [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      `const expected = ${JSON.stringify(expectedRecord)};`,
      "const actual = { args: process.argv.slice(2), stdin: readFileSync(0, 'utf8') };",
      `writeFileSync(${JSON.stringify(hookLog)}, JSON.stringify(actual));`,
      "if (JSON.stringify(actual) !== JSON.stringify(expected)) {",
      "  console.error('pre-push received different reviewed push metadata');",
      "  process.exit(41);",
      "}",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );

  await service.push(repository, {
    destinationBranch: "review/hook",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: false,
  });

  assert.deepEqual(JSON.parse(await fs.readFile(hookLog, "utf8")), expectedRecord);
  assert.equal(await git(remote, ["rev-parse", destinationRef]), capability.expectedHead);

  const noOpRecord = { args: ["origin", remote], stdin: "" };
  await fs.writeFile(
    path.join(repository, ".git", "hooks", "pre-push"),
    [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      `const expected = ${JSON.stringify(noOpRecord)};`,
      "const actual = { args: process.argv.slice(2), stdin: readFileSync(0, 'utf8') };",
      `writeFileSync(${JSON.stringify(hookLog)}, JSON.stringify(actual));`,
      "if (JSON.stringify(actual) !== JSON.stringify(expected)) {",
      "  console.error('pre-push received a fabricated no-op ref update');",
      "  process.exit(42);",
      "}",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await service.push(repository, {
    destinationBranch: "review/hook",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: false,
  });
  assert.deepEqual(JSON.parse(await fs.readFile(hookLog, "utf8")), noOpRecord);
});

test("GitService keeps pre-push and receive-pack on one remote advertisement", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(repository, ["push", "origin", "main"]);
  await fs.writeFile(path.join(repository, "step.txt"), "B\n");
  await git(repository, ["add", "step.txt"]);
  await git(repository, ["commit", "-m", "Commit B"]);
  const commitB = await git(repository, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(repository, "step.txt"), "C\n");
  await git(repository, ["commit", "-am", "Commit C"]);
  await fs.writeFile(
    path.join(repository, ".git", "hooks", "pre-push"),
    [
      "#!/usr/bin/env node",
      "const { spawnSync } = require('node:child_process');",
      `const result = spawnSync('git', ['push', '--no-verify', 'origin', ${JSON.stringify(`${commitB}:refs/heads/main`)}], { env: process.env, stdio: 'inherit' });`,
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0 });
  const capability = await service.pushCapability(repository);

  await assert.rejects(
    service.push(repository, {
      destinationBranch: "main",
      expectedBranch: capability.branch!,
      expectedHead: capability.expectedHead!,
      expectedRemoteIdentity: capability.remoteIdentities.origin!,
      remote: "origin",
      setUpstream: false,
    }),
    (error) => error instanceof GitServiceError && error.code === "command_failed",
  );
  assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), commitB);
});

test("GitService pushes through a receive-pack-only transport without probing upload-pack", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "push-only.git");
  const transport = path.join(root, "receive-pack-only.cjs");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await fs.writeFile(
    transport,
    [
      "#!/usr/bin/env node",
      "const { spawnSync } = require('node:child_process');",
      "const [service, repository] = process.argv.slice(2);",
      "if (service !== 'git-receive-pack') { console.error('upload-pack denied'); process.exit(43); }",
      "const result = spawnSync(service, [repository], { env: process.env, stdio: 'inherit' });",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await git(repository, ["config", "protocol.ext.allow", "always"]);
  await git(repository, ["remote", "add", "origin", `ext::${transport} %S ${remote}`]);
  const service = new GitService({ cacheTtlMs: 0 });
  const capability = await service.pushCapability(repository);

  await service.push(repository, {
    destinationBranch: "main",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: false,
  });

  assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), capability.expectedHead);
});

test("GitService retries push capability until branch and HEAD form one snapshot", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const marker = path.join(root, "push-capability-interleaved");
  const wrapper = path.join(root, "git-push-capability-race.mjs");
  const mainHead = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["switch", "-c", "feature"]);
  await fs.writeFile(path.join(repository, "feature.txt"), "feature\n", "utf8");
  await git(repository, ["add", "feature.txt"]);
  await git(repository, ["commit", "-m", "Feature head"]);
  const featureHead = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["switch", "main"]);
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const marker = ${JSON.stringify(marker)};`,
      "const args = process.argv.slice(2);",
      "const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8', env: process.env });",
      "if (args[0] === 'symbolic-ref' && args[1] === '--quiet' && args[2] === 'HEAD' && !existsSync(marker)) {",
      "  writeFileSync(marker, 'switched\\n');",
      "  const switched = spawnSync('git', ['switch', 'feature'], { cwd: process.cwd(), env: process.env, stdio: 'ignore' });",
      "  if (switched.status !== 0) process.exit(switched.status ?? 1);",
      "}",
      "if (result.stdout) process.stdout.write(result.stdout);",
      "if (result.stderr) process.stderr.write(result.stderr);",
      "if (result.error) throw result.error;",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper });
  const capability = await service.pushCapability(repository);

  assert.equal(capability.branch, "feature");
  assert.equal(capability.expectedHead, featureHead);
  assert.notEqual(capability.expectedHead, mainHead);
  assert.equal(await git(repository, ["symbolic-ref", "--short", "HEAD"]), "feature");
});

test("GitService freezes the reviewed push endpoint through timeout reconciliation", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const reviewedRemote = path.join(root, "reviewed.git");
  const replacementRemote = path.join(root, "replacement.git");
  const wrapper = path.join(root, "git-freeze-push-endpoint.mjs");
  await fs.mkdir(reviewedRemote);
  await fs.mkdir(replacementRemote);
  await git(reviewedRemote, ["init", "--bare", "--initial-branch=main"]);
  await git(replacementRemote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", reviewedRemote]);
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { spawnSync } from 'node:child_process';",
      `const replacement = ${JSON.stringify(replacementRemote)};`,
      "const args = process.argv.slice(2);",
      "if (args[0] === 'push') {",
      "  const configEnv = { ...process.env };",
      "  for (const key of Object.keys(configEnv)) if (key.startsWith('GIT_CONFIG_')) delete configEnv[key];",
      "  const changed = spawnSync('git', ['config', 'remote.origin.url', replacement], { env: configEnv, stdio: 'inherit' });",
      "  if (changed.status !== 0) process.exit(changed.status ?? 1);",
      "}",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "if (args[0] === 'push' && result.status === 0) setTimeout(() => process.exit(0), 3000);",
      "else process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper, pushTimeoutMs: 1_500 });
  const capability = await service.pushCapability(repository);
  const result = await service.push(repository, {
    destinationBranch: "main",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: false,
  });

  assert.match(result.warning ?? "", /stopped responding/);
  assert.equal(await git(reviewedRemote, ["rev-parse", "refs/heads/main"]), capability.expectedHead);
  await assert.rejects(git(replacementRemote, ["rev-parse", "refs/heads/main"]));
  assert.equal(await git(repository, ["remote", "get-url", "origin"]), replacementRemote);
});

test("GitService neutralizes chained URL rewrites after resolving the reviewed push endpoint", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const reviewedRemote = path.join(root, "reviewed.git");
  const reroutedRemote = path.join(root, "rerouted.git");
  await fs.mkdir(reviewedRemote);
  await fs.mkdir(reroutedRemote);
  await git(reviewedRemote, ["init", "--bare", "--initial-branch=main"]);
  await git(reroutedRemote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["config", `url.${reviewedRemote}.insteadOf`, "aiden-stage-one:"]);
  await git(repository, ["config", `url.${reroutedRemote}.insteadOf`, reviewedRemote]);
  await git(repository, ["remote", "add", "origin", "aiden-stage-one:"]);
  const service = new GitService({ cacheTtlMs: 0 });
  const capability = await service.pushCapability(repository);

  await service.push(repository, {
    destinationBranch: "main",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: false,
  });

  assert.equal(await git(reviewedRemote, ["rev-parse", "refs/heads/main"]), capability.expectedHead);
  await assert.rejects(git(reroutedRemote, ["rev-parse", "refs/heads/main"]));
});

test("GitService neutralizes pushInsteadOf before a second endpoint rewrite", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const reviewedRemote = path.join(root, "reviewed-push.git");
  const reroutedRemote = path.join(root, "rerouted-push.git");
  await fs.mkdir(reviewedRemote);
  await fs.mkdir(reroutedRemote);
  await git(reviewedRemote, ["init", "--bare", "--initial-branch=main"]);
  await git(reroutedRemote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["config", `url.${reviewedRemote}.pushInsteadOf`, "aiden-push-stage-one:"]);
  await git(repository, ["config", `url.${reroutedRemote}.insteadOf`, reviewedRemote]);
  await git(repository, ["remote", "add", "origin", "aiden-push-stage-one:"]);
  const service = new GitService({ cacheTtlMs: 0 });
  const capability = await service.pushCapability(repository);

  await service.push(repository, {
    destinationBranch: "main",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: false,
  });

  assert.equal(await git(reviewedRemote, ["rev-parse", "refs/heads/main"]), capability.expectedHead);
  await assert.rejects(git(reroutedRemote, ["rev-parse", "refs/heads/main"]));
});

test("GitService never reconciles a timed-out pre-push hook as a completed transport", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(repository, ["push", "origin", "main"]);
  await fs.writeFile(
    path.join(repository, ".git", "hooks", "pre-push"),
    "#!/usr/bin/env node\nsetTimeout(() => undefined, 2_000);\n",
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0, pushTimeoutMs: 100 });
  const capability = await service.pushCapability(repository);

  await assert.rejects(
    service.push(repository, {
      destinationBranch: "main",
      expectedBranch: capability.branch!,
      expectedHead: capability.expectedHead!,
      expectedRemoteIdentity: capability.remoteIdentities.origin!,
      remote: "origin",
      setUpstream: false,
    }),
    (error) => error instanceof GitServiceError && error.code === "timeout",
  );
});

test("GitService does not treat a rejected push as success when the remote was already exact", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  const wrapper = path.join(root, "git-push-rejected.mjs");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(repository, ["push", "origin", "main"]);
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { spawnSync } from 'node:child_process';",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'push') { console.error('pre-push policy rejected this push'); process.exit(1); }",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper });
  const capability = await service.pushCapability(repository);

  await assert.rejects(
    service.push(repository, {
      destinationBranch: "main",
      expectedBranch: capability.branch!,
      expectedHead: capability.expectedHead!,
      expectedRemoteIdentity: capability.remoteIdentities.origin!,
      remote: "origin",
      setUpstream: false,
    }),
    (error) =>
      error instanceof GitServiceError &&
      error.code === "command_failed" &&
      /pre-push policy rejected/.test(error.message),
  );
  assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), capability.expectedHead);
});

test("GitService explains unavailable push states without widening a nested workspace", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  const nested = path.join(repository, "packages", "app");
  await fs.mkdir(nested, { recursive: true });
  const service = new GitService({ cacheTtlMs: 0 });

  const noRemote = await service.pushCapability(repository);
  assert.equal(noRemote.allowed, false);
  assert.match(noRemote.reason ?? "", /Add a Git remote/);

  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  const nestedCapability = await service.pushCapability(nested);
  assert.equal(nestedCapability.allowed, false);
  assert.equal(nestedCapability.repositoryRoot, false);
  assert.match(nestedCapability.reason ?? "", /repository root/);

  await git(repository, ["switch", "--detach"]);
  const detached = await service.pushCapability(repository);
  assert.equal(detached.allowed, false);
  assert.match(detached.reason ?? "", /local branch/);
});

test("GitService refreshes an existing upstream tracking ref after every reviewed push", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  const service = new GitService({ cacheTtlMs: 0 });

  const initial = await service.pushCapability(repository);
  await service.push(repository, {
    destinationBranch: "main",
    expectedBranch: initial.branch!,
    expectedHead: initial.expectedHead!,
    expectedRemoteIdentity: initial.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: true,
  });
  assert.equal(
    await git(repository, ["rev-parse", "refs/remotes/origin/main"]),
    initial.expectedHead,
  );

  await fs.writeFile(path.join(repository, "second.txt"), "second\n", "utf8");
  await git(repository, ["add", "second.txt"]);
  await git(repository, ["commit", "-m", "Second push"]);
  const second = await service.pushCapability(repository);
  assert.equal(second.upstream, "origin/main");
  assert.equal(second.ahead, 1);
  const result = await service.push(repository, {
    destinationBranch: "main",
    expectedBranch: second.branch!,
    expectedHead: second.expectedHead!,
    expectedRemoteIdentity: second.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: false,
  });

  assert.equal(result.warning, undefined);
  assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), second.expectedHead);
  assert.equal(
    await git(repository, ["rev-parse", "refs/remotes/origin/main"]),
    second.expectedHead,
  );
  const refreshed = await service.pushCapability(repository);
  assert.equal(refreshed.ahead, 0);
  assert.equal(refreshed.behind, 0);
});

test("GitService never rewinds a tracking ref advanced after the reviewed transport", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  const peer = path.join(root, "peer");
  const wrapper = path.join(root, "git-tracking-race.mjs");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(repository, ["push", "-u", "origin", "main"]);
  await fs.writeFile(path.join(repository, "reviewed.txt"), "reviewed\n", "utf8");
  await git(repository, ["add", "reviewed.txt"]);
  await git(repository, ["commit", "-m", "Reviewed push"]);
  await git(root, ["clone", repository, peer]);
  await git(peer, ["config", "user.email", "peer@example.test"]);
  await git(peer, ["config", "user.name", "Peer Test"]);
  await fs.writeFile(path.join(peer, "newer.txt"), "newer\n", "utf8");
  await git(peer, ["add", "newer.txt"]);
  await git(peer, ["commit", "-m", "Newer remote push"]);
  const newerHead = await git(peer, ["rev-parse", "HEAD"]);
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { spawnSync } from 'node:child_process';",
      `const peer = ${JSON.stringify(peer)};`,
      `const remote = ${JSON.stringify(remote)};`,
      "const args = process.argv.slice(2);",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "if (args[0] === 'push' && result.status === 0) {",
      "  const newerPush = spawnSync('git', ['-C', peer, 'push', remote, 'HEAD:refs/heads/main'], { stdio: 'ignore' });",
      "  if (newerPush.status !== 0) process.exit(newerPush.status ?? 1);",
      "  const refresh = spawnSync('git', ['fetch', 'origin', 'main'], { stdio: 'ignore' });",
      "  if (refresh.status !== 0) process.exit(refresh.status ?? 1);",
      "}",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper });
  const capability = await service.pushCapability(repository);
  const result = await service.push(repository, {
    destinationBranch: "main",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: false,
  });

  assert.match(result.warning ?? "", /could not safely update its local tracking ref/);
  assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), newerHead);
  assert.equal(await git(repository, ["rev-parse", "refs/remotes/origin/main"]), newerHead);
});

test("GitService preserves remote-scoped receive-pack policy on its frozen alias", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  const receivePack = path.join(root, "reject-receive-pack");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await fs.writeFile(receivePack, "#!/bin/sh\necho 'receive-pack policy refused push' >&2\nexit 42\n", {
    mode: 0o700,
  });
  await git(repository, ["config", "remote.origin.receivepack", receivePack]);
  const service = new GitService({ cacheTtlMs: 0 });
  const capability = await service.pushCapability(repository);

  await assert.rejects(
    service.push(repository, {
      destinationBranch: "main",
      expectedBranch: capability.branch!,
      expectedHead: capability.expectedHead!,
      expectedRemoteIdentity: capability.remoteIdentities.origin!,
      remote: "origin",
      setUpstream: false,
    }),
    (error) => error instanceof GitServiceError && error.code === "command_failed" && /receive-pack policy/.test(error.message),
  );
  await assert.rejects(git(remote, ["rev-parse", "refs/heads/main"]));
});

test("GitService reconciles bounded post-receive output after the exact ref was pushed", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await fs.writeFile(
    path.join(remote, "hooks", "post-receive"),
    "#!/usr/bin/env node\nprocess.stderr.write('x'.repeat(8192));\n",
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0, maxBufferBytes: 1_024 });
  const capability = await service.pushCapability(repository);
  const result = await service.push(repository, {
    destinationBranch: "main",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: false,
  });

  assert.match(result.warning ?? "", /more output than Aiden could retain/);
  assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), capability.expectedHead);
});

test("GitService rejects stale and non-fast-forward pushes without forcing", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  const peer = path.join(root, "peer");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  const service = new GitService({ cacheTtlMs: 0 });
  const initialCapability = await service.pushCapability(repository);
  await service.push(repository, {
    destinationBranch: "main",
    expectedBranch: initialCapability.branch!,
    expectedHead: initialCapability.expectedHead!,
    expectedRemoteIdentity: initialCapability.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: true,
  });

  await git(repository, ["switch", "-c", "feature"]);
  await assert.rejects(
    service.push(repository, {
      destinationBranch: "main",
      expectedBranch: initialCapability.branch!,
      expectedHead: initialCapability.expectedHead!,
      expectedRemoteIdentity: initialCapability.remoteIdentities.origin!,
      remote: "origin",
      setUpstream: true,
    }),
    (error) => error instanceof GitServiceError && error.code === "stale_snapshot",
  );
  assert.equal(
    await git(repository, ["for-each-ref", "--format=%(upstream:short)", "refs/heads/feature"]),
    "",
  );
  await git(repository, ["switch", "main"]);

  await fs.writeFile(path.join(repository, "local.txt"), "local\n", "utf8");
  await git(repository, ["add", "local.txt"]);
  await git(repository, ["commit", "-m", "Local diverged"]);
  await assert.rejects(
    service.push(repository, {
      destinationBranch: "main",
      expectedBranch: initialCapability.branch!,
      expectedHead: initialCapability.expectedHead!,
      expectedRemoteIdentity: initialCapability.remoteIdentities.origin!,
      remote: "origin",
      setUpstream: false,
    }),
    (error) => error instanceof GitServiceError && error.code === "stale_snapshot",
  );

  await git(root, ["clone", remote, peer]);
  await git(peer, ["config", "user.email", "peer@example.test"]);
  await git(peer, ["config", "user.name", "Peer Test"]);
  await fs.writeFile(path.join(peer, "remote.txt"), "remote\n", "utf8");
  await git(peer, ["add", "remote.txt"]);
  await git(peer, ["commit", "-m", "Remote diverged"]);
  await git(peer, ["push", "origin", "main"]);
  const remoteHead = await git(remote, ["rev-parse", "refs/heads/main"]);
  const divergedCapability = await service.pushCapability(repository);
  await assert.rejects(
    service.push(repository, {
      destinationBranch: "main",
      expectedBranch: divergedCapability.branch!,
      expectedHead: divergedCapability.expectedHead!,
      expectedRemoteIdentity: divergedCapability.remoteIdentities.origin!,
      remote: "origin",
      setUpstream: false,
    }),
    (error) => error instanceof GitServiceError && error.code === "command_failed",
  );
  assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), remoteHead);
});

test("GitService reconciles a push timeout against the exact remote ref", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  const wrapper = path.join(root, "git-push-timeout.mjs");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { spawnSync } from 'node:child_process';",
      "const args = process.argv.slice(2);",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "if (args[0] === 'push' && result.status === 0) setTimeout(() => process.exit(0), 2000);",
      "else process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper, pushTimeoutMs: 500 });
  const capability = await service.pushCapability(repository);
  const result = await service.push(repository, {
    destinationBranch: "main",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: false,
  });
  assert.match(result.warning ?? "", /stopped responding/);
  assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), capability.expectedHead);
});

test("GitService does not mutate upstream configuration after a cancelled push reconciles", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  const marker = path.join(root, "push-finished");
  const wrapper = path.join(root, "git-push-abort.mjs");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const marker = ${JSON.stringify(marker)};`,
      "const args = process.argv.slice(2);",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "if (args[0] === 'push' && result.status === 0) { writeFileSync(marker, 'pushed\\n'); setTimeout(() => process.exit(0), 2000); }",
      "else process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper, pushTimeoutMs: 5_000 });
  const capability = await service.pushCapability(repository);
  const controller = new AbortController();
  const operation = service.push(repository, {
    destinationBranch: "main",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: true,
  }, controller.signal);

  let pushed = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      await fs.access(marker);
      pushed = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.equal(pushed, true);
  controller.abort();
  const result = await operation;
  assert.match(result.warning ?? "", /cancelled request did not change the local upstream/);
  assert.equal(result.upstreamSet, false);
  assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), capability.expectedHead);
  assert.equal(
    await git(repository, ["for-each-ref", "--format=%(upstream:short)", "refs/heads/main"]),
    "",
  );
});

test("GitService rechecks cancellation after post-push branch reads before setting upstream", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  const pushMarker = path.join(root, "push-finished-before-upstream");
  const readMarker = path.join(root, "post-push-read-started");
  const wrapper = path.join(root, "git-post-push-read-delay.mjs");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const pushMarker = ${JSON.stringify(pushMarker)};`,
      `const readMarker = ${JSON.stringify(readMarker)};`,
      "const args = process.argv.slice(2);",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "if (args[0] === 'push' && result.status === 0) writeFileSync(pushMarker, 'pushed\\n');",
      "if (existsSync(pushMarker) && args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {",
      "  writeFileSync(readMarker, 'reading\\n');",
      "  setTimeout(() => process.exit(result.status ?? 1), 1200);",
      "} else process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper, pushTimeoutMs: 5_000 });
  const capability = await service.pushCapability(repository);
  const controller = new AbortController();
  const operation = service.push(repository, {
    destinationBranch: "main",
    expectedBranch: capability.branch!,
    expectedHead: capability.expectedHead!,
    expectedRemoteIdentity: capability.remoteIdentities.origin!,
    remote: "origin",
    setUpstream: true,
  }, controller.signal);

  let reading = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      await fs.access(readMarker);
      reading = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.equal(reading, true);
  controller.abort();
  const result = await operation;
  assert.match(result.warning ?? "", /cancelled request did not change the local upstream/);
  assert.equal(result.upstreamSet, false);
  assert.equal(
    await git(repository, ["for-each-ref", "--format=%(upstream:short)", "refs/heads/main"]),
    "",
  );
});

test("GitService preserves an unknown push outcome when remote verification fails", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  const marker = path.join(root, "push-ran");
  const wrapper = path.join(root, "git-push-unknown.mjs");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const marker = ${JSON.stringify(marker)};`,
      "const args = process.argv.slice(2);",
      "if (args[0] === 'ls-remote' && existsSync(marker)) process.exit(1);",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "if (args[0] === 'push' && result.status === 0) { writeFileSync(marker, 'pushed\\n'); setTimeout(() => process.exit(0), 2000); }",
      "else process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper, pushTimeoutMs: 500 });
  const capability = await service.pushCapability(repository);
  await assert.rejects(
    service.push(repository, {
      destinationBranch: "main",
      expectedBranch: capability.branch!,
      expectedHead: capability.expectedHead!,
      expectedRemoteIdentity: capability.remoteIdentities.origin!,
      remote: "origin",
      setUpstream: false,
    }),
    (error) => {
      assert.equal(error instanceof GitServiceError, true);
      assert.match((error as Error).message, /could not determine whether the remote branch was updated/i);
      return true;
    },
  );
  assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), capability.expectedHead);
});

test("GitService compares the current branch from the merge base and freezes per-file diffs", async (t) => {
  const repository = await createRepository(t);
  const initialHead = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["switch", "-c", "side", initialHead]);
  await fs.writeFile(path.join(repository, "side.txt"), "side\n", "utf8");
  await git(repository, ["add", "side.txt"]);
  await git(repository, ["commit", "-m", "Side commit"]);
  await git(repository, ["switch", "main"]);
  await fs.writeFile(path.join(repository, "main.txt"), "main\n", "utf8");
  await git(repository, ["add", "main.txt"]);
  await git(repository, ["commit", "-m", "Main commit"]);
  const service = new GitService({ cacheTtlMs: 0 });

  const comparison = await service.compare(repository, "refs/heads/side");
  assert.equal(comparison.ahead, 1);
  assert.equal(comparison.behind, 1);
  assert.equal(comparison.mergeBase, initialHead);
  assert.deepEqual(comparison.files.map((file) => file.path), ["main.txt"]);
  const diff = await service.comparisonDiff(repository, {
    expectedHead: comparison.expectedHead,
    expectedTarget: comparison.expectedTarget,
    mergeBase: comparison.mergeBase,
    path: "main.txt",
    targetRef: comparison.targetRef,
  });
  assert.match(diff.patch, /\+main/);

  await fs.writeFile(path.join(repository, "later.txt"), "later\n", "utf8");
  await git(repository, ["add", "later.txt"]);
  await git(repository, ["commit", "-m", "Move comparison head"]);
  await assert.rejects(
    service.comparisonDiff(repository, {
      expectedHead: comparison.expectedHead,
      expectedTarget: comparison.expectedTarget,
      mergeBase: comparison.mergeBase,
      path: "main.txt",
      targetRef: comparison.targetRef,
    }),
    (error) => error instanceof GitServiceError && error.code === "stale_snapshot",
  );
});

test("GitService branch comparison stays inside a nested workspace and rejects unrelated history", async (t) => {
  const repository = await createRepository(t);
  const nested = path.join(repository, "packages", "app");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "inside.txt"), "base\n", "utf8");
  await fs.writeFile(path.join(repository, "outside.txt"), "base\n", "utf8");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Nested base"]);
  await git(repository, ["branch", "base"]);
  await fs.writeFile(path.join(nested, "inside.txt"), "changed\n", "utf8");
  await fs.mkdir(path.join(nested, "packages", "app"), { recursive: true });
  await fs.writeFile(path.join(nested, "packages", "app", "deep.txt"), "deep\n", "utf8");
  await fs.writeFile(path.join(repository, "outside.txt"), "changed\n", "utf8");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Scoped changes"]);
  const service = new GitService({ cacheTtlMs: 0 });
  const comparison = await service.compare(nested, "refs/heads/base");
  assert.deepEqual(comparison.files.map((file) => file.path), ["inside.txt", "packages/app/deep.txt"]);
  const nestedDiff = await service.comparisonDiff(nested, {
    expectedHead: comparison.expectedHead,
    expectedTarget: comparison.expectedTarget,
    mergeBase: comparison.mergeBase,
    path: "packages/app/deep.txt",
    targetRef: comparison.targetRef,
  });
  assert.match(nestedDiff.patch, /\+deep/);

  await git(repository, ["switch", "--orphan", "unrelated"]);
  await fs.writeFile(path.join(repository, "unrelated.txt"), "unrelated\n", "utf8");
  await git(repository, ["add", "unrelated.txt"]);
  await git(repository, ["commit", "-m", "Unrelated root"]);
  await git(repository, ["switch", "main"]);
  await assert.rejects(
    service.compare(repository, "refs/heads/unrelated"),
    (error) => error instanceof GitServiceError && error.code === "invalid_ref",
  );
});

test("GitService diff rendering never executes repository textconv commands", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const marker = path.join(root, "textconv-ran");
  const driver = path.join(root, "textconv-driver.mjs");
  await fs.writeFile(
    driver,
    [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'ran\\n');`,
      "if (process.argv[2]) process.stdout.write(readFileSync(process.argv[2]));",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await git(repository, ["config", "diff.aiden.textconv", driver]);
  await fs.writeFile(path.join(repository, ".gitattributes"), "*.txt diff=aiden\n");
  await fs.writeFile(path.join(repository, "sample.txt"), "base\n");
  await git(repository, ["add", ".gitattributes", "sample.txt"]);
  await git(repository, ["commit", "-m", "Textconv base"]);
  await git(repository, ["branch", "comparison-base"]);

  const service = new GitService({ cacheTtlMs: 0 });
  await fs.writeFile(path.join(repository, "sample.txt"), "working\n");
  const workingReview = await service.review(repository);
  const workingDiff = await service.diff(repository, {
    expectedSnapshot: workingReview.commit.snapshot!,
    path: "sample.txt",
  });
  assert.match(workingDiff.patch, /\+working/);
  await assert.rejects(fs.access(marker));

  await git(repository, ["add", "sample.txt"]);
  await git(repository, ["commit", "-m", "Textconv change"]);
  await fs.rm(marker, { force: true });
  const comparison = await service.compare(repository, "refs/heads/comparison-base");
  const comparisonDiff = await service.comparisonDiff(repository, {
    expectedHead: comparison.expectedHead,
    expectedTarget: comparison.expectedTarget,
    mergeBase: comparison.mergeBase,
    path: "sample.txt",
    targetRef: comparison.targetRef,
  });
  assert.match(comparisonDiff.patch, /\+working/);
  await assert.rejects(fs.access(marker));
});

test("GitService returns workspace review files and bounded per-file diffs", async (t) => {
  const repository = await createRepository(t);
  const service = new GitService({ cacheTtlMs: 0 });
  await fs.writeFile(path.join(repository, "README.md"), "staged\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await fs.writeFile(path.join(repository, "README.md"), "working\n", "utf8");
  await fs.writeFile(path.join(repository, "new file.txt"), "new\ncontent\n", "utf8");

  const review = await service.review(repository);
  assert.equal(review.isRepo, true);
  assert.equal(review.branch, "main");
  assert.equal(review.commit.allowed, true);
  assert.match(review.commit.snapshot ?? "", /^[0-9a-f]{64}$/);
  assert.equal(review.commit.snapshotComplete, true);
  assert.equal(review.commit.repositoryRoot, true);
  assert.deepEqual(review.summary, {
    fileCount: 2,
    additions: 3,
    deletions: 1,
    unavailableStats: 0,
    stagedFiles: 1,
    unstagedFiles: 2,
    conflictedFiles: 0,
  });
  assert.deepEqual(
    review.files.map((file) => ({
      path: file.path,
      status: file.status,
      staged: file.staged,
      unstaged: file.unstaged,
      additions: file.additions,
      deletions: file.deletions,
    })),
    [
      {
        path: "new file.txt",
        status: "untracked",
        staged: false,
        unstaged: true,
        additions: 2,
        deletions: 0,
      },
      {
        path: "README.md",
        status: "modified",
        staged: true,
        unstaged: true,
        additions: 1,
        deletions: 1,
      },
    ],
  );

  const trackedDiff = await service.diff(repository, {
    expectedSnapshot: review.commit.snapshot!,
    path: "README.md",
  });
  assert.match(trackedDiff.patch, /^diff --git/m);
  assert.match(trackedDiff.patch, /^-initial$/m);
  assert.match(trackedDiff.patch, /^\+working$/m);
  const untrackedDiff = await service.diff(repository, {
    expectedSnapshot: review.commit.snapshot!,
    path: "new file.txt",
  });
  assert.match(untrackedDiff.patch, /^--- \/dev\/null$/m);
  assert.match(untrackedDiff.patch, /^\+content$/m);

  await fs.writeFile(path.join(repository, "README.md"), "changed after review\n", "utf8");
  await assert.rejects(
    service.diff(repository, {
      expectedSnapshot: review.commit.snapshot!,
      path: "README.md",
    }),
    (error) => error instanceof GitServiceError && error.code === "stale_snapshot",
  );
});

test("GitService review preserves a nested workspace boundary", async (t) => {
  const repository = await createRepository(t);
  const nested = path.join(repository, "packages", "app");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "index.ts"), "export const value = 1;\n", "utf8");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Add nested workspace"]);
  await fs.writeFile(path.join(nested, "index.ts"), "export const value = 2;\n", "utf8");
  await fs.mkdir(path.join(nested, "packages", "app"), { recursive: true });
  await fs.writeFile(path.join(nested, "packages", "app", "deep.ts"), "export const deep = true;\n", "utf8");
  await fs.writeFile(path.join(repository, "outside.txt"), "outside\n", "utf8");

  const service = new GitService({ cacheTtlMs: 0 });
  const review = await service.review(nested);
  assert.equal(review.commit.allowed, false);
  assert.equal(review.commit.repositoryRoot, false);
  assert.match(review.commit.reason ?? "", /repository root/);
  assert.deepEqual(review.files.map((file) => file.path), ["index.ts", "packages/app/deep.ts"]);
  const diff = await service.diff(nested, {
    expectedSnapshot: review.commit.snapshot!,
    path: "index.ts",
  });
  assert.match(diff.patch, /^\+export const value = 2;$/m);
  await assert.rejects(
    service.diff(nested, {
      expectedSnapshot: review.commit.snapshot!,
      path: "../../outside.txt",
    }),
    /inside the workspace/,
  );
});

test("GitService commits all reviewed changes and refuses a stale content snapshot", async (t) => {
  const repository = await createRepository(t);
  const service = new GitService({ cacheTtlMs: 0 });
  await fs.writeFile(path.join(repository, "README.md"), "reviewed\n", "utf8");
  await fs.writeFile(path.join(repository, "new.txt"), "new\n", "utf8");
  const staleReview = await service.review(repository);
  await fs.writeFile(path.join(repository, "README.md"), "changed after review\n", "utf8");

  await assert.rejects(
    service.commit(repository, {
      expectedSnapshot: staleReview.commit.snapshot!,
      message: "Should not commit",
      mode: "all",
    }),
    (error) => error instanceof GitServiceError && error.code === "stale_snapshot",
  );
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Initial commit");

  const currentReview = await service.review(repository);
  const result = await service.commit(repository, {
    expectedSnapshot: currentReview.commit.snapshot!,
    message: "Commit reviewed changes",
    mode: "all",
  });
  assert.equal(result.branch, "main");
  assert.equal(result.subject, "Commit reviewed changes");
  assert.equal(result.remainingChanges, 0);
  assert.match(result.commit, /^[0-9a-f]{40,64}$/);
  assert.equal(await git(repository, ["status", "--porcelain"]), "");
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Commit reviewed changes");
});

test("GitService detects a working-tree write that races isolated staging", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const wrapper = path.join(root, "git-race-wrapper.mjs");
  const marker = path.join(root, "race-triggered");
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const repository = ${JSON.stringify(repository)};`,
      `const marker = ${JSON.stringify(marker)};`,
      "const args = process.argv.slice(2);",
      "if (args[0] === 'add' && !existsSync(marker)) {",
      "  writeFileSync(marker, 'triggered\\n');",
      "  writeFileSync(`${repository}/README.md`, 'changed during staging\\n');",
      "}",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await fs.writeFile(path.join(repository, "README.md"), "reviewed\n", "utf8");
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper });
  const review = await service.review(repository);

  await assert.rejects(
    service.commit(repository, {
      expectedSnapshot: review.commit.snapshot!,
      message: "Must not commit raced contents",
      mode: "all",
    }),
    (error) => error instanceof GitServiceError && error.code === "stale_snapshot",
  );
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Initial commit");
  assert.equal(await git(repository, ["diff", "--cached", "--name-only"]), "");
  assert.equal(await fs.readFile(path.join(repository, "README.md"), "utf8"), "changed during staging\n");
});

test("GitService staged-only commit preserves unstaged portions", async (t) => {
  const repository = await createRepository(t);
  const service = new GitService({ cacheTtlMs: 0 });
  await fs.writeFile(path.join(repository, "README.md"), "staged version\n", "utf8");
  await git(repository, ["add", "README.md"]);
  await fs.writeFile(path.join(repository, "README.md"), "working version\n", "utf8");
  const review = await service.review(repository);

  const result = await service.commit(repository, {
    expectedSnapshot: review.commit.snapshot!,
    message: "Commit staged version",
    mode: "staged",
  });
  assert.equal(result.remainingChanges, 1);
  assert.equal(await git(repository, ["show", "HEAD:README.md"]), "staged version");
  assert.equal(await fs.readFile(path.join(repository, "README.md"), "utf8"), "working version\n");
});

test("GitService first commit works from an unborn repository", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = path.join(root, "first-commit");
  await fs.mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.email", "aiden@example.test"]);
  await git(repository, ["config", "user.name", "Aiden Test"]);
  await fs.writeFile(path.join(repository, "README.md"), "first\n", "utf8");
  const service = new GitService({ cacheTtlMs: 0 });
  const review = await service.review(repository);
  assert.equal(review.commit.allowed, true);

  const result = await service.commit(repository, {
    expectedSnapshot: review.commit.snapshot!,
    message: "First commit",
    mode: "all",
  });
  assert.equal(result.branch, "main");
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "First commit");
});

test("GitService disables commit when a complete content snapshot exceeds its bound", async (t) => {
  const repository = await createRepository(t);
  await fs.writeFile(path.join(repository, "README.md"), "content exceeds the test snapshot bound\n", "utf8");
  const review = await new GitService({ cacheTtlMs: 0, snapshotMaxBytes: 8 }).review(repository);
  assert.equal(review.commit.allowed, false);
  assert.equal(review.commit.snapshotComplete, false);
  assert.equal(review.commit.snapshot, undefined);
  assert.match(review.commit.reason ?? "", /too large|unsupported path/);
});

test("GitService leaves the real index untouched when a commit hook refuses changes", async (t) => {
  const repository = await createRepository(t);
  await fs.writeFile(path.join(repository, "README.md"), "blocked\n", "utf8");
  const hook = path.join(repository, ".git", "hooks", "pre-commit");
  await fs.writeFile(hook, "#!/bin/sh\necho blocked-by-test >&2\nexit 1\n", { mode: 0o700 });
  const service = new GitService({ cacheTtlMs: 0 });
  const review = await service.review(repository);

  await assert.rejects(
    service.commit(repository, {
      expectedSnapshot: review.commit.snapshot!,
      message: "Blocked commit",
      mode: "all",
    }),
    (error) => {
      assert.equal(error instanceof GitServiceError, true);
      assert.match((error as GitServiceError).message, /left the real Git index unchanged/);
      return true;
    },
  );
  assert.equal(await git(repository, ["diff", "--cached", "--name-only"]), "");
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Initial commit");
});

test("GitService rejects a hook-mutated isolated index without touching the real index", async (t) => {
  const repository = await createRepository(t);
  await fs.writeFile(path.join(repository, "README.md"), "selected\n", "utf8");
  const hook = path.join(repository, ".git", "hooks", "pre-commit");
  await fs.writeFile(hook, "#!/bin/sh\ngit reset -q HEAD -- README.md\n", { mode: 0o700 });
  const service = new GitService({ cacheTtlMs: 0 });
  const review = await service.review(repository);

  await assert.rejects(
    service.commit(repository, {
      expectedSnapshot: review.commit.snapshot!,
      message: "Hook changed selection",
      mode: "all",
    }),
    (error) => error instanceof GitServiceError && error.code === "stale_snapshot",
  );
  assert.equal(await git(repository, ["diff", "--cached", "--name-only"]), "");
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Initial commit");
});

test("GitService reports post-commit hook failure as a successful commit warning", async (t) => {
  const repository = await createRepository(t);
  await fs.writeFile(path.join(repository, "README.md"), "committed\n", "utf8");
  const hook = path.join(repository, ".git", "hooks", "post-commit");
  await fs.writeFile(hook, "#!/bin/sh\necho post-commit-warning >&2\nexit 1\n", { mode: 0o700 });
  const service = new GitService({ cacheTtlMs: 0 });
  const review = await service.review(repository);

  const result = await service.commit(repository, {
    expectedSnapshot: review.commit.snapshot!,
    message: "Commit despite post hook",
    mode: "all",
  });
  assert.match(result.warning ?? "", /post-commit hook/);
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Commit despite post hook");
  assert.equal(await git(repository, ["status", "--porcelain"]), "");
});

test("GitService gives commit hooks the non-editor environment used by git commit -m", async (t) => {
  const repository = await createRepository(t);
  await fs.writeFile(path.join(repository, "README.md"), "noninteractive\n", "utf8");
  const hook = path.join(repository, ".git", "hooks", "pre-commit");
  await fs.writeFile(
    hook,
    "#!/bin/sh\nif [ \"$GIT_EDITOR\" != ':' ]; then echo unexpected-editor >&2; exit 1; fi\n",
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0 });
  const review = await service.review(repository);

  await service.commit(repository, {
    expectedSnapshot: review.commit.snapshot!,
    message: "Noninteractive hooks",
    mode: "all",
  });
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Noninteractive hooks");
});

test("GitService reconciles a timeout after the exact branch ref was updated", async (t) => {
  const repository = await createRepository(t);
  const wrapper = path.join(path.dirname(repository), "git-update-ref-timeout.mjs");
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { spawnSync } from 'node:child_process';",
      "const args = process.argv.slice(2);",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "if (args[0] === 'update-ref' && result.status === 0) setTimeout(() => process.exit(0), 2000);",
      "else process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await fs.writeFile(path.join(repository, "README.md"), "timeout reconciled\n", "utf8");
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper, mutationTimeoutMs: 500 });
  const review = await service.review(repository);

  const result = await service.commit(repository, {
    expectedSnapshot: review.commit.snapshot!,
    message: "Reconciled timeout",
    mode: "all",
  });
  assert.match(result.warning ?? "", /stopped responding/);
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Reconciled timeout");
  assert.equal(await git(repository, ["status", "--porcelain"]), "");
});

test("GitService reports an unknown outcome when ref verification also fails", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const marker = path.join(root, "ref-update-ran");
  const wrapper = path.join(root, "git-unknown-ref-outcome.mjs");
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const marker = ${JSON.stringify(marker)};`,
      "const args = process.argv.slice(2);",
      "if (args[0] === 'show-ref' && existsSync(marker)) process.exit(2);",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "if (args[0] === 'update-ref' && result.status === 0) {",
      "  writeFileSync(marker, 'updated\\n');",
      "  process.exit(2);",
      "}",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await fs.writeFile(path.join(repository, "README.md"), "outcome unknown\n", "utf8");
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper });
  const review = await service.review(repository);

  await assert.rejects(
    service.commit(repository, {
      expectedSnapshot: review.commit.snapshot!,
      message: "Unknown ref outcome",
      mode: "all",
    }),
    (error) => {
      assert.equal(error instanceof GitServiceError, true);
      assert.match((error as Error).message, /could not determine whether the branch was updated/i);
      assert.doesNotMatch((error as Error).message, /No commit was created/);
      return true;
    },
  );
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Unknown ref outcome");
  assert.equal(await git(repository, ["show", ":README.md"]), "initial");
  await assert.rejects(fs.access(path.join(repository, ".git", "index.lock")));
});

test("GitService reconciles an abort after the exact branch ref was updated", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const marker = path.join(root, "update-ref-finished");
  const wrapper = path.join(root, "git-update-ref-abort.mjs");
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const marker = ${JSON.stringify(marker)};`,
      "const args = process.argv.slice(2);",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "if (args[0] === 'update-ref' && result.status === 0) {",
      "  writeFileSync(marker, 'updated\\n');",
      "  setTimeout(() => process.exit(0), 2000);",
      "} else process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await fs.writeFile(path.join(repository, "README.md"), "abort reconciled\n", "utf8");
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper, mutationTimeoutMs: 5_000 });
  const review = await service.review(repository);
  const controller = new AbortController();
  const operation = service.commit(repository, {
    expectedSnapshot: review.commit.snapshot!,
    message: "Reconciled abort",
    mode: "all",
  }, controller.signal);

  let refUpdated = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      await fs.access(marker);
      refUpdated = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.equal(refUpdated, true);
  controller.abort();
  const result = await operation;
  assert.match(result.warning ?? "", /stopped responding/);
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Reconciled abort");
  assert.equal(await git(repository, ["status", "--porcelain"]), "");
});

test("GitService recognizes a candidate in branch ancestry after the ref advances again", async (t) => {
  const repository = await createRepository(t);
  const wrapper = path.join(path.dirname(repository), "git-update-ref-advance.mjs");
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { spawnSync } from 'node:child_process';",
      "const args = process.argv.slice(2);",
      "const run = (nextArgs) => spawnSync('git', nextArgs, { encoding: 'utf8', env: process.env });",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "if (args[0] === 'update-ref' && result.status === 0) {",
      "  const branchRef = args[3];",
      "  const candidate = args[4];",
      "  const tree = run(['rev-parse', `${candidate}^{tree}`]).stdout.trim();",
      "  const advanced = run(['commit-tree', tree, '-p', candidate, '-m', 'Advanced after candidate']).stdout.trim();",
      "  const advancedResult = run(['update-ref', branchRef, advanced, candidate]);",
      "  if (advancedResult.status !== 0) process.exit(advancedResult.status ?? 1);",
      "  setTimeout(() => process.exit(0), 2000);",
      "} else process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await fs.writeFile(path.join(repository, "README.md"), "candidate contents\n", "utf8");
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper, mutationTimeoutMs: 500 });
  const review = await service.review(repository);

  const result = await service.commit(repository, {
    expectedSnapshot: review.commit.snapshot!,
    message: "Candidate commit",
    mode: "all",
  });
  assert.match(result.warning ?? "", /branch moved again/);
  assert.equal(await git(repository, ["merge-base", "--is-ancestor", result.commit, "HEAD"]).then(() => true), true);
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Advanced after candidate");
  assert.equal(await git(repository, ["diff", "--cached", "--name-only"]), "README.md");
});

test("GitService holds the worktree HEAD lock through index finalization", async (t) => {
  const repository = await createRepository(t);
  await git(repository, ["branch", "other"]);
  const root = path.dirname(repository);
  const marker = path.join(root, "head-repoint-result");
  const headLock = path.join(repository, ".git", "HEAD.lock");
  const wrapper = path.join(root, "git-head-repoint-race.mjs");
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const marker = ${JSON.stringify(marker)};`,
      `const headLock = ${JSON.stringify(headLock)};`,
      "const args = process.argv.slice(2);",
      "if (args[0] === 'symbolic-ref' && args[1] === '--quiet' && existsSync(headLock) && !existsSync(marker)) {",
      "  const repoint = spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/other'], { env: process.env, stdio: 'ignore' });",
      "  writeFileSync(marker, String(repoint.status ?? 1));",
      "}",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await fs.writeFile(path.join(repository, "README.md"), "head guarded\n", "utf8");
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper });
  const review = await service.review(repository);

  const result = await service.commit(repository, {
    expectedSnapshot: review.commit.snapshot!,
    message: "Guard HEAD finalization",
    mode: "all",
  });
  assert.equal(await fs.readFile(marker, "utf8").then((value) => Number(value) !== 0), true);
  assert.equal(result.warning, undefined);
  assert.equal(await git(repository, ["branch", "--show-current"]), "main");
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Guard HEAD finalization");
  assert.equal(await git(repository, ["status", "--porcelain"]), "");
  await assert.rejects(fs.access(headLock));
});

test("GitService holds the checked-out branch ref lock through index finalization", async (t) => {
  const repository = await createRepository(t);
  const initialHead = await git(repository, ["rev-parse", "HEAD"]);
  const root = path.dirname(repository);
  const marker = path.join(root, "branch-repoint-result");
  const refLock = path.join(repository, ".git", "refs", "heads", "main.lock");
  const wrapper = path.join(root, "git-branch-repoint-race.mjs");
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const marker = ${JSON.stringify(marker)};`,
      `const refLock = ${JSON.stringify(refLock)};`,
      `const initialHead = ${JSON.stringify(initialHead)};`,
      "const args = process.argv.slice(2);",
      "if (args[0] === 'symbolic-ref' && args[1] === '--quiet' && existsSync(refLock) && !existsSync(marker)) {",
      "  const repoint = spawnSync('git', ['update-ref', 'refs/heads/main', initialHead], { env: process.env, stdio: 'ignore' });",
      "  writeFileSync(marker, String(repoint.status ?? 1));",
      "}",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await fs.writeFile(path.join(repository, "README.md"), "branch ref guarded\n", "utf8");
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper });
  const review = await service.review(repository);

  const result = await service.commit(repository, {
    expectedSnapshot: review.commit.snapshot!,
    message: "Guard branch ref finalization",
    mode: "all",
  });
  assert.equal(await fs.readFile(marker, "utf8").then((value) => Number(value) !== 0), true);
  assert.equal(result.warning, undefined);
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Guard branch ref finalization");
  assert.equal(await git(repository, ["status", "--porcelain"]), "");
  await assert.rejects(fs.access(refLock));
});

test("GitService leaves the remaining-change count unknown when status refresh fails", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const marker = path.join(root, "commit-ref-updated");
  const wrapper = path.join(root, "git-status-failure.mjs");
  await fs.writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const marker = ${JSON.stringify(marker)};`,
      "const args = process.argv.slice(2);",
      "if (args[0] === 'status' && existsSync(marker)) process.exit(1);",
      "const result = spawnSync('git', args, { env: process.env, stdio: 'inherit' });",
      "if (result.error) throw result.error;",
      "if (args[0] === 'update-ref' && result.status === 0) writeFileSync(marker, 'updated\\n');",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await fs.writeFile(path.join(repository, "README.md"), "status unavailable\n", "utf8");
  const service = new GitService({ cacheTtlMs: 0, gitBinary: wrapper });
  const review = await service.review(repository);

  const result = await service.commit(repository, {
    expectedSnapshot: review.commit.snapshot!,
    message: "Unknown remaining count",
    mode: "all",
  });
  assert.equal(result.remainingChanges, undefined);
  assert.match(result.warning ?? "", /remaining-change count/);
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Unknown remaining count");
});

test("GitService commits through the linked worktree's own index", async (t) => {
  const repository = await createRepository(t);
  const linked = path.join(path.dirname(repository), "linked");
  await git(repository, ["worktree", "add", "-b", "linked", linked]);
  await fs.writeFile(path.join(linked, "README.md"), "linked change\n", "utf8");
  const service = new GitService({ cacheTtlMs: 0 });
  const review = await service.review(linked);

  const result = await service.commit(linked, {
    expectedSnapshot: review.commit.snapshot!,
    message: "Commit linked worktree",
    mode: "all",
  });
  assert.equal(result.branch, "linked");
  assert.equal(await git(linked, ["status", "--porcelain"]), "");
  assert.equal(await git(linked, ["log", "-1", "--format=%s"]), "Commit linked worktree");
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Initial commit");
});

test("GitService refuses commit while another process owns the real index lock", async (t) => {
  const repository = await createRepository(t);
  await fs.writeFile(path.join(repository, "README.md"), "locked\n", "utf8");
  const service = new GitService({ cacheTtlMs: 0 });
  const review = await service.review(repository);
  const lockPath = path.join(repository, ".git", "index.lock");
  await fs.writeFile(lockPath, "owned elsewhere", "utf8");
  t.after(() => fs.unlink(lockPath).catch(() => undefined));

  await assert.rejects(
    service.commit(repository, {
      expectedSnapshot: review.commit.snapshot!,
      message: "Must not commit",
      mode: "all",
    }),
    /index is busy/,
  );
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "Initial commit");
});

test("GitService compare-and-swaps HEAD instead of overwriting an external ref update", async (t) => {
  const repository = await createRepository(t);
  await fs.writeFile(path.join(repository, "README.md"), "selected\n", "utf8");
  const hook = path.join(repository, ".git", "hooks", "pre-commit");
  await fs.writeFile(
    hook,
    [
      "#!/bin/sh",
      "parent=$(git rev-parse HEAD)",
      "tree=$(git rev-parse 'HEAD^{tree}')",
      "external=$(git commit-tree \"$tree\" -p \"$parent\" -m 'External commit')",
      "git update-ref refs/heads/main \"$external\" \"$parent\"",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 0 });
  const review = await service.review(repository);

  await assert.rejects(
    service.commit(repository, {
      expectedSnapshot: review.commit.snapshot!,
      message: "Must not replace external commit",
      mode: "all",
    }),
    /No commit was created/,
  );
  assert.equal(await git(repository, ["log", "-1", "--format=%s"]), "External commit");
  assert.equal(await git(repository, ["diff", "--cached", "--name-only"]), "");
});

test("GitService review expands untracked folders into editable files", async (t) => {
  const repository = await createRepository(t);
  await fs.mkdir(path.join(repository, "src"));
  await fs.writeFile(path.join(repository, "src", "new.ts"), "export const added = true;\n", "utf8");

  const service = new GitService({ cacheTtlMs: 0 });
  const review = await service.review(repository);
  assert.deepEqual(review.files.map((file) => file.path), ["src/new.ts"]);
  const diff = await service.diff(repository, {
    expectedSnapshot: review.commit.snapshot!,
    path: "src/new.ts",
  });
  assert.match(diff.patch, /^\+export const added = true;$/m);
});

test("GitService reviews an untracked symlink as the link Git will commit", async (t) => {
  const repository = await createRepository(t);
  const outside = path.join(path.dirname(repository), "outside-target.txt");
  await fs.writeFile(outside, "outside file contents\n", "utf8");
  await fs.symlink(outside, path.join(repository, "linked.txt"));

  const service = new GitService({ cacheTtlMs: 0 });
  const review = await service.review(repository);
  assert.equal(review.files[0]?.additions, 1);
  const diff = await service.diff(repository, {
    expectedSnapshot: review.commit.snapshot!,
    path: "linked.txt",
  });
  assert.match(diff.patch, /new file mode 120000/);
  assert.match(diff.patch, new RegExp(`^\\+${outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.doesNotMatch(diff.patch, /outside file contents/);

  await service.commit(repository, {
    expectedSnapshot: review.commit.snapshot!,
    message: "Add reviewed symlink",
    mode: "all",
  });
  assert.match(await git(repository, ["ls-tree", "HEAD", "linked.txt"]), /^120000 blob /);
  assert.equal(await git(repository, ["show", "HEAD:linked.txt"]), outside);
});

test("GitService reviews untracked regular-file modes, newlines, and literal path characters exactly", async (t) => {
  const repository = await createRepository(t);
  const executablePath = path.join(repository, "tool.sh");
  const backslashName = "back\\slash.txt";
  await fs.writeFile(executablePath, "#!/bin/sh\nprintf ready", "utf8");
  await fs.chmod(executablePath, 0o755);
  await fs.writeFile(path.join(repository, backslashName), "literal path\n", "utf8");
  const service = new GitService({ cacheTtlMs: 0 });

  let review = await service.review(repository);
  let executableDiff = await service.diff(repository, {
    expectedSnapshot: review.commit.snapshot!,
    path: "tool.sh",
  });
  assert.match(executableDiff.patch, /new file mode 100755/);
  assert.match(executableDiff.patch, /\\ No newline at end of file/);
  const literalPathDiff = await service.diff(repository, {
    expectedSnapshot: review.commit.snapshot!,
    path: backslashName,
  });
  assert.match(literalPathDiff.patch, /^diff --git "a\/back\\\\slash\.txt" "b\/back\\\\slash\.txt"$/m);
  assert.doesNotMatch(literalPathDiff.patch, /a\/back\/slash\.txt/);

  await git(repository, ["config", "core.fileMode", "false"]);
  review = await service.review(repository);
  executableDiff = await service.diff(repository, {
    expectedSnapshot: review.commit.snapshot!,
    path: "tool.sh",
  });
  assert.match(executableDiff.patch, /new file mode 100644/);
  await service.commit(repository, {
    expectedSnapshot: review.commit.snapshot!,
    message: "Add reviewed regular files",
    mode: "all",
  });
  assert.match(await git(repository, ["ls-tree", "HEAD", "tool.sh"]), /^100644 blob /);
});

test("GitService review uses final working contents for staged-and-edited files before the first commit", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = path.join(root, "unborn-review");
  await fs.mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(repository, "first.txt"), "staged\n", "utf8");
  await git(repository, ["add", "first.txt"]);
  await fs.writeFile(path.join(repository, "first.txt"), "working\ncopy\n", "utf8");

  const review = await new GitService({ cacheTtlMs: 0 }).review(repository);
  assert.equal(review.branch, "main");
  assert.deepEqual(review.summary, {
    fileCount: 1,
    additions: 2,
    deletions: 0,
    unavailableStats: 0,
    stagedFiles: 1,
    unstagedFiles: 1,
    conflictedFiles: 0,
  });
  assert.equal(review.files[0]?.additions, 2);
});

test("GitService marks an oversized review diff as truncated", async (t) => {
  const repository = await createRepository(t);
  await fs.writeFile(path.join(repository, "README.md"), `${"changed line\n".repeat(300)}`, "utf8");
  const service = new GitService({ cacheTtlMs: 0, maxBufferBytes: 700 });
  const review = await service.review(repository);
  const diff = await service.diff(repository, {
    expectedSnapshot: review.commit.snapshot!,
    path: "README.md",
  });
  assert.equal(diff.truncated, true);
  assert.match(diff.patch, /^diff --git/m);
});

test("GitService serializes mutations by common directory", async (t) => {
  const repository = await createRepository(t);
  const service = new GitService({ cacheTtlMs: 0 });

  await Promise.all([
    service.createBranch(repository, "feature/first"),
    service.createBranch(repository, "feature/second"),
  ]);

  const refs = (await git(repository, ["for-each-ref", "--format=%(refname:short)", "refs/heads/feature"])).split(
    "\n",
  );
  assert.deepEqual(refs.sort(), ["feature/first", "feature/second"]);

  await assert.rejects(service.createBranch(repository, "feature/first"));
  await service.createBranch(repository, "feature/after-failure");
  assert.equal(await git(repository, ["branch", "--show-current"]), "feature/after-failure");
});

test("GitService creates, lists, and removes managed worktrees", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const service = new GitService({ cacheTtlMs: 0 });

  const created = await service.createWorktree(repository, root, "codex/isolated");
  assert.equal(created.branch, "codex/isolated");
  assert.equal(created.current, true);
  assert.equal(path.relative(await fs.realpath(root), created.path).startsWith(".."), false);
  assert.equal((await fs.stat(created.path)).isDirectory(), true);
  assert.equal(await git(repository, ["branch", "--show-current"]), "main");

  const worktrees = await service.worktrees(repository);
  assert.equal(worktrees.length, 2);
  assert.equal(worktrees.some((worktree) => worktree.branch === "codex/isolated"), true);
  await assert.rejects(
    service.createWorktree(repository, root, "codex/isolated"),
    (error) => error instanceof GitServiceError && error.code === "invalid_ref",
  );

  await fs.writeFile(path.join(created.path, "dirty.txt"), "dirty\n", "utf8");
  await assert.rejects(
    service.deleteManagedWorktree(repository, created.path, created.branch, created.createdFromHead),
    (error) => error instanceof GitServiceError && error.code === "dirty_worktree",
  );
  await fs.rm(path.join(created.path, "dirty.txt"));

  const deleted = await service.deleteManagedWorktree(
    repository,
    created.path,
    created.branch,
    created.createdFromHead,
  );
  assert.equal(deleted.branchDeleted, true);
  await assert.rejects(fs.access(created.path));
  assert.equal((await service.worktrees(repository)).length, 1);
});

test("GitService bounds subprocess time and output", async (t) => {
  const root = await temporaryDirectory(t);
  const slowGit = path.join(root, "slow-git");
  const childPidFile = path.join(root, "child.pid");
  await fs.writeFile(slowGit, `#!/bin/sh\nsleep 30 &\necho $! > '${childPidFile}'\nwait\n`, {
    encoding: "utf8",
    mode: 0o700,
  });
  const slowService = new GitService({ gitBinary: slowGit, readTimeoutMs: 250 });
  await assert.rejects(
    slowService.info(root),
    (error) => error instanceof GitServiceError && error.code === "timeout",
  );
  const childPid = Number((await fs.readFile(childPidFile, "utf8")).trim());
  let childAlive = true;
  for (let attempt = 0; attempt < 10 && childAlive; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
  }
  assert.equal(childAlive, false, "timeout should terminate descendants in Git's process group");

  const repository = await createRepository(t);
  for (let index = 0; index < 20; index += 1) {
    await git(repository, ["branch", `long-branch-name-${index.toString().padStart(2, "0")}`]);
  }
  const boundedService = new GitService({ cacheTtlMs: 0, maxBufferBytes: 160 });
  await assert.rejects(
    boundedService.branches(repository),
    (error) => error instanceof GitServiceError && error.code === "output_limit",
  );
});

test("GitService preserves nested workspace scope in managed worktrees", async (t) => {
  const repository = await createRepository(t);
  const nested = path.join(repository, "packages", "app");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "index.ts"), "export {};\n", "utf8");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Add nested workspace"]);
  const root = await temporaryDirectory(t);
  const service = new GitService({ cacheTtlMs: 0 });

  const created = await service.createWorktree(nested, root, "codex/nested");
  assert.equal(created.workspacePath, path.join(created.path, "packages", "app"));
  assert.equal((await fs.stat(created.workspacePath)).isDirectory(), true);
  await service.rollbackWorktree(nested, created);
});

test("GitService serializes mutations across linked worktree paths", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const service = new GitService({ cacheTtlMs: 0 });
  const created = await service.createWorktree(repository, root, "codex/linked");

  await Promise.all([
    service.createBranch(repository, "feature/from-main"),
    service.createBranch(created.path, "feature/from-linked"),
  ]);
  const refs = await git(repository, ["for-each-ref", "--format=%(refname:short)", "refs/heads/feature"]);
  assert.deepEqual(refs.split("\n").sort(), ["feature/from-linked", "feature/from-main"]);
});

test("GitService retries a read that crosses a mutation epoch", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const wrapper = path.join(root, "delayed-git");
  const started = path.join(root, "status-started");
  const snapshot = path.join(root, "status-snapshot");
  await fs.writeFile(
    wrapper,
    `#!/bin/sh\nif [ "$1" = "status" ] && [ ! -f '${started}' ]; then\n  /usr/bin/git "$@" > '${snapshot}' || exit $?\n  touch '${started}'\n  sleep 1\n  cat '${snapshot}'\n  exit 0\nfi\nexec /usr/bin/git "$@"\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  const service = new GitService({ cacheTtlMs: 5_000, gitBinary: wrapper, readTimeoutMs: 10_000 });
  const pendingInfo = service.info(repository);
  let statusStarted = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await fs.access(started);
      statusStarted = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.equal(statusStarted, true, "the delayed status read should start before the mutation");
  await service.createBranch(repository, "feature/during-read");
  assert.equal((await pendingInfo).branch, "feature/during-read");
  assert.equal((await service.info(repository)).branch, "feature/during-read");
});

test("GitService rolls back a worktree when add times out after Git created it", async (t) => {
  const repository = await createRepository(t);
  const root = await temporaryDirectory(t);
  const wrapper = path.join(root, "git-wrapper");
  await fs.writeFile(
    wrapper,
    '#!/bin/sh\nif [ "$1" = "worktree" ] && [ "$2" = "add" ]; then\n  /usr/bin/git "$@" || exit $?\n  sleep 30\n  exit 0\nfi\nexec /usr/bin/git "$@"\n',
    { encoding: "utf8", mode: 0o700 },
  );
  const service = new GitService({ gitBinary: wrapper, mutationTimeoutMs: 100, readTimeoutMs: 2_000 });
  await assert.rejects(
    service.createWorktree(repository, root, "codex/timeout"),
    (error) => error instanceof GitServiceError && error.code === "timeout",
  );
  assert.equal((await service.worktrees(repository)).length, 1);
  await assert.rejects(git(repository, ["show-ref", "--verify", "refs/heads/codex/timeout"]));
});

test("GitService rejects branch/worktree creation in an unborn repository", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = path.join(root, "unborn");
  await fs.mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  const service = new GitService({ cacheTtlMs: 0 });
  const info = await service.info(repository);
  assert.equal(info.unborn, true);
  assert.equal(info.branch, "main");
  assert.deepEqual((await service.branches(repository)).branches, ["main"]);
  await assert.rejects(
    service.createBranch(repository, "feature/no-head"),
    (error) => error instanceof GitServiceError && error.code === "unborn",
  );
  await assert.rejects(
    service.createWorktree(repository, path.join(root, "worktrees"), "feature/no-head"),
    (error) => error instanceof GitServiceError && error.code === "unborn",
  );
});

test("GitService strips inherited repository-routing environment variables", async (t) => {
  const repository = await createRepository(t);
  const other = await createRepository(t);
  const previousGitDir = process.env.GIT_DIR;
  const previousWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = path.join(other, ".git");
  process.env.GIT_WORK_TREE = other;
  try {
    const info = await new GitService({ cacheTtlMs: 0 }).info(repository);
    assert.equal(info.isRepo, true);
    assert.equal(info.branch, "main");
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
    if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousWorkTree;
  }
});

test("GitService strips inherited command config before installing its reviewed pre-push proxy", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  const inheritedHooks = path.join(root, "inherited-hooks");
  const hookLog = path.join(root, "reviewed-hook-args");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await fs.mkdir(inheritedHooks);
  await fs.writeFile(
    path.join(inheritedHooks, "pre-push"),
    "#!/bin/sh\necho inherited-hook-ran >&2\nexit 77\n",
    { mode: 0o700 },
  );
  await fs.writeFile(
    path.join(repository, ".git", "hooks", "pre-push"),
    `#!/bin/sh\nprintf '%s\\n%s\\n' "$1" "$2" > ${JSON.stringify(hookLog)}\n`,
    { mode: 0o700 },
  );
  const previousParameters = process.env.GIT_CONFIG_PARAMETERS;
  process.env.GIT_CONFIG_PARAMETERS = `'core.hooksPath=${inheritedHooks}'`;
  try {
    const service = new GitService({ cacheTtlMs: 0 });
    const capability = await service.pushCapability(repository);
    await service.push(repository, {
      destinationBranch: "main",
      expectedBranch: capability.branch!,
      expectedHead: capability.expectedHead!,
      expectedRemoteIdentity: capability.remoteIdentities.origin!,
      remote: "origin",
      setUpstream: false,
    });
  } finally {
    if (previousParameters === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = previousParameters;
  }
  assert.deepEqual((await fs.readFile(hookLog, "utf8")).trim().split("\n"), ["origin", remote]);
});

test("GitService preserves native failure semantics for an executable hook path that is a directory", async (t) => {
  const repository = await createRepository(t);
  const root = path.dirname(repository);
  const remote = path.join(root, "remote.git");
  await fs.mkdir(remote);
  await git(remote, ["init", "--bare", "--initial-branch=main"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await fs.mkdir(path.join(repository, ".git", "hooks", "pre-push"));
  const service = new GitService({ cacheTtlMs: 0 });
  const capability = await service.pushCapability(repository);
  await assert.rejects(
    service.push(repository, {
      destinationBranch: "main",
      expectedBranch: capability.branch!,
      expectedHead: capability.expectedHead!,
      expectedRemoteIdentity: capability.remoteIdentities.origin!,
      remote: "origin",
      setUpstream: false,
    }),
    (error) => error instanceof GitServiceError && error.code === "command_failed",
  );
  await assert.rejects(git(remote, ["rev-parse", "refs/heads/main"]));
});

test("GitService redacts credentials from command failures", async (t) => {
  const root = await temporaryDirectory(t);
  const failingGit = path.join(root, "failing-git");
  await fs.writeFile(
    failingGit,
    "#!/bin/sh\necho \"fatal: unable to access 'https://secret-token@example.test/repo?access_token=also-secret'\" >&2\nexit 1\n",
    { encoding: "utf8", mode: 0o700 },
  );
  const service = new GitService({ gitBinary: failingGit });
  await assert.rejects(service.info(root), (error) => {
    assert.equal(error instanceof GitServiceError, true);
    assert.equal((error as GitServiceError).message.includes("secret-token"), false);
    assert.equal((error as GitServiceError).message.includes("also-secret"), false);
    assert.equal((error as GitServiceError).message.includes("***"), true);
    return true;
  });
});

test("GitService fails soft for non-repositories", async (t) => {
  const directory = await temporaryDirectory(t);
  assert.deepEqual(await new GitService().info(directory), { isRepo: false });
});
