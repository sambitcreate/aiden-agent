import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  isWorkspaceArtifactTitle,
  parseWorkspaceArtifactActions,
  parseWorkspaceArtifactOutput,
  parseWorkspaceArtifactRefresh,
  parseWorkspaceArtifactSnapshotV1,
  parseWorkspaceArtifactSources,
  resolveWorkspaceArtifactCommand,
  workspaceArtifactDataJson,
  workspaceArtifactSourceAccess,
  type ResolvedWorkspaceArtifactCommand,
  type WorkspaceArtifactActionV1,
  type WorkspaceArtifactSourceV1,
} from "./workspace-artifacts.js";

// How the parser refuses a template that puts page data where it could do more than be one argument.
const PLACEMENT_REFUSED = /\{\{\w+\}\} cannot (?:sit|be|follow)|runs without a shell, so it may not use|may not be passed/u;

/** The argument lists an action with page data runs, one per command; it never goes through a shell. */
function argvOf(resolved: ResolvedWorkspaceArtifactCommand): string[][] {
  assert.equal(resolved.kind, "argv", "a template with {{params}} runs without a shell");
  return resolved.kind === "argv" ? resolved.steps.flatMap((step) => step.pipeline.map((command) => command.argv)) : [];
}

/** Runs a one-command argument list the way the runner does: no shell. */
function runArgv(argv: readonly string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
}

test("sources accept shell commands and workspace files and reject paths outside the folder", () => {
  assert.deepEqual(
    parseWorkspaceArtifactSources([
      { name: "pulls", kind: "shell", command: "  gh pr list --json number,title  " },
      { name: "todo", kind: "file", file: "docs/TODO.md", parse: "lines" },
    ]),
    [
      { name: "pulls", kind: "shell", command: "gh pr list --json number,title", parse: "json" },
      { name: "todo", kind: "file", file: "docs/TODO.md", parse: "lines" },
    ],
  );
  for (const file of ["/etc/passwd", "../secrets", "docs/../../x", "~/notes", "C:\\Windows\\x"]) {
    assert.throws(() => parseWorkspaceArtifactSources([{ name: "x", kind: "file", file }]), /workspace/u, file);
  }
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "a", kind: "shell", command: "x" }, { name: "a", kind: "shell", command: "y" }]), /twice/u);
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "pull-list", kind: "shell", command: "x" }]), /must be an identifier/u);
  // A well-formed name that is reserved says so and offers a free one.
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "constructor", kind: "shell", command: "x" }]), /"constructor" is reserved .*try "myConstructor"/u);
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "path", kind: "shell", command: "x" }]), /"path" is reserved \(Aiden's phone apps .*try "myPath"/u);
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "childCount", kind: "shell", command: "x" }]), /reserved.*try "myChildCount"/u);
  assert.deepEqual(parseWorkspaceArtifactSources([{ name: "myPath", kind: "shell", command: "x" }]).map((source) => source.name), ["myPath"]);
  const withParam = (name: string) => [{ name: "go", label: "Go", command: "git show {{" + name + "}}", params: [{ name }] }];
  assert.throws(() => parseWorkspaceArtifactActions(withParam("path")), /params\[0\]: the name "path" is reserved.*try "myPath"/u);
  assert.equal(parseWorkspaceArtifactActions(withParam("myPath"))[0]!.params[0]!.name, "myPath");
  assert.throws(() => parseWorkspaceArtifactActions([{ name: "token", label: "Token", command: "x" }]), /actions\[0\]: the name "token" is reserved.*try "myToken"/u);
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "x", kind: "http", command: "x" }]), /kind/u);
});

test("action templates may only name their own params", () => {
  assert.deepEqual(
    parseWorkspaceArtifactActions([
      { name: "merge", label: "Merge pull request", command: "gh pr merge {{number}} --squash", params: [{ name: "number", type: "number" }] },
    ]),
    [{ name: "merge", label: "Merge pull request", command: "gh pr merge {{number}} --squash", params: [{ name: "number", type: "number" }] }],
  );
  assert.throws(
    () => parseWorkspaceArtifactActions([{ name: "merge", label: "Merge", command: "gh pr merge {{id}}", params: [{ name: "number" }] }]),
    /\{\{id\}\} is not one of its params/u,
  );
  assert.throws(() => parseWorkspaceArtifactActions([{ name: "merge", label: "", command: "x" }]), /label/u);
});

test("refresh intervals are opt-in and never faster than a minute", () => {
  assert.deepEqual(parseWorkspaceArtifactRefresh(undefined), { onOpen: true });
  assert.deepEqual(parseWorkspaceArtifactRefresh({ onOpen: false, intervalSeconds: 300 }), { onOpen: false, intervalSeconds: 300 });
  assert.throws(() => parseWorkspaceArtifactRefresh({ intervalSeconds: 5 }), /60/u);
});

const merge: WorkspaceArtifactActionV1 = {
  name: "comment",
  label: "Comment",
  command: "printf '%s|%s' {{who}} {{count}}",
  params: [
    { name: "who", type: "string" },
    { name: "count", type: "number" },
  ],
};

test("filled-in values reach the program as single literal arguments, and the preview reads the same to a shell", () => {
  const hostile = [`$(touch /tmp/aiden-pwned)`, `'; echo hi; '`, "a  b c", `"$HOME"`, "`id`", "plain", "x\"y", "subject\n\nbody; echo hi", "a\tb"];
  for (const value of hostile) {
    const resolved = resolveWorkspaceArtifactCommand(merge, [value, 3]);
    assert.deepEqual(argvOf(resolved), [["printf", "%s|%s", value, "3"]], value);
    assert.equal(runArgv(argvOf(resolved)[0]!), `${value}|3`, value);
    // The confirmation shows the preview; a shell reading it gets the same arguments.
    assert.equal(execFileSync("/bin/sh", ["-c", resolved.preview], { encoding: "utf8" }), `${value}|3`, value);
  }
  // A template without page data keeps the shell: it is shown and run as written.
  const plain = resolveWorkspaceArtifactCommand({ name: "a", label: "A", command: "git status | head -n 1 && echo $HOME", params: [] }, []);
  assert.deepEqual(plain, { kind: "shell", command: "git status | head -n 1 && echo $HOME", preview: "git status | head -n 1 && echo $HOME" });
});

