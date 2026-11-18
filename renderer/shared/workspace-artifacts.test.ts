import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
  type WorkspaceArtifactActionV1,
  type WorkspaceArtifactSourceV1,
} from "./workspace-artifacts.js";

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

test("filled-in values reach the shell as single literal words", () => {
  // The shell itself is the oracle: whatever the page passes comes back verbatim.
  const hostile = [`$(touch /tmp/aiden-pwned)`, `'; echo hi; '`, "a  b c", `"$HOME"`, "`id`", "plain", "x\"y"];
  for (const value of hostile) {
    const { command } = resolveWorkspaceArtifactCommand(merge, [value, 3]);
    const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    assert.equal(output, `${value}|3`, value);
  }
});

test("a value never runs as code, even where a template quotes its placeholder", () => {
  const marker = path.join(os.tmpdir(), `aiden-artifact-injection-${process.pid}`);
  fs.rmSync(marker, { force: true });
  // These shapes are rejected when the model saves an action; the runner is safe even so.
  for (const template of [`printf '%s' "{{body}}"`, `printf '%s' '{{body}}'`, "printf '%s' `echo {{body}}`", `printf '%s' $(echo {{body}})`]) {
    const action: WorkspaceArtifactActionV1 = { name: "a", label: "A", command: template, params: [{ name: "body", type: "string" }] };
    for (const value of [`$(touch ${marker})`, `'; touch ${marker}; '`, `\`touch ${marker}\``]) {
      execFileSync("/bin/sh", ["-c", resolveWorkspaceArtifactCommand(action, [value]).command], { encoding: "utf8" });
    }
  }
  assert.equal(fs.existsSync(marker), false);
});

test("a template cannot run with a different value from the one its confirmation shows", () => {
  const action = (command: string): WorkspaceArtifactActionV1 => ({ name: "a", label: "A", command, params: [{ name: "target", type: "string" }] });
  // Each template is accepted, yet tries to swap the value after it was bound.
  for (const template of [
    "set -- actual-target; printf '%s' {{target}}",
    "f() { printf '%s' {{target}}; }; f actual-target",
    "AIDEN_ARG_1=actual-target; printf '%s' {{target}}",
    "f() { local AIDEN_ARG_1=actual-target; printf '%s' {{target}}; }; f",
    "unset AIDEN_ARG_1; printf '%s' {{target}}",
  ]) {
    // Saving refuses templates that name the reserved variables; the binding holds even so.
    if (template.includes("AIDEN_ARG_")) assert.throws(() => parseWorkspaceArtifactActions([action(template)]), /reserved/u);
    else parseWorkspaceArtifactActions([action(template)]);
    const { command, preview } = resolveWorkspaceArtifactCommand(action(template), ["shown-target"]);
    assert.equal(spawnSync("/bin/sh", ["-c", preview], { encoding: "utf8" }).stdout, "shown-target", template);
    const ran = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    // Either it uses what the person confirmed, or the shell refuses; never the other target.
    if (ran.status === 0) assert.equal(ran.stdout, "shown-target", template);
    else assert.equal(ran.stdout.includes("actual-target"), false, template);
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
  ]) {
    assert.throws(() => parseWorkspaceArtifactActions(action(command)), /own unquoted word/u, command);
  }
  for (const command of [
    "gh pr merge {{x}} --squash",
    "echo {{x}}; echo done",
    "(cd sub && git switch {{x}})",
    `echo "fixed" {{x}}`,
    "git show HEAD:{{x}}",
    "git push origin {{x}}:refs/heads/{{y}}",
    "cat notes/{{x}}.md",
    "gh api repos/acme/app/issues -f title={{x}}",
    "printf '%s' {{x}} >notes/{{y}}.txt",
  ]) {
    assert.equal(parseWorkspaceArtifactActions(action(command)).length, 1, command);
  }
});

test("a joined value reaches the program as part of one literal argument", () => {
  const action = parseWorkspaceArtifactActions([
    { name: "a", label: "A", command: "printf '%s|' HEAD:{{x}} {{x}}.md", params: [{ name: "x", type: "string" }] },
  ])[0]!;
  for (const value of ["main", "a b", "$(id)", "*", "x;y"]) {
    const { command, preview } = resolveWorkspaceArtifactCommand(action, [value]);
    assert.equal(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }), `HEAD:${value}|${value}.md|`, value);
    assert.equal(execFileSync("/bin/sh", ["-c", preview], { encoding: "utf8" }), `HEAD:${value}|${value}.md|`, value);
  }
});

