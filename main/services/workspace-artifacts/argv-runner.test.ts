import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  parseWorkspaceArtifactActions,
  resolveWorkspaceArtifactCommand,
  type ResolvedWorkspaceArtifactCommand,
  type WorkspaceArtifactActionV1,
  type WorkspaceArtifactArgvStep,
} from "../../../renderer/shared/workspace-artifacts.js";
import { findProgramOnPath, runArgvPlan, type ArgvPlanOptions } from "./argv-runner.js";

const step = (connector: WorkspaceArtifactArgvStep["connector"], ...pipeline: (string[] | [string[], WorkspaceArtifactArgvStep["pipeline"][number]["redirects"]])[]) => ({
  connector,
  pipeline: pipeline.map((command) => (Array.isArray(command[0]) ? { argv: command[0] as string[], redirects: command[1] as WorkspaceArtifactArgvStep["pipeline"][number]["redirects"] } : { argv: command as string[], redirects: [] })),
});

function plan(steps: WorkspaceArtifactArgvStep[], overrides: Partial<ArgvPlanOptions> = {}) {
  return runArgvPlan({ steps, cwd: os.tmpdir(), env: process.env, timeoutMs: 10_000, maxOutputBytes: 1_000_000, ...overrides });
}

/** Runs what an action resolved to as the runner would: argument lists without a shell. */
async function runResolved(resolved: ResolvedWorkspaceArtifactCommand, cwd: string, env: NodeJS.ProcessEnv = {}) {
  assert.equal(resolved.kind, "argv", "a template with page data runs without a shell");
  if (resolved.kind !== "argv") throw new Error("unreachable");
  return runArgvPlan({ steps: resolved.steps, cwd, env: { ...process.env, ...env }, timeoutMs: 10_000, maxOutputBytes: 1_000_000 });
}

test("a pipeline connects each command's output to the next one's input", async () => {
  const result = await plan([step(";", ["printf", "b\na\nb\n"], ["sort"], ["uniq", "-c"], ["tr", "-s", " "])]);
  assert.deepEqual({ stdout: result.stdout, exitCode: result.exitCode }, { stdout: " 1 a\n 2 b\n", exitCode: 0 });
  // The pipeline's status is its last command's, and the first command reads nothing.
  assert.equal((await plan([step(";", ["false"], ["true"])])).exitCode, 0);
  assert.equal((await plan([step(";", ["true"], ["false"])])).exitCode, 1);
  assert.equal((await plan([step(";", ["cat"], ["wc", "-c"])])).stdout.trim(), "0");
});

test("; && and || run the next pipeline by the last status, as a shell does", async () => {
  const run = async (...steps: WorkspaceArtifactArgvStep[]) => {
    const result = await plan(steps);
    return { stdout: result.stdout, exitCode: result.exitCode };
  };
  assert.deepEqual(await run(step(";", ["false"]), step(";", ["printf", "a"])), { stdout: "a", exitCode: 0 });
  assert.deepEqual(await run(step(";", ["false"]), step("&&", ["printf", "a"])), { stdout: "", exitCode: 1 });
  assert.deepEqual(await run(step(";", ["true"]), step("&&", ["printf", "a"])), { stdout: "a", exitCode: 0 });
  assert.deepEqual(await run(step(";", ["false"]), step("||", ["printf", "b"])), { stdout: "b", exitCode: 0 });
  assert.deepEqual(await run(step(";", ["true"]), step("||", ["printf", "b"])), { stdout: "", exitCode: 0 });
  // A skipped command keeps the status: false && x || y runs y.
  assert.deepEqual(await run(step(";", ["false"]), step("&&", ["printf", "x"]), step("||", ["printf", "y"])), { stdout: "y", exitCode: 0 });
});

test("the three redirections send output where a shell would", async () => {
  const both = ["sh", "-c", "printf out; printf err >&2", "sh"];
  const run = async (redirects: WorkspaceArtifactArgvStep["pipeline"][number]["redirects"], next?: string[]) => {
    const result = await plan([step(";", [both, redirects], ...(next ? [next] : []))]);
    return { stdout: result.stdout, stderr: result.stderr };
  };
  assert.deepEqual(await run([]), { stdout: "out", stderr: "err" });
  assert.deepEqual(await run([">/dev/null"]), { stdout: "", stderr: "err" });
  assert.deepEqual(await run(["2>/dev/null"]), { stdout: "out", stderr: "" });
  // Applied left to right: 2>&1 >/dev/null keeps stderr on the old stdout.
  assert.deepEqual(await run([">/dev/null", "2>&1"]), { stdout: "", stderr: "" });
  assert.equal((await run(["2>&1", ">/dev/null"])).stdout, "err");
  // Into a pipe, 2>&1 sends both streams to the next command.
  assert.equal((await run(["2>&1"], ["wc", "-c"])).stderr, "");
  assert.equal((await run(["2>&1"], ["wc", "-c"])).stdout.trim(), "6");
  assert.equal((await run([], ["wc", "-c"])).stdout.trim(), "3");
});