test("a value never runs as code, even where a template quotes its placeholder", () => {
  const marker = path.join(os.tmpdir(), `aiden-artifact-injection-${process.pid}`);
  fs.rmSync(marker, { force: true });
  const values = [`$(touch ${marker})`, `'; touch ${marker}; '`, `\`touch ${marker}\``];
  const action = (command: string): WorkspaceArtifactActionV1 => ({ name: "a", label: "A", command, params: [{ name: "body", type: "string" }] });
  for (const value of values) {
    runArgv(argvOf(resolveWorkspaceArtifactCommand(action("printf '%s' {{body}}"), [value]))[0]!);
  }
  // Saving refuses these shapes, and one stored before a rule existed is turned off at run time too.
  for (const template of [`printf '%s' "{{body}}"`, `printf '%s' '{{body}}'`, "printf '%s' `echo {{body}}`", `printf '%s' $(echo {{body}})`]) {
    for (const value of values) assert.throws(() => resolveWorkspaceArtifactCommand(action(template), [value]), /A is turned off/u, template);
  }
  assert.equal(fs.existsSync(marker), false);
});

test("a template cannot run with a different value from the one its confirmation shows", () => {
  const action = (command: string): WorkspaceArtifactActionV1 => ({ name: "a", label: "A", command, params: [{ name: "target", type: "string" }] });
  // Each template tries to swap the value after it was bound; with no shell
  // there are no variables, functions or positional parameters to swap, and
  // the syntax that would make them is refused when saved and when run.
  for (const template of [
    "set -- actual-target; printf '%s' {{target}}",
    "f() { printf '%s' {{target}}; }; f actual-target",
    "AIDEN_ARG_1=actual-target; printf '%s' {{target}}",
    "f() { local AIDEN_ARG_1=actual-target; printf '%s' {{target}}; }; f",
    "unset AIDEN_ARG_1; printf '%s' {{target}}",
    "printf '%s' \"$1\" {{target}}",
  ]) {
    assert.throws(() => parseWorkspaceArtifactActions([action(template)]), PLACEMENT_REFUSED, template);
    assert.throws(() => resolveWorkspaceArtifactCommand(action(template), ["shown-target"]), /turned off/u, template);
  }
});

test("a placeholder must be its own unquoted word, or joined only to plain text", () => {
  const action = (command: string) => [{ name: "a", label: "A", command, params: [{ name: "x" }, { name: "y" }] }];
  for (const command of [
    `echo "{{x}}"`,
    `echo '{{x}}'`,
    "echo `{{x}}`",
    "echo $(cat {{x}})",
    "echo ${{{x}}}",
    "cat <<EOF\n{{x}}\nEOF",
    // Joined to shell syntax, an option or an assignment the command reads.
    "echo $HOME{{x}}",
    "echo {{x}}$HOME",
    "echo *{{x}}",
    "echo ~{{x}}",
    "echo {{x}}'s'",
    "echo {{x}}#tag",
    "gh pr comment 1 --body={{x}}",
    "git log -n{{x}}",
    // vim, less and more read +text as a command; curl and gh read @text as a file.
    "vim -es +{{x}} +q",
    "curl -d @{{x}} https://example.com",
    "PAGER={{x}} git log",
    "if X={{x}} git log; then :; fi",
    // A redirection's file, and the file an option writes.
    "printf '%s' {{x}} >notes/{{y}}.txt",
    "echo hi >> {{x}}",
    "cat < {{x}}",
    "git log --output {{x}}",
    "git log --out {{x}}",
    "sort -o {{x}} notes.txt",
    "gh issue comment 1 --body-file {{x}}",
    "gh issue comment 1 -F {{x}}",
    "gh issue create --title t --body-file {{x}}",
    "gh pr create -F {{x}}",
    "gh pr edit 1 --body-file {{x}}",
    "gh pr create --recover {{x}}",
    "git config -f {{x}} user.name me",
    "uniq notes.txt {{x}}",
    "uniq -f 1 notes.txt {{x}}",
    // Where git connects to a remote, which can be a URL or a command.
    "git fetch {{x}}",
    "git push {{x}} main",
    "git pull --rebase {{x}} main",
    "git fetch --multiple origin {{x}}",
    "git push --repo {{x}} main",
    "git push origin :{{x}}",
    // The folder git worktree add creates.
    "git worktree add {{x}}",
    "git worktree add ../review {{x}}",
    // A file read from anywhere, or a temporary directory written to.
    "sort -T {{x}} notes.txt",
    "git commit -qF {{x}} --allow-empty",
    "git tag -F {{x}} v1",
    "git diff --no-index /etc/hosts {{x}}",
    "git diff HEAD~1 --no-index /etc/hosts {{x}}",
    // jq reads files from its filter and operands; page data goes in as --arg.
    "jq -n {{x}}",
    "jq -r .name {{x}}",
    "jq --arg {{x}} '$x' notes.json",
    // A subshell, and a redirection to a file: the grammar has neither.
    "(git fetch && git switch {{x}})",
    "printf '%s' {{x}} >notes/out.txt",
  ]) {
    assert.throws(() => parseWorkspaceArtifactActions(action(command)), PLACEMENT_REFUSED, command);
  }
  for (const command of [
    "gh pr merge {{x}} --squash",
    "echo {{x}}; echo done",
    "git fetch && git switch {{x}}",
    `echo "fixed" {{x}}`,
    "git show HEAD:{{x}}",
    "git push origin {{x}}:refs/heads/{{y}}",
    "cat notes/{{x}}.md",
    "printf '%s' {{x}} >/dev/null",
    "uniq -f 1 {{x}}",
  ]) {
    assert.equal(parseWorkspaceArtifactActions(action(command)).length, 1, command);
  }
});

