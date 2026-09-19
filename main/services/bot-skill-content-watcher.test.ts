import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  botRuntimeInventoryLeases,
} from "./bot-runtime-inventory-lease.js";
import { BotSkillContentWatcher } from "./bot-skill-content-watcher.js";
import { SkillRegistry } from "./skill-registry.js";

test("editing an admitted discovered skill aborts the live Bot inventory lease", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-skill-watch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillDirectory = path.join(root, "skill");
  const skillFile = path.join(skillDirectory, "SKILL.md");
  await fs.mkdir(skillDirectory);
  await fs.writeFile(skillFile, "---\nname: Skill\n---\nBefore\n", "utf8");

  const watcher = new BotSkillContentWatcher();
  t.after(() => watcher.dispose());
  await watcher.watchSkillFiles([skillFile]);
  await settleWatcherEvents();
  const lease = botRuntimeInventoryLeases.acquire();
  const aborted = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Skill watcher did not invalidate live Bot authority.")),
      5_000,
    );
    lease.signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
  await fs.writeFile(skillFile, "---\nname: Skill\n---\nAfter\n", "utf8");
  await aborted;

  assert.equal(lease.signal.aborted, true);
  assert.throws(() => lease.assertCurrent(), /capabilities changed/u);
});

test("watcher ignores unrelated files beside a skill", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-skill-watch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillFile = path.join(root, "SKILL.md");
  await fs.writeFile(skillFile, "Skill", "utf8");
  let changes = 0;
  const watcher = new BotSkillContentWatcher(() => { changes += 1; });
  t.after(() => watcher.dispose());
  await watcher.watchSkillFiles([skillFile]);
  // Darwin may deliver the directory's already-queued creation notification
  // immediately after watch registration. That event predates the behavior
  // under test, so establish a quiet baseline before creating the unrelated
  // sibling.
  await new Promise<void>((resolve) => setTimeout(resolve, 75));
  changes = 0;

  await fs.writeFile(path.join(root, "notes.txt"), "Unrelated", "utf8");
  await new Promise<void>((resolve) => setTimeout(resolve, 50));

  assert.equal(changes, 0);
});

test("a watched edit invalidates a warm runtime skill snapshot immediately", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-skill-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillFile = path.join(root, "SKILL.md");
  await fs.writeFile(skillFile, "Before", "utf8");
  const workspace = {
    id: "workspace",
    name: "Workspace",
    folderPath: root,
    permission: "full" as const,
    createdAt: 1,
    updatedAt: 1,
  };
  const registry = new SkillRegistry({
    getWorkspace: async () => workspace,
    listConfigured: async () => [],
    discover: async () => [{
      id: `workspace:${skillFile}`,
      name: "Watched",
      description: "Watched skill",
      instructions: await fs.readFile(skillFile, "utf8"),
      source: "workspace" as const,
      path: skillFile,
    }],
    invocationKey: new Uint8Array(32).fill(9),
    cacheTtlMs: 5_000,
  });
  let resolveChanged = () => {};
  const watcher = new BotSkillContentWatcher(() => {
    registry.invalidate();
    resolveChanged();
  });
  t.after(() => watcher.dispose());
  await watcher.watchSkillFiles([skillFile]);
  await settleWatcherEvents();
  assert.equal((await registry.snapshot(workspace.id)).available[0]?.instructions, "Before");

  let changeTimeout: NodeJS.Timeout | undefined;
  const changed = new Promise<void>((resolve, reject) => {
    changeTimeout = setTimeout(
      () => reject(new Error("Skill watcher did not invalidate the warm Bot snapshot.")),
      1_000,
    );
    resolveChanged = () => {
      clearTimeout(changeTimeout);
      resolve();
    };
  });
  t.after(() => clearTimeout(changeTimeout));
  await fs.writeFile(skillFile, "After", "utf8");
  await changed;

  assert.equal((await registry.snapshot(workspace.id)).available[0]?.instructions, "After");
});

const settleWatcherEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 100));

async function waitForChange(readChanges: () => number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (readChanges() === 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(readChanges() > 0, "Skill watcher must observe the current skill directory");
}

test("watcher observes atomic skill replacement and subsequent edits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-skill-atomic-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillFile = path.join(root, "SKILL.md");
  await fs.writeFile(skillFile, "Before");
  let changes = 0;
  const watcher = new BotSkillContentWatcher(() => { changes += 1; });
  t.after(() => watcher.dispose());
  await watcher.watchSkillFiles([skillFile]);
  await settleWatcherEvents();
  changes = 0;
  const stagedFile = path.join(root, "SKILL.md.tmp");
  await fs.writeFile(stagedFile, "Replacement");
  await fs.rename(stagedFile, skillFile);
  await waitForChange(() => changes);
  await settleWatcherEvents();
  changes = 0;
  await fs.writeFile(skillFile, "After replacement");
  await waitForChange(() => changes);
});

test("disposal fences an in-flight skill registration", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-skill-dispose-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillFile = path.join(root, "SKILL.md");
  await fs.writeFile(skillFile, "Before");
  let changes = 0;
  const watcher = new BotSkillContentWatcher(() => { changes += 1; });
  t.after(() => watcher.dispose());
  const pending = watcher.watchSkillFiles([skillFile]);
  watcher.dispose();
  await pending;
  // Callback suppression alone would hide a leaked native watcher.
  assert.equal(Reflect.get(watcher, "directories").size, 0);
  await settleWatcherEvents();
  changes = 0;
  await fs.writeFile(skillFile, "After disposal");
  await settleWatcherEvents();
  assert.equal(changes, 0, "Pending registration must not resurrect disposed watchers");
});

test("disposed skill watchers cannot be registered again", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-skill-disposed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillFile = path.join(root, "SKILL.md");
  await fs.writeFile(skillFile, "Before");
  let changes = 0;
  const watcher = new BotSkillContentWatcher(() => { changes += 1; });
  t.after(() => watcher.dispose());
  watcher.dispose();
  await watcher.watchSkillFiles([skillFile]);
  assert.equal(Reflect.get(watcher, "directories").size, 0);
  await settleWatcherEvents();
  changes = 0;
  await fs.writeFile(skillFile, "After disposal");
  await settleWatcherEvents();
  assert.equal(changes, 0, "Disposed watcher must remain closed");
});

test("disposal closes installed watchers and permits a fresh independent instance", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-skill-close-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillFile = path.join(root, "SKILL.md");
  await fs.writeFile(skillFile, "Before");
  let retiredChanges = 0;
  const retired = new BotSkillContentWatcher(() => { retiredChanges += 1; });
  t.after(() => retired.dispose());
  await retired.watchSkillFiles([skillFile]);
  await settleWatcherEvents();
  retired.dispose();
  retired.dispose();
  retiredChanges = 0;

  let freshChanges = 0;
  const fresh = new BotSkillContentWatcher(() => { freshChanges += 1; });
  t.after(() => fresh.dispose());
  await fresh.watchSkillFiles([skillFile]);
  await settleWatcherEvents();
  freshChanges = 0;
  await fs.writeFile(skillFile, "After disposal");
  await waitForChange(() => freshChanges);
  await settleWatcherEvents();
  assert.equal(retiredChanges, 0);
});
