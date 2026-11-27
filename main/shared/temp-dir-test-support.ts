import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, type TestContext } from "node:test";

export async function temporaryDirectory(
  t: Pick<TestContext, "after">,
  prefix: string,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

export function createTempDirRegistry(): {
  create: (prefix: string) => Promise<string>;
} {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });
  return {
    async create(prefix: string): Promise<string> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
  };
}
