/** Run with npm run test:foreground-file-tools:electron (owns build and fixture cleanup). */
import { app } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { buildCodingTools } from "../main/services/coding-tools.js";
import { ForegroundReadCleanupError, ForegroundReadOperations } from "../main/services/foreground-read-scope.js";

// Caller cancellation deliberately precedes cleanup. Observe the original
// operations so sequential smoke samples join cleanup rather than racing the
// four-owner admission limit. The runner's hard deadline still bounds this wait.
const pendingOperations = new Set<Promise<unknown>>();
const cleanupFailures: ForegroundReadCleanupError[] = [];
const originalRun = ForegroundReadOperations.prototype.run;
ForegroundReadOperations.prototype.run = function <T>(
  signal: AbortSignal | undefined,
  durationMs: number | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutResult: () => T,
): Promise<T> {
  return originalRun.call(this, signal, durationMs, async (ownedSignal) => {
    const pending = operation(ownedSignal);
    pendingOperations.add(pending);
    try { return await pending; }
    catch (error) {
      if (error instanceof ForegroundReadCleanupError) cleanupFailures.push(error);
      throw error;
    }
    finally { pendingOperations.delete(pending); }
  }, timeoutResult) as Promise<T>;
};

async function settleForegroundOperations() {
  await Promise.allSettled([...pendingOperations]);
  // Let the scope's completion handler release its admission after cleanup.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pendingOperations.size, 0);
  assert.deepEqual(cleanupFailures, [], "Cancelled operations must release every owned resource.");
}

async function smoke() {
  const [root, profile] = process.argv.slice(2);
  assert.ok(root && profile, "Run through the foreground smoke package script.");
  app.setPath("userData", profile);
  await app.whenReady();
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
    await settleForegroundOperations();
  }
  assert.match(await invoke("grep", { pattern: "^(a+)+$" }), /search stopped after 5000 ms/);
  await settleForegroundOperations();
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
        globs: globs.map((pattern) => pattern.replaceAll(root, "<workspace>")),
        cancellationMs,
        deadline: "settled with incomplete notice",
        workerPortsAfter: resources.length,
        result: "passed",
      },
      null,
      2,
    ),
  );
}

void smoke().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
