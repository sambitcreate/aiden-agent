import { appendFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Serial file windows from hosted main CI 35245275117, including fixture work.
// These weights only balance work: every new deterministic spec is included.
export const FILE_SECONDS = Object.freeze({
  "draft-agent-chats.spec.ts": 91,
  "chat-message-queue.spec.ts": 91,
  "browser-cancellation.spec.ts": 78,
  "chat-shell-interactions.spec.ts": 67,
  "settings-unification.spec.ts": 66,
  "browser.spec.ts": 58,
  "browser-agent.spec.ts": 46,
  "onboarding-lmstudio.spec.ts": 44,
  "browser-lifecycle.spec.ts": 37,
  "guided-setup.spec.ts": 29,
  "model-pad-responsive.spec.ts": 25,
  "assistant-scheduled-profile.spec.ts": 24,
  "settings-model-picker.spec.ts": 19,
  "provider-artwork.spec.ts": 16,
  "custom-model-options.spec.ts": 13,
  "terminal.spec.ts": 12,
  "lmstudio-chat-attachments.spec.ts": 11,
  "remote-access-lifecycle.spec.ts": 11,
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
