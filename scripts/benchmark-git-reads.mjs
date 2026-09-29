// Run with `npx tsx scripts/benchmark-git-reads.mjs [--baseline <ref>]`.
// Synthetic temporary repositories only; no provider/catalog/profile traffic.
import fs from "node:fs/promises";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
const baseline = process.argv[2] === "--baseline" ? process.argv[3] : undefined;
const copied = baseline ? join(checkout, "main/services", `.benchmark-git-${process.pid}.ts`) : undefined;
const root = await fs.mkdtemp(join(tmpdir(), "aiden-git-benchmark-"));
try {
  if (copied) await fs.writeFile(copied, execFileSync("git", ["show", `${baseline}:main/services/git.ts`], { cwd: checkout }));
  const { GitService } = await import(pathToFileURL(copied ?? join(checkout, "main/services/git.ts")).href);
  const repo = join(root, "repo");
  await fs.mkdir(repo);
  const git = args => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "Synthetic fixture"]);
  git(["config", "user.email", "fixture@example.test"]);
  git(["commit", "--allow-empty", "-m", "Fixture"]);
  const service = new GitService({ cacheTtlMs: 60_000 });
  const originalRun = service.run.bind(service);
  let commands = 0;
  service.run = (...args) => { commands++; return originalRun(...args); };
  await service.info(repo);
  const coldInfoCommands = commands;
  commands = 0;
  for (let i = 0; i < 10; i++) await service.info(repo);
  const warmInfoCommands = commands;
  const contents = "1234567\n".repeat(2048);
  for (let i = 0; i < 1000; i++) await fs.writeFile(join(repo, `fixture-${String(i).padStart(4, "0")}.txt`), contents);
  const originalSnapshot = service.reviewSnapshot.bind(service);
  let snapshot = false;
  service.reviewSnapshot = async (...args) => {
    snapshot = true;
    try { return await originalSnapshot(...args); } finally { snapshot = false; }
  };
  const originalReadFile = fs.readFile;
  const probe = await fs.open(join(root, "probe"), "w+");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  let metrics = { active: 0, peak: 0, bytes: 0 };
  const measured = async action => {
    metrics.active++;
    metrics.peak = Math.max(metrics.peak, metrics.active);
    try { const result = await action(); metrics.bytes += typeof result.bytesRead === "number" ? result.bytesRead : Buffer.byteLength(result); return result; }
    finally { metrics.active--; }
  };
  fs.readFile = (...args) => !snapshot && String(args[0]).includes("/fixture-") ? measured(() => originalReadFile(...args)) : originalReadFile(...args);
  prototype.read = function (...args) { return measured(() => originalRead.apply(this, args)); };
  syncBuiltinESMExports();
  const passes = [];
  try {
    for (let i = 0; i < 3; i++) {
      metrics = { active: 0, peak: 0, bytes: 0 };
      const review = await service.review(repo);
      passes.push({ ...metrics, unavailableStats: review.summary.unavailableStats, additions: review.summary.additions, snapshotComplete: review.commit.snapshotComplete });
    }
  } finally {
    fs.readFile = originalReadFile;
    prototype.read = originalRead;
    syncBuiltinESMExports();
  }
  console.log(JSON.stringify({ baseline: baseline ?? "working-tree", node: process.version, fixtureFiles: 1000, bytesPerFile: contents.length, coldInfoCommands, warmInfoRequests: 10, warmInfoCommands, fallbackPasses: passes, maxRssKiB: process.resourceUsage().maxRSS,
    caveat: "Real Git/source counters with clean pinned dependencies; fallback bytes exclude unchanged snapshot hashing. RSS includes Node/tsx/Git fixture overhead, not packaged Electron latency or energy. Polling cadence and default TTL unchanged." }, null, 2));
} finally {
  if (copied) await fs.rm(copied, { force: true });
  await fs.rm(root, { force: true, recursive: true });
}
