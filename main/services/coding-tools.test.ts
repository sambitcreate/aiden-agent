import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildCodingTools, summarizeToolCall } from "./coding-tools.js";

test("approval summaries describe the consequence of mutating tools", () => {
  assert.equal(
    summarizeToolCall("write_file", { path: "src/app.ts" }),
    "Create or replace file: src/app.ts",
  );
  assert.equal(summarizeToolCall("edit_file", { path: "src/app.ts" }), "Edit file: src/app.ts");
  assert.equal(summarizeToolCall("run_command", { command: "npm test" }), "Run command: npm test");
});

test("workspace search and read tools exclude .env files from model-visible results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-grep-"));
  try {
    await fs.writeFile(path.join(root, ".env"), "SECRET_TOKEN=do-not-expose\n", "utf8");
    await fs.writeFile(path.join(root, "visible.txt"), "PUBLIC_TOKEN=show-this\n", "utf8");
    const readFile = buildCodingTools(root).find((tool) => tool.name === "read_file");
    const glob = buildCodingTools(root).find((tool) => tool.name === "glob");
    const grep = buildCodingTools(root).find((tool) => tool.name === "grep");
    assert.ok(readFile);
    assert.ok(glob);
    assert.ok(grep);

    await assert.rejects(
      readFile.execute("test", { path: ".env" }),
      /Reading \.env files is disabled/,
    );
    const globResult = await glob.execute("test", { pattern: "*" });
    const globBlock = globResult.content[0];
    assert.equal(globBlock?.type, "text");
    const globText = globBlock?.type === "text" ? globBlock.text : "";
    assert.match(globText, /visible\.txt/);
    assert.doesNotMatch(globText, /\.env/);
    const secretGlobResult = await glob.execute("test", { pattern: ".env" });
    const secretGlobBlock = secretGlobResult.content[0];
    assert.equal(secretGlobBlock?.type, "text");
    assert.equal(secretGlobBlock?.type === "text" ? secretGlobBlock.text : "", "[no matches]");

    const result = await grep.execute("test", { pattern: "TOKEN" });
    const block = result.content[0];
    assert.equal(block?.type, "text");
    const text = block?.type === "text" ? block.text : "";
    assert.match(text, /visible\.txt:1: PUBLIC_TOKEN=show-this/);
    assert.doesNotMatch(text, /SECRET_TOKEN/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("filesystem tools do not follow workspace symlinks outside the root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-tools-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-tools-outside-"));
  try {
    const outsideFile = path.join(outside, "secret.txt");
    const danglingOutsideFile = path.join(outside, "created-later.txt");
    await fs.writeFile(outsideFile, "SECRET_TOKEN=do-not-expose\n", "utf8");
    await fs.symlink(outsideFile, path.join(root, "linked-secret"));
    await fs.symlink(danglingOutsideFile, path.join(root, "dangling-secret"));

    const tools = buildCodingTools(root);
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;
    const readFile = byName("read_file");
    const editFile = byName("edit_file");
    const writeFile = byName("write_file");
    const listDir = byName("list_dir");
    const grep = byName("grep");
    const glob = byName("glob");

    await assert.rejects(
      readFile.execute("test", { path: "linked-secret" }),
      /outside the workspace/,
    );
    await assert.rejects(
      editFile.execute("test", {
        path: "linked-secret",
        old_string: "SECRET",
        new_string: "PUBLIC",
      }),
      /outside the workspace/,
    );
    await assert.rejects(
      writeFile.execute("test", { path: "linked-secret", content: "changed" }),
      /outside the workspace/,
    );
    await assert.rejects(
      writeFile.execute("test", { path: "dangling-secret", content: "changed" }),
      /dangling symbolic link/,
    );
    await assert.rejects(
      listDir.execute("test", { path: "linked-secret" }),
      /outside the workspace/,
    );
    await assert.rejects(
      grep.execute("test", { pattern: "TOKEN", path: "linked-secret" }),
      /outside the workspace/,
    );

    const globResult = await glob.execute("test", { pattern: "*" });
    const globBlock = globResult.content[0];
    assert.equal(globBlock?.type, "text");
    assert.doesNotMatch(globBlock?.type === "text" ? globBlock.text : "", /linked-secret/);
    assert.equal(await fs.readFile(outsideFile, "utf8"), "SECRET_TOKEN=do-not-expose\n");
    await assert.rejects(fs.access(danglingOutsideFile));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("run_command cancellation kills the shell process group", async () => {
  if (process.platform === "win32") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-command-"));
  try {
    const runCommand = buildCodingTools(root).find((tool) => tool.name === "run_command");
    assert.ok(runCommand);
    const controller = new AbortController();
    const startedAt = Date.now();
    const running = runCommand.execute("test", { command: "sleep 30 & exit 0" }, controller.signal);
    setTimeout(() => controller.abort(new Error("test cancellation")), 50);
    await assert.rejects(running, /test cancellation/);
    assert.ok(Date.now() - startedAt < 3_000, "command process group should settle promptly");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