test("a misplaced placeholder is refused with the fix for where it sits", () => {
  const refusal = (command: string, param = "x") => {
    try {
      parseWorkspaceArtifactActions([{ name: "a", label: "A", command, params: [{ name: param }] }]);
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail(`${command} was accepted`);
  };
  // A joined option is answered with that same option as a separate word.
  assert.match(refusal("head -n{{count}} notes.txt", "count"), /\{\{count\}\} cannot be joined to the option -n\. Pass it as a separate word: -n \{\{count\}\}\./u);
  assert.match(refusal("cut -f{{col}} notes.txt", "col"), /joined to the option -f\. Pass it as a separate word: -f \{\{col\}\}\./u);
  assert.match(refusal("gh pr comment 1 --body={{body}}", "body"), /joined to the option --body\. Pass it as a separate word: --body \{\{body\}\}\./u);
  // Each other kind names its own position and fix, not a generic "own unquoted word" line.
  assert.match(refusal(`echo "{{x}}"`), /^actions\[0\]: \{\{x\}\} cannot sit inside double quotes\. Leave the quotes off/u);
  assert.match(refusal(`echo '{{x}}'`), /cannot sit inside single quotes/u);
  assert.match(refusal("{{x}} status"), /\{\{x\}\} cannot be the command itself\. Write the program literally/u);
  assert.match(refusal("git {{x}}"), /cannot be the git subcommand\. Write the subcommand literally/u);
  assert.match(refusal("git worktree {{x}}"), /cannot be the git worktree verb\. Write list, add or remove literally/u);
  assert.match(refusal("gh {{x}} view 1"), /cannot be the gh command\. Write the command and its verb literally/u);
  assert.match(refusal("gh pr {{x}} 1"), /cannot be the gh pr verb\. Write the verb literally, as in gh pr view \{\{x\}\}/u);
  assert.match(refusal("echo +{{x}}"), /cannot follow \+, which programs read as a command/u);
  // A count written as -{{n}} needs its option, and tail's +N (from line N) has no checked form.
  assert.match(refusal("head -{{count}} notes.txt", "count"), /\{\{count\}\} cannot follow a bare -.*The number needs its option as a separate word, for example -n \{\{count\}\}\./u);
  assert.doesNotMatch(refusal("git log -{{count}}", "count"), /- \{\{count\}\}/u);
  assert.match(
    refusal("tail -n +{{count}} notes.txt", "count"),
    /\{\{count\}\} cannot follow \+ there: use -n \{\{count\}\} \(last N lines\); starting from line N with page data is not supported\./u,
  );
  assert.match(refusal("tail --bytes +{{count}} notes.txt", "count"), /use --bytes \{\{count\}\} \(last N bytes\); starting from byte N/u);
  assert.match(refusal("cat a{{x}}'b'"), /cannot be joined to quoted text/u);
  for (const command of ["head -n{{count}} notes.txt", `echo "{{count}}"`, "{{count}} status"]) {
    assert.doesNotMatch(refusal(command, "count"), /own unquoted word/u, command);
  }
});

test("a template with page data runs without a shell, so shell syntax the checker cannot model is refused", () => {
  const action = (command: string) => [{ name: "a", label: "A", command, params: [{ name: "x" }] }];
  // Each of these once hid a command from a check that read shell text.
  for (const command of [
    "echo {{x}} | ((sh) )",
    "echo {{x}} | ((sh -s) ) 2>&1",
    "echo {{x}} | { ((sh) ); }",
    "echo {{x}} | $((sh) )",
    "( (sh -c 'touch PWNED') ); echo {{x}}",
    "echo [[ {{x}}; sh -c 'touch PWNED'; ]]",
    "echo {{x}} [[ | sh ]]",
    "[[ a ]] ; echo {{x}}; [[ b ]]; sh -c 'touch PWNED'",
    "echo {{x}} $((sh -c 'touch PWNED') )",
    "echo {{x}} $[ $(touch PWNED) ]",
    "echo {{x}} $(echo ')'); sh -c 'touch PWNED'",
    "echo {{x}} ${a:-'}'}; sh -c 'touch PWNED'",
    "echo {{x}} $'a\\'b'; sh -c 'touch PWNED'",
    "echo {{x}} & sh -c 'touch PWNED'",
    "echo {{x}} |& sh",
    "echo {{x}} &>/dev/null; sh",
    "echo {{x}} # ; sh",
    "echo {{x}} \\; sh",
    "echo {{x}} <(sh -c 'touch PWNED')",
    "echo {{x}} > >(sh)",
    "echo {{x}} <<-EOF\nEOF",
    "case a in a) sh;; esac; echo {{x}}",
    "echo {{x}} ;; sh",
    "! echo {{x}}",
    "e\\val {{x}}",
    "ev\\\nal {{x}}",
    "echo {{x}} | while read l; do $l; done",
    "echo {{x}} | tee PWNED",
    "echo {{x}} > a.sh; sh a.sh",
  ]) {
    assert.throws(() => parseWorkspaceArtifactActions(action(command)), PLACEMENT_REFUSED, command);
  }
  // The operators the grammar does have keep their meaning.
  const [parsed] = parseWorkspaceArtifactActions([
    { name: "a", label: "A", command: "git fetch -q 2>/dev/null || git status && git log -1 {{x}} 2>&1 | head -n 1; \\\n  git status >/dev/null", params: [{ name: "x" }] },
  ]);
  const resolved = resolveWorkspaceArtifactCommand(parsed!, ["main"]);
  assert.ok(resolved.kind === "argv");
  // git reads no pathspec magic or glob from a value or the template.
  const GIT = { GIT_LITERAL_PATHSPECS: "1" };
  assert.deepEqual(resolved.steps, [
    { connector: ";", pipeline: [{ argv: ["git", "fetch", "-q"], redirects: ["2>/dev/null"], env: GIT }] },
    { connector: "||", pipeline: [{ argv: ["git", "status"], redirects: [], env: GIT }] },
    {
      connector: "&&",
      pipeline: [
        { argv: ["git", "log", "-1", "main"], redirects: ["2>&1"], env: GIT },
        { argv: ["head", "-n", "1"], redirects: [] },
      ],
    },
    { connector: ";", pipeline: [{ argv: ["git", "status"], redirects: [">/dev/null"], env: GIT }] },
  ]);
  // A template without page data is not parsed this way: it runs in a shell, as written.
  assert.equal(parseWorkspaceArtifactActions([{ name: "a", label: "A", command: "echo hi | ((sh) )" }]).length, 1);
});

test("a joined value reaches the program as part of one literal argument", () => {
  const action = parseWorkspaceArtifactActions([
    { name: "a", label: "A", command: "printf '%s|' HEAD:{{x}} {{x}}.md", params: [{ name: "x", type: "string" }] },
  ])[0]!;
  for (const value of ["main", "a b", "$(id)", "*", "x;y"]) {
    const resolved = resolveWorkspaceArtifactCommand(action, [value]);
    assert.deepEqual(argvOf(resolved), [["printf", "%s|", `HEAD:${value}`, `${value}.md`]], value);
    assert.equal(runArgv(argvOf(resolved)[0]!), `HEAD:${value}|${value}.md|`, value);
    assert.equal(execFileSync("/bin/sh", ["-c", resolved.preview], { encoding: "utf8" }), `HEAD:${value}|${value}.md|`, value);
  }
});

test("a placeholder cannot be run as a command or hidden from the check", () => {
  const actions = (command: string, type: "string" | "number" = "string") => [{ name: "a", label: "A", command, params: [{ name: "x", type }] }];
  const refused = [
    "{{x}} --version",
    "echo ok; {{x}}",
    "echo ok | {{x}}",
    "eval {{x}}",
    "sh -c {{x}}",
    "xargs {{x}}",
    "if {{x}}; then echo ok; fi",
    "FOO=1 {{x}}",
    // Quoted or expanded text before the placeholder does not hide its command.
    'eval "${HOME}" {{x}}',
    "eval ';' {{x}}",
    "'eval' echo {{x}}",
    "$RUNNER {{x}}",
    "if true; then {{x}}; fi",
    "eval echo {{x}}",
    "bash -lc {{x}}",
    "sudo -u me {{x}}",
    "find . -exec {{x}} ;",
    // A ")" inside quotes does not close the $(…) around the placeholder.
    'echo $(printf ")" {{x}})',
    "{ {{x}}; }",
    "printf '%s' \\{{x}}",
    // A quote in a comment must not change what the next line counts as quoted.
    '# say "hi\necho "{{x}}"',
    "echo {{x}} '",
    "echo $AIDEN_ARG_1 {{x}}",
    // Assignments, redirections, comments and line breaks before the name do not hide it.
    "FOO='two words' eval {{x}}",
    ">/dev/null eval {{x}}",
    "eval 2>&1 {{x}}",
    "# a comment\neval {{x}}",
    "# a comment\n{{x}}",
    "ev\\\nal {{x}}",
    "coproc eval {{x}}",
    "/usr/bin/env {{x}}",
    "/usr/bin/en? {{x}}",
    "{e,e}val {{x}}",
    "echo <({{x}})",
    "trap {{x}} EXIT",
    // Interpreters run their code option's value, and awk and sed their first operand.
    "python3 -c {{x}}",
    "python3.12 -Ic {{x}}",
    "python3 -m {{x}}",
    "python3 {{x}}",
    "node -e {{x}}",
    "perl -ne {{x}}",
    "ruby -e {{x}}",
    "bash {{x}}",
    "awk {{x}} notes.txt",
    "awk -F , {{x}} notes.txt",
    "awk -f {{x}} notes.txt",
    "sed -n {{x}} notes.txt",
    "sqlite3 app.db {{x}}",
    "psql -c {{x}}",
    "git -c {{x}} status",
    "git --git-dir .git -c {{x}} probe",
    "git --namespace review -c {{x}} probe",
    "git --shallow-file shallow -c {{x}} probe",
    "git --some-future-option value -c {{x}} probe",
    // Options that name a program to start, and make's NAME=value arguments.
    "git fetch --upload-pack {{x}} origin",
    "git -C repo push --receive-pack {{x}} origin",
    "git clone -u {{x}} repo copy",
    "git rebase -x {{x}} main",
    "git merge -s {{x}} main",
    "git pull --strategy {{x}} origin main",
    "git cherry-pick --strat {{x}} HEAD",
    "git submodule foreach {{x}}",
    "git bisect run {{x}}",
    "rsync -avze {{x}} src host:dst",
    "tar -I {{x}} -xf notes.tar",
    "zip -T --unzip-command {{x}} notes.zip notes.txt",
    "scp -o {{x}} notes.txt host:",
    "man -P {{x}} ls",
    "make {{x}}",
    "make -C {{x}} test",
    // Long options count by any abbreviation git and getopt accept, and by a name that says program.
    "git ls-remote --upload-p {{x}} .",
    "git fetch --upload {{x}} origin",
    "git clone -c {{x}} repo copy",
    "git clone --conf {{x}} repo copy",
    "git send-email --sendmail-cmd {{x}} patch",
    "tar --use-compress {{x}} -cf notes.tar notes.txt",
    "sort --compress-program {{x}} notes.txt",
    "zip --unzip {{x}} notes.zip",
    "gh pr view 1 --shell {{x}}",
    // git config keys that git runs, pipes to or reads as more configuration.
    "git config core.sshCommand {{x}}",
    "git config --global core.fsmonitor {{x}}",
    "git config alias.st {{x}}",
    "git config include.path {{x}}",
    "git config --get {{x}}",
    // Programs that run what they are given: package runners, editors, pagers, script, hash -p.
    "script -q /dev/null {{x}}",
    "hash -p {{x}} ls",
    "npm exec {{x}}",
    "npx {{x}}",
    "bun x {{x}}",
    "pnpm dlx {{x}}",
    "yarn dlx {{x}}",
    "go run {{x}}",
    "vim -es {{x}}",
    "less {{x}}",
    "ssh -o ProxyCommand={{x}} host true",
    // Short options in a cluster, read as git and getopt read them: the last letter takes the next word.
    "git rebase -qx {{x}} HEAD~2",
    "git rebase -fx {{x}} HEAD~2",
    "git merge -qs {{x}} HEAD",
    "git pull -qs {{x}}",
    "gh pr merge 1 -sF {{x}}",
    "gh pr review 1 -cF {{x}}",
    "gh pr comment 1 -eF {{x}}",
    "git config user.name foo -zf {{x}}",
    "git config set user.name foo --fil {{x}}",
    "rg --pr cat {{x}}",
    // Each program, git subcommand and gh verb lists the slots page data may
    // fill; every other position, and any option the table does not know, is refused.
    "git fetch --refmap {{x}} origin",
    "git pull --refmap {{x}} origin main",
    "git fetch origin main --unknown-option {{x}}",
    "git blame --contents {{x}} notes.txt",
    "git blame -S {{x}} notes.txt",
    "git blame --ignore-revs-file {{x}} notes.txt",
    "git ls-files --exclude-from {{x}}",
    "git ls-files -X {{x}}",
    "git log -O {{x}}",
    "git diff -O {{x}}",
    "jq -R -L --arg . {{x}}",
    "jq -n --arg --arg . {{x}}",
    "jq -n --rawfile v {{x}} .",
    "jq -n --slurpfile v {{x}} .",
    "jq -f {{x}}",
    "jq --args -n '$ARGS' {{x}}",
    "jq -n --jsonargs '$ARGS' {{x}}",
    "jq . {{x}}",
    "git stash {{x}}",
    "git stash {{x}} -m note",
    "gh pr view 1 --jq {{x}}",
    "gh pr list -q {{x}}",
    "gh pr view 1 --template {{x}}",
    "gh pr list -R {{x}}",
    "gh pr view --repo {{x}}",
    "gh pr create --template {{x}}",
    "gh pr list --search -- {{x}}",
    "gh pr list -- {{x}}",
    "gh pr view 1 {{x}}",
  ];
  for (const command of refused) assert.throws(() => parseWorkspaceArtifactActions(actions(command)), PLACEMENT_REFUSED, command);
  // Text is fine as a plain argument, between the operators the grammar has.
  for (const command of [
    "test {{x}} -gt 0 && echo big",
    "printf '%s\\n' {{x}} | sort",
    "git fetch -q || git checkout {{x}}",
    "printf '%s\\n' {{x}}\ngit status",
    "echo '((' {{x}} '[[' '$(id)'",
    // Words that merely spell a command name are data, not the command.
    "printf '%s\\n' command | grep -F command -- {{x}}",
    "printf '%s\\n' command is {{x}}",
    "grep -c {{x}} notes.txt",
    "git log --format=%h 2>&1 {{x}}",
    "gh pr merge \\\n  {{x}} --squash",
    "git grep -c {{x}}",
    "git log -c {{x}}",
    // The same option names elsewhere, or in another subcommand, take plain values.
    "git cherry-pick -x {{x}}",
    "git cherry-pick -s {{x}}",
    // A letter that takes a value ends the cluster: in -mq the message is "q", so the next word is a plain argument.
    "git commit -qm {{x}}",
    "git commit -mq {{x}}",
    "git rebase -q --onto main {{x}}",
    "git merge --no-ff {{x}}",
    "git push -u origin {{x}}",
    "git config user.name {{x}}",
    "git config --global user.email {{x}}",
    "sort -k 2 {{x}}",
    "git --no-pager log -c {{x}}",
    "git worktree add -b {{x}} ../review",
    "git remote -v | grep -F -- {{x}}",
    "gh browse {{x}}",
    "gh run view {{x}} --log | tail -n 20",
    // Each gh group takes its own verbs: writing an issue or pull request, rerunning a run, reading releases.
    "gh issue create --title {{x}} --body 'From the page'",
    "gh issue edit 3 --title {{x}}",
    "gh pr create --draft --title {{x}} --body {{x}}",
    "gh pr edit {{x}} --add-label bug",
    "gh pr ready {{x}}",
    "gh pr checks {{x}} --watch",
    "gh run rerun {{x}} --failed",
    "gh run watch {{x}}",
    "gh run cancel {{x}}",
    "gh release view {{x}}",
    "gh release list --limit {{x}}",
    "gh label list --search {{x}}",
    "gh workflow view {{x}}",
    "gh workflow list --limit {{x}}",
    "jq -r --arg name {{x}} '.[] | select(.name == $name)' notes.json | sort | uniq -c",
    "git push origin {{x}}",
    "git diff HEAD -- {{x}}",
    "git stash push -m {{x}}",
    "git stash -m {{x}}",
    "git blame -L {{x}} notes.txt",
    "git grep -e {{x}}",
    "gh pr view {{x}} --json title",
    "gh pr list --search {{x}} --limit 5",
    "gh pr list --base {{x}}",
    "jq -n --argjson n {{x}} '$n + 1'",
  ]) {
    assert.equal(parseWorkspaceArtifactActions(actions(command)).length, 1, command);
  }
  // Page data goes only to a short list of programs: every command in the
  // template, piped, chained, grouped or substituted, must start with one, by
  // a plain name, and git and gh with a listed subcommand. Programs off the
  // list can run what they are given in ways an option check cannot see.
  for (const command of [
    // Shells and interpreters, fed the value on input, from a file or as a script.
    "echo {{x}} | sh",
    "printf '%s\\n' {{x}} | bash",
    "echo {{x}} > a.sh; sh a.sh",
    "sh <<< {{x}}",
    "bash --rcfile notes.txt {{x}}",
    "sh -c 'printf %s \"$1\"' sh {{x}}",
    "python3 -X dev -W ignore {{x}}",
    "python3 scripts/report.py {{x}}",
    "node -C dev {{x}}",
    "node --title t {{x}}",
    "awk -f notes.txt {{x}}",
    "awk '{ print $1 }' {{x}}",
    "sed -n '1,5p' {{x}}",
    "sqlite3 {{x}} 'select 1'",
    "expect -c {{x}}",
    "osascript -l JavaScript {{x}}",
    "lldb --batch -o {{x}}",
    // Programs that start another program, a session or a server.
    "tmux new-session -d {{x}}",
    "screen -dm {{x}}",
    "ssh-agent {{x}}",
    "sftp -D {{x}} x",
    "open {{x}}",
    "docker run --rm {{x}}",
    "code --install-extension {{x}}",
    "curl -o {{x}} file:///etc/hosts",
    "rsync -av {{x}} backup/",
    "tar -xf {{x}}",
    "make -j {{x}} test",
    // Package managers run install scripts and package scripts.
    "npm install --offline --no-save {{x}}",
    "npm run {{x}}",
    "npm view {{x}} version",
    "pip install {{x}}",
    "brew install {{x}}",
    "cargo install {{x}}",
    "yarn add {{x}}",
    "uv pip install {{x}}",
    "go test -run {{x}} ./...",
    // Shell builtins and keywords that run, store or redefine what comes next.
    "set -- {{x}}; \"$@\"",
    "for f in {{x}}; do $f; done",
    "alias l={{x}}\nl",
    "let {{x}}",
    "read -r first < notes.txt; echo {{x}}",
    "unset {{x}}",
    "f() { printf %s {{x}}; }; f",
    "f () { local {{x}}; }; f",
    "cd sub && git switch {{x}}",
    "exec git log {{x}}",
    "command git log {{x}}",
    // git and gh subcommands off the list, or hidden behind an option or a variable.
    "git filter-branch -f --tree-filter {{x}} HEAD",
    "git instaweb --httpd {{x}}",
    "git submodule add {{x}}",
    "git difftool -t {{x}} HEAD",
    "git send-email --to {{x}} patch",
    "git -C repo log {{x}}",
    "git --exec-path=bin log {{x}}",
    "git $SUB {{x}}",
    "git config core.editor {{x}}",
    "GIT_PAGER=cat git log {{x}}",
    "gh api repos/acme/app/issues -f title={{x}}",
    "gh extension install {{x}}",
    "gh workflow run deploy.yml -f ref={{x}}",
    "gh workflow run {{x}}",
    "gh secret set TOKEN --body {{x}}",
    "gh auth login --hostname {{x}}",
    "gh run download {{x}}",
    "gh repo clone {{x}}",
    // gh repo view and list read whichever repository or owner the operand names.
    "gh repo view {{x}}",
    "gh repo view {{x}} --json description",
    "gh repo list {{x}}",
    "gh release create {{x}}",
    "gh label create {{x}}",
    "gh issue checkout {{x}}",
    "gh run merge {{x}}",
    "gh alias set x {{x}}",
    "gh config set editor {{x}}",
    // A command word that is quoted, a path or an expansion.
    "/usr/bin/git log {{x}}",
    "'git' log {{x}}",
    "\\git log {{x}}",
    "$GIT log {{x}}",
    // Every stage and substitution is checked, not just the one with the value.
    "echo {{x}} | xargs git log",
    "git log {{x}} | tee out.txt",
    "echo {{x}} $(npm run build)",
    "diff <(sh notes.txt) <(echo {{x}})",
    "echo `id` {{x}}",
    "echo $(( $(cat n) )) {{x}}",
    "echo ${!ref} {{x}}",
    "echo ${PS1@P} {{x}}",
    "echo {{x}}; echo $_",
    "sort --compress-program=gzip {{x}}",
    "rg --pre ./run-me {{x}}",
  ]) {
    for (const type of ["string", "number"] as const) {
      assert.throws(() => parseWorkspaceArtifactActions(actions(command, type)), PLACEMENT_REFUSED, `${command} (${type})`);
    }
  }
  // The refusal names the program and what page data may be passed to, and
  // that the same command without a {{param}} is not limited, which holds.
  assert.throws(() => parseWorkspaceArtifactActions(actions("npm view {{x}} version")), (error: Error) => {
    assert.match(error.message, /a command that uses npm\b/u);
    assert.match(error.message, /\bgit status\b.*\bgh pr\b.*\bjq\b/u);
    assert.match(error.message, /without \{\{params\}\} is not limited/u);
    return true;
  });
  assert.equal(parseWorkspaceArtifactActions([{ name: "a", label: "A", command: "npm view aiden version", params: [] }]).length, 1);
});

test("filled-in values are checked against their declared types", () => {
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["x", "not a number"]), /number/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, [{ nested: true }, 1]), /text/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["a\u0000b", 1]), /Comment: who contains a control character/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["a\rb", 1]), /contains a control character/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["a\u001bb", 1]), /contains a control character/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["a\u202eb", 1]), /control/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["--upload-pack=x", 1]), /cannot start with "-"/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["a", 1, "extra"]), /takes 2/u);
  assert.equal(resolveWorkspaceArtifactCommand(merge, ["x", "42"]).preview, "printf '%s|%s' 'x' '42'");
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["x", -1]), /cannot be negative/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["x", "-1"]), /cannot be negative/u);
});

