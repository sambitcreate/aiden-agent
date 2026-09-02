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

const WATCH_REGISTRATION_SETTLE_MS = 75;
const WATCH_EVENT_DEADLINE_MS = 5_000;

async function settleWatcherRegistration(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, WATCH_REGISTRATION_SETTLE_MS));
}

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
  await settleWatcherRegistration();
  const lease = botRuntimeInventoryLeases.acquire();
  t.after(() => lease.release());
  const aborted = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Skill watcher did not invalidate live Bot authority.")),
      WATCH_EVENT_DEADLINE_MS,
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
  await settleWatcherRegistration();
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
  assert.equal((await registry.snapshot(workspace.id)).available[0]?.instructions, "Before");

  let resolveChanged!: () => void;
  let changeTimeout: NodeJS.Timeout | undefined;
  const changed = new Promise<void>((resolve, reject) => {
    changeTimeout = setTimeout(
      () => reject(new Error("Skill watcher did not invalidate the warm Bot snapshot.")),
      WATCH_EVENT_DEADLINE_MS,
    );
    resolveChanged = () => {
      clearTimeout(changeTimeout);
      resolve();
    };
  });
  t.after(() => clearTimeout(changeTimeout));
  const watcher = new BotSkillContentWatcher(() => {
    registry.invalidate();
    resolveChanged();
  });
  t.after(() => watcher.dispose());
  await watcher.watchSkillFiles([skillFile]);
  await settleWatcherRegistration();
  await fs.writeFile(skillFile, "After", "utf8");
  await changed;

  assert.equal((await registry.snapshot(workspace.id)).available[0]?.instructions, "After");
});
