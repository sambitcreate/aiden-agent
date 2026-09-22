import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium } from "playwright";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const distributionRoot = path.join(repositoryRoot, "release", "distribution");
const timeoutMs = 45_000;
const execFileAsync = promisify(execFile);

async function findApps(root) {
  const results = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) results.push(candidate);
    else if (entry.isDirectory()) results.push(...await findApps(candidate));
  }
  return results;
}

async function waitForReady(journal, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Packaged Aiden exited before diagnostics were ready (${child.exitCode ?? child.signalCode}).`);
    }
    try {
      const records = (await readFile(journal, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (
        records.some((record) => record.event === "session-started" && record.fields?.profile === "production") &&
        records.some((record) => record.event === "electron-ready") &&
        records.some((record) => record.event === "renderer-ready")
      ) return;
    } catch (error) {
      if ((error?.code ?? "") !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  throw new Error("Packaged Aiden did not produce production diagnostics before the deadline.");
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a DevTools port.");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForJournalEvent(journal, eventName) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const records = (await readFile(journal, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (records.some((record) => record.event === eventName)) return;
    } catch (error) {
      if ((error?.code ?? "") !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  throw new Error(`Packaged Aiden did not record ${eventName} before the deadline.`);
}

async function confirmNativeCrashDialog(processId) {
  const script = `
tell application "System Events"
  set targetProcess to first process whose unix id is ${processId}
  set frontmost of targetProcess to true
  repeat 100 times
    if exists sheet 1 of window 1 of targetProcess then
      if exists button "Enable until restart" of sheet 1 of window 1 of targetProcess then
        click button "Enable until restart" of sheet 1 of window 1 of targetProcess
        return
      end if
    end if
    if exists button "Enable until restart" of window 1 of targetProcess then
      click button "Enable until restart" of window 1 of targetProcess
      return
    end if
    delay 0.1
  end repeat
  error "Native crash-capture confirmation did not appear."
end tell`;
  await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: timeoutMs });
}

const supplied = process.argv[2] ? path.resolve(process.argv[2]) : null;
const apps = supplied ? [supplied] : await findApps(distributionRoot);
if (apps.length !== 1) throw new Error(`Expected exactly one packaged Aiden app, found ${apps.length}.`);
const app = apps[0];
const executable = path.join(app, "Contents", "MacOS", path.basename(app, ".app"));
if (!(await stat(executable)).isFile()) throw new Error("Packaged Aiden executable is missing.");

const root = await mkdtemp(path.join(os.tmpdir(), "aiden-packaged-diagnostics-"));
const userData = path.join(root, "user-data");
const config = path.join(root, "config");
const xdgCache = path.join(root, "xdg-cache");
const xdgConfig = path.join(root, "xdg-config");
const xdgData = path.join(root, "xdg-data");
await Promise.all([userData, config, xdgCache, xdgConfig, xdgData].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));

const environment = {};
for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TEMP", "TMP", "TMPDIR", "TZ", "USER"]) {
  if (process.env[name] !== undefined) environment[name] = process.env[name];
}
Object.assign(environment, {
  AIDEN_CONFIG_DIR: config,
  AIDEN_RUNTIME_PROFILE: "production",
  HOME: root,
  XDG_CACHE_HOME: xdgCache,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: xdgData,
});

const devtoolsPort = await freePort();
const child = spawn(executable, [
  `--user-data-dir=${userData}`,
  `--remote-debugging-port=${devtoolsPort}`,
  "--disable-gpu",
], {
  cwd: root,
  env: environment,
  stdio: "ignore",
});
let browser;
try {
  const logs = path.join(userData, "logs");
  const journal = path.join(logs, "aiden.log");
  await waitForReady(journal, child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtoolsPort}`);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  if (!page) throw new Error("Packaged renderer was not available through DevTools.");
  const modePromise = page.evaluate(async () => {
    const bridge = globalThis.aidenAPI;
    if (!bridge) throw new Error("Packaged preload bridge is unavailable.");
    return bridge.ipc.invoke("diagnostics:mode-enable");
  });
  await confirmNativeCrashDialog(child.pid);
  const mode = await modePromise;
  if (!mode?.enabled || !mode.disablesOnRestart) {
    throw new Error("Packaged explicit crash capture did not become active.");
  }
  await waitForJournalEvent(journal, "diagnostic-mode-enabled");
  if (((await stat(logs)).mode & 0o777) !== 0o700) throw new Error("Packaged diagnostics directory is not owner-only.");
  for (const file of [journal, path.join(logs, "aiden-fatal.log"), path.join(logs, "subagent-runtime.log")]) {
    if (((await stat(file)).mode & 0o777) !== 0o600) throw new Error(`Packaged diagnostic file is not owner-only: ${path.basename(file)}`);
  }
  if (((await stat(path.join(userData, "Crashpad"))).mode & 0o777) !== 0o700) {
    throw new Error("Packaged Crashpad storage is not owner-only.");
  }
  process.stdout.write("Verified packaged production diagnostics and explicit local-only Crashpad mode.\n");
} finally {
  await browser?.close().catch(() => undefined);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
