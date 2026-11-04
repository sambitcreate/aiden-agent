import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  coveredByBotLocations,
  resolveBotAccessTarget,
  type BotAccessTargetDeps,
} from "./bot-access-target.js";

test("resolve folders, files, home, symlinks and exact approved-root boundaries", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bot-target-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const home = await fs.realpath(temp),
    documents = path.join(home, "Documents"),
    taxes = path.join(documents, "Taxes"),
    privateRoot = path.join(home, "Aiden");
  await fs.mkdir(taxes, { recursive: true });
  await fs.mkdir(path.join(privateRoot, "bots", "x"), { recursive: true });
  await fs.writeFile(path.join(taxes, "2025.pdf"), "return");
  await fs.symlink(path.join(privateRoot, "bots", "x"), path.join(home, "link"));
  let roots: { id: string; folderPath: string }[] = [];
  const deps: BotAccessTargetDeps = {
    homeDirectory: () => home,
    privateRoots: () => [privateRoot],
    approvedRoots: async () => roots,
  };
  const file = await resolveBotAccessTarget(path.join(taxes, "2025.pdf"), deps);
  assert.equal(file.kind, "folder");
  if (file.kind !== "folder") throw new Error("Expected folder");
  assert.equal(file.root, taxes);
  assert.equal(file.label, "Taxes");
  assert.equal(file.place, "~/Documents/Taxes");
  const stat = await fs.stat(taxes, { bigint: true });
  assert.equal(file.device, String(stat.dev));
  assert.equal(file.inode, String(stat.ino));
  assert.deepEqual(file.always, { kind: "new" });
  assert.deepEqual(await resolveBotAccessTarget(path.join(home, "link"), deps), {
    kind: "refused",
    reason: "private",
  });
  roots = [{ id: "root_a", folderPath: documents }];
  assert.deepEqual(((await resolveBotAccessTarget(taxes, deps)) as typeof file).always, {
    kind: "none",
    reason: "covered",
  });
  assert.deepEqual(((await resolveBotAccessTarget(documents, deps)) as typeof file).always, {
    kind: "existing",
    rootId: "root_a",
  });
  roots = [{ id: "root_a", folderPath: taxes }];
  assert.deepEqual(((await resolveBotAccessTarget(documents, deps)) as typeof file).always, {
    kind: "none",
    reason: "overlaps",
  });
  assert.deepEqual(((await resolveBotAccessTarget("~", deps)) as typeof file).always, {
    kind: "none",
    reason: "home",
  });
  assert.equal(
    ((await resolveBotAccessTarget("~/Documents/Taxes", deps)) as typeof file).root,
    taxes,
  );
  for (const [input, reason] of [
    ["relative", "not_absolute"],
    ["/", "filesystem_root"],
    [path.join(home, "missing"), "not_found"],
    ["/" + "é".repeat(2048), "too_long"],
  ]) {
    assert.deepEqual(await resolveBotAccessTarget(input!, deps), { kind: "refused", reason });
  }
  assert.deepEqual(await resolveBotAccessTarget("whole_mac", deps), { kind: "whole_mac" });
});
test("coverage respects path segments and independently sufficient access mode", () => {
  assert.equal(coveredByBotLocations("/a/b/c", [{ root: "/a/b" }]), true);
  assert.equal(coveredByBotLocations("/a/bc", [{ root: "/a/b" }]), false);
  assert.equal(coveredByBotLocations("/a/b/c", [{ root: "/a/b", access: "read" }], "write"), false);
  assert.equal(
    coveredByBotLocations(
      "/a/b/c",
      [
        { root: "/a/b", access: "read" },
        { root: "/a/b/c", access: "write" },
      ],
      "write",
    ),
    true,
  );
});
