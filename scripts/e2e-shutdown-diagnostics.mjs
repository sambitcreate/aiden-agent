// What an E2E run prints when Electron does not exit after Playwright asks it
// to quit. Hosted runs keep only a sanitized receipt and the job log, so the
// lines below are the only record of where the main process stopped.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const LIFECYCLE_SCOPES = new Set(["electron-lifecycle", "main"]);
const MAX_MESSAGE = 240;

/**
 * The quit and shutdown records of a dev log, oldest first, one short line
 * each. The journal has already redacted every message.
 */
export function lifecycleRecords(devLog, limit = 40) {
  const lines = [];
  for (const line of devLog.split("\n")) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const scope = record?.fields?.legacyScope;
    if (!LIFECYCLE_SCOPES.has(scope)) continue;
    const message = typeof record.fields.message === "string" ? record.fields.message.slice(0, MAX_MESSAGE) : "";
    lines.push(`  ${String(record.at)} ${String(record.level)} ${scope} ${message}`.trimEnd());
  }
  return lines.slice(-limit);
}

/** The main thread's call graph from macOS `sample` output, cut to `limit` lines. */
export function sampleMainThread(output, limit = 120) {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Call graph:");
  if (start < 0) return [];
  const thread = [];
  for (const line of lines.slice(start + 1)) {
    // The next thread starts at the same indent as the first.
    if (thread.length > 0 && /^ {4}\S/u.test(line) && /Thread_/u.test(line)) break;
    if (line.trim() === "") break;
    thread.push(line);
  }
  return thread.slice(0, limit);
}

/** One `/proc/<pid>/task/<tid>` thread as "name state wchan". */
export function procThreadLine(tid, stat, wchan) {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return `  ${tid} ?`;
  const name = stat.slice(open + 1, close);
  const state = stat.slice(close + 2).split(" ")[0] ?? "?";
  const waiting = wchan && wchan !== "0" ? ` ${wchan}` : "";
  return `  ${tid} ${name} ${state}${waiting}`;
}

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error && !stdout ? null : String(stdout));
    });
  });
}

/** The main thread, then any thread that isn't sleeping, then how many slept. */
async function linuxThreads(pid) {
  const taskDir = `/proc/${pid}/task`;
  const tids = await readdir(taskDir).catch(() => []);
  const lines = [];
  let sleeping = 0;
  for (const tid of tids) {
    const stat = await readFile(path.join(taskDir, tid, "stat"), "utf8").catch(() => "");
    if (!stat) continue;
    const wchan = await readFile(path.join(taskDir, tid, "wchan"), "utf8").catch(() => "");
    const line = procThreadLine(tid, stat, wchan.trim());
    if (tid === String(pid)) lines.unshift(line);
    else if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("S")) sleeping += 1;
    else if (lines.length < 40) lines.push(line);
  }
  if (sleeping) lines.push(`  (${sleeping} more sleeping)`);
  return lines;
}

/**
 * Where a main process that would not quit had got to: its quit and shutdown
 * records, then its threads (macOS: the main thread's call graph from
 * `sample`; Linux: the main thread's state and any thread awake). Never throws.
 */
export async function describeStuckShutdown({ pid, devLogPath, platform = process.platform }) {
  const sections = [];
  if (devLogPath) {
    const devLog = await readFile(devLogPath, "utf8").catch(() => null);
    const records = devLog === null ? [] : lifecycleRecords(devLog);
    sections.push(`Quit and shutdown records:\n${records.length ? records.join("\n") : "  (none)"}`);
  } else {
    // The production journal keeps no legacy info records, so it has none to give.
    sections.push("Quit and shutdown records:\n  (only a development-profile dev log keeps them)");
  }
  if (platform === "darwin") {
    const output = await run("/usr/bin/sample", [String(pid), "1", "-mayDie"], 20_000);
    const thread = output === null ? [] : sampleMainThread(output);
    sections.push(`Main thread (sample):\n${thread.length ? thread.join("\n") : "  (unavailable)"}`);
  } else if (platform === "linux") {
    const threads = await linuxThreads(pid);
    sections.push(`Threads (tid name state wchan):\n${threads.length ? threads.join("\n") : "  (unavailable)"}`);
  }
  return sections.join("\n");
}
