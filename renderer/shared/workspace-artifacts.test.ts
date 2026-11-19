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
const PLACEMENT_REFUSED = /own unquoted word|runs without a shell, so it may not use|may not be passed/u;

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
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "constructor", kind: "shell", command: "x" }]), /identifier/u);
  assert.throws(() => parseWorkspaceArtifactSources([{ name: "path", kind: "shell", command: "x" }]), /identifier/u);
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
  const hostile = [`$(touch /tmp/aiden-pwned)`, `'; echo hi; '`, "a  b c", `"$HOME"`, "`id`", "plain", "x\"y"];
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
    "git config -f {{x}} user.name me",
    "uniq notes.txt {{x}}",
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
  assert.deepEqual(resolved.steps, [
    { connector: ";", pipeline: [{ argv: ["git", "fetch", "-q"], redirects: ["2>/dev/null"] }] },
    { connector: "||", pipeline: [{ argv: ["git", "status"], redirects: [] }] },
    {
      connector: "&&",
      pipeline: [
        { argv: ["git", "log", "-1", "main"], redirects: ["2>&1"] },
        { argv: ["head", "-n", "1"], redirects: [] },
      ],
    },
    { connector: ";", pipeline: [{ argv: ["git", "status"], redirects: [">/dev/null"] }] },
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
    "git worktree add ../review {{x}}",
    "git remote -v | grep -F -- {{x}}",
    "gh browse {{x}}",
    "gh run view {{x}} --log | tail -n 20",
    "jq -r .name {{x}} | sort | uniq -c",
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
    "gh issue create --title {{x}}",
    "gh extension install {{x}}",
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
  // The refusal names the program and what page data may be passed to.
  assert.throws(() => parseWorkspaceArtifactActions(actions("npm view {{x}} version")), (error: Error) => {
    assert.match(error.message, /a command that uses npm\b/u);
    assert.match(error.message, /\bgit status\b.*\bgh pr\b.*\bjq\b/u);
    return true;
  });
});

test("filled-in values are checked against their declared types", () => {
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["x", "not a number"]), /number/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, [{ nested: true }, 1]), /text/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["a\u0000b", 1]), /control/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["a\u202eb", 1]), /control/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["--upload-pack=x", 1]), /cannot start with "-"/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["a", 1, "extra"]), /takes 2/u);
  assert.equal(resolveWorkspaceArtifactCommand(merge, ["x", "42"]).preview, "printf '%s|%s' 'x' '42'");
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["x", -1]), /cannot be negative/u);
  assert.throws(() => resolveWorkspaceArtifactCommand(merge, ["x", "-1"]), /cannot be negative/u);
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
