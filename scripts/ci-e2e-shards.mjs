import { appendFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Serial file windows from hosted CI 41534097337, including fixture work.
// Shard 3 was cancelled during its last file; its weight includes a conservative allowance.
// Weights affect scheduling only; newly discovered specs always run.
export const FILE_SECONDS = Object.freeze({
  "app-controls.spec.ts": 36,
  "assistant-scheduled-profile.spec.ts": 51,
  "bot-browser.spec.ts": 21,
  "bot-computer-tab.spec.ts": 5,
  "bot-connect-card.spec.ts": 4,
  "bot-handoff-own-screen.spec.ts": 10,
  "bot-sign-in.spec.ts": 3,
  "bots-persistence.spec.ts": 16,
  "bots-sidebar-panel.spec.ts": 6,
  "bots-starter.spec.ts": 14,
  "browser-agent.spec.ts": 28,
  "browser-cancellation.spec.ts": 41,
  "browser-initial-crash.spec.ts": 2,
  "browser-lifecycle.spec.ts": 122,
  "browser-throttling.spec.ts": 22,
  "browser.spec.ts": 95,
  "chat-follow-bottom.spec.ts": 60,
  "chat-fork.spec.ts": 9,
  "chat-message-queue.spec.ts": 163,
  "chat-shell-interactions.spec.ts": 192,
  "chat-top-bar.spec.ts": 166,
  "create-images.spec.ts": 84,
  "custom-model-options.spec.ts": 39,
  "cut-off-reply.spec.ts": 13,
  "draft-agent-chats.spec.ts": 112,
  "environment-devices-agent.spec.ts": 18,
  "environment-devices-android.spec.ts": 19,
  "environment-devices-features.spec.ts": 12,
  "environment-devices-stream.spec.ts": 18,
  "environment-devices-tab.spec.ts": 19,
  "environment-focus.spec.ts": 67,
  "follow-through-lifecycle.spec.ts": 36,
  "guided-setup.spec.ts": 88,
  "inbox-sidebar.spec.ts": 54,
  "inline-visuals.spec.ts": 44,
  "interrupted-question-resume.spec.ts": 57,
  "interrupted-reply-resume.spec.ts": 41,
  "linux-window-controls.spec.ts": 1,
  "lmstudio-chat-attachments.spec.ts": 22,
  "memory-list.spec.ts": 16,
  "model-call-retry.spec.ts": 21,
  "model-pad-responsive.spec.ts": 7,
  "no-workspace-chat.spec.ts": 15,
  "onboarding-lmstudio.spec.ts": 41,
  "peer-project-clone.spec.ts": 8,
  "provider-artwork.spec.ts": 8,
  "provider-failure-actions.spec.ts": 12,
  "providers-settings.spec.ts": 16,
  "quick-view-cards.spec.ts": 25,
  "remote-access-lifecycle.spec.ts": 20,
  "settings-connectors.spec.ts": 7,
  "settings-model-picker.spec.ts": 14,
  "settings-simulator-ssh-hosts.spec.ts": 8,
  "settings-unification.spec.ts": 125,
  "studio-foundation.spec.ts": 24,
  "terminal.spec.ts": 10,
  "usage-data.spec.ts": 11,
  "usage-limit-wait.spec.ts": 13,
  "workspace-folder-missing.spec.ts": 8,
  "workspace-panel.spec.ts": 140,
  "workspace-settings.spec.ts": 11,
  "worktree-folder-deleted.spec.ts": 9
});

export function discoverSpecs(directory = path.join(root, "tests/e2e")) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

export function planShards(specs, count = 3) {
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error("Invalid E2E shard count");
  if (!Array.isArray(specs) || new Set(specs).size !== specs.length || specs.some((file) =>
    typeof file !== "string" || !/^[\w/-]+(?:\.[\w-]+)*\.spec\.ts$/u.test(file) || file.includes(".."))) {
    throw new Error("Invalid or duplicate E2E spec paths");
  }
  const files = specs.filter((file) => !file.endsWith(".live.spec.ts") && file !== "diagnostics-production.spec.ts");
  const weight = (file) => FILE_SECONDS[file] ?? 30;
  files.sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, "en"));
  const shards = Array.from({ length: count }, (_, index) => ({ index: index + 1, seconds: 0, files: [] }));
  for (const file of files) {
    const shard = shards.reduce((best, candidate) => candidate.seconds < best.seconds ? candidate : best);
    shard.files.push(file);
    shard.seconds += weight(file);
  }
  return shards;
}

export function shardArguments(specs, selection) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(selection ?? "");
  if (!match || Number(match[1]) > Number(match[2])) throw new Error("Use an E2E shard such as 1/3");
  const shard = planShards(specs, Number(match[2]))[Number(match[1]) - 1];
  if (!shard.files.length) throw new Error("E2E shard must contain tests");
  const patterns = shard.files.map((file) => `(?:^|/)tests/e2e/${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`);
  return { shard, args: ["test", "--config=playwright.config.ts", "--workers=1", "--fail-on-flaky-tests", ...patterns] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { shard, args } = shardArguments(discoverSpecs(), process.argv[2]);
  if (process.argv[3] === "--list") {
    process.stdout.write(`${JSON.stringify(shard, null, 2)}\n`);
  } else {
    if (process.argv.length !== 3) throw new Error("Unexpected E2E shard arguments");
    const start = Date.now();
    const result = spawnSync(process.execPath, [path.join(root, "node_modules/@playwright/test/cli.js"), ...args], {
      cwd: root, env: process.env, stdio: "inherit",
    });
    const seconds = Math.round((Date.now() - start) / 1000);
    const success = !result.error && result.status === 0;
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `Electron shard ${shard.index}: ${shard.files.length} spec files, ${seconds}s, ${success ? "passed" : "failed"}.\n`);
    }
    process.exitCode = success ? 0 : 1;
  }
}