test("a program is looked up only in absolute PATH entries; a missing one fails with 127 and runs nothing of its pipeline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-argv-path-"));
  try {
    fs.mkdirSync(path.join(dir, "bin"));
    const marker = path.join(dir, "ran");
    fs.writeFileSync(path.join(dir, "bin", "git"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    // A relative entry, read against the workspace, is skipped.
    const env = { ...process.env, PATH: `bin${path.delimiter}${process.env.PATH ?? ""}` };
    assert.notEqual(await findProgramOnPath("git", env), path.join(dir, "bin", "git"));
    assert.equal(await findProgramOnPath("git", { PATH: "bin" }), undefined);
    const result = await plan([step(";", ["git", "--version"])], { cwd: dir, env: { PATH: "bin" } });
    assert.equal(result.exitCode, 127);
    assert.match(result.stderr, /git: command not found/u);
    assert.equal(fs.existsSync(marker), false);
    const missing = await plan([step(";", ["touch", marker], ["no-such-program-aiden"]), step("||", ["printf", "fallback"])], { cwd: dir });
    assert.deepEqual({ stdout: missing.stdout, exitCode: missing.exitCode }, { stdout: "fallback", exitCode: 0 });
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a command killed by a signal reports 128 plus the signal number", async () => {
  const result = await plan([step(";", ["sh", "-c", "kill -TERM $$"])]);
  assert.equal(result.exitCode, 128 + os.constants.signals.SIGTERM);
});

test("the output cap, the deadline and cancelling stop every command and leave nothing running", async () => {
  const capped = await plan([step(";", ["yes"], ["cat"])], { maxOutputBytes: 1000 });
  assert.equal(capped.outputLimitExceeded, true);
  assert.equal(capped.exitCode, null);
  assert.ok(capped.stdout.length <= 1000);

  const started = Date.now();
  const late = await plan([step(";", ["sleep", "30"]), step(";", ["printf", "after"])], { timeoutMs: 200 });
  assert.equal(late.timedOut, true);
  assert.equal(late.exitCode, null);
  assert.equal(late.stdout, "", "nothing after the deadline runs");
  assert.ok(Date.now() - started < 5_000);

  const controller = new AbortController();
  const running = plan([step(";", ["sleep", "30"], ["cat"])], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const cancelled = await running;
  assert.equal(cancelled.aborted, true);
  assert.equal(cancelled.exitCode, null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-argv-abort-"));
  try {
    const before = new AbortController();
    before.abort();
    const skipped = await plan([step(";", ["touch", path.join(dir, "ran")])], { signal: before.signal });
    assert.equal(skipped.aborted, true);
    assert.deepEqual(fs.readdirSync(dir), [], "a run cancelled before it starts runs nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a workspace file reached through a symbolic link that leaves the folder is not read", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-argv-links-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret\n");
  fs.writeFileSync(path.join(workspace, "notes", "today.md"), "inside\n");
  fs.symlinkSync(outside, path.join(workspace, "away"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "secret-link.txt"));
  fs.symlinkSync(path.join(workspace, "notes"), path.join(workspace, "notes-link"));
  const action = (command: string): WorkspaceArtifactActionV1 => parseWorkspaceArtifactActions([{ name: "a", label: "A", command, params: [{ name: "file" }] }])[0]!;
  const read = (command: string, value: string) => runResolved(resolveWorkspaceArtifactCommand(action(command), [value]), workspace);
  // Each value is relative and stays inside as text, so only its real path gives it away.
  for (const value of ["away/secret.txt", "secret-link.txt", "away/missing.txt", "away/../away/secret.txt", "notes-link/../away/secret.txt"]) {
    for (const command of ["cat {{file}}", "grep -c secret {{file}}", "head -n 1 {{file}} || echo fallback", "test -e {{file}} && echo 1"]) {
      const result = await read(command, value);
      assert.doesNotMatch(result.stdout, /top secret|^1$/mu, `${command} with ${value}`);
      assert.match(result.stderr, /leads outside the workspace through a symbolic link, so it was not run/u, `${command} with ${value}`);
    }
  }
  // The refused command never ran; the rest of the template follows its status as a shell would.
  assert.equal((await read("head -n 1 {{file}} || echo fallback", "away/secret.txt")).stdout, "fallback\n");
  // A link that stays inside the folder, and a file that does not exist yet, still work.
  assert.equal((await read("cat {{file}}", "notes-link/today.md")).stdout, "inside\n");
  assert.equal((await read("cat {{file}}", "notes/today.md")).stdout, "inside\n");
  assert.match((await read("cat {{file}}", "notes/new.md")).stderr, /No such file/u);
});

test("everyday templates do what their preview would do in a shell", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-argv-preview-"));
  try {
    fs.writeFileSync(path.join(dir, "notes.txt"), "b\na\nb\nmain\n");
    const cases: [string, string[]][] = [
      ["printf '%s\\n' {{x}} | sort | uniq -c", ["a b", "$(id)", "x;y"]],
      ["grep -F -- {{x}} notes.txt | wc -l", ["b", "main", "nope", "*"]],
      ["grep -qF -- {{x}} notes.txt && printf 'has %s' {{x}} || printf 'no %s' {{x}}", ["main", "nope"]],
      ["sort notes.txt | uniq -c | grep -F -- {{x}} 2>&1", ["b", "zz"]],
      ["printf '%s' {{x}} >/dev/null; printf done", ["a"]],
      ["cat notes.txt missing-{{x}} 2>&1 | wc -l", ["file"]],
      ["test {{x}} = main && printf yes; printf ' end'", ["main", "other"]],
      ["printf '%s|' HEAD:{{x}} {{x}}.md \\\n  'a b'", ["main", "a b"]],
    ];
    for (const [command, values] of cases) {
      const action = parseWorkspaceArtifactActions([{ name: "a", label: "A", command, params: [{ name: "x" }] }])[0]!;
      for (const value of values) {
        const resolved = resolveWorkspaceArtifactCommand(action, [value]);
        const ran = await runResolved(resolved, dir);
        const shell = spawnSync("/bin/sh", ["-c", resolved.preview], { cwd: dir, encoding: "utf8" });
        assert.deepEqual({ stdout: ran.stdout, exitCode: ran.exitCode }, { stdout: shell.stdout, exitCode: shell.status }, `${command} with ${value}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no template the parser accepts lets a text value run code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-artifact-oracle-"));
  const marker = path.join(dir, "ran");
  const script = path.join(dir, "run-me");
  fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const scriptJs = path.join(dir, "e.js");
  fs.writeFileSync(scriptJs, `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`);
  // Each value runs code if something reads it as shell, a program to start,
  // an awk program, a sed script, Python, JavaScript, a git alias, make's
  // shell, an expect or lldb command, or is the file a redirection writes.
  const values = [
    `touch ${marker}`,
    `exec touch ${marker}`,
    `platform shell touch ${marker}`,
    scriptJs,
    marker,
    `a[$(touch ${marker})0]`,
    script,
    `BEGIN { system("touch ${marker}") }`,
    `1e touch ${marker}`,
    `__import__("os").system("touch ${marker}")`,
    `alias.probe=!touch ${marker}`,
    `SHELL=${script}`,
    `core.sshCommand=${script}`,
    `core.pager=${script}`,
    `!${script}`,
  ];
  spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "notes.txt"), "notes\n");
  fs.writeFileSync(path.join(dir, "Makefile"), "all:\n\t@true\n");
  const candidates = [
    "[[ {{x}} -gt 0 ]]",
    "(( {{x}} > 0 ))",
    "(( 0 < {{x}} ))",
    "(( 0 >> {{x}} ))",
    "let {{x}}",
    "seed=1 let {{x}}",
    "if true; then let {{x}}; fi",
    "f() { local {{x}}; }; f",
    "declare -i n; n=1; declare {{x}}",
    "read {{x}} </dev/null",
    "printf -v {{x}} %s ok",
    "[ -v {{x}} ]",
    "eval echo {{x}}",
    'eval "${HOME}" {{x}}',
    "eval ';' {{x}}",
    "FOO='two words' eval {{x}}",
    ">/dev/null eval {{x}}",
    "eval 2>&1 {{x}}",
    "# a comment\neval {{x}}",
    "# a comment\n{{x}}",
    "ev\\\nal {{x}}",
    "/usr/bin/env {{x}}",
    "nohup {{x}} >/dev/null",
    "find . -maxdepth 0 -exec {{x}} \\;",
    "sh {{x}}",
    "sh -c {{x}}",
    "awk {{x}} </dev/null",
    "sed {{x}} </dev/null",
    "python3 -c {{x}}",
    "git -c {{x}} probe",
    "git --git-dir .git -c {{x}} probe",
    "git --shallow-file shallow -c {{x}} probe",
    "printf '%s' {{x}} # [[ later",
    "[ {{x}} -gt 0 ]",
    "test {{x}} -eq 1",
    "printf '%s' {{x}}",
    "sh -c 'printf %s \"$1\"' sh {{x}}",
    "awk '{ print }' {{x}}",
    "sed -n 1p {{x}}",
    "printf -v out %s {{x}}",
    // Options whose value names a program to start: git's transport helpers,
    // rsync's remote shell, tar's compressor, zip's tester, scp's ssh, man's pager.
    "git ls-remote --upload-pack {{x}} .",
    "git fetch --upload-pack {{x}} .",
    "git clone -u {{x}} . copy",
    "git -C . ls-remote --upload-pack {{x}} .",
    "git archive --remote . --exec {{x}} HEAD",
    "rsync -e {{x}} notes.txt localhost:copy",
    "rsync --rsh {{x}} notes.txt localhost:copy",
    "tar --use-compress-program {{x}} -cf notes.tar notes.txt",
    "zip -T -TT {{x}} notes.zip notes.txt",
    "scp -S {{x}} notes.txt localhost:copy",
    "man -P {{x}} ls",
    // Abbreviated long options, and git's options and config keys that start a program.
    "git ls-remote --upload-p {{x}} .",
    "git fetch --upload {{x}} .",
    "git clone -c {{x}} ssh://localhost/repo copy",
    "git clone --config {{x}} ssh://localhost/repo copy",
    "git config core.sshCommand {{x}} && git ls-remote ssh://localhost/repo",
    "git config alias.probe {{x}} && git probe",
    "tar --use-compress {{x}} -cf notes.tar notes.txt",
    "script -q /dev/null {{x}}",
    "hash -p {{x}} ls; ls",
    // make reads NAME=value arguments as variables, SHELL among them.
    "make {{x}}",
    "make all {{x}}",
    // Joined to an option or a variable, the value still names the program.
    "git ls-remote --upload-pack={{x}} .",
    "tar --use-compress-program={{x}} -cf notes.tar notes.txt",
    "GIT_SSH_COMMAND={{x}} git ls-remote localhost:repo",
    // Joined after plain text, the value is only ever part of one argument.
    "git log -1 HEAD:{{x}}",
    "printf '%s' refs/heads/{{x}}.lock",
    // Programs that read the value as code from their input, a file, a list
    // or a later command, and options no per-option list foresaw.
    "echo {{x}} | sh",
    "printf '%s\\n' {{x}} | bash",
    'set -- {{x}}; "$@"',
    "for f in {{x}}; do $f; done",
    "echo {{x}} > a.sh; sh a.sh",
    "sh <<< {{x}}",
    "bash <<<{{x}}",
    "echo hi >> {{x}}",
    "alias l={{x}}\nl",
    "git filter-branch -f --tree-filter {{x}} HEAD",
    "git filter-branch -f --msg-filter {{x}} HEAD",
    "git filter-branch -f --env-filter {{x}} HEAD",
    "git rebase --exe {{x}} HEAD",
    "sed -n {{x}} notes.txt",
    "node -C dev {{x}}",
    "node --title t {{x}}",
    "bash --rcfile notes.txt {{x}}",
    "bash -c -- {{x}}",
    "sh -c -e {{x}}",
    "bash -c +x {{x}}",
    "sh -c -o errexit {{x}}",
    "ssh-agent {{x}}",
    "printf -v y %s {{x}}; echo $((y))",
    "printf %s {{x}}; echo $_",
    // Shell syntax the grammar refuses, which once hid a command from the check.
    "echo {{x}} | ((sh) )",
    "echo {{x}} | $((sh) )",
    "echo {{x}} [[ | sh ]]",
    "[[ a ]] ; echo {{x}}; [[ b ]]; sh -c 'touch PWNED'",
    // The commands the allowlist keeps, so the oracle runs accepted templates too.
    "git show HEAD:{{x}}",
    "git checkout {{x}}",
    "git log --oneline -n 5 -- {{x}}",
    "git branch --list {{x}}",
    "grep -F -- {{x}} notes.txt",
    "echo {{x}} | sort | uniq -c",
    "git status --short && git log -1 {{x}} 2>&1 | head -n 1",
    "test {{x}} = main || printf '%s\\n' {{x}}",
  ];
  let accepted = 0;
  try {
    for (const template of candidates) {
      let action: WorkspaceArtifactActionV1;
      try {
        action = parseWorkspaceArtifactActions([{ name: "a", label: "A", command: template, params: [{ name: "x", type: "string" }] }])[0]!;
      } catch {
        continue;
      }
      accepted += 1;
      for (const value of values) {
        let resolved: ReturnType<typeof resolveWorkspaceArtifactCommand>;
        try {
          resolved = resolveWorkspaceArtifactCommand(action, [value]);
        } catch {
          continue; // A value its slot refuses never runs.
        }
        await runResolved(resolved, dir, {
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          FILTER_BRANCH_SQUELCH_WARNING: "1",
        });
        assert.equal(fs.existsSync(marker), false, `${template} ran ${value}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(accepted >= 6, "the oracle should exercise accepted templates too");
});

test("everyday git and gh actions with page data still save and run with the confirmed values", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-artifact-allowed-"));
  const repo = path.join(dir, "repo");
  const origin = path.join(dir, "origin.git");
  const bin = path.join(dir, "bin");
  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
  try {
    fs.mkdirSync(repo);
    fs.mkdirSync(bin);
    // gh is a stand-in that prints the arguments it was given.
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nprintf '[%s]' \"$@\"\n", { mode: 0o755 });
    git(["init", "-q", "--bare", origin], dir);
    git(["init", "-q"]);
    fs.writeFileSync(path.join(repo, "notes.txt"), "notes\n");
    git(["add", "notes.txt"]);
    git(["-c", "user.email=a@example.com", "-c", "user.name=a", "commit", "-q", "-m", "add notes"]);
    git(["branch", "feature"]);
    git(["remote", "add", "origin", origin]);
    const run = async (command: string, params: WorkspaceArtifactActionV1["params"], values: unknown[]) => {
      const action = parseWorkspaceArtifactActions([{ name: "a", label: "A", command, params }])[0]!;
      const result = await runResolved(resolveWorkspaceArtifactCommand(action, values), repo, {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        GIT_TERMINAL_PROMPT: "0",
      });
      assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
      return result.stdout;
    };
    const text = (name: string) => ({ name, type: "string" as const });
    const number = (name: string) => ({ name, type: "number" as const });
    assert.equal(await run("git show HEAD:{{file}}", [text("file")], ["notes.txt"]), "notes\n");
    assert.match(await run("git log --oneline -n 5 -- {{file}}", [text("file")], ["notes.txt"]), /add notes/u);
    await run("git checkout -q {{branch}}", [text("branch")], ["feature"]);
    assert.equal(git(["branch", "--show-current"]).trim(), "feature");
    // Pipes and && between the commands, as a shell would run them.
    assert.equal(await run("git log --oneline -- {{file}} | wc -l | tr -d ' '", [text("file")], ["notes.txt"]), "1\n");
    assert.equal(
      await run("git rev-parse --verify -q {{branch}} >/dev/null && printf '%s\\n' {{branch}} exists", [text("branch")], ["feature"]),
      "feature\nexists\n",
    );
    assert.equal(await run("git rev-parse --verify -q {{branch}} >/dev/null || printf 'no %s' {{branch}}", [text("branch")], ["nope"]), "no nope");
    await run("git push -q origin HEAD:{{branch}}", [text("branch")], ["review"]);
    assert.equal(git(["rev-parse", "refs/heads/review"], origin), git(["rev-parse", "HEAD"]));
    assert.equal(await run("gh pr merge {{n}} --squash", [number("n")], [7]), "[pr][merge][7][--squash]");
    assert.equal(
      await run("gh issue comment {{n}} --body {{body}}", [number("n"), text("body")], [7, "Looks good; $(id)"]),
      "[issue][comment][7][--body][Looks good; $(id)]",
    );
    // A value that starts with "-" reaches the program as the option's value, not as an option.
    assert.equal(await run("gh pr create --title {{t}} --body {{b}}", [text("t"), text("b")], ["--web", "- item"]), "[pr][create][--title][--web][--body][- item]");
    assert.equal(await run("grep -c -e {{q}} notes.txt || true", [text("q")], ["-v"]), "0\n");
    git(["config", "user.email", "a@example.com"]);
    git(["config", "user.name", "a"]);
    await run("git commit -q --allow-empty -m {{m}}", [text("m")], ["--amend"]);
    assert.equal(git(["log", "-1", "--format=%s"]).trim(), "--amend");
    assert.equal(git(["rev-list", "--count", "HEAD"]).trim(), "2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("a branch value pushes only the branch it names, never a glob or a full ref of the page's choosing", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-artifact-push-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  const origin = path.join(dir, "origin.git");
  const git = (args: string[], cwd = repo) => execFileSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=a", ...args], { cwd, encoding: "utf8" });
  fs.mkdirSync(repo);
  git(["init", "-q", "--bare", "-b", "main", origin], dir);
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "one"]);
  git(["commit", "-q", "--allow-empty", "-m", "two"]);
  git(["remote", "add", "origin", origin]);
  git(["push", "-q", "origin", "main"]);
  // The page's own main is behind the remote's, and two branches and a tag were never pushed.
  git(["reset", "-q", "--hard", "HEAD~1"]);
  git(["branch", "feature"]);
  git(["branch", "private-wip"]);
  git(["tag", "v-internal"]);
  const remoteRefs = () => git(["for-each-ref", "--format=%(refname) %(objectname)"], origin).trim().split("\n").sort();
  const before = remoteRefs();
  const push = (command: string, value: string) => {
    const action = parseWorkspaceArtifactActions([{ name: "a", label: "A", command, params: [{ name: "branch" }] }])[0]!;
    return runResolved(resolveWorkspaceArtifactCommand(action, [value]), repo, { GIT_TERMINAL_PROMPT: "0" });
  };
  for (const command of ["git push origin {{branch}}", "git push --force origin {{branch}}", "git push -q origin HEAD:{{branch}}"]) {
    for (const value of ["refs/heads/*", "refs/tags/*", "*", "refs/heads/main", "refs/tags/v-internal", "@", ".", "main^", "feature..main", "fe ature"]) {
      assert.throws(() => push(command, value), /branch must be a branch or tag name there/u, `${command} with ${value}`);
    }
  }
  assert.deepEqual(remoteRefs(), before, "nothing reached the remote");
  const pushed = await push("git push --force origin {{branch}}", "feature");
  assert.equal(pushed.exitCode, 0, pushed.stderr);
  assert.deepEqual(remoteRefs(), [...before, `refs/heads/feature ${git(["rev-parse", "feature"]).trim()}`].sort(), "only the named branch moved; main was not rewound");
});

test("in a workspace that is a folder of a larger repository, git reaches no file outside it through a value", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-artifact-subfolder-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args: string[], cwd = dir) => execFileSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=a", ...args], { cwd, encoding: "utf8" });
  const ws = path.join(dir, "ws");
  fs.mkdirSync(ws);
  fs.mkdirSync(path.join(dir, "secret"));
  fs.writeFileSync(path.join(ws, "f"), "hello\n");
  fs.writeFileSync(path.join(dir, "secret", "s"), "TOPSECRET\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "one"]);
  // Uncommitted work outside the workspace, and a file there nobody staged.
  fs.writeFileSync(path.join(dir, "secret", "s"), "EDITED OUTSIDE\n");
  fs.writeFileSync(path.join(dir, "secret", "new"), "x\n");
  const resolve = (command: string, values: string[]) => {
    const names = [...command.matchAll(/\{\{(\w+)\}\}/gu)].map((match) => match[1]!);
    const action = parseWorkspaceArtifactActions([{ name: "a", label: "A", command, params: [...new Set(names)].map((name) => ({ name })) }])[0]!;
    return resolveWorkspaceArtifactCommand(action, values);
  };
  const refused: [string, string, RegExp][] = [
    ["git checkout -- {{file}}", ":/", /file must name a file inside the workspace/u],
    ["git add {{file}}", ":(top)secret", /file must name a file inside the workspace/u],
    ["git grep TOPSECRET -- {{file}}", ":/", /file must name a file inside the workspace/u],
    ["git ls-files {{file}}", ":/", /file must name a file inside the workspace/u],
    ["git log -p -- {{file}}", ":(top)secret", /file must name a file inside the workspace/u],
    ["git diff {{file}}", "*", /file must name a file inside the workspace/u],
    ["git show {{rev}}", "HEAD:secret/s", /rev must be a git revision there/u],
    ["git show {{rev}}", "HEAD:../secret/s", /rev must be a git revision there/u],
    ["git log -p {{rev}}", ":/one", /rev must be a git revision there/u],
    ["git show HEAD:{{file}}", "../secret/s", /file must name a file inside the workspace/u],
    ["git show HEAD:{{file}}", ":secret/s", /file must name a file inside the workspace/u],
  ];
  for (const [command, value, problem] of refused) {
    assert.throws(() => resolve(command, [value]), problem, `${command} with ${value}`);
  }
  assert.equal(fs.readFileSync(path.join(dir, "secret", "s"), "utf8"), "EDITED OUTSIDE\n", "the edit outside was not reverted");
  assert.equal(git(["diff", "--cached", "--name-only"]), "", "nothing outside was staged");

  // git reads a file after REV: from the repository root; the checked plan reads it from the workspace, and the preview shows that.
  const show = resolve("git show HEAD:{{file}}", ["f"]);
  assert.equal(show.preview, "GIT_LITERAL_PATHSPECS=1 git show HEAD:./'f'");
  const shown = await runResolved(show, ws);
  assert.deepEqual({ stdout: shown.stdout, exitCode: shown.exitCode }, { stdout: "hello\n", exitCode: 0 });
  const shell = spawnSync("/bin/sh", ["-c", show.preview], { cwd: ws, encoding: "utf8" });
  assert.equal(shell.stdout, shown.stdout, "the preview runs what the plan runs");
  // A value that names the outside file from the repository root reads nothing there.
  const fromRoot = await runResolved(resolve("git show HEAD:{{file}}", ["secret/s"]), ws);
  assert.doesNotMatch(fromRoot.stdout, /TOPSECRET/u);
  assert.notEqual(fromRoot.exitCode, 0);

  // Pathspec magic a template writes itself is read literally too, so it matches nothing outside.
  const listed = await runResolved(resolve("git ls-files :/ {{file}}", ["f"]), ws);
  assert.equal(listed.stdout, "f\n");
  // Everyday file and revision values still work.
  const logged = await runResolved(resolve("git log --format=%s {{rev}} -- {{file}}", ["HEAD", "f"]), ws);
  assert.deepEqual({ stdout: logged.stdout, exitCode: logged.exitCode }, { stdout: "one\n", exitCode: 0 });

  // A revision value that names no revision is never read as a file: git falls back to files for
  // `show`, `log` and `reset` when nothing has that name, and `sub/../../secret/s` reaches past the workspace.
  fs.mkdirSync(path.join(ws, "sub"));
  git(["add", "secret/s"]);
  const outside = "sub/../../secret/s";
  for (const command of ["git reset {{rev}}", "git reset -q {{rev}}", "git show {{rev}}", "git log -p {{rev}}", "git cherry-pick {{rev}}", "git revert --no-edit {{rev}}"]) {
    const ran = await runResolved(resolve(command, [outside]), ws);
    assert.notEqual(ran.exitCode, 0, `${command} with ${outside}`);
    assert.doesNotMatch(ran.stdout, /TOPSECRET|EDITED/u, `${command} with ${outside}`);
  }
  assert.equal(git(["diff", "--cached", "--name-only"]), "secret/s\n", "the file staged outside stays staged");
  // A real revision still resets, and a file after it is read from the workspace.
  fs.writeFileSync(path.join(ws, "f"), "changed\n");
  git(["add", "ws/f"]);
  const reset = await runResolved(resolve("git reset {{rev}} f", ["HEAD"]), ws);
  assert.equal(reset.exitCode, 0, reset.stderr);
  assert.equal(git(["diff", "--cached", "--name-only"]), "secret/s\n");
});

test("a branch value for git checkout never discards a file's uncommitted edits", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-artifact-checkout-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args: string[]) => execFileSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=a", ...args], { cwd: dir, encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "notes.md"), "committed\n");
  fs.writeFileSync(path.join(dir, "a.ts"), "committed\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "one"]);
  git(["branch", "feature"]);
  fs.writeFileSync(path.join(dir, "notes.md"), "UNSAVED WORK\n");
  fs.writeFileSync(path.join(dir, "a.ts"), "UNSAVED WORK\n");
  const action = parseWorkspaceArtifactActions([{ name: "a", label: "A", command: "git checkout {{branch}}", params: [{ name: "branch" }] }])[0]!;
  // git reads a value that names no branch as files, unless something says it is a branch.
  const file = resolveWorkspaceArtifactCommand(action, ["notes.md"]);
  const ran = await runResolved(file, dir);
  assert.notEqual(ran.exitCode, 0);
  assert.match(ran.stderr, /invalid reference/u);
  for (const value of [".", "*.ts", "a.?s"]) assert.throws(() => resolveWorkspaceArtifactCommand(action, [value]), /branch must be a git revision there/u, value);
  assert.equal(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), "UNSAVED WORK\n");
  assert.equal(fs.readFileSync(path.join(dir, "a.ts"), "utf8"), "UNSAVED WORK\n");
  // A shell given the preview reads the value the same way.
  assert.equal(file.preview, "GIT_LITERAL_PATHSPECS=1 git checkout 'notes.md' --");
  assert.notEqual(spawnSync("/bin/sh", ["-c", file.preview], { cwd: dir }).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), "UNSAVED WORK\n");
  // A branch still switches, carrying the edits along.
  const switched = await runResolved(resolveWorkspaceArtifactCommand(action, ["feature"]), dir);
  assert.equal(switched.exitCode, 0, switched.stderr);
  assert.equal(git(["branch", "--show-current"]).trim(), "feature");
  assert.equal(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), "UNSAVED WORK\n");
  // A revision checks out detached, and a value that reaches a file through a folder is still read only as a revision.
  fs.mkdirSync(path.join(dir, "sub"));
  const throughFolder = await runResolved(resolveWorkspaceArtifactCommand(action, ["sub/../notes.md"]), dir);
  assert.notEqual(throughFolder.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), "UNSAVED WORK\n");
  const detached = await runResolved(resolveWorkspaceArtifactCommand(action, ["feature~0"]), dir);
  assert.equal(detached.exitCode, 0, detached.stderr);
  assert.equal(git(["branch", "--show-current"]).trim(), "");
  assert.equal(git(["rev-parse", "HEAD"]), git(["rev-parse", "feature"]));
  assert.equal(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), "UNSAVED WORK\n");
  // Options written after the branch stay options: the -- goes after them, not before.
  for (const option of ["-q", "--quiet", "-f"]) {
    const quiet = parseWorkspaceArtifactActions([{ name: "a", label: "A", command: `git checkout {{branch}} ${option}`, params: [{ name: "branch" }] }])[0]!;
    const target = option === "-f" ? "main" : git(["branch", "--show-current"]).trim() === "main" ? "feature" : "main";
    const resolved = resolveWorkspaceArtifactCommand(quiet, [target]);
    assert.equal(resolved.preview, `GIT_LITERAL_PATHSPECS=1 git checkout '${target}' ${option} --`);
    const result = await runResolved(resolved, dir);
    assert.equal(result.exitCode, 0, `${option}: ${result.stderr}`);
    assert.equal(git(["branch", "--show-current"]).trim(), target);
  }
});