test("where a value lands decides what it may be: no option, no refspec, no file outside the workspace", () => {
  const run = (command: string, value: string | number, type: "string" | "number" = "string") => {
    const resolved = resolveWorkspaceArtifactCommand({ name: "a", label: "A", command, params: [{ name: "x", type }] }, [value]);
    assert.equal(resolved.kind, "argv");
    return resolved as Extract<typeof resolved, { kind: "argv" }>;
  };
  // A leading dash is read as an option, except as the separate-word value of
  // an option the program always takes as its value.
  assert.throws(() => run("git log -1 {{x}}", "--output=/tmp/x"), /x cannot start with "-" there: the program would read it as an option\. Pass such a value as an option's value/u);
  // Not even after --: gh ignores it, and git grep -e -- or rg -e -- spend it as the pattern.
  for (const [command, value] of [
    ["grep -F -- {{x}} notes.txt", "-v"],
    ["git grep -e -- {{x}}", "-Otouch /tmp/x"],
    ["rg -e -- {{x}}", "--pre=rm"],
    ["git commit -m -- {{x}}", "--amend"],
  ]) {
    assert.throws(() => run(command!, value!), /cannot start with "-"|may not be passed/u, command);
  }
  assert.deepEqual(run("grep -F -e {{x}} notes.txt", "-v").steps[0]!.pipeline[0]!.argv, ["grep", "-F", "-e", "-v", "notes.txt"]);
  assert.deepEqual(run("git commit -m {{x}}", "--amend").steps[0]!.pipeline[0]!.argv, ["git", "commit", "-m", "--amend"]);
  assert.deepEqual(run("gh pr list --search {{x}}", "-label:bug").steps[0]!.pipeline[0]!.argv, ["gh", "pr", "list", "--search", "-label:bug"]);
  // A branch git pushes, fetches or pulls: + forces it, a leading : deletes it, a : maps it elsewhere.
  for (const value of ["+main", ":main", "main:other", "-main"]) {
    assert.throws(() => run("git push origin {{x}}", value), /x cannot start with|x must be a branch or tag name there: no (leading - or \+|:)/u, value);
  }
  assert.throws(() => run("git push origin HEAD:{{x}}", "a:b"), /x must be a branch or tag name there: no :/u);
  assert.throws(() => run("git pull origin {{x}}", "+main"), /a forced push/u);
  assert.deepEqual(run("git push origin {{x}}", "feature/x").steps[0]!.pipeline[0]!.argv, ["git", "push", "origin", "feature/x"]);
  // A file a program reads stays inside the workspace, including when joined to text.
  for (const [command, value] of [
    ["cat {{x}}", "/etc/passwd"],
    ["cat {{x}}", "../../.ssh/id_ed25519"],
    ["cat {{x}}", "~/.netrc"],
    ["cat {{x}}", "C:\\Windows\\win.ini"],
    ["cat notes/{{x}}.md", "../../../etc/hosts"],
    ["head -n 5 {{x}}", "/etc/hosts"],
    ["grep -F todo {{x}}", "/etc/hosts"],
    ["grep -e todo {{x}}", "/etc/hosts"],
    ["grep -f {{x}} notes.txt", "/etc/passwd"],
    ["git diff HEAD -- {{x}}", "/etc/hosts"],
    // test's file operators would tell the page whether an outside path exists.
    ["test -e {{x}}", "/etc/passwd"],
    ["test -f {{x}} && echo yes", "../../.ssh/id_ed25519"],
    ["test -d {{x}}", "~/Library"],
    ["test {{x}} -nt notes.txt", "/etc/hosts"],
    ["test notes.txt -ot {{x}}", "/etc/hosts"],
  ]) {
    assert.throws(() => run(command!, value!), /x must name a file inside the workspace/u, `${command} ${value}`);
  }
  assert.deepEqual(run("cat notes/{{x}}.md", "a/../b").steps[0]!.pipeline[0]!.argv, ["cat", "notes/a/../b.md"]);
  // test compares text as text.
  assert.deepEqual(run("test {{x}} = main", "/etc/passwd").steps[0]!.pipeline[0]!.argv, ["test", "/etc/passwd", "=", "main"]);
  assert.deepEqual(run("test -n {{x}}", "/etc/passwd").steps[0]!.pipeline[0]!.argv, ["test", "-n", "/etc/passwd"]);
  assert.deepEqual(run("test -e {{x}}", "notes/today.md").steps[0]!.pipeline[0]!.argv, ["test", "-e", "notes/today.md"]);
  // A GitHub search stays in this repository: no repo:, org: or user: qualifier, in any case or place.
  for (const [command, value] of [
    ["gh pr list --search {{x}}", "repo:acme/secret is:open"],
    ["gh pr list --search {{x}}", "is:open ORG:acme"],
    ["gh issue list -S {{x}}", "bug User:someone"],
    ["gh issue list --search {{x}}", "-label:bug (repo:acme/other)"],
    ["gh label list --search {{x}}", "org:acme"],
    ["gh pr list --search is:open+{{x}}", "repo:acme/other"],
  ]) {
    assert.throws(() => run(command!, value!), /x cannot hold a repo:, org: or user: qualifier there/u, `${command} ${value}`);
  }
  assert.deepEqual(run("gh pr list --search {{x}}", "is:open label:bug author:@me").steps[0]!.pipeline[0]!.argv, [
    "gh", "pr", "list", "--search", "is:open label:bug author:@me",
  ]);
  // A grep pattern is not a file.
  assert.deepEqual(run("grep -F {{x}} notes.txt", "/etc/hosts").steps[0]!.pipeline[0]!.argv, ["grep", "-F", "/etc/hosts", "notes.txt"]);
  // A gh number or branch cannot point at another repository or a URL; a count is a whole number.
  for (const value of ["https://example.com/o/r/pull/1", "other:branch", "me@host", "-1"]) {
    assert.throws(() => run("gh pr view {{x}}", value), /x must be a number or a branch-like name there|cannot start with "-"/u, value);
  }
  assert.deepEqual(run("gh pr view {{x}}", "feature/x").steps[0]!.pipeline[0]!.argv, ["gh", "pr", "view", "feature/x"]);
  assert.throws(() => run("gh release list --limit {{x}}", "5 or more"), /x must be a whole number there/u);
  assert.deepEqual(run("gh release list --limit {{x}}", 5, "number").steps[0]!.pipeline[0]!.argv, ["gh", "release", "list", "--limit", "5"]);
  // Where nothing is read as a path or ref, text is just text.
  assert.deepEqual(run("git commit -m {{x}}", "fix: a/../b:c").steps[0]!.pipeline[0]!.argv, ["git", "commit", "-m", "fix: a/../b:c"]);
});

test("the display and filter options saved buttons use are read, and an unknown one says how to fix it", () => {
  const argv = (command: string, value: string) => {
    const resolved = resolveWorkspaceArtifactCommand({ name: "a", label: "A", command, params: [{ name: "x", type: "string" }] }, [value]);
    assert.equal(resolved.kind, "argv", command);
    return argvOf(resolved)[0]!;
  };
  for (const [command, value] of [
    ["git log --color=never -1 {{x}}", "main"],
    ["git show --color=always {{x}}", "HEAD~1"],
    ["git diff --word-diff {{x}}", "main"],
    ["git diff --word-diff=color --color=never {{x}}", "main"],
    ["git diff -M --stat {{x}}", "main"],
    ["git diff -C --find-renames=50% --find-copies {{x}}", "main"],
    ["git diff --diff-filter=M --name-only {{x}}", "main"],
    ["git diff --merge-base {{x}}", "main"],
    ["git branch --merged {{x}}", "main"],
    ["git branch --no-merged {{x}}", "main"],
    ["git branch -a --contains {{x}}", "abc123"],
    ["git branch -r --no-contains {{x}}", "main"],
    ["git branch --sort=-committerdate --list {{x}}", "feat/*"],
    ["git branch -v {{x}}", "fix-?"],
    ["git tag --contains {{x}}", "abc123"],
    ["git tag -l {{x}} --sort=-v:refname", "v1.*"],
    ["git tag -n {{x}}", "v*"],
    ["git blame --date=short {{x}}", "notes.txt"],
    ["git stash show -p {{x}}", "stash@{1}"],
    ["git stash drop {{x}}", "2"],
    ["git stash apply {{x}}", "stash@{0}"],
    ["rg --color never --max-columns 200 --sort path {{x}}", "todo"],
    ["rg -M {{x}} todo", "120"],
  ]) {
    // The value reaches the program unchanged, as one argument where the placeholder was.
    const words = command.split(" ");
    assert.equal(argv(command, value)[words.indexOf("{{x}}")], value, command);
  }
  // A pattern is only a pattern while listing: a value that would create,
  // delete or rename a ref is still a plain name, and never an option.
  for (const [command, value] of [
    ["git branch {{x}}", "feat/*"],
    ["git branch -d {{x}}", "feat/*"],
    ["git branch --list -D {{x}}", "feat/*"],
    ["git branch --merged main -d {{x}}", "old-*"],
    ["git tag {{x}}", "v*"],
    ["git tag -d {{x}}", "v*"],
    ["git tag -l -d {{x}}", "v*"],
    ["git branch --list {{x}}", "--delete"],
    ["git tag -l {{x}}", "-d"],
    ["git branch --contains {{x}}", "main~1"],
    ["git stash show {{x}}", "stash@{1}:notes.txt"],
    ["git stash drop {{x}}", "stash@{-1}"],
    ["rg --max-columns {{x}} todo", "200 or so"],
  ]) {
    assert.throws(() => argv(command, value), /x (must be|cannot start)/u, `${command} ${value}`);
  }
  // An option Aiden does not read says what to do and which it does read.
  const refusal = (command: string) => {
    try {
      parseWorkspaceArtifactActions([{ name: "a", label: "A", command, params: [{ name: "x" }] }]);
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail(`${command} was accepted`);
  };
  const rebase = refusal("git rebase -i {{x}}");
  assert.match(rebase, /git rebase with -i, an option Aiden does not check there \(remove it; the rest of the command still works\)/u);
  assert.match(rebase, /Options it checks: -q, -v, --abort, --continue\b/u);
  assert.match(refusal("git log --frobnicate {{x}}"), /Options it checks: .* and \d+ more/u);
});

test("commands and labels reject characters that hide what runs", () => {
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "a", kind: "shell", command: "ls \u202e-la" }]), /control/u);
  assert.throws(() => parseWorkspaceArtifactActions([{ name: "a", label: "Me\u200brge", command: "x" }]), /label/u);
  const shell = (command: string) => parseWorkspaceArtifactSources([{ name: "a", kind: "shell", command }]);
  // Format, default-ignorable and bidi characters render as nothing or reorder text.
  for (const hidden of ["\u2066", "\u061c", "\u00ad", "\u034f", "\u180e", "\ufeff", "\u{e0041}", "\u3164"]) {
    assert.throws(() => shell(`ls ${hidden}-la`), /invisible/u, JSON.stringify(hidden));
    assert.throws(() => parseWorkspaceArtifactActions([{ name: "a", label: `G${hidden}o`, command: "x" }]), /label/u);
  }
  // A carriage return can redraw a line over what came before it.
  assert.throws(() => shell("echo safe\rrm -rf ~"), /\\r/u);
  // Blank lines can push the rest of a command out of view in a review dialog.
  assert.throws(() => shell("echo a\n\n\nrm -rf ~"), /blank line/u);
  assert.throws(() => shell("echo a\n \t\n\nrm -rf ~"), /blank line/u);
  // Ordinary multi-line scripts still read as they run.
  assert.deepEqual(shell("set -e\n\techo a\n\necho b"), [{ name: "a", kind: "shell", command: "set -e\n\techo a\n\necho b", parse: "json" }]);
});

