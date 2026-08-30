import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createNativeSubagentRunStoreStorage } from "./subagent-run-store-io.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const binary = path.join(repositoryRoot, "build", "native", "aiden-subagent-run-store");

test("native run-store adapter accepts the platform generation and round-trips data", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("The native run-store helper is supported only on macOS and Linux.");
    return;
  }
  const parent = await mkdtemp(path.join(os.tmpdir(), "aiden-run-store-io-"));
  const storage = createNativeSubagentRunStoreStorage(path.join(parent, "store"), binary);
  t.after(async () => {
    await storage.close();
    await rm(parent, { recursive: true, force: true });
  });

  assert.deepEqual(await storage.read(), {
    status: "missing",
    contents: undefined,
    generation: "missing",
  });
  const first = await storage.write("missing", '{"revision":1}');
  assert.match(
    first,
    process.platform === "linux"
      ? /^[0-9a-f]+(?:-[0-9a-f]+){6}$/u
      : /^[0-9a-f]+(?:-[0-9a-f]+){8}$/u,
  );
  assert.deepEqual(await storage.read(), {
    status: "data",
    contents: Buffer.from('{"revision":1}'),
    generation: first,
  });
  const second = await storage.write(first, '{"revision":2}');
  assert.notEqual(second, first);
  await storage.syncDirectory();
});
