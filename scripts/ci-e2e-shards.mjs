import { appendFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Conservative complete file windows from hosted runs 41784199399 and 41789418295.
// Preserve larger historical weights; partial cancelled windows never lower them.
// Independent completed run 41778188548 validates the allocation and budget reserve.
// Weights affect scheduling only; newly discovered specs always run.
export const E2E_SHARD_COUNT = 4;
export const FILE_SECONDS = Object.freeze({
  "app-controls.spec.ts": 59,
  "assistant-scheduled-profile.spec.ts": 67,
  "bot-browser.spec.ts": 21,
  "bot-computer-tab.spec.ts": 14,
  "bot-connect-card.spec.ts": 8,
  "bot-connector-watches.spec.ts": 30,
  "bot-handoff-own-screen.spec.ts": 10,
  "bot-open-work.spec.ts": 30,
  "bot-peers.spec.ts": 30,
  "bot-routine-models.spec.ts": 30,
  "bot-sign-in.spec.ts": 5,
  "bots-persistence.spec.ts": 45,
  "bots-sidebar-panel.spec.ts": 7,
  "bots-starter.spec.ts": 22,
  "browser-agent.spec.ts": 38,
  "browser-cancellation.spec.ts": 66,
  "browser-initial-crash.spec.ts": 3,
  "browser-lifecycle.spec.ts": 237,
  "browser-throttling.spec.ts": 29,
  "browser.spec.ts": 166,
  "chat-follow-bottom.spec.ts": 61,
  "chat-fork.spec.ts": 13,
  "chat-message-queue.spec.ts": 263,
  "chat-shell-interactions.spec.ts": 310,
  "chat-top-bar.spec.ts": 166,
  "create-images.spec.ts": 166,
  "custom-model-options.spec.ts": 54,
  "cut-off-reply.spec.ts": 21,
  "draft-agent-chats.spec.ts": 112,
  "environment-devices-agent.spec.ts": 21,
  "environment-devices-android.spec.ts": 19,
  "environment-devices-features.spec.ts": 18,
  "environment-devices-stream.spec.ts": 22,
  "environment-devices-tab.spec.ts": 23,
  "environment-focus.spec.ts": 76,
  "follow-through-lifecycle.spec.ts": 48,
  "guided-setup.spec.ts": 94,
  "inbox-sidebar.spec.ts": 59,
  "inline-visuals.spec.ts": 56,
  "interrupted-question-resume.spec.ts": 75,
  "interrupted-reply-resume.spec.ts": 64,
  "linux-window-controls.spec.ts": 1,
  "lmstudio-chat-attachments.spec.ts": 22,
  "memory-list.spec.ts": 16,
  "model-call-retry.spec.ts": 26,
  "model-pad-responsive.spec.ts": 13,
  "no-workspace-chat.spec.ts": 37,
  "onboarding-lmstudio.spec.ts": 41,
  "peer-project-clone.spec.ts": 11,
  "provider-artwork.spec.ts": 8,
  "provider-failure-actions.spec.ts": 26,
  "providers-settings.spec.ts": 25,
  "quick-view-cards.spec.ts": 27,
  "remote-access-lifecycle.spec.ts": 43,
  "settings-connectors.spec.ts": 39,
  "settings-model-picker.spec.ts": 20,
  "settings-simulator-ssh-hosts.spec.ts": 16,
  "settings-unification.spec.ts": 156,
  "studio-foundation.spec.ts": 30,
  "terminal.spec.ts": 11,
  "transcript-image-consent.spec.ts": 30,
  "usage-data.spec.ts": 11,
  "usage-limit-wait.spec.ts": 18,
  "workspace-folder-missing.spec.ts": 8,
  "workspace-panel.spec.ts": 140,
  "workspace-settings.spec.ts": 12,
  "worktree-folder-deleted.spec.ts": 11
});

export function discoverSpecs(directory = path.join(root, "tests/e2e")) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

export function planShards(specs, count = E2E_SHARD_COUNT) {
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
