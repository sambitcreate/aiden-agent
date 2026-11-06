import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  botAccessPrivateRoots,
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

test("private storage and its parents are refused while Home remains once-only", async (t) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bot-target-private-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const parent = path.join(home, "Library", "Application Support");
  const privateRoot = path.join(parent, "Aiden");
  const configDirectory = path.join(home, ".aiden");
  await fs.mkdir(path.join(privateRoot, "bots", "other"), { recursive: true });
  await fs.mkdir(configDirectory);
  await fs.writeFile(path.join(configDirectory, "extra-config.json"), "config outside userData");
  await fs.mkdir(path.join(home, "Documents"));
  await fs.symlink(parent, path.join(home, "alias"));
  await fs.symlink(configDirectory, path.join(home, "config-alias"));
  const deps: BotAccessTargetDeps = { homeDirectory: () => home, privateRoots: () => botAccessPrivateRoots(privateRoot, configDirectory), approvedRoots: async () => [] };
  for (const requested of [parent, path.join(home, "Library"), path.join(home, "alias"), privateRoot, configDirectory, path.join(configDirectory, "extra-config.json"), path.join(home, "config-alias")]) {
    assert.deepEqual(await resolveBotAccessTarget(requested, deps), { kind: "refused", reason: "private" }, requested);
  }
  const ordinary = await resolveBotAccessTarget(path.join(home, "Documents"), deps);
  assert.equal(ordinary.kind, "folder");
  if (ordinary.kind === "folder") assert.deepEqual(ordinary.always, { kind: "new" });
  const resolved = await resolveBotAccessTarget("~", deps);
  assert.equal(resolved.kind, "folder");
  if (resolved.kind === "folder") assert.deepEqual(resolved.always, { kind: "none", reason: "home" });
});

test("only approved roots overlapping the target invalidate its inventory snapshot", async (t) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bot-target-inventory-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const target = path.join(home, "Documents", "Taxes");
  const unrelated = path.join(home, "Documents-old");
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(unrelated);
  let roots: { id: string; folderPath: string }[] = [];
  const deps: BotAccessTargetDeps = { homeDirectory: () => home, privateRoots: () => [], approvedRoots: async () => roots };
  const revision = async () => { const resolved = await resolveBotAccessTarget(target, deps); assert.equal(resolved.kind, "folder"); return resolved.kind === "folder" ? resolved.inventoryRevision : undefined; };
  const captured = await revision();
  assert.ok(captured);
  roots = [{ id: "unrelated", folderPath: unrelated }];
  assert.equal(await revision(), captured, "an unrelated addition leaves the answer valid");
  roots = [];
  assert.equal(await revision(), captured, "an unrelated removal leaves the answer valid");
  for (const folderPath of [path.dirname(target), target, path.join(target, "2025")]) {
    await fs.mkdir(folderPath, { recursive: true });
    roots = [{ id: "relevant", folderPath }];
    assert.notEqual(await revision(), captured, folderPath);
  }
});

test("a transient target filesystem read failure is preserved rather than declared stale or missing", async () => {
  const failure = Object.assign(new Error("temporary disk read failure"), { code: "EIO" });
  await assert.rejects(resolveBotAccessTarget("/ordinary", {
    homeDirectory: () => "/home", privateRoots: () => [], approvedRoots: async () => [],
    filesystem: { realpath: async () => { throw failure; }, stat: async () => { throw new Error("unreachable"); } },
  }), (error: unknown) => error === failure);
});