test("git tag points a tag at the revision a value names, never at a file", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-artifact-tag-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args: string[]) => execFileSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=a", ...args], { cwd: dir, encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "notes.md"), "one\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "one"]);
  fs.writeFileSync(path.join(dir, "notes.md"), "two\n");
  git(["commit", "-q", "-am", "two"]);
  const action = parseWorkspaceArtifactActions([
    { name: "a", label: "A", command: "git tag -a {{name}} {{rev}} -m {{message}}", params: [{ name: "name" }, { name: "rev" }, { name: "message" }] },
  ])[0]!;
  const tagged = resolveWorkspaceArtifactCommand(action, ["v1", "HEAD~1", "first"]);
  assert.match(tagged.preview, / -m 'first' --$/u);
  const identity = { GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" };
  const ran = await runResolved(tagged, dir, identity);
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.equal(git(["rev-parse", "v1^{commit}"]), git(["rev-parse", "HEAD~1"]));
  // A file name is not a revision, and the tag name stays a plain name.
  const file = await runResolved(resolveWorkspaceArtifactCommand(action, ["v2", "notes.md", "x"]), dir, identity);
  assert.notEqual(file.exitCode, 0);
  assert.throws(() => resolveWorkspaceArtifactCommand(action, ["v~1", "HEAD", "x"]), /name must be a branch or tag name there/u);
  assert.equal(git(["tag"]), "v1\n");
});