test("a title is one line of visible characters", () => {
  assert.equal(isWorkspaceArtifactTitle("Open PRs"), true);
  assert.equal(isWorkspaceArtifactTitle("Open\tPRs"), false);
  assert.equal(isWorkspaceArtifactTitle("Open\nPRs"), false);
  assert.equal(isWorkspaceArtifactTitle("Open\u2028PRs"), false);
  assert.equal(isWorkspaceArtifactTitle("Open\u200bPRs"), false);
  // The invisible parts of a visible emoji are fine; the same characters alone are not.
  for (const title of ["\u2764\ufe0f Alerts", "1\ufe0f\u20e3 First", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467} Family", "\u{1f44b}\u{1f3fd}\u200d\u2642\ufe0f Hi"]) {
    assert.equal(isWorkspaceArtifactTitle(title), true, title);
  }
  for (const title of ["Open\ufe0fPRs", "Open\u200dPRs", "\u2764\ufe0f\ufe0f Alerts", "\u{1f468}\u200d"]) {
    assert.equal(isWorkspaceArtifactTitle(title), false, JSON.stringify(title));
  }
});

test("output parses as JSON, non-empty lines or text, within the data cap", () => {
  assert.deepEqual(parseWorkspaceArtifactOutput("json", '[{"n":1}]'), { ok: true, dataJson: '[{"n":1}]' });
  assert.deepEqual(parseWorkspaceArtifactOutput("lines", "a\n\n  b  \r\nc\n"), { ok: true, dataJson: '["a","  b","c"]' });
  assert.deepEqual(parseWorkspaceArtifactOutput("text", "hello\n\n"), { ok: true, dataJson: '"hello"' });
  assert.equal(parseWorkspaceArtifactOutput("json", "not json").ok, false);
  const big = parseWorkspaceArtifactOutput("text", "x".repeat(70 * 1024));
  assert.equal(big.ok, false);
});

