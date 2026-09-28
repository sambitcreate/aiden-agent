/** Bundle with esbuild and run using the pinned Electron executable (see evidence doc). */
import { app } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodingTools } from "../main/services/coding-tools.js";

void app.whenReady().then(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-electron-file-tools-"));
  try {
    const tools = buildCodingTools(root);
    const invoke = async (name: string, params: object, signal?: AbortSignal) => {
      const result = await tools
        .find((tool) => tool.name === name)!
        .execute("electron-smoke", params, signal);
      const block = result.content[0];
      return block?.type === "text" ? block.text : "";
    };
    await fs.mkdir(path.join(root, "src/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "src/sub/b.ts"), "");
    await fs.writeFile(path.join(root, "src/a.ts"), "foobar foofoo\n");
    await fs.symlink("src", path.join(root, "link"));
    const globs = [
      "*",
      "**",
      "**/*",
      "**/*.ts",
      "src/**",
      "src",
      "src/*.{ts,js}",
      "link/*.ts",
      "*/a.ts",
      "**/*/*.ts",
      "{src,link}/**/*",
      "src/**/..",
      `{${path.join(root, "src/*.ts")},src/sub/*.ts}`,
    ];
    for (const pattern of globs) {
      const expected: string[] = [];
      for await (const entry of fs.glob(pattern, { cwd: root })) expected.push(entry);
      assert.equal(
        await invoke("glob", { pattern }),
        expected.sort().join("\n") || "[no matches]",
        pattern,
      );
    }
    assert.equal(
      await invoke("grep", { pattern: "(?<=foo)bar|\\b(foo)\\1\\b" }),
      "src/a.ts:1: foobar foofoo",
    );
    for (let i = 0; i < 6; i++)
      await assert.rejects(invoke("grep", { pattern: "[" }), /Invalid regular expression/);
    await fs.writeFile(path.join(root, "src/a.ts"), "a".repeat(100_000) + "!");
    const cancellationMs: number[] = [];
    for (let i = 0; i < 6; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("electron cancelled")), 150);
      const start = performance.now();
      try {
        await assert.rejects(
          invoke("grep", { pattern: "^(a+)+$" }, controller.signal),
          /electron cancelled/,
        );
      } finally {
        clearTimeout(timer);
      }
      cancellationMs.push(performance.now() - start);
    }
    assert.match(await invoke("grep", { pattern: "^(a+)+$" }), /search stopped after 5000 ms/);
    assert.equal(await invoke("grep", { pattern: "missing" }), "[no matches]");
    const resources = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "MessagePort");
    assert.deepEqual(resources, []);
    console.log(
      JSON.stringify(
        {
          electron: process.versions.electron,
          node: process.version,
          globs,
          cancellationMs,
          deadline: "settled with incomplete notice",
          workerPortsAfter: resources.length,
          result: "passed",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    app.exit(process.exitCode ?? 0);
  }
});