test("a placeholder cannot be run as a command, hidden from the check, or read as bash arithmetic", () => {
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
  ];
  for (const command of refused) assert.throws(() => parseWorkspaceArtifactActions(actions(command)), /own unquoted word/u, command);
  for (const command of [
    "[[ {{x}} -gt 0 ]] && echo big",
    "(( {{x}} > 0 )) && echo big",
    "let {{x}}",
    "f() { local {{x}}; }; f",
    "seed=1 let {{x}}",
    "if true; then let {{x}}; fi",
    "(( 0 < {{x}} ))",
    "(( 0 >> {{x}} ))",
    "[[ 0 > {{x}} ]]",
    // Builtins that take a variable name evaluate its [subscript].
    "read {{x}} </dev/null",
    "printf -v {{x}} %s ok",
    "[ -v {{x}} ]",
    "unset {{x}}",
  ]) {
    assert.throws(() => parseWorkspaceArtifactActions(actions(command)), /arithmetic/u, command);
    assert.equal(parseWorkspaceArtifactActions(actions(command, "number")).length, 1, command);
  }
  // Text is fine outside those places, even when the same template uses them elsewhere.
  for (const command of [
    "[ {{x}} -gt 0 ] && echo big",
    "gh pr view {{x}} # the number",
    "printf '%s\\n' {{x}} | sort",
    "printf %s {{x}} # comparison uses [[ later",
    "if (( 1 )); then printf %s {{x}}; fi",
    "[[ -d .git ]] && git checkout {{x}}",
    "f() { local result=ok; printf %s {{x}}; }; f",
    "echo '((' {{x}}",
    'echo "$(git rev-parse HEAD)" {{x}}',
    "sh -c 'printf %s \"$1\"' sh {{x}}",
    // Words that merely spell a command name are data, not the command.
    "printf '%s\\n' command | grep -F command -- {{x}}",
    "printf '%s\\n' command is {{x}}",
    "grep -c {{x}} notes.txt",
    "python3 scripts/report.py {{x}}",
    "node -e 'console.log(process.argv[1])' {{x}}",
    "awk '{ print $1 }' {{x}}",
    "awk -F , -f report.awk {{x}}",
    "sed -n '1,5p' {{x}}",
    "sqlite3 {{x}} 'select 1'",
    "git log --format={x} 2>&1 {{x}}",
    "gh pr merge \\\n  {{x}} --squash",
    "printf -v out %s {{x}}",
    "read -r first < {{x}}; printf %s \"$first\"",
    "git grep -c {{x}}",
    "git log -c {{x}}",
    "git --no-pager -C repo log -c {{x}}",
    "git --no-literal-pathspecs log -c {{x}}",
    // The same option names elsewhere, or in another subcommand, take plain values.
    "git cherry-pick -x {{x}}",
    "git push -u origin {{x}}",
    "rsync -av {{x}} backup/",
    "tar -xf {{x}}",
    "make -j {{x}} test",
    "git config user.name {{x}}",
    "git config --global user.email {{x}}",
    "git send-email --to {{x}} patch",
    "gh issue create --title {{x}} --label bug",
    "gh pr create --base main --head {{x}} --fill",
    "npm run build -- {{x}}",
    "go test -run {{x}} ./...",
    "sort -k 2 {{x}}",
  ]) {
    assert.equal(parseWorkspaceArtifactActions(actions(command)).length, 1, command);
  }
});

test("no template the parser accepts lets a text value run code", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-artifact-oracle-"));
  const marker = path.join(dir, "ran");
  const script = path.join(dir, "run-me");
  fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  // Each value runs code if something reads it as shell, a program to start,
  // an awk program, a sed script, Python, a git alias or make's shell.
  const values = [
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
        const { command } = resolveWorkspaceArtifactCommand(action, [value]);
        for (const [shell, args] of [["/bin/sh", ["-c"]], ["bash", ["--posix", "-c"]], ["bash", ["-c"]]] as const) {
          spawnSync(shell, [...args, command], { cwd: dir, encoding: "utf8", stdio: "ignore", timeout: 5000 });
          assert.equal(fs.existsSync(marker), false, `${template} ran ${value} under ${shell} ${args.join(" ")}`);
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(accepted >= 6, "the oracle should exercise accepted templates too");
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