test("sources follow the workspace's access like a chat would", () => {
  const shell: WorkspaceArtifactSourceV1 = { name: "a", kind: "shell", command: "ls", parse: "lines" };
  const file: WorkspaceArtifactSourceV1 = { name: "b", kind: "file", file: "a.json", parse: "json" };
  assert.equal(workspaceArtifactSourceAccess("full", true, shell, false), "run");
  assert.equal(workspaceArtifactSourceAccess("ask", true, shell, false), "needs-approval");
  assert.equal(workspaceArtifactSourceAccess("ask", true, shell, true), "run");
  assert.equal(workspaceArtifactSourceAccess("ask", true, file, false), "run");
  assert.equal(workspaceArtifactSourceAccess("none", true, file, true), "blocked");
  assert.equal(workspaceArtifactSourceAccess("full", false, shell, true), "blocked");
});

test("page data binds each source by name, null until it first loads", () => {
  const artifact = {
    visual: { dataJson: '{"title":"PRs","pulls":"static"}' } as never,
    sources: [
      { name: "pulls", kind: "shell", command: "x", parse: "json" },
      { name: "todo", kind: "file", file: "t", parse: "lines" },
    ] satisfies WorkspaceArtifactSourceV1[],
  };
  const snapshot = parseWorkspaceArtifactSnapshotV1({
    revision: 1,
    refreshedAt: 1,
    sources: { pulls: { status: "error", at: 1, dataJson: "[1,2]", error: "offline" } },
  });
  assert.deepEqual(JSON.parse(workspaceArtifactDataJson(artifact, snapshot)!), { title: "PRs", pulls: [1, 2], todo: null });
});
